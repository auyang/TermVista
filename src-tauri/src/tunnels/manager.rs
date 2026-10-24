use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use russh::ChannelStream;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::ssh::{SessionManager, SessionTermination, SshErrorCode, SshState};

use super::models::{
    ForwardRule, ForwardRuntime, Socks5Rule, Socks5Runtime, TcpCheckResult, TunnelError,
    TunnelErrorCode, TunnelEvent, TunnelProtocol, TunnelState, now_millis,
};
use super::socks5::{
    REP_CONNECTION_REFUSED, REP_GENERAL_FAILURE, REP_HOST_UNREACHABLE, REP_NETWORK_UNREACHABLE,
    REP_SUCCEEDED, RequestError, read_connect_request, write_reply,
};

const MAX_ACTIVE_CONNECTIONS: usize = 64;
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(12);
const SOCKS5_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const RUNTIME_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_TUNNEL_EVENTS: usize = 100;

type RuntimeSink = dyn Fn(ForwardRuntime) + Send + Sync + 'static;
type Socks5RuntimeSink = dyn Fn(Socks5Runtime) + Send + Sync + 'static;

struct ActiveForward {
    profile_id: String,
    session_id: String,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

struct ActiveSocks5 {
    profile_id: String,
    session_id: String,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct TrafficCounters {
    from_local: AtomicU64,
    to_local: AtomicU64,
}

impl TrafficCounters {
    fn snapshot(&self) -> (u64, u64) {
        (
            self.from_local.load(Ordering::Relaxed),
            self.to_local.load(Ordering::Relaxed),
        )
    }
}

#[derive(Default)]
struct TrafficSyncState {
    reported: (u64, u64),
    sampled: (u64, u64),
}

#[derive(Default)]
struct TunnelInner {
    runtimes: HashMap<String, ForwardRuntime>,
    active: HashMap<String, ActiveForward>,
    socks5_runtimes: HashMap<String, Socks5Runtime>,
    active_socks5: HashMap<String, ActiveSocks5>,
    last_target_checks: HashMap<String, TcpCheckResult>,
    events: VecDeque<TunnelEvent>,
}

pub struct TunnelManager {
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<RuntimeSink>,
    socks5_sink: Arc<Socks5RuntimeSink>,
    operations: Mutex<()>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new(|_| {})
    }
}

impl TunnelManager {
    pub fn new(sink: impl Fn(ForwardRuntime) + Send + Sync + 'static) -> Self {
        Self::new_with_socks5(sink, |_| {})
    }

