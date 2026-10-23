use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::{Mutex, oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    AuthPromptEvent, DiagnosticSessionCommand, HostKeyDecision, HostKeyIdentity, HostKeyStore,
    SessionSummary, SshConnectRequest, SshError, SshErrorCode, SshState, TerminalSize,
    backend::{
        BackendSession, OutputFlow, ReadOnlyCommandOutput, ReadOnlySessionCommand, SessionRecord,
        SessionTermination, SshBackend, SshEvents, invalid_connect_request,
    },
};

const MAX_INPUT_BYTES: usize = 32 * 1024;
const HOST_KEY_DECISION_TIMEOUT: Duration = Duration::from_secs(120);
const AUTH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_AUTH_PROMPTS: usize = 16;
const MAX_AUTH_RESPONSE_BYTES: usize = 4096;
const MAX_AUTH_RESPONSES_BYTES: usize = 8192;

pub struct AttemptControl {
    canceled_tx: watch::Sender<bool>,
    decision_tx: std::sync::Mutex<Option<oneshot::Sender<HostKeyDecision>>>,
    auth_response_tx: std::sync::Mutex<Option<PendingAuthResponse>>,
}

struct PendingAuthResponse {
    prompt_id: String,
    expected_count: usize,
    sender: oneshot::Sender<Vec<Zeroizing<String>>>,
}

impl AttemptControl {
    fn new() -> Self {
        let (canceled_tx, _) = watch::channel(false);
        Self {
            canceled_tx,
            decision_tx: std::sync::Mutex::new(None),
            auth_response_tx: std::sync::Mutex::new(None),
        }
    }

    pub fn is_canceled(&self) -> bool {
        *self.canceled_tx.borrow()
    }

    pub async fn canceled(&self) {
        let mut canceled = self.canceled_tx.subscribe();
        if *canceled.borrow() {
            return;
        }
        let _ = canceled.changed().await;
    }

    pub fn register_host_key_decision(
        &self,
    ) -> Result<oneshot::Receiver<HostKeyDecision>, SshError> {
        if self.is_canceled() {
            return Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"));
        }
        let (decision_tx, decision_rx) = oneshot::channel();
        {
            let mut pending = self
                .decision_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if pending.is_some() {
                return Err(SshError::new(
                    SshErrorCode::Internal,
                    "连接尝试已有待处理的主机密钥确认。",
                ));
            }
            *pending = Some(decision_tx);
        }
        Ok(decision_rx)
    }

    pub async fn wait_for_host_key_decision(
        &self,
        decision_rx: oneshot::Receiver<HostKeyDecision>,
    ) -> Result<HostKeyDecision, SshError> {
        let mut canceled = self.canceled_tx.subscribe();
        if *canceled.borrow() {
            self.decision_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            return Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"));
        }
        let result = tokio::select! {
            decision = decision_rx => decision.map_err(|_| SshError::new(
                SshErrorCode::Canceled,
                "主机密钥确认已取消。",
            )),
            changed = canceled.changed() => {
                let _ = changed;
                Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"))
            },
            _ = tokio::time::sleep(HOST_KEY_DECISION_TIMEOUT) => Err(SshError::new(
                SshErrorCode::HostKeyRejected,
                "等待主机密钥确认超时，连接已拒绝。",
            )),
        };
        self.decision_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        result
    }

    fn decide(&self, decision: HostKeyDecision) -> Result<(), SshError> {
        let sender = self
            .decision_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        sender
            .ok_or_else(|| {
                SshError::new(
                    SshErrorCode::SessionNotFound,
                    "当前连接没有等待中的主机密钥确认。",
                )
            })?
            .send(decision)
            .map_err(|_| SshError::new(SshErrorCode::Canceled, "连接尝试已结束。"))
    }

