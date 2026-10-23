use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use russh::ChannelStream;
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::ssh::{SessionManager, SessionTermination, SshErrorCode, SshState};

use super::models::{
    ForwardRule, ForwardRuntime, TunnelError, TunnelErrorCode, TunnelState, now_millis,
};

const MAX_ACTIVE_CONNECTIONS: usize = 64;
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(12);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

type RuntimeSink = dyn Fn(ForwardRuntime) + Send + Sync + 'static;

struct ActiveForward {
    profile_id: String,
    session_id: String,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct TunnelInner {
    runtimes: HashMap<String, ForwardRuntime>,
    active: HashMap<String, ActiveForward>,
}

pub struct TunnelManager {
    inner: Arc<Mutex<TunnelInner>>,
    sink: Arc<RuntimeSink>,
    operations: Mutex<()>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new(|_| {})
    }
}

impl TunnelManager {
    pub fn new(sink: impl Fn(ForwardRuntime) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TunnelInner::default())),
            sink: Arc::new(sink),
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
        let ids: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .active
                .iter()
                .filter(|(_, forward)| forward.session_id == session_id)
                .map(|(rule_id, _)| rule_id.clone())
                .collect()
        };
        for rule_id in ids {
            let _ = self.stop_locked(&rule_id).await;
        }
    }

    pub async fn stop_profile(&self, profile_id: &str) {
        let _operation = self.operations.lock().await;
        self.stop_profile_locked(profile_id).await;
    }

    async fn stop_profile_locked(&self, profile_id: &str) {
        let ids: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .active
                .iter()
                .filter(|(_, forward)| forward.profile_id == profile_id)
                .map(|(rule_id, _)| rule_id.clone())
                .collect()
        };
        for rule_id in ids {
            let _ = self.stop_locked(&rule_id).await;
        }
    }

    pub async fn shutdown_all(&self) {
        let _operation = self.operations.lock().await;
        let ids: Vec<String> = self.inner.lock().await.active.keys().cloned().collect();
        for rule_id in ids {
            let _ = self.stop_locked(&rule_id).await;
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

    pub async fn forget_rule(&self, rule_id: &str) -> Result<(), TunnelError> {
        let _operation = self.operations.lock().await;
        self.ensure_stopped_locked(rule_id).await?;
        let mut inner = self.inner.lock().await;
        inner.active.remove(rule_id);
        inner.runtimes.remove(rule_id);
        Ok(())
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
    let mut lost_session = false;
    let mut accept_error = false;

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            changed = termination.changed() => {
                if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                    lost_session = true;
                    cancellation.cancel();
                    break;
                }
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
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
                        increment_connections(&inner, &sink, &rule, 1).await;
                        connections.spawn(forward_one_connection(
                            local_stream,
                            peer,
                            rule.clone(),
                            session_id.clone(),
                            Arc::clone(&sessions),
                            cancellation.child_token(),
                            Arc::clone(&inner),
                            Arc::clone(&sink),
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
    mutate_shared_runtime(&inner, &sink, &rule, |runtime| {
        runtime.state = state;
        runtime.session_id = None;
        runtime.local_address = None;
        runtime.active_connections = 0;
        runtime.last_error_code = error_code;
        runtime.last_error_message = error_message;
        runtime.updated_at = now_millis();
    })
    .await;
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
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let origin_host = peer.ip().to_string();
    let origin_port = u32::from(peer.port());
    let target_port = rule.target_port;
    let mut remote_stream: ChannelStream<russh::client::Msg> = tokio::select! {
        _ = cancellation.cancelled() => {
            decrement_connections(&inner, &sink, &rule).await;
            return;
        }
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
                decrement_connections(&inner, &sink, &rule).await;
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
                decrement_connections(&inner, &sink, &rule).await;
                return;
            }
            Ok(Ok(stream)) => stream,
        }
    };

    let copy_result = tokio::select! {
        _ = cancellation.cancelled() => None,
        result = copy_bidirectional(&mut local_stream, &mut remote_stream) => Some(result),
    };
    if let Some(Ok((from_local, to_local))) = copy_result {
        add_transferred_bytes(&inner, &sink, &rule, from_local, to_local).await;
    }
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

async fn add_transferred_bytes(
    inner: &Arc<Mutex<TunnelInner>>,
    sink: &Arc<RuntimeSink>,
    rule: &ForwardRule,
    from_local: u64,
    to_local: u64,
) {
    mutate_shared_runtime(inner, sink, rule, |runtime| {
        let current_from_local = runtime.bytes_from_local.parse::<u64>().unwrap_or_default();
        let current_to_local = runtime.bytes_to_local.parse::<u64>().unwrap_or_default();
        runtime.bytes_from_local = current_from_local.saturating_add(from_local).to_string();
        runtime.bytes_to_local = current_to_local.saturating_add(to_local).to_string();
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
    mutate_shared_runtime(inner, sink, rule, |runtime| {
        runtime.last_error_code = Some(code);
        runtime.last_error_message = Some(message);
    })
    .await;
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

#[cfg(test)]
mod tests {
    use super::TunnelManager;
    use crate::tunnels::models::{ForwardRule, TunnelError, TunnelErrorCode};
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