    pub fn new_with_socks5(
        sink: impl Fn(ForwardRuntime) + Send + Sync + 'static,
        socks5_sink: impl Fn(Socks5Runtime) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TunnelInner::default())),
            sink: Arc::new(sink),
            socks5_sink: Arc::new(socks5_sink),
            operations: Mutex::new(()),
        }
    }

    pub async fn start(
        &self,
        rule: &ForwardRule,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<ForwardRuntime, TunnelError> {
        let _operation = self.operations.lock().await;
        self.start_locked(rule, session_id, sessions).await
    }

    pub async fn start_loaded(
        &self,
        load_rule: impl FnOnce() -> Result<ForwardRule, TunnelError>,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<ForwardRuntime, TunnelError> {
        let _operation = self.operations.lock().await;
        let rule = load_rule()?;
        self.start_locked(&rule, session_id, sessions).await
    }

    async fn start_locked(
        &self,
        rule: &ForwardRule,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<ForwardRuntime, TunnelError> {
        let mut rule = rule.clone();
        rule.validate_and_normalize()?;
        let binding = sessions.security_binding(session_id).await.map_err(|_| {
            TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话不存在或尚未完成主机指纹验证和身份认证。",
            )
        })?;
        if binding.summary.state != SshState::Connected {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话尚未连接。",
            ));
        }
        if binding.summary.profile_id != rule.profile_id {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionProfileMismatch,
                "此 SSH 会话不属于该转发规则绑定的服务器配置。",
            ));
        }
        let termination = sessions
            .termination_receiver(session_id)
            .await
            .map_err(|_| TunnelError::new(TunnelErrorCode::SessionMissing, "SSH 会话已关闭。"))?;
        if *termination.borrow() != SessionTermination::Running {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话已断开，请重新连接后手动启动转发。",
            ));
        }

        {
            let mut inner = self.inner.lock().await;
            if let Some(active) = inner.active.get(&rule.id) {
                if !active.task.is_finished() {
                    return Err(TunnelError::new(
                        TunnelErrorCode::RuleRunning,
                        "此规则已在启动或运行中。",
                    ));
                }
                inner.active.remove(&rule.id);
            }
        }

        self.mutate_runtime(&rule, |runtime| {
            runtime.state = TunnelState::Starting;
            runtime.session_id = Some(session_id.to_owned());
            runtime.local_address = None;
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
        })
        .await;

        let address = SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            rule.local_port.try_into().map_err(|_| {
                TunnelError::new(TunnelErrorCode::InvalidRule, "本地端口超出有效范围。")
            })?,
        );
        let listener = match TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                let (code, message) = if error.kind() == std::io::ErrorKind::AddrInUse {
                    (TunnelErrorCode::BindInUse, "本地端口已被其他程序占用。")
                } else {
                    (
                        TunnelErrorCode::BindFailed,
                        "无法监听本机端口，请检查系统权限和端口状态。",
                    )
                };
                self.mutate_runtime(&rule, |runtime| {
                    runtime.state = TunnelState::Error;
                    runtime.session_id = None;
                    runtime.last_error_code = Some(code);
                    runtime.last_error_message = Some(message.to_owned());
                })
                .await;
                append_tunnel_event(
                    &self.inner,
                    &rule.id,
                    &rule.profile_id,
                    TunnelProtocol::LocalTcp,
                    code,
                    message,
                )
                .await;
                return Err(TunnelError::new(code, message));
            }
        };
        let local_address = match listener.local_addr() {
            Ok(address) => address,
            Err(_) => {
                self.mutate_runtime(&rule, |runtime| {
                    runtime.state = TunnelState::Error;
                    runtime.session_id = None;
                    runtime.last_error_code = Some(TunnelErrorCode::BindFailed);
                    runtime.last_error_message = Some("无法读取本地监听地址。".to_owned());
                })
                .await;
                append_tunnel_event(
                    &self.inner,
                    &rule.id,
                    &rule.profile_id,
                    TunnelProtocol::LocalTcp,
                    TunnelErrorCode::BindFailed,
                    "无法读取本地监听地址。",
                )
                .await;
                return Err(TunnelError::new(
                    TunnelErrorCode::BindFailed,
                    "无法读取本地监听地址。",
                ));
            }
        };

        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let task_rule = rule.clone();
        let task_session_id = session_id.to_owned();
        let task_sessions = Arc::clone(&sessions);
        let task_inner = Arc::clone(&self.inner);
        let task_sink = Arc::clone(&self.sink);
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return;
            }
            run_listener(
                listener,
                task_rule,
                task_session_id,
                task_sessions,
                termination,
                task_cancellation,
                task_inner,
                task_sink,
            )
            .await;
        });

        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner.runtimes.entry(rule.id.clone()).or_insert_with(|| {
                ForwardRuntime::stopped(rule.id.clone(), rule.profile_id.clone())
            });
            runtime.state = TunnelState::Running;
            runtime.session_id = Some(session_id.to_owned());
            runtime.local_address = Some(local_address.to_string());
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
            runtime.updated_at = now_millis();
            let runtime = runtime.clone();
            inner.active.insert(
                rule.id.clone(),
                ActiveForward {
                    profile_id: rule.profile_id.clone(),
                    session_id: session_id.to_owned(),
                    cancellation,
                    task,
                },
            );
            runtime
        };
        (self.sink)(runtime.clone());
        let _ = start_tx.send(());
        Ok(runtime)
    }

    pub async fn start_socks5(
        &self,
        rule: &Socks5Rule,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<Socks5Runtime, TunnelError> {
        let _operation = self.operations.lock().await;
        self.start_socks5_locked(rule, session_id, sessions).await
    }

    pub async fn start_socks5_loaded(
        &self,
        load_rule: impl FnOnce() -> Result<Socks5Rule, TunnelError>,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<Socks5Runtime, TunnelError> {
        let _operation = self.operations.lock().await;
        let rule = load_rule()?;
        self.start_socks5_locked(&rule, session_id, sessions).await
    }

    async fn start_socks5_locked(
        &self,
        rule: &Socks5Rule,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<Socks5Runtime, TunnelError> {
        let mut rule = rule.clone();
        rule.validate_and_normalize()?;
        let binding = sessions.security_binding(session_id).await.map_err(|_| {
            TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话不存在或尚未完成主机指纹验证和身份认证。",
            )
        })?;
        if binding.summary.state != SshState::Connected {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话尚未连接。",
            ));
        }
        if binding.summary.profile_id != rule.profile_id {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionProfileMismatch,
                "此 SSH 会话不属于该 SOCKS5 规则绑定的服务器配置。",
            ));
        }
        let termination = sessions
            .termination_receiver(session_id)
            .await
            .map_err(|_| TunnelError::new(TunnelErrorCode::SessionMissing, "SSH 会话已关闭。"))?;
        if *termination.borrow() != SessionTermination::Running {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话已断开，请重新连接后手动启动 SOCKS5。",
            ));
        }

        {
            let mut inner = self.inner.lock().await;
            if let Some(active) = inner.active_socks5.get(&rule.id) {
                if !active.task.is_finished() {
                    return Err(TunnelError::new(
                        TunnelErrorCode::RuleRunning,
                        "此 SOCKS5 规则已在启动或运行中。",
                    ));
                }
                inner.active_socks5.remove(&rule.id);
            }
        }

        self.mutate_socks5_runtime(&rule, |runtime| {
            runtime.state = TunnelState::Starting;
            runtime.session_id = Some(session_id.to_owned());
            runtime.local_address = None;
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
        })
        .await;

        let address = SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            rule.local_port.try_into().map_err(|_| {
                TunnelError::new(TunnelErrorCode::InvalidRule, "本地端口超出有效范围。")
            })?,
        );
        let listener = match TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                let (code, message) = if error.kind() == std::io::ErrorKind::AddrInUse {
                    (TunnelErrorCode::BindInUse, "本地端口已被其他程序占用。")
                } else {
                    (
                        TunnelErrorCode::BindFailed,
                        "无法监听本机端口，请检查系统权限和端口状态。",
                    )
                };
                self.mutate_socks5_runtime(&rule, |runtime| {
                    runtime.state = TunnelState::Error;
                    runtime.session_id = None;
                    runtime.last_error_code = Some(code);
                    runtime.last_error_message = Some(message.to_owned());
                })
                .await;
                append_tunnel_event(
                    &self.inner,
                    &rule.id,
                    &rule.profile_id,
                    TunnelProtocol::Socks5,
                    code,
                    message,
                )
                .await;
                return Err(TunnelError::new(code, message));
            }
        };
        let local_address = match listener.local_addr() {
            Ok(address) => address,
            Err(_) => {
                self.mutate_socks5_runtime(&rule, |runtime| {
                    runtime.state = TunnelState::Error;
                    runtime.session_id = None;
                    runtime.last_error_code = Some(TunnelErrorCode::BindFailed);
                    runtime.last_error_message = Some("无法读取本地监听地址。".to_owned());
                })
                .await;
                append_tunnel_event(
                    &self.inner,
                    &rule.id,
                    &rule.profile_id,
                    TunnelProtocol::Socks5,
                    TunnelErrorCode::BindFailed,
                    "无法读取本地监听地址。",
                )
                .await;
                return Err(TunnelError::new(
                    TunnelErrorCode::BindFailed,
                    "无法读取本地监听地址。",
                ));
            }
        };

        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let task_rule = rule.clone();
        let task_session_id = session_id.to_owned();
        let task_sessions = Arc::clone(&sessions);
        let task_inner = Arc::clone(&self.inner);
        let task_sink = Arc::clone(&self.socks5_sink);
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return;
            }
            run_socks5_listener(
                listener,
                task_rule,
                task_session_id,
                task_sessions,
                termination,
                task_cancellation,
                task_inner,
                task_sink,
            )
            .await;
        });

        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner
                .socks5_runtimes
                .entry(rule.id.clone())
                .or_insert_with(|| {
                    Socks5Runtime::stopped(rule.id.clone(), rule.profile_id.clone())
                });
            runtime.state = TunnelState::Running;
            runtime.session_id = Some(session_id.to_owned());
            runtime.local_address = Some(local_address.to_string());
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
            runtime.updated_at = now_millis();
            let runtime = runtime.clone();
            inner.active_socks5.insert(
                rule.id.clone(),
                ActiveSocks5 {
                    profile_id: rule.profile_id.clone(),
                    session_id: session_id.to_owned(),
                    cancellation,
                    task,
                },
            );
            runtime
        };
        (self.socks5_sink)(runtime.clone());
        let _ = start_tx.send(());
        Ok(runtime)
    }

    pub async fn stop_socks5(&self, rule_id: &str) -> Result<Socks5Runtime, TunnelError> {
        let _operation = self.operations.lock().await;
        self.stop_socks5_locked(rule_id).await
    }

    async fn stop_socks5_locked(&self, rule_id: &str) -> Result<Socks5Runtime, TunnelError> {
        let (forward, stopping_runtime) = {
            let mut inner = self.inner.lock().await;
            let forward = inner.active_socks5.remove(rule_id);
            if let Some(runtime) = inner.socks5_runtimes.get_mut(rule_id) {
                runtime.state = TunnelState::Stopping;
                runtime.updated_at = now_millis();
                (forward, Some(runtime.clone()))
            } else {
                (forward, None)
            }
        };
        if let Some(runtime) = stopping_runtime {
            (self.socks5_sink)(runtime);
        }

        if let Some(forward) = forward {
            forward.cancellation.cancel();
            let mut task = forward.task;
            if timeout(STOP_TIMEOUT, &mut task).await.is_err() {
                task.abort();
                let _ = timeout(Duration::from_secs(1), &mut task).await;
            }
        }

        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner.socks5_runtimes.get_mut(rule_id).ok_or_else(|| {
                TunnelError::new(TunnelErrorCode::InvalidRule, "找不到 SOCKS5 规则。")
            })?;
            runtime.state = TunnelState::Stopped;
            runtime.session_id = None;
            runtime.local_address = None;
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
            runtime.updated_at = now_millis();
            runtime.clone()
        };
        (self.socks5_sink)(runtime.clone());
        Ok(runtime)
    }

    pub async fn stop(&self, rule_id: &str) -> Result<ForwardRuntime, TunnelError> {
        let _operation = self.operations.lock().await;
        self.stop_locked(rule_id).await
    }

    async fn stop_locked(&self, rule_id: &str) -> Result<ForwardRuntime, TunnelError> {
        let (forward, stopping_runtime) = {
            let mut inner = self.inner.lock().await;
            let forward = inner.active.remove(rule_id);
            if let Some(runtime) = inner.runtimes.get_mut(rule_id) {
                runtime.state = TunnelState::Stopping;
                runtime.updated_at = now_millis();
                (forward, Some(runtime.clone()))
            } else {
                (forward, None)
            }
        };
        if let Some(runtime) = stopping_runtime {
            (self.sink)(runtime);
        }

        if let Some(forward) = forward {
            forward.cancellation.cancel();
            let mut task = forward.task;
            if timeout(STOP_TIMEOUT, &mut task).await.is_err() {
                task.abort();
                let _ = timeout(Duration::from_secs(1), &mut task).await;
            }
        }

        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner.runtimes.get_mut(rule_id).ok_or_else(|| {
                TunnelError::new(TunnelErrorCode::InvalidRule, "找不到端口转发规则。")
            })?;
            runtime.state = TunnelState::Stopped;
            runtime.session_id = None;
            runtime.local_address = None;
            runtime.active_connections = 0;
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
            runtime.last_error_code = None;
            runtime.last_error_message = None;
            runtime.updated_at = now_millis();
            runtime.clone()
        };
        (self.sink)(runtime.clone());
        Ok(runtime)
    }

    pub async fn stop_session(&self, session_id: &str) {
        let _operation = self.operations.lock().await;
        let (forward_ids, socks5_ids): (Vec<String>, Vec<String>) = {
            let inner = self.inner.lock().await;
            (
                inner
                    .active
                    .iter()
                    .filter(|(_, forward)| forward.session_id == session_id)
                    .map(|(rule_id, _)| rule_id.clone())
                    .collect(),
                inner
                    .active_socks5
                    .iter()
                    .filter(|(_, forward)| forward.session_id == session_id)
                    .map(|(rule_id, _)| rule_id.clone())
                    .collect(),
            )
        };
        for rule_id in forward_ids {
            let _ = self.stop_locked(&rule_id).await;
        }
        for rule_id in socks5_ids {
            let _ = self.stop_socks5_locked(&rule_id).await;
        }
    }

    pub async fn stop_profile(&self, profile_id: &str) {
        let _operation = self.operations.lock().await;
        self.stop_profile_locked(profile_id).await;
    }

    async fn stop_profile_locked(&self, profile_id: &str) {
        let (forward_ids, socks5_ids): (Vec<String>, Vec<String>) = {
            let inner = self.inner.lock().await;
            (
                inner
                    .active
                    .iter()
                    .filter(|(_, forward)| forward.profile_id == profile_id)
                    .map(|(rule_id, _)| rule_id.clone())
                    .collect(),
                inner
                    .active_socks5
                    .iter()
                    .filter(|(_, forward)| forward.profile_id == profile_id)
                    .map(|(rule_id, _)| rule_id.clone())
                    .collect(),
            )
        };
        for rule_id in forward_ids {
            let _ = self.stop_locked(&rule_id).await;
        }
        for rule_id in socks5_ids {
            let _ = self.stop_socks5_locked(&rule_id).await;
        }
    }

    pub async fn shutdown_all(&self) {
        let _operation = self.operations.lock().await;
        let (forward_ids, socks5_ids) = {
            let inner = self.inner.lock().await;
            (
                inner.active.keys().cloned().collect::<Vec<_>>(),
                inner.active_socks5.keys().cloned().collect::<Vec<_>>(),
            )
        };
        for rule_id in forward_ids {
            let _ = self.stop_locked(&rule_id).await;
        }
        for rule_id in socks5_ids {
            let _ = self.stop_socks5_locked(&rule_id).await;
        }
    }

    pub async fn ensure_stopped(&self, rule_id: &str) -> Result<(), TunnelError> {
        let _operation = self.operations.lock().await;
        self.ensure_stopped_locked(rule_id).await
    }

    async fn ensure_stopped_locked(&self, rule_id: &str) -> Result<(), TunnelError> {
        let inner = self.inner.lock().await;
        if inner
            .active
            .get(rule_id)
            .is_some_and(|active| !active.task.is_finished())
        {
            return Err(TunnelError::new(
                TunnelErrorCode::RuleRunning,
                "请先停止此端口转发，再修改或删除规则。",
            ));
        }
        Ok(())
    }

    pub async fn with_socks5_rule_stopped<T>(
        &self,
        rule_id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operations.lock().await;
        self.ensure_socks5_stopped_locked(rule_id)
            .await
            .map_err(|error| error.message)?;
        action()
    }

    async fn ensure_socks5_stopped_locked(&self, rule_id: &str) -> Result<(), TunnelError> {
        let inner = self.inner.lock().await;
        if inner
            .active_socks5
            .get(rule_id)
            .is_some_and(|active| !active.task.is_finished())
        {
            return Err(TunnelError::new(
                TunnelErrorCode::RuleRunning,
                "请先停止 SOCKS5 规则，再修改或删除。",
            ));
        }
        Ok(())
    }

    pub async fn forget_rule(&self, rule_id: &str) -> Result<(), TunnelError> {
        let _operation = self.operations.lock().await;
        self.ensure_stopped_locked(rule_id).await?;
        let mut inner = self.inner.lock().await;
        inner.active.remove(rule_id);
        inner.runtimes.remove(rule_id);
        inner.last_target_checks.remove(rule_id);
        Ok(())
    }

    pub async fn delete_socks5_rule_if_stopped(
        &self,
        rule_id: &str,
        delete: impl FnOnce() -> Result<bool, String>,
    ) -> Result<bool, String> {
        let _operation = self.operations.lock().await;
        self.ensure_socks5_stopped_locked(rule_id)
            .await
            .map_err(|error| error.message)?;
        let deleted = delete()?;
        if deleted {
            let mut inner = self.inner.lock().await;
            inner.active_socks5.remove(rule_id);
            inner.socks5_runtimes.remove(rule_id);
            inner.last_target_checks.remove(rule_id);
        }
        Ok(deleted)
    }

    pub async fn forget_profile(&self, profile_id: &str) {
        let _operation = self.operations.lock().await;
        self.stop_profile_locked(profile_id).await;
        self.forget_profile_locked(profile_id).await;
    }

    async fn forget_profile_locked(&self, profile_id: &str) {
        let mut inner = self.inner.lock().await;
        inner
            .runtimes
            .retain(|_, runtime| runtime.profile_id != profile_id);
        inner
            .active
            .retain(|_, forward| forward.profile_id != profile_id);
        inner
            .socks5_runtimes
            .retain(|_, runtime| runtime.profile_id != profile_id);
        inner
            .active_socks5
            .retain(|_, forward| forward.profile_id != profile_id);
        inner
            .last_target_checks
            .retain(|_, check| check.profile_id != profile_id);
    }

    pub async fn with_rule_stopped<T>(
        &self,
        rule_id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operations.lock().await;
        self.ensure_stopped_locked(rule_id)
            .await
            .map_err(|error| error.message)?;
        action()
    }

    pub async fn delete_rule_if_stopped(
        &self,
        rule_id: &str,
        delete: impl FnOnce() -> Result<bool, String>,
    ) -> Result<bool, String> {
        let _operation = self.operations.lock().await;
        self.ensure_stopped_locked(rule_id)
            .await
            .map_err(|error| error.message)?;
        let deleted = delete()?;
        if deleted {
            let mut inner = self.inner.lock().await;
            inner.active.remove(rule_id);
            inner.runtimes.remove(rule_id);
            inner.last_target_checks.remove(rule_id);
        }
        Ok(deleted)
    }

    pub async fn delete_profile_and_stop_tunnels(
        &self,
        profile_id: &str,
        delete: impl FnOnce() -> Result<bool, String>,
    ) -> Result<bool, String> {
        let _operation = self.operations.lock().await;
        self.stop_profile_locked(profile_id).await;
        let deleted = delete()?;
        if deleted {
            self.forget_profile_locked(profile_id).await;
        }
        Ok(deleted)
    }

    pub async fn runtime_list(&self) -> Vec<ForwardRuntime> {
        let mut runtimes: Vec<_> = self.inner.lock().await.runtimes.values().cloned().collect();
        runtimes.sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
        runtimes
    }

    pub async fn socks5_runtime_list(&self) -> Vec<Socks5Runtime> {
        let mut runtimes: Vec<_> = self
            .inner
            .lock()
            .await
            .socks5_runtimes
            .values()
            .cloned()
            .collect();
        runtimes.sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
        runtimes
    }

    pub async fn event_history(&self) -> Vec<TunnelEvent> {
        self.inner
            .lock()
            .await
            .events
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    pub async fn last_target_check(
        &self,
        rule_id: &str,
        session_id: &str,
    ) -> Option<TcpCheckResult> {
        self.inner
            .lock()
            .await
            .last_target_checks
            .get(rule_id)
            .filter(|check| check.session_id == session_id)
            .cloned()
    }

    pub async fn check_tcp_target(
        &self,
        rule: &ForwardRule,
        session_id: &str,
        sessions: Arc<SessionManager>,
    ) -> Result<TcpCheckResult, TunnelError> {
        let mut rule = rule.clone();
        rule.validate_and_normalize()?;
        let binding = sessions.security_binding(session_id).await.map_err(|_| {
            TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话不存在或尚未完成主机指纹验证和身份认证。",
            )
        })?;
        if binding.summary.state != SshState::Connected {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话尚未连接。",
            ));
        }
        if binding.summary.profile_id != rule.profile_id {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionProfileMismatch,
                "所选 SSH 会话不属于此 TCP 检查规则绑定的服务器。",
            ));
        }
        let termination = sessions
            .termination_receiver(session_id)
            .await
            .map_err(|_| TunnelError::new(TunnelErrorCode::SessionMissing, "SSH 会话已关闭。"))?;
        if *termination.borrow() != SessionTermination::Running {
            return Err(TunnelError::new(
                TunnelErrorCode::SessionMissing,
                "SSH 会话已断开，无法检查远端 TCP 目标。",
            ));
        }

        let started = tokio::time::Instant::now();
        let check = timeout(
            CHANNEL_OPEN_TIMEOUT,
            sessions.open_direct_tcpip(
                session_id,
                &rule.target_host,
                rule.target_port,
                "127.0.0.1",
                0,
            ),
        )
        .await;
        let (reachable, elapsed_ms, error_code) = match check {
            Ok(Ok(stream)) => {
                drop(stream);
                (true, Some(started.elapsed().as_millis() as u64), None)
            }
            Err(_) => (false, None, Some(TunnelErrorCode::TargetUnreachable)),
            Ok(Err(error)) => {
                let code = match error.code {
                    SshErrorCode::SessionClosed | SshErrorCode::ServerClosed => {
                        TunnelErrorCode::ConnectionLost
                    }
                    _ => TunnelErrorCode::RemoteRejected,
                };
                (false, None, Some(code))
            }
        };
        let result = TcpCheckResult {
            rule_id: rule.id,
            profile_id: rule.profile_id,
            session_id: session_id.to_owned(),
            target_host: rule.target_host,
            target_port: rule.target_port,
            reachable,
            elapsed_ms,
            checked_at: now_millis(),
            error_code,
        };
        self.inner
            .lock()
            .await
            .last_target_checks
            .insert(result.rule_id.clone(), result.clone());
        Ok(result)
    }

    async fn mutate_socks5_runtime(
        &self,
        rule: &Socks5Rule,
        change: impl FnOnce(&mut Socks5Runtime),
    ) -> Socks5Runtime {
        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner
                .socks5_runtimes
                .entry(rule.id.clone())
                .or_insert_with(|| {
                    Socks5Runtime::stopped(rule.id.clone(), rule.profile_id.clone())
                });
            runtime.profile_id = rule.profile_id.clone();
            change(runtime);
            runtime.updated_at = now_millis();
            runtime.clone()
        };
        (self.socks5_sink)(runtime.clone());
        runtime
    }

    async fn mutate_runtime(
        &self,
        rule: &ForwardRule,
        change: impl FnOnce(&mut ForwardRuntime),
    ) -> ForwardRuntime {
        let runtime = {
            let mut inner = self.inner.lock().await;
            let runtime = inner.runtimes.entry(rule.id.clone()).or_insert_with(|| {
                ForwardRuntime::stopped(rule.id.clone(), rule.profile_id.clone())
            });
            runtime.profile_id = rule.profile_id.clone();
            change(runtime);
            runtime.updated_at = now_millis();
            runtime.clone()
        };
        (self.sink)(runtime.clone());
        runtime
    }
}