    pub fn register_auth_prompt(
        &self,
        prompt_id: String,
        expected_count: usize,
    ) -> Result<oneshot::Receiver<Vec<Zeroizing<String>>>, SshError> {
        if self.is_canceled() {
            return Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"));
        }
        if expected_count > MAX_AUTH_PROMPTS {
            return Err(SshError::new(
                SshErrorCode::AuthFailed,
                "服务器要求的 SSH 二次认证项目过多，连接已停止。",
            ));
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self
            .auth_response_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.is_some() {
            return Err(SshError::new(
                SshErrorCode::Internal,
                "连接尝试已有待处理的 SSH 二次认证。",
            ));
        }
        *pending = Some(PendingAuthResponse {
            prompt_id,
            expected_count,
            sender,
        });
        Ok(receiver)
    }

    pub async fn wait_for_auth_prompt_response(
        &self,
        receiver: oneshot::Receiver<Vec<Zeroizing<String>>>,
    ) -> Result<Vec<Zeroizing<String>>, SshError> {
        let mut canceled = self.canceled_tx.subscribe();
        if *canceled.borrow() {
            self.auth_response_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            return Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"));
        }
        let result = tokio::select! {
            response = receiver => response.map_err(|_| SshError::new(
                SshErrorCode::Canceled,
                "SSH 二次认证已取消。",
            )),
            changed = canceled.changed() => {
                let _ = changed;
                Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"))
            },
            _ = tokio::time::sleep(AUTH_PROMPT_TIMEOUT) => Err(SshError::new(
                SshErrorCode::AuthPromptTimeout,
                "等待 SSH 二次认证输入超时，连接已取消。",
            )),
        };
        self.auth_response_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        result
    }

    pub fn respond_auth_prompt(
        &self,
        prompt_id: &str,
        responses: Vec<Zeroizing<String>>,
    ) -> Result<(), SshError> {
        let sender = {
            let mut pending = self
                .auth_response_tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(current) = pending.as_ref() else {
                return Err(SshError::new(
                    SshErrorCode::SessionNotFound,
                    "当前连接没有等待中的 SSH 二次认证。",
                ));
            };
            if current.prompt_id != prompt_id {
                return Err(SshError::new(
                    SshErrorCode::SessionNotFound,
                    "SSH 二次认证编号已过期，请重新连接。",
                ));
            }
            if responses.len() != current.expected_count {
                return Err(SshError::new(
                    SshErrorCode::AuthFailed,
                    "二次认证输入数量与服务器提示不匹配。",
                ));
            }
            let total_bytes: usize = responses.iter().map(|value| value.len()).sum();
            if total_bytes > MAX_AUTH_RESPONSES_BYTES
                || responses
                    .iter()
                    .any(|value| value.len() > MAX_AUTH_RESPONSE_BYTES)
            {
                return Err(SshError::new(
                    SshErrorCode::InputTooLarge,
                    "SSH 二次认证输入超过安全长度限制。",
                ));
            }
            pending
                .take()
                .map(|current| current.sender)
                .ok_or_else(|| {
                    SshError::new(SshErrorCode::SessionNotFound, "SSH 二次认证已结束。")
                })?
        };
        sender
            .send(responses)
            .map_err(|_| SshError::new(SshErrorCode::Canceled, "SSH 连接已结束。"))
    }

    fn cancel(&self) {
        self.canceled_tx.send_replace(true);
        self.decision_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        self.auth_response_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }
}

struct ManagerInner {
    sessions: Mutex<HashMap<String, SessionRecord>>,
    output_flows: Mutex<HashMap<String, Arc<OutputFlow>>>,
}

pub struct SessionManager {
    backend: Arc<dyn SshBackend>,
    host_keys: Arc<HostKeyStore>,
    inner: Arc<ManagerInner>,
    attempts: Mutex<HashMap<String, Arc<AttemptControl>>>,
}

#[derive(Clone)]
pub struct SessionSecurityBinding {
    pub summary: SessionSummary,
    pub identity: HostKeyIdentity,
}

impl SessionManager {
    pub fn new(backend: Arc<dyn SshBackend>, host_keys: Arc<HostKeyStore>) -> Self {
        Self {
            backend,
            host_keys,
            inner: Arc::new(ManagerInner {
                sessions: Mutex::new(HashMap::new()),
                output_flows: Mutex::new(HashMap::new()),
            }),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        &self,
        request: SshConnectRequest,
        on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
        on_status: tauri::ipc::Channel<super::SshStatusEvent>,
        on_host_key: tauri::ipc::Channel<super::HostKeyChallenge>,
        on_auth_prompt: tauri::ipc::Channel<AuthPromptEvent>,
    ) -> Result<String, SshError> {
        if let Some(error) = invalid_connect_request(&request) {
            return Err(error);
        }
        let attempt_id = request.attempt_id.clone();
        let profile_id = request.profile_id.clone();
        let host = request.host.clone();
        let port = request.port;
        let username = request.username.clone();
        let session_id = Uuid::new_v4().to_string();
        let output_flow = Arc::new(OutputFlow::new());
        let events = SshEvents::new(
            attempt_id.clone(),
            session_id.clone(),
            on_data,
            on_status,
            on_host_key,
            on_auth_prompt,
            Arc::clone(&output_flow),
        );
        let attempt = Arc::new(AttemptControl::new());
        {
            let mut attempts = self.attempts.lock().await;
            if attempts.contains_key(&attempt_id) {
                return Err(SshError::new(SshErrorCode::Internal, "连接尝试编号重复。"));
            }
            attempts.insert(attempt_id.clone(), Arc::clone(&attempt));
        }
        self.inner
            .output_flows
            .lock()
            .await
            .insert(attempt_id.clone(), output_flow);
        events.send_status(SshState::Connecting, None);

        let result = self
            .backend
            .connect(super::backend::SshConnectContext {
                request,
                session_id: session_id.clone(),
                events: events.clone(),
                host_keys: Arc::clone(&self.host_keys),
                attempt: Arc::clone(&attempt),
            })
            .await;
        self.attempts.lock().await.remove(&attempt_id);

        let BackendSession {
            transport,
            termination,
        } = match result {
            Ok(session) if !attempt.is_canceled() => session,
            Ok(session) => {
                let _ = session.transport.disconnect().await;
                self.inner.output_flows.lock().await.remove(&attempt_id);
                let error = SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。");
                events.send_status(SshState::Canceled, Some(error.clone()));
                return Err(error);
            }
            Err(error) => {
                self.inner.output_flows.lock().await.remove(&attempt_id);
                let state = if error.code == SshErrorCode::Canceled {
                    SshState::Canceled
                } else {
                    SshState::Error
                };
                events.send_status(state, Some(error.clone()));
                return Err(error);
            }
        };

        let summary = SessionSummary {
            session_id: session_id.clone(),
            profile_id,
            host,
            port,
            username,
            state: SshState::Connected,
        };
        let record = SessionRecord {
            summary,
            events: events.clone(),
            transport: Arc::clone(&transport),
            termination: termination.clone(),
        };
        self.inner
            .sessions
            .lock()
            .await
            .insert(session_id.clone(), record);
        events.send_status(SshState::Connected, None);
        self.watch_termination(session_id.clone(), termination);
        Ok(session_id)
    }

    fn watch_termination(
        &self,
        session_id: String,
        mut termination: watch::Receiver<SessionTermination>,
    ) {
        let inner = Arc::downgrade(&self.inner);
        tauri::async_runtime::spawn(async move {
            loop {
                if *termination.borrow_and_update() != SessionTermination::Running {
                    break;
                }
                if termination.changed().await.is_err() {
                    return;
                }
            }
            let ended = termination.borrow_and_update().clone();
            let Some(inner) = inner.upgrade() else {
                return;
            };
            if let Some(record) = inner.sessions.lock().await.remove(&session_id) {
                inner
                    .output_flows
                    .lock()
                    .await
                    .remove(record.events.attempt_id());
                match ended {
                    SessionTermination::Running => {}
                    SessionTermination::Closed => {
                        let error =
                            SshError::new(SshErrorCode::ServerClosed, "SSH 服务器已关闭终端连接。");
                        record.events.send_status(SshState::Error, Some(error));
                    }
                    SessionTermination::Error(error) => {
                        record.events.send_status(SshState::Error, Some(error));
                    }
                }
                let _ = record.transport.disconnect().await;
            }
        });
    }

    pub async fn decide_host_key(
        &self,
        attempt_id: &str,
        decision: HostKeyDecision,
    ) -> Result<(), SshError> {
        let attempt = self.attempts.lock().await.get(attempt_id).cloned();
        attempt
            .ok_or_else(|| {
                SshError::new(SshErrorCode::SessionNotFound, "连接尝试已结束或不存在。")
            })?
            .decide(decision)
    }

    pub async fn auth_response(
        &self,
        attempt_id: &str,
        prompt_id: &str,
        responses: Vec<Zeroizing<String>>,
    ) -> Result<(), SshError> {
        let attempt = self.attempts.lock().await.get(attempt_id).cloned();
        attempt
            .ok_or_else(|| {
                SshError::new(SshErrorCode::SessionNotFound, "找不到等待认证的 SSH 连接。")
            })?
            .respond_auth_prompt(prompt_id, responses)
    }

    pub async fn cancel_connect(&self, attempt_id: &str) -> Result<(), SshError> {
        let attempt = self.attempts.lock().await.get(attempt_id).cloned();
        attempt
            .ok_or_else(|| {
                SshError::new(SshErrorCode::SessionNotFound, "连接尝试已结束或不存在。")
            })?
            .cancel();
        Ok(())
    }

    pub async fn write(&self, session_id: &str, bytes: Vec<u8>) -> Result<(), SshError> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(SshError::new(
                SshErrorCode::InputTooLarge,
                "单次终端输入超过 32 KiB，请分段粘贴。",
            ));
        }
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| Arc::clone(&record.transport))
            .ok_or_else(session_not_found)?;
        session.write(bytes).await
    }

    pub async fn resize(&self, session_id: &str, size: TerminalSize) -> Result<(), SshError> {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| Arc::clone(&record.transport))
            .ok_or_else(session_not_found)?;
        session.resize(size.normalized()).await
    }

    pub async fn open_sftp_stream(
        &self,
        session_id: &str,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, SshError> {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| Arc::clone(&record.transport))
            .ok_or_else(session_not_found)?;
        session.open_sftp_stream().await
    }

    pub async fn open_direct_tcpip(
        &self,
        session_id: &str,
        target_host: &str,
        target_port: u32,
        originator_host: &str,
        originator_port: u32,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, SshError> {
        let session = {
            let sessions = self.inner.sessions.lock().await;
            let record = sessions.get(session_id).ok_or_else(session_not_found)?;
            if record.summary.state != SshState::Connected
                || record.transport.host_key_identity().is_none()
            {
                return Err(SshError::new(
                    SshErrorCode::SessionClosed,
                    "当前 SSH 会话未连接或缺少已验证的主机身份。",
                ));
            }
            Arc::clone(&record.transport)
        };
        session
            .open_direct_tcpip(target_host, target_port, originator_host, originator_port)
            .await
    }

    pub async fn exec_read_only(
        &self,
        session_id: &str,
        command: ReadOnlySessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError> {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| Arc::clone(&record.transport))
            .ok_or_else(session_not_found)?;
        session.exec_read_only(command, cancel).await
    }

    pub async fn exec_diagnostic(
        &self,
        session_id: &str,
        command: DiagnosticSessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError> {
        let session = self
            .inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| Arc::clone(&record.transport))
            .ok_or_else(session_not_found)?;
        session.exec_diagnostic(command, cancel).await
    }

    pub async fn security_binding(
        &self,
        session_id: &str,
    ) -> Result<SessionSecurityBinding, SshError> {
        let sessions = self.inner.sessions.lock().await;
        let record = sessions.get(session_id).ok_or_else(session_not_found)?;
        let identity = record.transport.host_key_identity().ok_or_else(|| {
            SshError::new(
                SshErrorCode::Internal,
                "当前 SSH 会话缺少已验证的服务器公钥身份，已停止诊断。",
            )
        })?;
        Ok(SessionSecurityBinding {
            summary: record.summary.clone(),
            identity,
        })
    }

    pub async fn termination_receiver(
        &self,
        session_id: &str,
    ) -> Result<watch::Receiver<SessionTermination>, SshError> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|record| record.termination.clone())
            .ok_or_else(session_not_found)
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), SshError> {
        let Some(record) = self.inner.sessions.lock().await.remove(session_id) else {
            return Err(session_not_found());
        };
        self.inner
            .output_flows
            .lock()
            .await
            .remove(record.events.attempt_id());
        record.events.send_status(SshState::Disconnecting, None);
        match record.transport.disconnect().await {
            Ok(()) => {
                record.events.send_status(SshState::Disconnected, None);
                Ok(())
            }
            Err(error) => {
                record
                    .events
                    .send_status(SshState::Error, Some(error.clone()));
                Err(error)
            }
        }
    }

    pub async fn sessions(&self) -> Vec<SessionSummary> {
        self.inner
            .sessions
            .lock()
            .await
            .values()
            .map(|record| record.summary.clone())
            .collect()
    }

    pub async fn acknowledge_output(&self, attempt_id: &str, bytes: usize) -> Result<(), SshError> {
        if bytes == 0 || bytes > 1024 * 1024 {
            return Err(SshError::new(
                SshErrorCode::InputTooLarge,
                "终端输出回执长度无效。",
            ));
        }
        let flow = self
            .inner
            .output_flows
            .lock()
            .await
            .get(attempt_id)
            .cloned()
            .ok_or_else(session_not_found)?;
        flow.acknowledge(bytes).await;
        Ok(())
    }

    pub async fn disconnect_all(&self) {
        let attempts = self
            .attempts
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for attempt in attempts {
            attempt.cancel();
        }
        let session_ids = self
            .inner
            .sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.disconnect(&session_id).await;
        }
    }
}

