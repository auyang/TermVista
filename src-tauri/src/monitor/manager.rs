use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tokio::{
    sync::{Mutex, Semaphore, watch},
    task::JoinSet,
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ssh::{
    ReadOnlyCommandOutput, ReadOnlySessionCommand, SessionManager, SessionTermination, SshError,
};

use super::{
    delta::{CpuCounters, NetworkCounters, cpu_busy_percent, network_rates},
    models::{
        CpuMetric, HostMetric, LatencyKind, LatencyMetric, MetricState, MonitorEvent,
        MonitorSnapshot, MonitorStatus, MonitorSubscriptionId, Monitored, ProcessMetric,
    },
    parsers::{
        ProcessSample, parse_df, parse_loadavg, parse_meminfo, parse_proc_net_dev, parse_proc_stat,
        parse_processes, parse_uptime,
    },
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVE_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const BACKGROUND_SAMPLE_INTERVAL: Duration = Duration::from_secs(15);
const HOST_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const DISK_SAMPLE_INTERVAL: Duration = Duration::from_secs(20);
const MAX_GLOBAL_COMMANDS: usize = 6;
const MAX_SESSION_COMMANDS: usize = 2;

struct Subscription {
    id: String,
    session_id: String,
    events: watch::Sender<Channel<MonitorEvent>>,
    active: watch::Sender<bool>,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

struct CommandSample {
    output: ReadOnlyCommandOutput,
    elapsed: Duration,
}

#[derive(Clone, Copy)]
struct ProcessCpuBaseline {
    cpu_ticks: u64,
    start_ticks: u64,
    ticks_per_second: u64,
}

struct MonitorTaskContext {
    sessions: Arc<SessionManager>,
    global_limit: Arc<Semaphore>,
    per_session_limit: Arc<Semaphore>,
    session_id: String,
    display_ip: String,
    subscription_id: String,
    events: watch::Receiver<Channel<MonitorEvent>>,
    active: watch::Receiver<bool>,
    cancel: CancellationToken,
    termination: watch::Receiver<SessionTermination>,
    snapshots: Arc<Mutex<HashMap<String, MonitorSnapshot>>>,
}

#[derive(Clone)]
pub struct MonitorManager {
    sessions: Arc<SessionManager>,
    subscriptions: Arc<Mutex<HashMap<String, Subscription>>>,
    snapshots: Arc<Mutex<HashMap<String, MonitorSnapshot>>>,
    global_limit: Arc<Semaphore>,
}

impl MonitorManager {
    pub fn new(sessions: Arc<SessionManager>) -> Self {
        Self {
            sessions,
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
            snapshots: Arc::new(Mutex::new(HashMap::new())),
            global_limit: Arc::new(Semaphore::new(MAX_GLOBAL_COMMANDS)),
        }
    }

    pub async fn start(
        &self,
        session_id: String,
        on_event: Channel<MonitorEvent>,
    ) -> Result<MonitorSubscriptionId, SshError> {
        let termination = self.sessions.termination_receiver(&session_id).await?;
        let host = self
            .sessions
            .sessions()
            .await
            .into_iter()
            .find(|session| session.session_id == session_id)
            .map(|session| session.host)
            .ok_or_else(|| {
                SshError::new(
                    crate::ssh::SshErrorCode::SessionNotFound,
                    "SSH 会话不存在或已经关闭。",
                )
            })?;

        let mut subscriptions = self.subscriptions.lock().await;
        if let Some(subscription) = subscriptions.get_mut(&session_id) {
            subscription.events.send_replace(on_event);
            return Ok(MonitorSubscriptionId {
                subscription_id: subscription.id.clone(),
            });
        }

        let subscription_id = Uuid::new_v4().to_string();
        let (events_tx, events_rx) = watch::channel(on_event);
        let (active_tx, active_rx) = watch::channel(false);
        let cancel = CancellationToken::new();
        subscriptions.insert(
            session_id.clone(),
            Subscription {
                id: subscription_id.clone(),
                session_id: session_id.clone(),
                events: events_tx.clone(),
                active: active_tx,
                cancel: cancel.clone(),
                task: None,
            },
        );

        let sessions = Arc::clone(&self.sessions);
        let subscriptions_for_cleanup = Arc::downgrade(&self.subscriptions);
        let global_limit = Arc::clone(&self.global_limit);
        let snapshots = Arc::clone(&self.snapshots);
        let per_session_limit = Arc::new(Semaphore::new(MAX_SESSION_COMMANDS));
        let worker_session_id = session_id.clone();
        let worker_subscription_id = subscription_id.clone();
        let worker_events_tx = events_tx.clone();
        let task = tauri::async_runtime::spawn(async move {
            let (status, message) = run_monitor(MonitorTaskContext {
                sessions: Arc::clone(&sessions),
                global_limit: Arc::clone(&global_limit),
                per_session_limit,
                session_id: worker_session_id.clone(),
                display_ip: host,
                subscription_id: worker_subscription_id.clone(),
                events: events_rx,
                active: active_rx,
                cancel,
                termination,
                snapshots: Arc::clone(&snapshots),
            })
            .await;
            if matches!(status, MonitorStatus::Stopped | MonitorStatus::Disconnected) {
                mark_cached_snapshot_stale(&snapshots, &worker_session_id, "监控采样已停止。")
                    .await;
            }
            if let Some(subscriptions) = subscriptions_for_cleanup.upgrade() {
                let mut subscriptions = subscriptions.lock().await;
                if subscriptions
                    .get(&worker_session_id)
                    .is_some_and(|subscription| subscription.id == worker_subscription_id)
                {
                    let channel = worker_events_tx.borrow().clone();
                    send_status(
                        &worker_subscription_id,
                        &worker_session_id,
                        &status,
                        message,
                        &channel,
                    );
                    subscriptions.remove(&worker_session_id);
                }
            }
        });
        if let Some(subscription) = subscriptions.get_mut(&session_id) {
            subscription.task = Some(task);
        }
        Ok(MonitorSubscriptionId { subscription_id })
    }

    pub async fn set_active_session(&self, session_id: Option<&str>) {
        let subscriptions = self.subscriptions.lock().await;
        for subscription in subscriptions.values() {
            subscription
                .active
                .send_replace(session_id == Some(subscription.session_id.as_str()));
        }
    }

    pub async fn snapshot(&self, session_id: &str) -> Option<MonitorSnapshot> {
        self.snapshots.lock().await.get(session_id).cloned()
    }

    pub async fn stop(&self, subscription_id: &str) {
        let removed = {
            let mut subscriptions = self.subscriptions.lock().await;
            let session_id = subscriptions.iter().find_map(|(session_id, subscription)| {
                (subscription.id == subscription_id).then(|| session_id.clone())
            });
            session_id.and_then(|session_id| {
                subscriptions
                    .remove(&session_id)
                    .map(|item| (session_id, item))
            })
        };
        if let Some((session_id, subscription)) = removed {
            subscription.cancel.cancel();
            let channel = subscription.events.borrow().clone();
            let _ = channel.send(MonitorEvent::Status {
                subscription_id: subscription.id,
                session_id: session_id.clone(),
                status: MonitorStatus::Stopped,
                message: None,
            });
            mark_cached_snapshot_stale(&self.snapshots, &session_id, "监控采样已停止。").await;
            finish_task(subscription.task).await;
        }
    }

    pub async fn stop_session(&self, session_id: &str) {
        let subscription = self.subscriptions.lock().await.remove(session_id);
        if let Some(subscription) = subscription {
            subscription.cancel.cancel();
            let _ = subscription.events.borrow().send(MonitorEvent::Status {
                subscription_id: subscription.id.clone(),
                session_id: subscription.session_id.clone(),
                status: MonitorStatus::Disconnected,
                message: Some("SSH 会话已断开，监控已停止。".to_owned()),
            });
            mark_cached_snapshot_stale(
                &self.snapshots,
                session_id,
                "SSH 会话已断开，监控数据已过期。",
            )
            .await;
            finish_task(subscription.task).await;
        }
    }

    pub async fn close_all(&self) {
        let subscriptions = {
            let mut subscriptions = self.subscriptions.lock().await;
            subscriptions
                .drain()
                .map(|(_, value)| value)
                .collect::<Vec<_>>()
        };
        for subscription in &subscriptions {
            subscription.cancel.cancel();
            let _ = subscription.events.borrow().send(MonitorEvent::Status {
                subscription_id: subscription.id.clone(),
                session_id: subscription.session_id.clone(),
                status: MonitorStatus::Stopped,
                message: None,
            });
            mark_cached_snapshot_stale(
                &self.snapshots,
                &subscription.session_id,
                "监控采样已停止。",
            )
            .await;
        }
        for subscription in subscriptions {
            finish_task(subscription.task).await;
        }
    }
}

async fn finish_task(task: Option<JoinHandle<()>>) {
    if let Some(mut task) = task
        && timeout(Duration::from_secs(2), &mut task).await.is_err()
    {
        task.abort();
        let _ = timeout(Duration::from_secs(1), task).await;
    }
}

fn send_status(
    subscription_id: &str,
    session_id: &str,
    status: &MonitorStatus,
    message: Option<String>,
    channel: &Channel<MonitorEvent>,
) {
    let _ = channel.send(MonitorEvent::Status {
        subscription_id: subscription_id.to_owned(),
        session_id: session_id.to_owned(),
        status: *status,
        message,
    });
}

async fn run_monitor(context: MonitorTaskContext) -> (MonitorStatus, Option<String>) {
    let MonitorTaskContext {
        sessions,
        global_limit,
        per_session_limit,
        session_id,
        display_ip,
        subscription_id,
        events,
        mut active,
        cancel,
        mut termination,
        snapshots,
    } = context;
    let mut snapshot = MonitorSnapshot::pending(&session_id);
    send_status(
        &subscription_id,
        &session_id,
        &MonitorStatus::Started,
        None,
        &events.borrow().clone(),
    );

    if !emit_snapshot(&mut snapshot, &subscription_id, &events, &snapshots).await {
        return (MonitorStatus::Stopped, None);
    }

    match execute_one(
        &sessions,
        &global_limit,
        &per_session_limit,
        &session_id,
        ReadOnlySessionCommand::SystemName,
        &cancel,
        &mut termination,
    )
    .await
    {
        Ok(sample) => match command_text(sample.output) {
            Ok(name) if name.trim().eq_ignore_ascii_case("linux") => {}
            Ok(name) => {
                return (
                    MonitorStatus::Unsupported,
                    Some(format!(
                        "当前服务器系统为 {}；本阶段只支持 Linux 监控。",
                        name.trim()
                    )),
                );
            }
            Err(error) => return (MonitorStatus::Unsupported, Some(error)),
        },
        Err(error) => return (MonitorStatus::Disconnected, Some(error)),
    }

    let mut previous_cpu: Option<CpuCounters> = None;
    let mut previous_network: Option<HashMap<String, NetworkCounters>> = None;
    let mut previous_network_at: Option<Instant> = None;
    let mut previous_processes = HashMap::new();
    let mut previous_process_sample_at = Instant::now();

    let initial_host = execute_batch(
        &sessions,
        &global_limit,
        &per_session_limit,
        &session_id,
        &[
            ReadOnlySessionCommand::Hostname,
            ReadOnlySessionCommand::LoadAverage,
            ReadOnlySessionCommand::Uptime,
            ReadOnlySessionCommand::MemoryInfo,
        ],
        &cancel,
        &termination,
    )
    .await;
    apply_host_samples(
        &mut snapshot,
        &display_ip,
        initial_host.iter().map(clone_sample_result).collect(),
    );
    let sampled_at = super::models::utc_now_iso8601();
    apply_core_samples(
        &mut snapshot,
        initial_host,
        &sampled_at,
        &mut previous_cpu,
        &mut previous_network,
        &mut previous_network_at,
    );
    if !emit_snapshot(&mut snapshot, &subscription_id, &events, &snapshots).await {
        return (MonitorStatus::Stopped, None);
    }

    let initial_live = execute_batch(
        &sessions,
        &global_limit,
        &per_session_limit,
        &session_id,
        &[
            ReadOnlySessionCommand::CpuStat,
            ReadOnlySessionCommand::NetworkInterfaces,
            ReadOnlySessionCommand::Processes,
            ReadOnlySessionCommand::LatencyProbe,
        ],
        &cancel,
        &termination,
    )
    .await;
    let sampled_at = super::models::utc_now_iso8601();
    apply_host_samples(
        &mut snapshot,
        &display_ip,
        initial_live.iter().map(clone_sample_result).collect(),
    );
    apply_process_samples(
        &mut snapshot,
        initial_live.iter().map(clone_sample_result).collect(),
        &mut previous_processes,
        &mut previous_process_sample_at,
        &sampled_at,
    );
    apply_core_samples(
        &mut snapshot,
        initial_live,
        &sampled_at,
        &mut previous_cpu,
        &mut previous_network,
        &mut previous_network_at,
    );
    let mut last_host_sample = Instant::now();
    let mut last_process_sample = previous_process_sample_at;
    if !emit_snapshot(&mut snapshot, &subscription_id, &events, &snapshots).await {
        return (MonitorStatus::Stopped, None);
    }

    let mut termination_for_disk = termination.clone();
    match execute_one(
        &sessions,
        &global_limit,
        &per_session_limit,
        &session_id,
        ReadOnlySessionCommand::Filesystems,
        &cancel,
        &mut termination_for_disk,
    )
    .await
    .and_then(|sample| command_text(sample.output))
    .and_then(|text| parse_df(&text).map_err(|error| format!("磁盘数据解析失败：{error:?}")))
    {
        Ok(disks) => snapshot.disks = Monitored::fresh(disks, super::models::utc_now_iso8601()),
        Err(error) => mark_failed(&mut snapshot.disks, error),
    }
    let mut last_disk_sample = Instant::now();
    if !emit_snapshot(&mut snapshot, &subscription_id, &events, &snapshots).await {
        return (MonitorStatus::Stopped, None);
    }

    loop {
        let active_now = *active.borrow();
        let interval = if active_now {
            ACTIVE_SAMPLE_INTERVAL
        } else {
            BACKGROUND_SAMPLE_INTERVAL
        };
        tokio::select! {
            _ = cancel.cancelled() => return (MonitorStatus::Stopped, None),
            changed = termination.changed() => {
                if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                    return (MonitorStatus::Disconnected, Some("SSH 会话已断开，监控已停止。".to_owned()));
                }
                continue;
            }
            changed = active.changed() => {
                if changed.is_err() { return (MonitorStatus::Stopped, None); }
                continue;
            }
            _ = sleep(interval) => {}
        }

        let now = Instant::now();
        let host_interval = if active_now {
            HOST_SAMPLE_INTERVAL
        } else {
            BACKGROUND_SAMPLE_INTERVAL
        };
        let process_interval = if active_now {
            ACTIVE_SAMPLE_INTERVAL
        } else {
            BACKGROUND_SAMPLE_INTERVAL
        };
        let host_due = now.duration_since(last_host_sample) >= host_interval;
        let process_due = now.duration_since(last_process_sample) >= process_interval;
        let disk_due = now.duration_since(last_disk_sample) >= DISK_SAMPLE_INTERVAL;

        let mut commands = vec![
            ReadOnlySessionCommand::CpuStat,
            ReadOnlySessionCommand::MemoryInfo,
            ReadOnlySessionCommand::NetworkInterfaces,
        ];
        if host_due {
            commands.extend([
                ReadOnlySessionCommand::Hostname,
                ReadOnlySessionCommand::LoadAverage,
                ReadOnlySessionCommand::Uptime,
                ReadOnlySessionCommand::LatencyProbe,
            ]);
        }
        if process_due {
            commands.push(ReadOnlySessionCommand::Processes);
        }

        let results = execute_batch(
            &sessions,
            &global_limit,
            &per_session_limit,
            &session_id,
            &commands,
            &cancel,
            &termination,
        )
        .await;
        let sampled_at = super::models::utc_now_iso8601();
        apply_host_samples(
            &mut snapshot,
            &display_ip,
            results.iter().map(clone_sample_result).collect(),
        );
        apply_process_samples(
            &mut snapshot,
            results.iter().map(clone_sample_result).collect(),
            &mut previous_processes,
            &mut previous_process_sample_at,
            &sampled_at,
        );
        apply_core_samples(
            &mut snapshot,
            results,
            &sampled_at,
            &mut previous_cpu,
            &mut previous_network,
            &mut previous_network_at,
        );
        if host_due {
            last_host_sample = Instant::now();
        }
        if process_due {
            last_process_sample = previous_process_sample_at;
        }

        if disk_due {
            let mut termination = termination.clone();
            let result = execute_one(
                &sessions,
                &global_limit,
                &per_session_limit,
                &session_id,
                ReadOnlySessionCommand::Filesystems,
                &cancel,
                &mut termination,
            )
            .await
            .and_then(|sample| command_text(sample.output))
            .and_then(|text| {
                parse_df(&text).map_err(|error| format!("磁盘数据解析失败：{error:?}"))
            });
            match result {
                Ok(disks) => {
                    snapshot.disks = Monitored::fresh(disks, super::models::utc_now_iso8601())
                }
                Err(error) => mark_failed(&mut snapshot.disks, error),
            }
            last_disk_sample = Instant::now();
        }
        if !emit_snapshot(&mut snapshot, &subscription_id, &events, &snapshots).await {
            return (MonitorStatus::Stopped, None);
        }
    }
}

fn clone_sample_result(
    (command, result): &(ReadOnlySessionCommand, Result<CommandSample, String>),
) -> (ReadOnlySessionCommand, Result<CommandSample, String>) {
    (
        *command,
        result
            .as_ref()
            .map(|sample| CommandSample {
                output: ReadOnlyCommandOutput {
                    stdout: sample.output.stdout.clone(),
                    stderr: sample.output.stderr.clone(),
                    exit_status: sample.output.exit_status,
                },
                elapsed: sample.elapsed,
            })
            .map_err(Clone::clone),
    )
}

fn apply_core_samples(
    snapshot: &mut MonitorSnapshot,
    results: Vec<(ReadOnlySessionCommand, Result<CommandSample, String>)>,
    sampled_at: &str,
    previous_cpu: &mut Option<CpuCounters>,
    previous_network: &mut Option<HashMap<String, NetworkCounters>>,
    previous_network_at: &mut Option<Instant>,
) {
    for (command, result) in results {
        match command {
            ReadOnlySessionCommand::CpuStat => match result
                .and_then(|sample| command_text(sample.output))
                .and_then(|text| {
                    parse_proc_stat(&text).map_err(|error| format!("CPU 数据解析失败：{error:?}"))
                }) {
                Ok(current) => {
                    if let Some(previous) = *previous_cpu
                        && let Some(busy_percent) = cpu_busy_percent(previous, current)
                    {
                        snapshot.cpu =
                            Monitored::fresh(CpuMetric { busy_percent }, sampled_at.to_owned());
                    } else if previous_cpu.is_some() {
                        mark_failed(
                            &mut snapshot.cpu,
                            "CPU 计数器发生回退或差值无效。".to_owned(),
                        );
                    }
                    *previous_cpu = Some(current);
                }
                Err(error) => mark_failed(&mut snapshot.cpu, error),
            },
            ReadOnlySessionCommand::MemoryInfo => match result
                .and_then(|sample| command_text(sample.output))
                .and_then(|text| {
                    parse_meminfo(&text).map_err(|error| format!("内存数据解析失败：{error:?}"))
                }) {
                Ok(value) => snapshot.memory = Monitored::fresh(value, sampled_at.to_owned()),
                Err(error) => mark_failed(&mut snapshot.memory, error),
            },
            ReadOnlySessionCommand::NetworkInterfaces => match result
                .and_then(|sample| command_text(sample.output))
                .and_then(|text| {
                    parse_proc_net_dev(&text)
                        .map_err(|error| format!("网络数据解析失败：{error:?}"))
                }) {
                Ok(current) => {
                    let now = Instant::now();
                    let interfaces = network_rates(
                        previous_network.as_ref().unwrap_or(&HashMap::new()),
                        &current,
                        previous_network_at
                            .map(|at| now.saturating_duration_since(at))
                            .unwrap_or_default(),
                    );
                    let selected_interface =
                        interfaces.first().map(|interface| interface.name.clone());
                    snapshot.network = Monitored::fresh(
                        super::models::NetworkMetric {
                            interfaces,
                            selected_interface,
                        },
                        sampled_at.to_owned(),
                    );
                    *previous_network = Some(current);
                    *previous_network_at = Some(now);
                }
                Err(error) => mark_failed(&mut snapshot.network, error),
            },
            _ => {}
        }
    }
}

fn apply_process_samples(
    snapshot: &mut MonitorSnapshot,
    results: Vec<(ReadOnlySessionCommand, Result<CommandSample, String>)>,
    previous: &mut HashMap<u32, ProcessCpuBaseline>,
    previous_at: &mut Instant,
    sampled_at: &str,
) {
    let Some((_, result)) = results
        .into_iter()
        .find(|(command, _)| *command == ReadOnlySessionCommand::Processes)
    else {
        return;
    };
    let samples = result
        .and_then(|sample| command_text(sample.output))
        .and_then(|text| {
            parse_processes(&text).map_err(|error| format!("进程数据解析失败：{error:?}"))
        });
    let samples = match samples {
        Ok(samples) => samples,
        Err(error) => {
            mark_failed(&mut snapshot.processes, error);
            return;
        }
    };

    let now = Instant::now();
    let elapsed = now
        .saturating_duration_since(*previous_at)
        .as_secs_f64()
        .max(f64::EPSILON);
    let mut next_previous = HashMap::with_capacity(samples.len());
    let processes = samples
        .into_iter()
        .map(|sample: ProcessSample| {
            let baseline = ProcessCpuBaseline {
                cpu_ticks: sample.cpu_ticks,
                start_ticks: sample.start_ticks,
                ticks_per_second: sample.ticks_per_second,
            };
            let cpu_percent = previous
                .get(&sample.pid)
                .filter(|prior| {
                    prior.start_ticks == sample.start_ticks
                        && prior.ticks_per_second == sample.ticks_per_second
                        && sample.cpu_ticks >= prior.cpu_ticks
                })
                .map(|prior| {
                    (sample.cpu_ticks - prior.cpu_ticks) as f64
                        / sample.ticks_per_second as f64
                        / elapsed
                        * 100.0
                })
                .unwrap_or(0.0);
            next_previous.insert(sample.pid, baseline);
            ProcessMetric {
                pid: sample.pid,
                command: sample.command,
                cpu_percent,
                rss_bytes: sample.rss_bytes,
            }
        })
        .collect();
    *previous = next_previous;
    *previous_at = now;
    snapshot.processes = Monitored::fresh(processes, sampled_at.to_owned());
}

fn apply_host_samples(
    snapshot: &mut MonitorSnapshot,
    display_ip: &str,
    results: Vec<(ReadOnlySessionCommand, Result<CommandSample, String>)>,
) {
    let host_requested = results.iter().any(|(command, _)| {
        matches!(
            *command,
            ReadOnlySessionCommand::Hostname
                | ReadOnlySessionCommand::LoadAverage
                | ReadOnlySessionCommand::Uptime
        )
    });
    let latency_requested = results
        .iter()
        .any(|(command, _)| *command == ReadOnlySessionCommand::LatencyProbe);
    let mut hostname = None;
    let mut load = None;
    let mut uptime = None;
    let mut latency = None;
    let mut errors = HashMap::new();
    for (command, result) in results {
        let parsed = result.and_then(|sample| {
            let elapsed = sample.elapsed;
            command_text(sample.output).map(|text| (text, elapsed))
        });
        match (command, parsed) {
            (ReadOnlySessionCommand::Hostname, Ok((value, _))) if !value.trim().is_empty() => {
                hostname = Some(value.trim().to_owned())
            }
            (ReadOnlySessionCommand::LoadAverage, Ok((value, _))) => match parse_loadavg(&value) {
                Ok(value) => load = Some(value),
                Err(error) => {
                    errors.insert(command, format!("负载数据解析失败：{error:?}"));
                }
            },
            (ReadOnlySessionCommand::Uptime, Ok((value, _))) => match parse_uptime(&value) {
                Ok(value) => uptime = Some(value),
                Err(error) => {
                    errors.insert(command, format!("运行时长解析失败：{error:?}"));
                }
            },
            (ReadOnlySessionCommand::LatencyProbe, Ok((_, elapsed))) => {
                latency = Some(LatencyMetric {
                    ssh_round_trip_ms: elapsed.as_secs_f64() * 1_000.0,
                    kind: LatencyKind::SshExecRoundTrip,
                })
            }
            (command, Err(error)) => {
                errors.insert(command, error);
            }
            (ReadOnlySessionCommand::Hostname, Ok(_)) => {
                errors.insert(command, "服务器未返回主机名。".to_owned());
            }
            _ => {}
        }
    }
    let sampled_at = super::models::utc_now_iso8601();
    if host_requested {
        if let (Some(hostname), Some(load), Some(uptime)) = (hostname, load, uptime) {
            snapshot.host = Monitored::fresh(
                HostMetric {
                    hostname,
                    display_ip: display_ip.to_owned(),
                    uptime_seconds: uptime,
                    load1: load.one,
                    load5: load.five,
                    load15: load.fifteen,
                },
                sampled_at.clone(),
            );
        } else {
            let reason = errors
                .get(&ReadOnlySessionCommand::Hostname)
                .or_else(|| errors.get(&ReadOnlySessionCommand::LoadAverage))
                .or_else(|| errors.get(&ReadOnlySessionCommand::Uptime))
                .cloned()
                .unwrap_or_else(|| "主机信息不完整。".to_owned());
            mark_failed(&mut snapshot.host, reason);
        }
    }
    if latency_requested {
        match latency {
            Some(value) if value.ssh_round_trip_ms.is_finite() => {
                snapshot.latency = Monitored::fresh(value, sampled_at)
            }
            _ => mark_failed(
                &mut snapshot.latency,
                errors
                    .remove(&ReadOnlySessionCommand::LatencyProbe)
                    .unwrap_or_else(|| "SSH 往返测量失败。".to_owned()),
            ),
        }
    }
}

async fn execute_batch(
    sessions: &Arc<SessionManager>,
    global_limit: &Arc<Semaphore>,
    per_session_limit: &Arc<Semaphore>,
    session_id: &str,
    commands: &[ReadOnlySessionCommand],
    cancel: &CancellationToken,
    termination: &watch::Receiver<SessionTermination>,
) -> Vec<(ReadOnlySessionCommand, Result<CommandSample, String>)> {
    let mut tasks = JoinSet::new();
    for command in commands.iter().copied() {
        let sessions = Arc::clone(sessions);
        let global_limit = Arc::clone(global_limit);
        let per_session_limit = Arc::clone(per_session_limit);
        let session_id = session_id.to_owned();
        let cancel = cancel.clone();
        let mut termination = termination.clone();
        tasks.spawn(async move {
            let result = execute_one(
                &sessions,
                &global_limit,
                &per_session_limit,
                &session_id,
                command,
                &cancel,
                &mut termination,
            )
            .await;
            (command, result)
        });
    }
    let mut results = Vec::with_capacity(commands.len());
    while let Some(result) = tasks.join_next().await {
        if let Ok(result) = result {
            results.push(result);
        }
    }
    results
}

async fn execute_one(
    sessions: &SessionManager,
    global_limit: &Arc<Semaphore>,
    per_session_limit: &Arc<Semaphore>,
    session_id: &str,
    command: ReadOnlySessionCommand,
    cancel: &CancellationToken,
    termination: &mut watch::Receiver<SessionTermination>,
) -> Result<CommandSample, String> {
    let acquire_permits = async {
        let session = Arc::clone(per_session_limit)
            .acquire_owned()
            .await
            .map_err(|_| "会话监控并发限制已关闭。".to_owned())?;
        let global = Arc::clone(global_limit)
            .acquire_owned()
            .await
            .map_err(|_| "全局监控并发限制已关闭。".to_owned())?;
        Ok::<_, String>((session, global))
    };
    let (_session_permit, _global_permit) = tokio::select! {
        result = timeout(COMMAND_TIMEOUT, acquire_permits) => match result {
            Ok(Ok(permits)) => permits,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err("等待监控并发槽位超过 5 秒。".to_owned()),
        },
        _ = cancel.cancelled() => return Err("监控采样已取消。".to_owned()),
        changed = termination.changed() => {
            let _ = changed;
            return Err("SSH 会话已关闭。".to_owned());
        }
    };

    let started = Instant::now();
    let execution = sessions
        .exec_read_only(session_id, command, cancel.clone())
        .await
        .map_err(|error| error.message)?;
    Ok(CommandSample {
        output: execution,
        elapsed: started.elapsed(),
    })
}

fn command_text(output: ReadOnlyCommandOutput) -> Result<String, String> {
    if output.exit_status.is_some_and(|status| status != 0) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            "服务器上的只读监控命令返回非零状态。".to_owned()
        } else {
            format!("服务器只读监控命令失败：{detail}")
        });
    }
    String::from_utf8(output.stdout).map_err(|_| "服务器监控输出不是有效 UTF-8。".to_owned())
}