async fn copy_counted<R, W>(
    reader: &mut R,
    writer: &mut W,
    counter: &AtomicU64,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut buffer = [0_u8; 16 * 1024];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            writer.shutdown().await?;
            return Ok(total);
        }
        writer.write_all(&buffer[..read]).await?;
        let read = read as u64;
        total = total.saturating_add(read);
        counter.fetch_add(read, Ordering::Relaxed);
    }
}

async fn copy_bidirectional_counted<L, R>(
    local_stream: &mut L,
    remote_stream: &mut R,
    traffic: &TrafficCounters,
) -> std::io::Result<(u64, u64)>
where
    L: AsyncRead + AsyncWrite + Unpin + ?Sized,
    R: AsyncRead + AsyncWrite + Unpin + ?Sized,
{
    let (mut local_read, mut local_write) = tokio::io::split(local_stream);
    let (mut remote_read, mut remote_write) = tokio::io::split(remote_stream);
    tokio::try_join!(
        copy_counted(&mut local_read, &mut remote_write, &traffic.from_local),
        copy_counted(&mut remote_read, &mut local_write, &traffic.to_local),
    )
}

fn bytes_per_second(bytes: u64, elapsed: Duration) -> u64 {
    let millis = elapsed.as_millis().max(1).min(u64::MAX as u128) as u64;
    bytes.saturating_mul(1000) / millis
}