fn session_not_found() -> SshError {
    SshError::new(SshErrorCode::SessionNotFound, "SSH 会话不存在或已经关闭。")
}

#[cfg(test)]
mod tests {
    use super::{AttemptControl, HostKeyDecision};
    use zeroize::Zeroizing;

    #[tokio::test]
    async fn host_key_response_is_registered_before_it_can_be_decided() {
        let attempt = AttemptControl::new();
        let decision = attempt.register_host_key_decision().unwrap();
        attempt.decide(HostKeyDecision::TrustAndSave).unwrap();
        assert_eq!(
            attempt.wait_for_host_key_decision(decision).await.unwrap(),
            HostKeyDecision::TrustAndSave
        );
    }

    #[tokio::test]
    async fn session_only_host_key_decision_is_delivered_to_the_current_attempt() {
        let attempt = AttemptControl::new();
        let decision = attempt.register_host_key_decision().unwrap();
        attempt.decide(HostKeyDecision::TrustOnce).unwrap();
        assert_eq!(
            attempt.wait_for_host_key_decision(decision).await.unwrap(),
            HostKeyDecision::TrustOnce
        );
    }

    #[tokio::test]
    async fn cancel_releases_pending_host_key_wait() {
        let attempt = AttemptControl::new();
        let decision = attempt.register_host_key_decision().unwrap();
        attempt.cancel();
        let error = attempt
            .wait_for_host_key_decision(decision)
            .await
            .unwrap_err();
        assert_eq!(error.code, super::SshErrorCode::Canceled);
    }

