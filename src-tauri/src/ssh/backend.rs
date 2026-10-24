use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};
use tokio_util::sync::CancellationToken;

const MAX_UNACKNOWLEDGED_OUTPUT: usize = 1024 * 1024;

pub struct OutputFlow {
    in_flight: AsyncMutex<usize>,
    space_available: Notify,
}

impl Default for OutputFlow {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputFlow {
    pub fn new() -> Self {
        Self {
            in_flight: AsyncMutex::new(0),
            space_available: Notify::new(),
        }
    }

    async fn reserve(&self, bytes: usize) -> Result<(), SshError> {
        if bytes > MAX_UNACKNOWLEDGED_OUTPUT {
            return Err(SshError::new(
                SshErrorCode::InputTooLarge,
                "单个 SSH 输出块超过终端缓冲上限。",
            ));
        }
        loop {
            let notified = self.space_available.notified();
            {
                let mut in_flight = self.in_flight.lock().await;
                if *in_flight + bytes <= MAX_UNACKNOWLEDGED_OUTPUT {
                    *in_flight += bytes;
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    pub async fn acknowledge(&self, bytes: usize) {
        let mut in_flight = self.in_flight.lock().await;
        *in_flight = in_flight.saturating_sub(bytes);
        drop(in_flight);
        self.space_available.notify_waiters();
    }
}

#[cfg(test)]
mod output_flow_tests {
    use super::{MAX_UNACKNOWLEDGED_OUTPUT, OutputFlow};
    use std::sync::Arc;

    #[tokio::test]
    async fn output_waits_for_frontend_ack_at_the_memory_limit() {
        let flow = Arc::new(OutputFlow::new());
        flow.reserve(MAX_UNACKNOWLEDGED_OUTPUT).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), flow.reserve(1))
                .await
                .is_err()
        );
        flow.acknowledge(1).await;
        flow.reserve(1).await.unwrap();
    }
}

use super::{
    AuthPromptEvent, HostKeyChallenge, HostKeyStore, SessionSummary, SshAuth, SshConnectRequest,
    SshError, SshErrorCode, SshState, SshStatusEvent, TerminalSize,
    session_manager::AttemptControl,
};

#[derive(Clone)]
pub struct SshEvents {
    attempt_id: String,
    session_id: String,
    state: Arc<std::sync::Mutex<SshState>>,
    pub output_flow: Arc<OutputFlow>,
    pub on_data: Channel<InvokeResponseBody>,
    pub on_status: Channel<SshStatusEvent>,
    pub on_host_key: Channel<HostKeyChallenge>,
    pub on_auth_prompt: Channel<AuthPromptEvent>,
}

impl SshEvents {
    pub fn new(
        attempt_id: String,
        session_id: String,
        on_data: Channel<InvokeResponseBody>,
        on_status: Channel<SshStatusEvent>,
        on_host_key: Channel<HostKeyChallenge>,
        on_auth_prompt: Channel<AuthPromptEvent>,
        output_flow: Arc<OutputFlow>,
    ) -> Self {
        Self {
            attempt_id,
            session_id,
            state: Arc::new(std::sync::Mutex::new(SshState::Connecting)),
            output_flow,
            on_data,
            on_status,
            on_host_key,
            on_auth_prompt,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub async fn send_data(&self, bytes: Vec<u8>) -> Result<(), SshError> {
        let byte_count = bytes.len();
        self.output_flow.reserve(byte_count).await?;
        if self.on_data.send(InvokeResponseBody::Raw(bytes)).is_err() {
            self.output_flow.acknowledge(byte_count).await;
            return Err(SshError::new(
                SshErrorCode::SessionClosed,
                "终端视图已关闭，SSH 输出已停止。",
            ));
        }
        Ok(())
    }

    pub fn send_host_key(&self, challenge: HostKeyChallenge) -> Result<(), SshError> {
        self.on_host_key.send(challenge).map_err(|_| {
            SshError::new(
                SshErrorCode::HostKeyRejected,
                "主机密钥确认窗口已关闭，连接已拒绝。",
            )
        })
    }

    pub fn send_auth_prompt(&self, prompt: AuthPromptEvent) -> Result<(), SshError> {
        self.on_auth_prompt.send(prompt).map_err(|_| {
            SshError::new(
                SshErrorCode::AuthFailed,
                "SSH 二次认证窗口已关闭，连接已取消。",
            )
        })
    }

    pub fn send_status(&self, state: SshState, error: Option<SshError>) -> bool {
        let mut current = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state != *current && !current.can_transition_to(state) {
            return false;
        }
        *current = state;
        let event = SshStatusEvent {
            attempt_id: self.attempt_id.clone(),
            session_id: Some(self.session_id.clone()),
            state,
            error,
        };
        let _ = self.on_status.send(event);
        true
    }

    pub fn current_state(&self) -> SshState {
        *self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct SshConnectContext {
    pub request: SshConnectRequest,
    pub session_id: String,
    pub initial_stream: Option<russh::ChannelStream<russh::client::Msg>>,
    pub events: SshEvents,
    pub host_keys: Arc<HostKeyStore>,
    pub attempt: Arc<AttemptControl>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionTermination {
    Running,
    Closed,
    Error(SshError),
}

pub struct BackendSession {
    pub transport: Arc<dyn SshSessionTransport>,
    pub termination: watch::Receiver<SessionTermination>,
}

/// 监控模块允许远端执行的只读命令；前端不能传入任意 Shell 字符串。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReadOnlySessionCommand {
    SystemName,
    Hostname,
    CpuStat,
    MemoryInfo,
    LoadAverage,
    Uptime,
    NetworkInterfaces,
    Processes,
    Filesystems,
    LatencyProbe,
}

/// 诊断专用固定命令目录；参数只能来自后端校验后的枚举或数值。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiagnosticSessionCommand {
    SystemInfo,
    ResourceSnapshot,
    ProcessList {
        sort: ProcessSort,
        limit: u8,
    },
    ServiceInspect {
        service: String,
    },
    ListeningPorts {
        protocol: PortProtocol,
        limit: u8,
        port: Option<u16>,
    },
    RecentLogs {
        service: String,
        lines: u8,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ProcessSort {
    Cpu,
    Memory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum PortProtocol {
    Tcp,
    Udp,
}

impl DiagnosticSessionCommand {
    pub fn command(&self) -> Result<String, SshError> {
        let command = match self {
            Self::SystemInfo => "LC_ALL=C printf 'system='; uname -srm; printf 'hostname='; hostname; printf 'uptime='; uptime".to_owned(),
            Self::ResourceSnapshot => "LC_ALL=C printf '%s\\n' '[meminfo]'; cat /proc/meminfo; printf '%s\\n' '[loadavg]'; cat /proc/loadavg; printf '%s\\n' '[filesystems]'; df -P -k".to_owned(),
            Self::ProcessList { sort, limit } => {
                let key = match sort { ProcessSort::Cpu => "-pcpu", ProcessSort::Memory => "-rss" };
                let limit = (*limit).clamp(1, 30).saturating_add(1);
                format!("LC_ALL=C ps -eo pid=,pcpu=,rss=,comm= --sort={key} | head -n {limit}")
            }
            Self::ServiceInspect { service } => format!(
                "LC_ALL=C systemctl show --no-pager --property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp -- '{service}'"
            ),
            Self::ListeningPorts { protocol, limit, port } => {
                let protocol = match protocol { PortProtocol::Tcp => "-lnt", PortProtocol::Udp => "-lnu" };
                let limit = (*limit).clamp(1, 100).saturating_add(1);
                if let Some(port) = port {
                    format!("LC_ALL=C ss {protocol} | awk 'NR == 1 || $4 ~ /:{port}$/ '")
                } else {
                    format!("LC_ALL=C ss {protocol} | head -n {limit}")
                }
            }
            Self::RecentLogs { service, lines } => format!(
                "LC_ALL=C journalctl --no-pager --output=short-iso --unit='{service}' -n {}",
                (*lines).clamp(1, 100)
            ),
        };
        if let Self::ServiceInspect { service } | Self::RecentLogs { service, .. } = self
            && !valid_systemd_unit(service)
        {
            return Err(SshError::new(
                SshErrorCode::InputTooLarge,
                "服务单位名称无效，诊断命令已拒绝。",
            ));
        }
        Ok(command)
    }
}

fn valid_systemd_unit(service: &str) -> bool {
    !service.is_empty()
        && service.len() <= 128
        && service.as_bytes()[0].is_ascii_alphanumeric()
        && service
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.@-".contains(&byte))
}

impl ReadOnlySessionCommand {
    pub fn command(self) -> &'static str {
        match self {
            Self::SystemName => "LC_ALL=C uname -s",
            Self::Hostname => "LC_ALL=C hostname",
            Self::CpuStat => "LC_ALL=C cat /proc/stat",
            Self::MemoryInfo => "LC_ALL=C cat /proc/meminfo",
            Self::LoadAverage => "LC_ALL=C cat /proc/loadavg",
            Self::Uptime => "LC_ALL=C cat /proc/uptime",
            Self::NetworkInterfaces => "LC_ALL=C cat /proc/net/dev",
            Self::Processes => {
                "LC_ALL=C sh -c 'ticks=$(getconf CLK_TCK 2>/dev/null || printf 100); ps -eo pid=,rss=,comm= --sort=-rss | head -n 50 | while read pid rss command; do IFS= read -r stat < \"/proc/$pid/stat\" || continue; fields=${stat##*) }; set -- $fields; [ \"$#\" -ge 20 ] || continue; shift 11; cpu_ticks=$(( $1 + $2 )); shift 8; start_ticks=$1; printf \"%s %s %s %s %s %s\\n\" \"$pid\" \"$ticks\" \"$cpu_ticks\" \"$start_ticks\" \"$rss\" \"$command\"; done'"
            }
            Self::Filesystems => "LC_ALL=C df -P -k",
            Self::LatencyProbe => "true",
        }
    }
}

#[derive(Debug, Default)]
pub struct ReadOnlyCommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}

#[async_trait]
pub trait SshBackend: Send + Sync {
    async fn connect(&self, context: SshConnectContext) -> Result<BackendSession, SshError>;
}

#[async_trait]
pub trait SshSessionTransport: Send + Sync {
    async fn write(&self, bytes: Vec<u8>) -> Result<(), SshError>;
    async fn resize(&self, size: TerminalSize) -> Result<(), SshError>;
    async fn open_sftp_stream(&self) -> Result<russh::ChannelStream<russh::client::Msg>, SshError>;
    async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u32,
        originator_host: &str,
        originator_port: u32,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, SshError>;
    async fn exec_read_only(
        &self,
        command: ReadOnlySessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError>;
    async fn exec_diagnostic(
        &self,
        command: DiagnosticSessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError>;
    fn host_key_identity(&self) -> Option<super::HostKeyIdentity>;
    async fn disconnect(&self) -> Result<(), SshError>;
}

pub struct SessionRecord {
    pub summary: SessionSummary,
    pub events: SshEvents,
    pub transport: Arc<dyn SshSessionTransport>,
    pub termination: watch::Receiver<SessionTermination>,
}

pub fn connection_timeout() -> Duration {
    Duration::from_secs(20)
}

pub fn invalid_connect_request(request: &SshConnectRequest) -> Option<SshError> {
    if request.jump_profile_id.is_some() != request.jump_session_id.is_some()
        || request
            .jump_profile_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
        || request
            .jump_session_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
    {
        return Some(SshError::new(
            SshErrorCode::JumpHostUnavailable,
            "跳板配置或已验证的跳板会话缺失；为避免绕过跳板，未尝试直连目标机。",
        ));
    }
    if request.host.trim().is_empty() {
        return Some(SshError::new(
            SshErrorCode::ConnectionFailed,
            "主机名不能为空。",
        ));
    }
    if request.username.trim().is_empty() {
        return Some(SshError::new(
            SshErrorCode::AuthFailed,
            "SSH 用户名不能为空。",
        ));
    }
    match &request.auth {
        SshAuth::Password { password } if password.is_empty() => {
            Some(SshError::new(SshErrorCode::AuthFailed, "请输入 SSH 密码。"))
        }
        SshAuth::PrivateKey {
            private_key_path,
            private_key_data,
            ..
        } if private_key_path.trim().is_empty() && private_key_data.is_none() => {
            Some(SshError::new(
                SshErrorCode::PrivateKeyInvalid,
                "请选择受保险库保护的 SSH 密钥或私钥文件路径。",
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod diagnostic_command_tests {
    use super::{DiagnosticSessionCommand, PortProtocol, ProcessSort};

    #[test]
    fn diagnostic_templates_are_fixed_and_only_interpolate_bounded_values() {
        assert_eq!(
            DiagnosticSessionCommand::SystemInfo.command().unwrap(),
            "LC_ALL=C printf 'system='; uname -srm; printf 'hostname='; hostname; printf 'uptime='; uptime"
        );
        let process = DiagnosticSessionCommand::ProcessList {
            sort: ProcessSort::Cpu,
            limit: 30,
        }
        .command()
        .unwrap();
        assert!(process.contains("--sort=-pcpu"));
        assert!(process.ends_with("head -n 31"));
        let port = DiagnosticSessionCommand::ListeningPorts {
            protocol: PortProtocol::Tcp,
            limit: 100,
            port: Some(443),
        }
        .command()
        .unwrap();
        assert!(port.contains("ss -lnt"));
        assert!(port.contains("/:443$/"));
    }

    #[test]
    fn service_names_cannot_inject_remote_shell_fragments() {
        for service in [
            "nginx.service; touch /tmp/compromised",
            "nginx.service\nwhoami",
            "$(id)",
            "-rf",
        ] {
            let command = DiagnosticSessionCommand::RecentLogs {
                service: service.to_owned(),
                lines: 100,
            };
            assert!(command.command().is_err(), "accepted {service:?}");
        }
        let valid = DiagnosticSessionCommand::ServiceInspect {
            service: "nginx.service".to_owned(),
        }
        .command()
        .unwrap();
        assert!(valid.contains("-- 'nginx.service'"));
    }
}