async fn sync_forward_traffic(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    traffic: &TrafficCounters,
    state: &mut TrafficSyncState,
    elapsed: Duration,
    stopped: bool,
) {
    sync_forward_totals(inner, sink, rule, traffic, &mut state.reported).await;
    if stopped {
        mutate_shared_runtime(inner, sink, rule, |runtime| {
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
        })
        .await;
        state.sampled = traffic.snapshot();
        return;
    }
    let current = traffic.snapshot();
    let from_local = current.0.saturating_sub(state.sampled.0);
    let to_local = current.1.saturating_sub(state.sampled.1);
    mutate_shared_runtime(inner, sink, rule, |runtime| {
        runtime.bytes_per_second_from_local = bytes_per_second(from_local, elapsed);
        runtime.bytes_per_second_to_local = bytes_per_second(to_local, elapsed);
    })
    .await;
    state.sampled = current;
}

async fn sync_forward_totals(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    traffic: &TrafficCounters,
    reported: &mut (u64, u64),
) {
    let current = traffic.snapshot();
    let from_local = current.0.saturating_sub(reported.0);
    let to_local = current.1.saturating_sub(reported.1);
    if from_local > 0 || to_local > 0 {
        mutate_shared_runtime(inner, sink, rule, |runtime| {
            let total_from_local = runtime.bytes_from_local.parse::<u64>().unwrap_or_default();
            let total_to_local = runtime.bytes_to_local.parse::<u64>().unwrap_or_default();
            runtime.bytes_from_local = total_from_local.saturating_add(from_local).to_string();
            runtime.bytes_to_local = total_to_local.saturating_add(to_local).to_string();
        })
        .await;
    }
    *reported = current;
}