    #[tokio::test]
    async fn keyboard_interactive_responses_are_bound_to_the_active_prompt() {
        let attempt = AttemptControl::new();
        let receiver = attempt
            .register_auth_prompt("prompt-1".to_owned(), 2)
            .unwrap();
        assert!(
            attempt
                .respond_auth_prompt("stale-prompt", vec![Zeroizing::new("stale".to_owned())])
                .is_err()
        );
        assert!(
            attempt
                .respond_auth_prompt("prompt-1", vec![Zeroizing::new("one".to_owned())])
                .is_err()
        );
        attempt
            .respond_auth_prompt(
                "prompt-1",
                vec![
                    Zeroizing::new("password".to_owned()),
                    Zeroizing::new("123456".to_owned()),
                ],
            )
            .unwrap();
        let responses = attempt
            .wait_for_auth_prompt_response(receiver)
            .await
            .unwrap();
        assert_eq!(&*responses[0], "password");
        assert_eq!(&*responses[1], "123456");
    }

    #[tokio::test]
    async fn cancel_releases_pending_keyboard_interactive_wait() {
        let attempt = AttemptControl::new();
        let receiver = attempt
            .register_auth_prompt("prompt-2".to_owned(), 1)
            .unwrap();
        attempt.cancel();
        let error = attempt
            .wait_for_auth_prompt_response(receiver)
            .await
            .unwrap_err();
        assert_eq!(error.code, super::SshErrorCode::Canceled);
    }
}