fn mark_failed<T>(metric: &mut Monitored<T>, reason: String) {
    metric.state = if metric.value.is_some() {
        MetricState::Stale
    } else {
        MetricState::Error
    };
    metric.reason = Some(reason);
}

async fn mark_cached_snapshot_stale(
    snapshots: &Mutex<HashMap<String, MonitorSnapshot>>,
    session_id: &str,
    reason: &str,
) {
    let mut snapshots = snapshots.lock().await;
    let Some(snapshot) = snapshots.get_mut(session_id) else {
        return;
    };
    mark_failed(&mut snapshot.host, reason.to_owned());
    mark_failed(&mut snapshot.cpu, reason.to_owned());
    mark_failed(&mut snapshot.memory, reason.to_owned());
    mark_failed(&mut snapshot.processes, reason.to_owned());
    mark_failed(&mut snapshot.network, reason.to_owned());
    mark_failed(&mut snapshot.latency, reason.to_owned());
    mark_failed(&mut snapshot.disks, reason.to_owned());
    snapshot.sequence = snapshot.sequence.saturating_add(1);
    snapshot.collected_at = super::models::utc_now_iso8601();
}

async fn emit_snapshot(
    snapshot: &mut MonitorSnapshot,
    subscription_id: &str,
    events: &watch::Receiver<Channel<MonitorEvent>>,
    snapshots: &Mutex<HashMap<String, MonitorSnapshot>>,
) -> bool {
    snapshot.sequence = snapshot.sequence.saturating_add(1);
    snapshot.collected_at = super::models::utc_now_iso8601();
    snapshots
        .lock()
        .await
        .insert(snapshot.session_id.clone(), snapshot.clone());
    events
        .borrow()
        .send(MonitorEvent::Snapshot {
            subscription_id: subscription_id.to_owned(),
            data: Box::new(snapshot.clone()),
        })
        .is_ok()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    use super::{
        CommandSample, ProcessCpuBaseline, apply_core_samples, apply_host_samples,
        apply_process_samples, clone_sample_result,
    };
    use crate::{
        monitor::{models::MetricState, models::MonitorSnapshot},
        ssh::{ReadOnlyCommandOutput, ReadOnlySessionCommand},
    };

    fn sample(stdout: &str) -> Result<CommandSample, String> {
        Ok(CommandSample {
            output: ReadOnlyCommandOutput {
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
                exit_status: Some(0),
            },
            elapsed: Duration::from_millis(1),
        })
    }

    #[test]
    fn host_and_memory_phase_keeps_unrequested_process_metrics_pending() {
        let mut snapshot = MonitorSnapshot::pending("session");
        let results = vec![
            (ReadOnlySessionCommand::Hostname, sample("node-a\n")),
            (
                ReadOnlySessionCommand::LoadAverage,
                sample("0.10 0.20 0.30 1/20 100\n"),
            ),
            (ReadOnlySessionCommand::Uptime, sample("120.0 90.0\n")),
            (
                ReadOnlySessionCommand::MemoryInfo,
                sample(
                    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
                ),
            ),
        ];
        apply_host_samples(
            &mut snapshot,
            "192.0.2.10",
            results.iter().map(clone_sample_result).collect(),
        );
        let mut previous_cpu = None;
        let mut previous_network = None;
        let mut previous_network_at = None;
        apply_core_samples(
            &mut snapshot,
            results,
            "2026-10-22T00:00:00Z",
            &mut previous_cpu,
            &mut previous_network,
            &mut previous_network_at,
        );

        assert_eq!(snapshot.host.state, MetricState::Fresh);
        assert_eq!(snapshot.memory.state, MetricState::Fresh);
        assert_eq!(snapshot.processes.state, MetricState::Pending);
        assert_eq!(snapshot.latency.state, MetricState::Pending);
    }

    #[test]
    fn process_cpu_uses_counter_deltas_between_samples() {
        let mut snapshot = MonitorSnapshot::pending("session");
        let mut previous = HashMap::new();
        let mut previous_at = Instant::now() - Duration::from_secs(1);
        previous.insert(
            42,
            ProcessCpuBaseline {
                cpu_ticks: 100,
                start_ticks: 999,
                ticks_per_second: 100,
            },
        );
        apply_process_samples(
            &mut snapshot,
            vec![(
                ReadOnlySessionCommand::Processes,
                sample("42 100 120 999 768 worker\n"),
            )],
            &mut previous,
            &mut previous_at,
            "2026-10-22T00:00:00Z",
        );

        let process = &snapshot.processes.value.as_ref().unwrap()[0];
        assert!(process.cpu_percent > 0.0);
        assert_eq!(process.rss_bytes, "786432");
        assert_eq!(process.command, "worker");
        assert_eq!(
            snapshot.processes.sampled_at.as_deref(),
            Some("2026-10-22T00:00:00Z")
        );
    }

    #[test]
    fn process_baseline_is_replaced_after_a_successful_sample() {
        let mut snapshot = MonitorSnapshot::pending("session");
        let mut previous = HashMap::new();
        let mut previous_at = Instant::now() - Duration::from_secs(1);
        apply_process_samples(
            &mut snapshot,
            vec![(
                ReadOnlySessionCommand::Processes,
                sample("42 100 120 999 768 worker\n"),
            )],
            &mut previous,
            &mut previous_at,
            "2026-10-22T00:00:00Z",
        );
        assert_eq!(previous.get(&42).unwrap().cpu_ticks, 120);
        assert_eq!(previous.get(&42).unwrap().start_ticks, 999);
    }
}