async fn sync_socks5_traffic(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
    traffic: &TrafficCounters,
    state: &mut TrafficSyncState,
    elapsed: Duration,
    stopped: bool,
) {
    sync_socks5_totals(inner, sink, rule, traffic, &mut state.reported).await;
    if stopped {
        mutate_shared_socks5_runtime(inner, sink, rule, |runtime| {
            runtime.bytes_per_second_from_local = 0;
            runtime.bytes_per_second_to_local = 0;
        })
        .await;
        state.sampled = traffic.snapshot();
        return;
    }
    let current = traffic.snapshot();
    let from_local = current.0.saturating_sub(state.sampled.0);
    let to_local = current.1.saturating_sub(state.sampled.1);
    mutate_shared_socks5_runtime(inner, sink, rule, |runtime| {
        runtime.bytes_per_second_from_local = bytes_per_second(from_local, elapsed);
        runtime.bytes_per_second_to_local = bytes_per_second(to_local, elapsed);
    })
    .await;
    state.sampled = current;
}

async fn sync_socks5_totals(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
    traffic: &TrafficCounters,
    reported: &mut (u64, u64),
) {
    let current = traffic.snapshot();
    let from_local = current.0.saturating_sub(reported.0);
    let to_local = current.1.saturating_sub(reported.1);
    if from_local > 0 || to_local > 0 {
        mutate_shared_socks5_runtime(inner, sink, rule, |runtime| {
            let total_from_local = runtime.bytes_from_local.parse::<u64>().unwrap_or_default();
            let total_to_local = runtime.bytes_to_local.parse::<u64>().unwrap_or_default();
            runtime.bytes_from_local = total_from_local.saturating_add(from_local).to_string();
            runtime.bytes_to_local = total_to_local.saturating_add(to_local).to_string();
        })
        .await;
    }
    *reported = current;
}

fn push_tunnel_event(
    inner: &mut TunnelInner,
    rule_id: &str,
    profile_id: &str,
    protocol: TunnelProtocol,
    code: TunnelErrorCode,
    message: &str,
) {
    inner.events.push_back(TunnelEvent {
        id: uuid::Uuid::new_v4().to_string(),
        rule_id: rule_id.to_owned(),
        profile_id: profile_id.to_owned(),
        protocol,
        occurred_at: now_millis(),
        code,
        message: message.to_owned(),
    });
    while inner.events.len() > MAX_TUNNEL_EVENTS {
        inner.events.pop_front();
    }
}

async fn append_tunnel_event(
    inner: &Arc<Mutex<TunnelInner>>,
    rule_id: &str,
    profile_id: &str,
    protocol: TunnelProtocol,
    code: TunnelErrorCode,
    message: &str,
) {
    let mut inner = inner.lock().await;
    push_tunnel_event(&mut inner, rule_id, profile_id, protocol, code, message);
}

#[allow(clippy::too_many_arguments)]
async fn run_listener(
    listener: TcpListener,
    rule: ForwardRule,
    session_id: String,
    sessions: Arc<SessionManager>,
    mut termination: watch::Receiver<SessionTermination>,
    cancellation: CancellationToken,
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<RuntimeSink>,
) {
    let permits = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
    let mut connections = JoinSet::new();
    let traffic = Arc::new(TrafficCounters::default());
    let mut traffic_state = TrafficSyncState::default();
    let mut last_sample = tokio::time::Instant::now();
    let mut sample = tokio::time::interval_at(
        last_sample + RUNTIME_SAMPLE_INTERVAL,
        RUNTIME_SAMPLE_INTERVAL,
    );
    sample.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut lost_session = false;
    let mut accept_error = false;

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = sample.tick() => {
                let now = tokio::time::Instant::now();
                sync_forward_traffic(&inner, &sink, &rule, &traffic, &mut traffic_state, now - last_sample, false).await;
                last_sample = now;
            }
            changed = termination.changed() => {
                if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                    lost_session = true;
                    cancellation.cancel();
                    break;
                }
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                sync_forward_totals(&inner, &sink, &rule, &traffic, &mut traffic_state.reported).await;
                if result.is_err() {
                    set_runtime_error(&inner, &sink, &rule, TunnelErrorCode::Internal, "一条本地转发连接异常结束。".to_owned()).await;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((local_stream, peer)) => {
                        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                            drop(local_stream);
                            continue;
                        };
                        connections.spawn(forward_one_connection(
                            local_stream,
                            peer,
                            rule.clone(),
                            session_id.clone(),
                            Arc::clone(&sessions),
                            cancellation.child_token(),
                            Arc::clone(&inner),
                            Arc::clone(&sink),
                            Arc::clone(&traffic),
                            permit,
                        ));
                    }
                    Err(_) => {
                        accept_error = true;
                        cancellation.cancel();
                        break;
                    }
                }
            }
        }
    }

    cancellation.cancel();
    if timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    sync_forward_traffic(
        &inner,
        &sink,
        &rule,
        &traffic,
        &mut traffic_state,
        tokio::time::Instant::now() - last_sample,
        true,
    )
    .await;

    let (state, error_code, error_message) = if lost_session {
        (
            TunnelState::Stopped,
            Some(TunnelErrorCode::ConnectionLost),
            Some("SSH 会话已断开，端口转发已停止；重连后需要手动重新启动。".to_owned()),
        )
    } else if accept_error {
        (
            TunnelState::Error,
            Some(TunnelErrorCode::BindFailed),
            Some("本地监听意外结束；请重新启动此转发规则。".to_owned()),
        )
    } else {
        (TunnelState::Stopped, None, None)
    };
    if let (Some(code), Some(message)) = (error_code, error_message.as_deref()) {
        append_tunnel_event(
            &inner,
            &rule.id,
            &rule.profile_id,
            TunnelProtocol::LocalTcp,
            code,
            message,
        )
        .await;
    }
    mutate_shared_runtime(&inner, &sink, &rule, |runtime| {
        runtime.state = state;
        runtime.session_id = None;
        runtime.local_address = None;
        runtime.active_connections = 0;
        runtime.bytes_per_second_from_local = 0;
        runtime.bytes_per_second_to_local = 0;
        runtime.last_error_code = error_code;
        runtime.last_error_message = error_message;
        runtime.updated_at = now_millis();
    })
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_socks5_listener(
    listener: TcpListener,
    rule: Socks5Rule,
    session_id: String,
    sessions: Arc<SessionManager>,
    mut termination: watch::Receiver<SessionTermination>,
    cancellation: CancellationToken,
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<Socks5RuntimeSink>,
) {
    let permits = Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS));
    let mut connections = JoinSet::new();
    let traffic = Arc::new(TrafficCounters::default());
    let mut traffic_state = TrafficSyncState::default();
    let mut last_sample = tokio::time::Instant::now();
    let mut sample = tokio::time::interval_at(
        last_sample + RUNTIME_SAMPLE_INTERVAL,
        RUNTIME_SAMPLE_INTERVAL,
    );
    sample.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut lost_session = false;
    let mut accept_error = false;

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = sample.tick() => {
                let now = tokio::time::Instant::now();
                sync_socks5_traffic(&inner, &sink, &rule, &traffic, &mut traffic_state, now - last_sample, false).await;
                last_sample = now;
            }
            changed = termination.changed() => {
                if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                    lost_session = true;
                    cancellation.cancel();
                    break;
                }
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                sync_socks5_totals(&inner, &sink, &rule, &traffic, &mut traffic_state.reported).await;
                if result.is_err() {
                    set_socks5_runtime_error(&inner, &sink, &rule, TunnelErrorCode::Internal,
                        "一条 SOCKS5 本地连接异常结束。".to_owned()).await;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((local_stream, peer)) => {
                        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                            drop(local_stream);
                            continue;
                        };
                        connections.spawn(serve_socks5_client(
                            local_stream,
                            peer,
                            rule.clone(),
                            session_id.clone(),
                            Arc::clone(&sessions),
                            cancellation.child_token(),
                            Arc::clone(&inner),
                            Arc::clone(&sink),
                            Arc::clone(&traffic),
                            permit,
                        ));
                    }
                    Err(_) => {
                        accept_error = true;
                        cancellation.cancel();
                        break;
                    }
                }
            }
        }
    }

    cancellation.cancel();
    if timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    sync_socks5_traffic(
        &inner,
        &sink,
        &rule,
        &traffic,
        &mut traffic_state,
        tokio::time::Instant::now() - last_sample,
        true,
    )
    .await;

    let (state, error_code, error_message) = if lost_session {
        (
            TunnelState::Stopped,
            Some(TunnelErrorCode::ConnectionLost),
            Some("SSH 会话已断开，SOCKS5 监听已停止；重连后需要手动重新启动。".to_owned()),
        )
    } else if accept_error {
        (
            TunnelState::Error,
            Some(TunnelErrorCode::BindFailed),
            Some("SOCKS5 本地监听意外结束；请重新启动此规则。".to_owned()),
        )
    } else {
        (TunnelState::Stopped, None, None)
    };
    if let (Some(code), Some(message)) = (error_code, error_message.as_deref()) {
        append_tunnel_event(
            &inner,
            &rule.id,
            &rule.profile_id,
            TunnelProtocol::Socks5,
            code,
            message,
        )
        .await;
    }
    mutate_shared_socks5_runtime(&inner, &sink, &rule, |runtime| {
        runtime.state = state;
        runtime.session_id = None;
        runtime.local_address = None;
        runtime.active_connections = 0;
        runtime.bytes_per_second_from_local = 0;
        runtime.bytes_per_second_to_local = 0;
        runtime.last_error_code = error_code;
        runtime.last_error_message = error_message;
        runtime.updated_at = now_millis();
    })
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn serve_socks5_client(
    mut local_stream: TcpStream,
    peer: SocketAddr,
    rule: Socks5Rule,
    session_id: String,
    sessions: Arc<SessionManager>,
    cancellation: CancellationToken,
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<Socks5RuntimeSink>,
    traffic: Arc<TrafficCounters>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let counted = serve_socks5_client_inner(
        &mut local_stream,
        peer,
        &rule,
        &session_id,
        &sessions,
        cancellation,
        &inner,
        &sink,
        &traffic,
    )
    .await;
    if counted {
        decrement_socks5_connections(&inner, &sink, &rule).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve_socks5_client_inner(
    local_stream: &mut TcpStream,
    peer: SocketAddr,
    rule: &Socks5Rule,
    session_id: &str,
    sessions: &SessionManager,
    cancellation: CancellationToken,
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    traffic: &TrafficCounters,
) -> bool {
    let target = tokio::select! {
        _ = cancellation.cancelled() => return false,
        result = timeout(SOCKS5_HANDSHAKE_TIMEOUT, read_connect_request(local_stream)) => {
            match result {
                Ok(Ok(target)) => target,
                Ok(Err(RequestError::NoAcceptableMethods)) => return false,
                Ok(Err(RequestError::Reply(reply))) => {
                    let _ = timeout(Duration::from_secs(1), write_reply(local_stream, reply)).await;
                    return false;
                }
                Err(_) => {
                    let _ = timeout(Duration::from_secs(1), write_reply(local_stream, REP_GENERAL_FAILURE)).await;
                    return false;
                }
            }
        }
    };

    let origin_host = peer.ip().to_string();
    let origin_port = u32::from(peer.port());
    let mut remote_stream = tokio::select! {
        _ = cancellation.cancelled() => return false,
        result = timeout(
            CHANNEL_OPEN_TIMEOUT,
            sessions.open_direct_tcpip(
                session_id,
                &target.host,
                u32::from(target.port),
                &origin_host,
                origin_port,
            ),
        ) => match result {
            Err(_) => {
                set_socks5_runtime_error(inner, sink, rule, TunnelErrorCode::TargetUnreachable,
                    format!("SOCKS5 远端目标 {}:{} 连接超时。", target.host, target.port)).await;
                let _ = write_reply(local_stream, REP_HOST_UNREACHABLE).await;
                return false;
            }
            Ok(Err(error)) => {
                let (code, reply, message) = match error.code {
                    SshErrorCode::SessionClosed | SshErrorCode::ServerClosed => (
                        TunnelErrorCode::ConnectionLost,
                        REP_NETWORK_UNREACHABLE,
                        "SSH 会话已断开，无法建立 SOCKS5 目标通道。",
                    ),
                    _ => (
                        TunnelErrorCode::RemoteRejected,
                        REP_CONNECTION_REFUSED,
                        "SSH 服务端拒绝建立 SOCKS5 远端 TCP 通道。",
                    ),
                };
                set_socks5_runtime_error(inner, sink, rule, code, message.to_owned()).await;
                let _ = write_reply(local_stream, reply).await;
                return false;
            }
            Ok(Ok(stream)) => stream,
        }
    };

    increment_socks5_connections(inner, sink, rule, 1).await;
    if write_reply(local_stream, REP_SUCCEEDED).await.is_err() {
        return true;
    }
    tokio::select! {
        _ = cancellation.cancelled() => {},
        _ = copy_bidirectional_counted(local_stream, &mut remote_stream, traffic) => {},
    }
    true
}

#[allow(clippy::too_many_arguments)]
async fn forward_one_connection(
    mut local_stream: TcpStream,
    peer: SocketAddr,
    rule: ForwardRule,
    session_id: String,
    sessions: Arc<SessionManager>,
    cancellation: CancellationToken,
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<RuntimeSink>,
    traffic: Arc<TrafficCounters>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let origin_host = peer.ip().to_string();
    let origin_port = u32::from(peer.port());
    let target_port = rule.target_port;
    let mut remote_stream: ChannelStream<russh::client::Msg> = tokio::select! {
        _ = cancellation.cancelled() => return,
        result = timeout(
            CHANNEL_OPEN_TIMEOUT,
            sessions.open_direct_tcpip(
                &session_id,
                &rule.target_host,
                target_port,
                &origin_host,
                origin_port,
            ),
        ) => match result {
            Err(_) => {
                set_runtime_error(&inner, &sink, &rule, TunnelErrorCode::TargetUnreachable, "连接远端目标超时；本地监听仍保持运行。".to_owned()).await;
                return;
            }
            Ok(Err(error)) => {
                let code = match error.code {
                    SshErrorCode::SessionClosed | SshErrorCode::ServerClosed => TunnelErrorCode::ConnectionLost,
                    _ => TunnelErrorCode::RemoteRejected,
                };
                let message = if code == TunnelErrorCode::ConnectionLost {
                    "SSH 会话已断开；端口转发正在停止。"
                } else {
                    "SSH 服务端拒绝建立远端 TCP 通道；本地监听仍保持运行。"
                };
                set_runtime_error(&inner, &sink, &rule, code, message.to_owned()).await;
                return;
            }
            Ok(Ok(stream)) => stream,
        }
    };

    increment_connections(&inner, &sink, &rule, 1).await;
    let copy_result = tokio::select! {
        _ = cancellation.cancelled() => None,
        result = copy_bidirectional_counted(&mut local_stream, &mut remote_stream, &traffic) => Some(result),
    };
    let _ = copy_result;
    decrement_connections(&inner, &sink, &rule).await;
}

async fn increment_connections(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    difference: u32,
) {
    mutate_shared_runtime(inner, sink, rule, |runtime| {
        runtime.active_connections = runtime.active_connections.saturating_add(difference);
    })
    .await;
}

async fn decrement_connections(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
) {
    mutate_shared_runtime(inner, sink, rule, |runtime| {
        runtime.active_connections = runtime.active_connections.saturating_sub(1);
    })
    .await;
}

async fn set_runtime_error(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    code: TunnelErrorCode,
    message: String,
) {
    let runtime = {
        let mut inner = inner.lock().await;
        let runtime = inner
            .runtimes
            .entry(rule.id.clone())
            .or_insert_with(|| ForwardRuntime::stopped(rule.id.clone(), rule.profile_id.clone()));
        runtime.last_error_code = Some(code);
        runtime.last_error_message = Some(message.clone());
        runtime.updated_at = now_millis();
        let runtime = runtime.clone();
        push_tunnel_event(
            &mut inner,
            &rule.id,
            &rule.profile_id,
            TunnelProtocol::LocalTcp,
            code,
            &message,
        );
        runtime
    };
    (sink)(runtime);
}

async fn mutate_shared_runtime(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    change: impl FnOnce(&mut ForwardRuntime),
) {
    let runtime = {
        let mut inner = inner.lock().await;
        let runtime = inner
            .runtimes
            .entry(rule.id.clone())
            .or_insert_with(|| ForwardRuntime::stopped(rule.id.clone(), rule.profile_id.clone()));
        change(runtime);
        runtime.updated_at = now_millis();
        runtime.clone()
    };
    (sink)(runtime);
}

async fn increment_socks5_connections(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
    difference: u32,
) {
    mutate_shared_socks5_runtime(inner, sink, rule, |runtime| {
        runtime.active_connections = runtime.active_connections.saturating_add(difference);
    })
    .await;
}

async fn decrement_socks5_connections(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
) {
    mutate_shared_socks5_runtime(inner, sink, rule, |runtime| {
        runtime.active_connections = runtime.active_connections.saturating_sub(1);
    })
    .await;
}

async fn set_socks5_runtime_error(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
    code: TunnelErrorCode,
    message: String,
) {
    let runtime = {
        let mut inner = inner.lock().await;
        let runtime = inner
            .socks5_runtimes
            .entry(rule.id.clone())
            .or_insert_with(|| Socks5Runtime::stopped(rule.id.clone(), rule.profile_id.clone()));
        runtime.last_error_code = Some(code);
        runtime.last_error_message = Some(message.clone());
        runtime.updated_at = now_millis();
        let runtime = runtime.clone();
        push_tunnel_event(
            &mut inner,
            &rule.id,
            &rule.profile_id,
            TunnelProtocol::Socks5,
            code,
            &message,
        );
        runtime
    };
    (sink)(runtime);
}

async fn mutate_shared_socks5_runtime(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<Socks5RuntimeSink>,
    rule: &Socks5Rule,
    change: impl FnOnce(&mut Socks5Runtime),
) {
    let runtime = {
        let mut inner = inner.lock().await;
        let runtime = inner
            .socks5_runtimes
            .entry(rule.id.clone())
            .or_insert_with(|| Socks5Runtime::stopped(rule.id.clone(), rule.profile_id.clone()));
        change(runtime);
        runtime.updated_at = now_millis();
        runtime.clone()
    };
    (sink)(runtime);
}

#[cfg(test)]
mod tests {
    use super::{MAX_TUNNEL_EVENTS, TunnelManager, append_tunnel_event};
    use crate::tunnels::models::{ForwardRule, TunnelError, TunnelErrorCode, TunnelProtocol};
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::{sync::oneshot, time::timeout};

    fn rule() -> ForwardRule {
        ForwardRule {
            id: "rule-1".to_owned(),
            profile_id: "profile-1".to_owned(),
            name: "测试".to_owned(),
            group_name: String::new(),
            local_host: "127.0.0.1".to_owned(),
            local_port: 34567,
            target_host: "127.0.0.1".to_owned(),
            target_port: 3306,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn rejects_unverified_or_cross_profile_sessions_before_binding() {
        let manager = TunnelManager::default();
        let error = manager
            .start(
                &rule(),
                "missing-session",
                std::sync::Arc::new(crate::ssh::SessionManager::new(
                    std::sync::Arc::new(crate::ssh::RusshBackend),
                    std::sync::Arc::new(
                        crate::ssh::HostKeyStore::load(
                            std::env::temp_dir().join("termvista-no-session-hosts.json"),
                        )
                        .unwrap(),
                    ),
                )),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, TunnelErrorCode::SessionMissing);
    }

    #[tokio::test]
    async fn tunnel_event_history_is_newest_first_and_bounded() {
        let manager = TunnelManager::default();
        for index in 0..110 {
            append_tunnel_event(
                &manager.inner,
                &format!("rule-{index}"),
                "profile",
                TunnelProtocol::LocalTcp,
                TunnelErrorCode::RemoteRejected,
                "remote channel rejected",
            )
            .await;
        }
        let events = manager.event_history().await;
        assert_eq!(events.len(), MAX_TUNNEL_EVENTS);
        assert_eq!(events[0].rule_id, "rule-109");
        assert_eq!(events.last().unwrap().rule_id, "rule-10");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_loaded_serializes_rule_read_with_deletion() {
        let manager = Arc::new(TunnelManager::default());
        let stored_rule = Arc::new(Mutex::new(Some(rule())));
        let (loaded_tx, loaded_rx) = oneshot::channel();
        let (continue_load_tx, continue_load_rx) = std::sync::mpsc::channel();
        let continue_load_rx = Mutex::new(continue_load_rx);
        let start_manager = Arc::clone(&manager);
        let start_store = Arc::clone(&stored_rule);
        let sessions = Arc::new(crate::ssh::SessionManager::new(
            Arc::new(crate::ssh::RusshBackend),
            Arc::new(
                crate::ssh::HostKeyStore::load(std::env::temp_dir().join(format!(
                    "termvista-no-session-hosts-{}.json",
                    uuid::Uuid::new_v4()
                )))
                .unwrap(),
            ),
        ));

        let start = tokio::spawn(async move {
            start_manager
                .start_loaded(
                    || {
                        let stored_rule = start_store.lock().unwrap().clone();
                        let _ = loaded_tx.send(());
                        continue_load_rx.lock().unwrap().recv().unwrap();
                        stored_rule.ok_or_else(|| {
                            TunnelError::new(TunnelErrorCode::InvalidRule, "规则已删除。")
                        })
                    },
                    "missing-session",
                    sessions,
                )
                .await
        });
        loaded_rx.await.unwrap();

        let (delete_waiting_tx, delete_waiting_rx) = oneshot::channel();
        let delete_manager = Arc::clone(&manager);
        let delete_store = Arc::clone(&stored_rule);
        let mut delete = tokio::spawn(async move {
            let _ = delete_waiting_tx.send(());
            delete_manager
                .delete_rule_if_stopped("rule-1", || {
                    delete_store.lock().unwrap().take();
                    Ok(true)
                })
                .await
        });
        delete_waiting_rx.await.unwrap();
        assert!(
            timeout(Duration::from_millis(50), &mut delete)
                .await
                .is_err()
        );

        continue_load_tx.send(()).unwrap();
        let start_error = start.await.unwrap().unwrap_err();
        assert_eq!(start_error.code, TunnelErrorCode::SessionMissing);
        assert!(delete.await.unwrap().unwrap());
        assert!(stored_rule.lock().unwrap().is_none());
    }
}
