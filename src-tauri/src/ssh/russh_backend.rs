use std::{
    future::Future,
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use russh::{
    ChannelMsg, Disconnect, Pty,
    client::{self, Handle, Handler},
    keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use tokio::{
    net::TcpStream,
    sync::{Mutex as AsyncMutex, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{timeout, timeout_at},
};
use tokio_util::{either::Either, sync::CancellationToken};
use zeroize::Zeroizing;

use super::{
    AttemptControl, AuthPromptEvent, AuthPromptField, DiagnosticSessionCommand, HostKeyChallenge,
    HostKeyCheck, HostKeyIdentity, HostKeyStore, SshAuth, SshBackend, SshError, SshErrorCode,
    SshErrorDetails, SshEvents, SshSessionTransport, SshState, TerminalSize,
    backend::{
        BackendSession, ReadOnlyCommandOutput, ReadOnlySessionCommand, SessionTermination,
        SshConnectContext, connection_timeout,
    },
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(150);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_AUTH_PROMPTS: usize = 16;
const MAX_AUTH_PROMPT_TEXT_BYTES: usize = 8192;
const MAX_AUTH_PROMPT_FIELD_BYTES: usize = 4096;
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(20);
const SESSION_QUEUE_CAPACITY: usize = 32;
const MAX_MONITOR_STDOUT_BYTES: usize = 128 * 1024;
const MAX_MONITOR_STDERR_BYTES: usize = 16 * 1024;
const MAX_DIAGNOSTIC_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_DIAGNOSTIC_STDERR_BYTES: usize = 4 * 1024;
const DIAGNOSTIC_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const MONITOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_SHELL_PROBE_BYTES: usize = 16 * 1024;
const SHELL_BOOTSTRAP_ECHO_TIMEOUT: Duration = Duration::from_secs(15);

pub struct RusshBackend;

#[async_trait]
impl SshBackend for RusshBackend {
    async fn connect(&self, mut context: SshConnectContext) -> Result<BackendSession, SshError> {
        let socket = if let Some(stream) = context.initial_stream.take() {
            Either::Left(stream)
        } else {
            let socket = match cancelable(
                &context.attempt,
                timeout(
                    connection_timeout(),
                    TcpStream::connect((context.request.host.as_str(), context.request.port)),
                ),
            )
            .await?
            {
                Err(_) => {
                    return Err(SshError::new(
                        SshErrorCode::ConnectionTimeout,
                        "连接服务器超时，请检查地址和网络。",
                    ));
                }
                Ok(Err(error)) => return Err(map_io_error(error)),
                Ok(Ok(socket)) => socket,
            };
            Either::Right(socket)
        };

        let handler_error = Arc::new(Mutex::new(None));
        let host_identity = Arc::new(Mutex::new(None));
        let handler = HostKeyHandler {
            host: context.request.host.clone(),
            port: context.request.port,
            host_keys: Arc::clone(&context.host_keys),
            attempt: Arc::clone(&context.attempt),
            events: context.events.clone(),
            last_error: Arc::clone(&handler_error),
            identity: Arc::clone(&host_identity),
        };
        let client_config = client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            channel_buffer_size: 64,
            ..client::Config::default()
        };
        let mut handle = match cancelable(
            &context.attempt,
            timeout(
                HANDSHAKE_TIMEOUT,
                client::connect_stream(Arc::new(client_config), socket, handler),
            ),
        )
        .await?
        {
            Err(_) => {
                return Err(SshError::new(
                    SshErrorCode::ConnectionTimeout,
                    "SSH 握手或主机密钥确认超时。",
                ));
            }
            Ok(Err(error)) => {
                if let Some(error) = handler_error
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    return Err(error);
                }
                return Err(map_russh_error(
                    error,
                    SshErrorCode::ConnectionFailed,
                    "SSH 握手失败",
                ));
            }
            Ok(Ok(handle)) => handle,
        };

        context.events.send_status(SshState::Authenticating, None);
        match cancelable(&context.attempt, authenticate(&mut handle, &context)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) | Err(error) => {
                disconnect_handle(&mut handle).await;
                return Err(error);
            }
        }
        context.events.send_status(SshState::OpeningPty, None);

        let shell_path = probe_login_shell(&handle, &context.attempt).await;
        if context.attempt.is_canceled() {
            disconnect_handle(&mut handle).await;
            return Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。"));
        }
        let shell_bootstrap = shell_path
            .as_deref()
            .and_then(shell_current_directory_setup);
        let bootstrap_echo = shell_bootstrap.map(|value| value.as_bytes().to_vec());
        let integration_modes = [(Pty::ECHO, 0)];
        let terminal_modes = if shell_path
            .as_deref()
            .is_some_and(shell_bootstrap_disables_echo)
        {
            &integration_modes[..]
        } else {
            &[][..]
        };

        let channel = match cancelable(
            &context.attempt,
            timeout(CHANNEL_TIMEOUT, handle.channel_open_session()),
        )
        .await?
        {
            Err(_) => {
                disconnect_handle(&mut handle).await;
                return Err(SshError::new(
                    SshErrorCode::ConnectionTimeout,
                    "打开 SSH 会话通道超时。",
                ));
            }
            Ok(Err(error)) => {
                disconnect_handle(&mut handle).await;
                return Err(map_russh_error(
                    error,
                    SshErrorCode::ChannelOpenFailed,
                    "无法打开 SSH 会话通道",
                ));
            }
            Ok(Ok(channel)) => channel,
        };

        let size = context.request.initial_size.normalized();
        match cancelable(
            &context.attempt,
            timeout(
                CHANNEL_TIMEOUT,
                channel.request_pty(
                    true,
                    "xterm-256color",
                    size.cols,
                    size.rows,
                    0,
                    0,
                    terminal_modes,
                ),
            ),
        )
        .await?
        {
            Err(_) => {
                disconnect_handle(&mut handle).await;
                return Err(SshError::new(
                    SshErrorCode::PtyRequestFailed,
                    "申请远程 PTY 超时。",
                ));
            }
            Ok(Err(error)) => {
                disconnect_handle(&mut handle).await;
                return Err(map_russh_error(
                    error,
                    SshErrorCode::PtyRequestFailed,
                    "服务器拒绝申请远程 PTY",
                ));
            }
            Ok(Ok(())) => {}
        }
        match cancelable(
            &context.attempt,
            timeout(CHANNEL_TIMEOUT, channel.request_shell(true)),
        )
        .await?
        {
            Err(_) => {
                disconnect_handle(&mut handle).await;
                return Err(SshError::new(
                    SshErrorCode::ShellRequestFailed,
                    "启动远程交互 Shell 超时。",
                ));
            }
            Ok(Err(error)) => {
                disconnect_handle(&mut handle).await;
                return Err(map_russh_error(
                    error,
                    SshErrorCode::ShellRequestFailed,
                    "服务器拒绝启动交互 Shell",
                ));
            }
            Ok(Ok(())) => {}
        }

        if let Some(bootstrap) = shell_bootstrap {
            match timeout(
                CHANNEL_TIMEOUT,
                channel.data_bytes(format!("{bootstrap}\r").into_bytes()),
            )
            .await
            {
                Err(_) => {
                    disconnect_handle(&mut handle).await;
                    return Err(SshError::new(
                        SshErrorCode::ConnectionTimeout,
                        "启用终端目录联动超时。",
                    ));
                }
                Ok(Err(error)) => {
                    disconnect_handle(&mut handle).await;
                    return Err(map_russh_error(
                        error,
                        SshErrorCode::PtyRequestFailed,
                        "启用终端目录联动失败",
                    ));
                }
                Ok(Ok(())) => {}
            }
        }

        let (read_half, write_half) = channel.split();
        let (input_tx, input_rx) = mpsc::channel(SESSION_QUEUE_CAPACITY);
        let (resize_tx, resize_rx) = mpsc::channel(8);
        let (stop_tx, stop_rx) = oneshot::channel();
        let (termination_tx, termination_rx) = watch::channel(SessionTermination::Running);

        let writer_termination = termination_tx.clone();
        let writer_task = tokio::spawn(run_writer(
            write_half,
            input_rx,
            resize_rx,
            stop_rx,
            writer_termination,
        ));
        let reader_termination = termination_tx.clone();
        let events = context.events.clone();
        let reader_task = tokio::spawn(run_reader(
            read_half,
            events,
            termination_rx.clone(),
            reader_termination,
            bootstrap_echo,
        ));

        let transport = Arc::new(RusshSession {
            handle: AsyncMutex::new(Some(handle)),
            host_identity: host_identity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            input_tx,
            resize_tx,
            stop_tx: AsyncMutex::new(Some(stop_tx)),
            reader_task: AsyncMutex::new(Some(reader_task)),
            writer_task: AsyncMutex::new(Some(writer_task)),
            termination_tx,
        });

        Ok(BackendSession {
            transport,
            termination: termination_rx,
        })
    }
}

async fn cancelable<T>(
    attempt: &AttemptControl,
    operation: impl Future<Output = T>,
) -> Result<T, SshError> {
    tokio::select! {
        result = operation => Ok(result),
        _ = attempt.canceled() => Err(SshError::new(SshErrorCode::Canceled, "SSH 连接已取消。")),
    }
}

struct HostKeyHandler {
    host: String,
    port: u16,
    host_keys: Arc<HostKeyStore>,
    attempt: Arc<super::AttemptControl>,
    events: SshEvents,
    last_error: Arc<Mutex<Option<SshError>>>,
    identity: Arc<Mutex<Option<HostKeyIdentity>>>,
}

impl HostKeyHandler {
    fn fail(&self, error: SshError) {
        *self
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
    }
}

fn apply_host_key_decision(
    host_keys: &HostKeyStore,
    host: &str,
    port: u16,
    identity: &HostKeyIdentity,
    decision: super::HostKeyDecision,
) -> Result<bool, SshError> {
    match decision {
        super::HostKeyDecision::TrustOnce => Ok(true),
        super::HostKeyDecision::TrustAndSave => {
            host_keys.trust(host, port, identity)?;
            Ok(true)
        }
        super::HostKeyDecision::Reject => Ok(false),
    }
}

impl Handler for HostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        self.events.send_status(SshState::VerifyingHostKey, None);
        let identity = match HostKeyIdentity::from_server_key(server_key) {
            Ok(identity) => identity,
            Err(error) => {
                self.fail(error);
                return Ok(false);
            }
        };
        *self
            .identity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(identity.clone());

        match self.host_keys.check(&self.host, self.port, &identity) {
            HostKeyCheck::Trusted => Ok(true),
            HostKeyCheck::Mismatch {
                prior_fingerprint,
                current_fingerprint,
                key_type,
            } => {
                if let Err(error) = self.host_keys.remember_mismatch(
                    self.events.attempt_id(),
                    &self.host,
                    self.port,
                    &identity,
                ) {
                    self.fail(error);
                    return Ok(false);
                }
                self.fail(
                    SshError::new(
                        SshErrorCode::HostKeyMismatch,
                        "服务器主机密钥发生变化，连接已停止。请先通过可信渠道核实新指纹。",
                    )
                    .with_details(SshErrorDetails::HostKeyChanged {
                        host: self.host.clone(),
                        port: self.port,
                        key_type,
                        prior_fingerprint,
                        current_fingerprint,
                    }),
                );
                Ok(false)
            }
            HostKeyCheck::Unknown => {
                let decision_rx = match self.attempt.register_host_key_decision() {
                    Ok(receiver) => receiver,
                    Err(error) => {
                        self.fail(error);
                        return Ok(false);
                    }
                };
                let challenge = HostKeyChallenge {
                    attempt_id: self.events.attempt_id().to_owned(),
                    host: self.host.clone(),
                    port: self.port,
                    key_type: identity.key_type.clone(),
                    fingerprint_sha256: identity.fingerprint_sha256.clone(),
                    prior_fingerprint: None,
                };
                if let Err(error) = self.events.send_host_key(challenge) {
                    self.fail(error);
                    return Ok(false);
                }

                match self.attempt.wait_for_host_key_decision(decision_rx).await {
                    Ok(decision) => match apply_host_key_decision(
                        &self.host_keys,
                        &self.host,
                        self.port,
                        &identity,
                        decision,
                    ) {
                        Ok(true) => Ok(true),
                        Ok(false) => {
                            self.fail(SshError::new(
                                SshErrorCode::HostKeyRejected,
                                "你拒绝了该 SSH 主机密钥，本次连接已取消。",
                            ));
                            Ok(false)
                        }
                        Err(error) => {
                            self.fail(error);
                            Ok(false)
                        }
                    },
                    Err(error) => {
                        self.fail(error);
                        Ok(false)
                    }
                }
            }
        }
    }
}

async fn authenticate(
    handle: &mut Handle<HostKeyHandler>,
    context: &SshConnectContext,
) -> Result<(), SshError> {
    let username = context.request.username.clone();
    if matches!(&context.request.auth, SshAuth::KeyboardInteractive) {
        return authenticate_keyboard_interactive(handle, username, context).await;
    }
    let auth_result: client::AuthResult = match &context.request.auth {
        SshAuth::Password { password } => {
            let mut password = Zeroizing::new(password.clone());
            let owned_password = std::mem::take(&mut *password);
            match timeout(
                AUTH_TIMEOUT,
                handle.authenticate_password(username, owned_password),
            )
            .await
            {
                Err(_) => {
                    return Err(SshError::new(
                        SshErrorCode::ConnectionTimeout,
                        "SSH 密码认证超时。",
                    ));
                }
                Ok(Err(error)) => {
                    return Err(map_russh_error(
                        error,
                        SshErrorCode::AuthFailed,
                        "SSH 密码认证失败",
                    ));
                }
                Ok(Ok(result)) => result,
            }
        }
        SshAuth::PrivateKey {
            private_key_path,
            private_key_data,
            passphrase,
            ..
        } => {
            let key_result = if let Some(secret) = private_key_data {
                keys::decode_secret_key(secret, passphrase.as_deref())
            } else {
                let key_path = expand_home(private_key_path);
                keys::load_secret_key(key_path, passphrase.as_deref())
            };
            let key = key_result.map_err(|_| {
                SshError::new(
                    SshErrorCode::PrivateKeyInvalid,
                    "无法读取私钥。请检查文件权限、格式及私钥口令。",
                )
            })?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| {
                    map_russh_error(error, SshErrorCode::AuthFailed, "无法协商私钥签名算法")
                })?
                .flatten();
            match timeout(
                AUTH_TIMEOUT,
                handle.authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                ),
            )
            .await
            {
                Err(_) => {
                    return Err(SshError::new(
                        SshErrorCode::ConnectionTimeout,
                        "SSH 私钥认证超时。",
                    ));
                }
                Ok(Err(error)) => {
                    return Err(map_russh_error(
                        error,
                        SshErrorCode::AuthFailed,
                        "SSH 私钥认证失败",
                    ));
                }
                Ok(Ok(result)) => result,
            }
        }
        SshAuth::KeyboardInteractive => {
            return Err(SshError::new(
                SshErrorCode::AuthFailed,
                "SSH 多重提示认证状态无效。",
            ));
        }
    };

    if auth_result.success() {
        Ok(())
    } else {
        Err(SshError::new(
            SshErrorCode::AuthFailed,
            "SSH 认证失败，请检查用户名、密码或私钥授权。",
        ))
    }
}

async fn authenticate_keyboard_interactive(
    handle: &mut Handle<HostKeyHandler>,
    username: String,
    context: &SshConnectContext,
) -> Result<(), SshError> {
    let mut response = match timeout(
        AUTH_TIMEOUT,
        handle.authenticate_keyboard_interactive_start(username, None::<String>),
    )
    .await
    {
        Err(_) => {
            return Err(SshError::new(
                SshErrorCode::ConnectionTimeout,
                "启动 SSH 多重提示认证超时。",
            ));
        }
        Ok(Err(error)) => {
            return Err(map_russh_error(
                error,
                SshErrorCode::AuthFailed,
                "启动 SSH 多重提示认证失败",
            ));
        }
        Ok(Ok(response)) => response,
    };

    loop {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::new(
                    SshErrorCode::AuthFailed,
                    "SSH 多重提示认证失败，请检查密码、验证码或服务器认证策略。",
                ));
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let prompts_bytes = prompts.iter().fold(0usize, |sum, prompt| {
                    sum.saturating_add(prompt.prompt.len())
                });
                let prompt_text_bytes = name
                    .len()
                    .saturating_add(instructions.len())
                    .saturating_add(prompts_bytes);
                if prompts.len() > MAX_AUTH_PROMPTS
                    || name.len() > MAX_AUTH_PROMPT_FIELD_BYTES
                    || instructions.len() > MAX_AUTH_PROMPT_FIELD_BYTES
                    || prompts
                        .iter()
                        .any(|prompt| prompt.prompt.len() > MAX_AUTH_PROMPT_FIELD_BYTES)
                    || prompt_text_bytes > MAX_AUTH_PROMPT_TEXT_BYTES
                {
                    return Err(SshError::new(
                        SshErrorCode::AuthFailed,
                        "服务器返回的 SSH 认证提示超出安全长度限制。",
                    ));
                }
                if prompts.is_empty() {
                    response = match timeout(
                        AUTH_TIMEOUT,
                        handle.authenticate_keyboard_interactive_respond(Vec::new()),
                    )
                    .await
                    {
                        Err(_) => {
                            return Err(SshError::new(
                                SshErrorCode::ConnectionTimeout,
                                "等待 SSH 多重提示认证继续超时。",
                            ));
                        }
                        Ok(Err(error)) => {
                            return Err(map_russh_error(
                                error,
                                SshErrorCode::AuthFailed,
                                "SSH 多重提示认证继续失败",
                            ));
                        }
                        Ok(Ok(response)) => response,
                    };
                    continue;
                }

                let prompt_id = uuid::Uuid::new_v4().to_string();
                let receiver = context
                    .attempt
                    .register_auth_prompt(prompt_id.clone(), prompts.len())?;
                context.events.send_auth_prompt(AuthPromptEvent {
                    attempt_id: context.request.attempt_id.clone(),
                    prompt_id,
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|prompt| AuthPromptField {
                            prompt: prompt.prompt,
                            echo: prompt.echo,
                        })
                        .collect(),
                })?;
                let responses = context
                    .attempt
                    .wait_for_auth_prompt_response(receiver)
                    .await?
                    .into_iter()
                    .map(|mut response| std::mem::take(&mut *response))
                    .collect();
                response = match timeout(
                    AUTH_TIMEOUT,
                    handle.authenticate_keyboard_interactive_respond(responses),
                )
                .await
                {
                    Err(_) => {
                        return Err(SshError::new(
                            SshErrorCode::ConnectionTimeout,
                            "发送 SSH 多重提示认证响应超时。",
                        ));
                    }
                    Ok(Err(error)) => {
                        return Err(map_russh_error(
                            error,
                            SshErrorCode::AuthFailed,
                            "发送 SSH 多重提示认证响应失败",
                        ));
                    }
                    Ok(Ok(response)) => response,
                };
            }
        }
    }
}

fn expand_home(path: &str) -> PathBuf {
    if (path == "~" || path.starts_with("~/") || path.starts_with("~\\"))
        && let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        let suffix = path.strip_prefix('~').unwrap_or_default();
        return PathBuf::from(home).join(suffix.trim_start_matches(['/', '\\']));
    }
    PathBuf::from(path)
}

struct RusshSession {
    handle: AsyncMutex<Option<Handle<HostKeyHandler>>>,
    host_identity: Option<HostKeyIdentity>,
    input_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<TerminalSize>,
    stop_tx: AsyncMutex<Option<oneshot::Sender<()>>>,
    reader_task: AsyncMutex<Option<JoinHandle<()>>>,
    writer_task: AsyncMutex<Option<JoinHandle<()>>>,
    termination_tx: watch::Sender<SessionTermination>,
}

#[async_trait]
impl SshSessionTransport for RusshSession {
    async fn write(&self, bytes: Vec<u8>) -> Result<(), SshError> {
        self.input_tx
            .send(bytes)
            .await
            .map_err(|_| SshError::new(SshErrorCode::SessionClosed, "SSH 输入通道已关闭。"))
    }

    async fn resize(&self, size: TerminalSize) -> Result<(), SshError> {
        self.resize_tx
            .send(size.normalized())
            .await
            .map_err(|_| SshError::new(SshErrorCode::SessionClosed, "SSH PTY 尺寸通道已关闭。"))
    }

    async fn open_sftp_stream(&self) -> Result<russh::ChannelStream<client::Msg>, SshError> {
        let handle = self.handle.lock().await;
        let handle = handle.as_ref().ok_or_else(|| {
            SshError::new(
                SshErrorCode::SessionClosed,
                "SSH 会话已关闭，无法打开 SFTP。",
            )
        })?;
        let channel = match timeout(CHANNEL_TIMEOUT, handle.channel_open_session()).await {
            Err(_) => {
                return Err(SshError::new(
                    SshErrorCode::ConnectionTimeout,
                    "打开 SFTP SSH 通道超时。",
                ));
            }
            Ok(Err(error)) => {
                return Err(map_russh_error(
                    error,
                    SshErrorCode::ChannelOpenFailed,
                    "打开 SFTP SSH 通道失败",
                ));
            }
            Ok(Ok(channel)) => channel,
        };
        match timeout(CHANNEL_TIMEOUT, channel.request_subsystem(true, "sftp")).await {
            Err(_) => Err(SshError::new(
                SshErrorCode::ConnectionTimeout,
                "等待服务器启动 SFTP 子系统超时。",
            )),
            Ok(Err(error)) => Err(SshError::new(
                SshErrorCode::ChannelOpenFailed,
                format!("服务器未能启动 SFTP 子系统，SSH 终端仍可使用：{error}"),
            )),
            Ok(Ok(())) => Ok(channel.into_stream()),
        }
    }

    async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u32,
        originator_host: &str,
        originator_port: u32,
    ) -> Result<russh::ChannelStream<client::Msg>, SshError> {
        let handle = self.handle.lock().await;
        let handle = handle.as_ref().ok_or_else(|| {
            SshError::new(
                SshErrorCode::SessionClosed,
                "SSH 会话已关闭，无法建立端口转发通道。",
            )
        })?;
        let channel = match timeout(
            CHANNEL_TIMEOUT,
            handle.channel_open_direct_tcpip(
                target_host,
                target_port,
                originator_host,
                originator_port,
            ),
        )
        .await
        {
            Err(_) => {
                return Err(SshError::new(
                    SshErrorCode::ConnectionTimeout,
                    "打开 SSH 远端 TCP 通道超时。",
                ));
            }
            Ok(Err(error)) => {
                return Err(map_russh_error(
                    error,
                    SshErrorCode::ChannelOpenFailed,
                    "SSH 服务端拒绝建立远端 TCP 通道",
                ));
            }
            Ok(Ok(channel)) => channel,
        };
        Ok(channel.into_stream())
    }

    async fn exec_read_only(
        &self,
        command: ReadOnlySessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError> {
        let deadline = tokio::time::Instant::now() + MONITOR_COMMAND_TIMEOUT;
        let mut termination = self.termination_tx.subscribe();
        let mut channel = {
            let handle = self.handle.lock().await;
            let handle = handle.as_ref().ok_or_else(|| {
                SshError::new(
                    SshErrorCode::SessionClosed,
                    "SSH 会话已关闭，无法读取监控信息。",
                )
            })?;
            tokio::select! {
                result = timeout_at(deadline, handle.channel_open_session()) => match result {
                    Err(_) => return Err(SshError::new(SshErrorCode::ConnectionTimeout, "打开监控 SSH 通道超时。")),
                    Ok(Err(error)) => return Err(map_russh_error(error, SshErrorCode::ChannelOpenFailed, "打开监控 SSH 通道失败")),
                    Ok(Ok(channel)) => channel,
                },
                _ = cancel.cancelled() => return Err(SshError::new(SshErrorCode::Canceled, "监控采样已取消。")),
                changed = termination.changed() => {
                    let _ = changed;
                    return Err(SshError::new(SshErrorCode::SessionClosed, "SSH 会话已关闭，监控采样已停止。"));
                }
            }
        };

        let request_result = tokio::select! {
            result = timeout_at(deadline, channel.exec(true, command.command())) => match result {
                Err(_) => Err(SshError::new(SshErrorCode::ConnectionTimeout, "启动只读监控命令超时。")),
                Ok(Err(error)) => Err(map_russh_error(error, SshErrorCode::ChannelOpenFailed, "启动只读监控命令失败")),
                Ok(Ok(())) => Ok(()),
            },
            _ = cancel.cancelled() => Err(SshError::new(SshErrorCode::Canceled, "监控采样已取消。")),
            changed = termination.changed() => {
                let _ = changed;
                Err(SshError::new(SshErrorCode::SessionClosed, "SSH 会话已关闭，监控采样已停止。"))
            }
        };
        if let Err(error) = request_result {
            close_monitor_channel(&channel).await;
            return Err(error);
        }

        let mut output = ReadOnlyCommandOutput::default();
        loop {
            let message = tokio::select! {
                result = timeout_at(deadline, channel.wait()) => match result {
                    Ok(message) => message,
                    Err(_) => {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(SshErrorCode::ConnectionTimeout, "只读监控命令超过 5 秒执行上限。"));
                    }
                },
                _ = cancel.cancelled() => {
                    close_monitor_channel(&channel).await;
                    return Err(SshError::new(SshErrorCode::Canceled, "监控采样已取消。"));
                }
                changed = termination.changed() => {
                    if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(
                            SshErrorCode::SessionClosed,
                            "SSH 会话已关闭，监控采样已停止。",
                        ));
                    }
                    continue;
                }
            };
            match message {
                Some(ChannelMsg::Data { data }) => {
                    if output.stdout.len().saturating_add(data.len()) > MAX_MONITOR_STDOUT_BYTES {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(
                            SshErrorCode::InputTooLarge,
                            "监控命令输出超过 128 KiB 限制。",
                        ));
                    }
                    output.stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if output.stderr.len().saturating_add(data.len()) > MAX_MONITOR_STDERR_BYTES {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(
                            SshErrorCode::InputTooLarge,
                            "监控命令错误输出超过 16 KiB 限制。",
                        ));
                    }
                    output.stderr.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    output.exit_status = Some(exit_status);
                }
                Some(ChannelMsg::Close) | None => break,
                Some(ChannelMsg::Failure) => {
                    close_monitor_channel(&channel).await;
                    return Err(SshError::new(
                        SshErrorCode::ChannelOpenFailed,
                        "服务器拒绝执行只读监控命令。",
                    ));
                }
                Some(_) => {}
            }
        }
        Ok(output)
    }

    async fn exec_diagnostic(
        &self,
        command: DiagnosticSessionCommand,
        cancel: CancellationToken,
    ) -> Result<ReadOnlyCommandOutput, SshError> {
        let deadline = tokio::time::Instant::now() + DIAGNOSTIC_COMMAND_TIMEOUT;
        let mut termination = self.termination_tx.subscribe();
        let mut channel = {
            let handle = self.handle.lock().await;
            let handle = handle.as_ref().ok_or_else(|| {
                SshError::new(
                    SshErrorCode::SessionClosed,
                    "SSH 会话已关闭，无法运行诊断检查。",
                )
            })?;
            tokio::select! {
                result = timeout_at(deadline, handle.channel_open_session()) => match result {
                    Err(_) => return Err(SshError::new(SshErrorCode::ConnectionTimeout, "打开诊断 SSH 通道超时。")),
                    Ok(Err(error)) => return Err(map_russh_error(error, SshErrorCode::ChannelOpenFailed, "打开诊断 SSH 通道失败")),
                    Ok(Ok(channel)) => channel,
                },
                _ = cancel.cancelled() => return Err(SshError::new(SshErrorCode::Canceled, "诊断检查已取消。")),
                changed = termination.changed() => {
                    let _ = changed;
                    return Err(SshError::new(SshErrorCode::SessionClosed, "SSH 会话已关闭，诊断检查已停止。"));
                }
            }
        };
        let command_text = command.command()?;
        let request = tokio::select! {
            result = timeout_at(deadline, channel.exec(true, command_text)) => match result {
                Err(_) => Err(SshError::new(SshErrorCode::ConnectionTimeout, "启动诊断检查超时。")),
                Ok(Err(error)) => Err(map_russh_error(error, SshErrorCode::ChannelOpenFailed, "启动只读诊断检查失败")),
                Ok(Ok(())) => Ok(()),
            },
            _ = cancel.cancelled() => Err(SshError::new(SshErrorCode::Canceled, "诊断检查已取消。")),
            changed = termination.changed() => {
                let _ = changed;
                Err(SshError::new(SshErrorCode::SessionClosed, "SSH 会话已关闭，诊断检查已停止。"))
            }
        };
        if let Err(error) = request {
            close_monitor_channel(&channel).await;
            return Err(error);
        }

        let mut output = ReadOnlyCommandOutput::default();
        loop {
            let message = tokio::select! {
                result = timeout_at(deadline, channel.wait()) => match result {
                    Ok(message) => message,
                    Err(_) => {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(SshErrorCode::ConnectionTimeout, "诊断检查超过 8 秒执行上限。"));
                    }
                },
                _ = cancel.cancelled() => {
                    close_monitor_channel(&channel).await;
                    return Err(SshError::new(SshErrorCode::Canceled, "诊断检查已取消。"));
                },
                changed = termination.changed() => {
                    if changed.is_err() || *termination.borrow_and_update() != SessionTermination::Running {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(SshErrorCode::SessionClosed, "SSH 会话已关闭，诊断检查已停止。"));
                    }
                    continue;
                }
            };
            match message {
                Some(ChannelMsg::Data { data }) => {
                    if output.stdout.len().saturating_add(data.len()) > MAX_DIAGNOSTIC_OUTPUT_BYTES
                    {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(
                            SshErrorCode::InputTooLarge,
                            "单步诊断输出超过 16 KiB 上限。",
                        ));
                    }
                    output.stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if output.stderr.len().saturating_add(data.len()) > MAX_DIAGNOSTIC_STDERR_BYTES
                    {
                        close_monitor_channel(&channel).await;
                        return Err(SshError::new(
                            SshErrorCode::InputTooLarge,
                            "单步诊断错误输出超过 4 KiB 上限。",
                        ));
                    }
                    output.stderr.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    output.exit_status = Some(exit_status)
                }
                Some(ChannelMsg::Close) | None => break,
                Some(ChannelMsg::Failure) => {
                    close_monitor_channel(&channel).await;
                    return Err(SshError::new(
                        SshErrorCode::ChannelOpenFailed,
                        "服务器拒绝执行只读诊断检查。",
                    ));
                }
                Some(_) => {}
            }
        }
        Ok(output)
    }

    fn host_key_identity(&self) -> Option<HostKeyIdentity> {
        self.host_identity.clone()
    }

    async fn disconnect(&self) -> Result<(), SshError> {
        if let Some(stop) = self.stop_tx.lock().await.take() {
            let _ = stop.send(());
        }
        if let Some(handle) = self.handle.lock().await.take() {
            let _ = timeout(
                Duration::from_secs(3),
                handle.disconnect(Disconnect::ByApplication, "", ""),
            )
            .await;
        }
        self.termination_tx.send_replace(SessionTermination::Closed);
        join_task(&self.writer_task).await;
        join_task(&self.reader_task).await;
        Ok(())
    }
}

async fn close_monitor_channel(channel: &russh::Channel<client::Msg>) {
    let _ = timeout(Duration::from_millis(250), channel.close()).await;
}

async fn probe_login_shell(
    handle: &Handle<HostKeyHandler>,
    attempt: &AttemptControl,
) -> Option<String> {
    const MARKER: &str = "__AI_SSH_STUDIO_SHELL__";
    let mut channel = tokio::select! {
        _ = attempt.canceled() => return None,
        result = timeout(SHELL_PROBE_TIMEOUT, handle.channel_open_session()) => result.ok()?.ok()?,
    };
    let deadline = tokio::time::Instant::now() + SHELL_PROBE_TIMEOUT;
    let command = format!("printf '\\n{MARKER}%s\\n' \"${{SHELL:-}}\"");
    let request = tokio::select! {
        _ = attempt.canceled() => None,
        result = timeout_at(deadline, channel.exec(true, command)) => Some(result),
    };
    if !matches!(request, Some(Ok(Ok(())))) {
        close_monitor_channel(&channel).await;
        return None;
    }

    let mut output = Vec::new();
    loop {
        let message = tokio::select! {
            _ = attempt.canceled() => None,
            result = timeout_at(deadline, channel.wait()) => result.ok().flatten(),
        };
        let Some(message) = message else {
            close_monitor_channel(&channel).await;
            return None;
        };
        match message {
            ChannelMsg::Data { data } => {
                if output.len().saturating_add(data.len()) > MAX_SHELL_PROBE_BYTES {
                    close_monitor_channel(&channel).await;
                    return None;
                }
                output.extend_from_slice(&data);
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = channel.close().await;

    let output = String::from_utf8_lossy(&output);
    output
        .rsplit_once(MARKER)
        .and_then(|(_, tail)| tail.lines().next())
        .map(str::trim)
        .filter(|shell| shell.starts_with('/') && shell.len() <= 4096)
        .map(str::to_owned)
}

fn shell_current_directory_setup(shell_path: &str) -> Option<&'static str> {
    let shell_name = shell_path.rsplit('/').next()?.to_ascii_lowercase();
    match shell_name.as_str() {
        "bash" => Some(
            "printf '\\r\\033[2K'; __ai_ssh_studio_emit_cwd(){ printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-localhost}\" \"$PWD\"; }; PROMPT_COMMAND=\"__ai_ssh_studio_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"; __ai_ssh_studio_emit_cwd; stty echo",
        ),
        "zsh" => Some("chpwd(){printf '\\e]7;file://%s\\a' $PWD;}; printf '\\r\\n'"),
        "fish" => Some(
            "printf '\\r\\e[2K'; functions --copy fish_prompt __ai_ssh_studio_original_fish_prompt; function fish_prompt; __ai_ssh_studio_original_fish_prompt; printf '\\e]7;file://%s%s\\a' (hostname) \"$PWD\"; end; stty echo",
        ),
        _ => None,
    }
}

fn shell_bootstrap_disables_echo(shell_path: &str) -> bool {
    matches!(
        shell_path
            .rsplit('/')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("bash" | "fish")
    )
}

async fn join_task(task: &AsyncMutex<Option<JoinHandle<()>>>) {
    if let Some(task) = task.lock().await.take()
        && timeout(Duration::from_secs(3), task).await.is_err()
    {
        // 终端资源回收必须有上限，卡住的远端不会阻塞整个应用退出。
    }
}

async fn run_writer<S>(
    writer: russh::ChannelWriteHalf<S>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<TerminalSize>,
    mut stop_rx: oneshot::Receiver<()>,
    termination: watch::Sender<SessionTermination>,
) where
    S: From<(russh::ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                let _ = writer.eof().await;
                let _ = writer.close().await;
                termination.send_replace(SessionTermination::Closed);
                break;
            }
            data = input_rx.recv() => match data {
                Some(bytes) => {
                    if let Err(error) = writer.data_bytes(bytes).await {
                        termination.send_replace(SessionTermination::Error(map_russh_error(
                            error,
                            SshErrorCode::SessionClosed,
                            "发送终端输入失败",
                        )));
                        break;
                    }
                }
                None => break,
            },
            size = resize_rx.recv() => match size {
                Some(size) => {
                    if let Err(error) = writer.window_change(size.cols, size.rows, 0, 0).await {
                        termination.send_replace(SessionTermination::Error(map_russh_error(
                            error,
                            SshErrorCode::SessionClosed,
                            "调整远程 PTY 尺寸失败",
                        )));
                        break;
                    }
                }
                None => break,
            },
        }
    }
}

async fn run_reader(
    mut reader: russh::ChannelReadHalf,
    events: SshEvents,
    mut termination_rx: watch::Receiver<SessionTermination>,
    termination_tx: watch::Sender<SessionTermination>,
    bootstrap_echo: Option<Vec<u8>>,
) {
    let mut bootstrap_filter = bootstrap_echo.map(BootstrapEchoFilter::new);
    let bootstrap_timeout = tokio::time::sleep(SHELL_BOOTSTRAP_ECHO_TIMEOUT);
    tokio::pin!(bootstrap_timeout);
    loop {
        tokio::select! {
            _ = &mut bootstrap_timeout, if bootstrap_filter.is_some() => {
                let pending = bootstrap_filter.take().map(BootstrapEchoFilter::flush).unwrap_or_default();
                if !pending.is_empty()
                    && let Err(error) = events.send_data(pending).await
                {
                    termination_tx.send_replace(SessionTermination::Error(error));
                    return;
                }
            }
            message = reader.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let visible = if let Some(filter) = bootstrap_filter.as_mut() {
                        let (visible, matched) = filter.strip(&data);
                        if matched {
                            bootstrap_filter = None;
                        }
                        visible
                    } else {
                        data.to_vec()
                    };
                    if visible.is_empty() {
                        continue;
                    }
                    let output = events.send_data(visible);
                    tokio::select! {
                        result = output => {
                            if let Err(error) = result {
                                termination_tx.send_replace(SessionTermination::Error(error));
                                return;
                            }
                        }
                        changed = termination_rx.changed() => {
                            if changed.is_err() || *termination_rx.borrow_and_update() != SessionTermination::Running {
                                return;
                            }
                        }
                    }
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. }) | None => {
                    if let Some(filter) = bootstrap_filter.take() {
                        let pending = filter.flush();
                        if !pending.is_empty()
                            && let Err(error) = events.send_data(pending).await
                        {
                            termination_tx.send_replace(SessionTermination::Error(error));
                            return;
                        }
                    }
                    if *termination_rx.borrow() == SessionTermination::Running {
                        termination_tx.send_replace(SessionTermination::Error(SshError::new(
                            SshErrorCode::ServerClosed,
                            "SSH 服务器已关闭终端连接。",
                        )));
                    }
                    return;
                }
                Some(_) => {}
            },
            changed = termination_rx.changed() => {
                if changed.is_err() || *termination_rx.borrow_and_update() != SessionTermination::Running {
                    return;
                }
            }
        }
    }
}

struct BootstrapEchoFilter {
    marker: &'static [u8],
    pending: Vec<u8>,
}

impl BootstrapEchoFilter {
    fn new(expected: Vec<u8>) -> Self {
        Self {
            marker: if expected.starts_with(b"chpwd(){") {
                b"chpwd(){"
            } else {
                b"__ai_ssh_studio_emit_cwd"
            },
            pending: Vec::new(),
        }
    }

    fn strip(&mut self, input: &[u8]) -> (Vec<u8>, bool) {
        let mut visible = Vec::new();
        for (index, byte) in input.iter().enumerate() {
            self.pending.push(*byte);
            let line_ended = matches!(*byte, b'\r' | b'\n');
            if line_ended {
                if self
                    .pending
                    .windows(self.marker.len())
                    .any(|window| window == self.marker)
                {
                    self.pending.clear();
                    visible.extend_from_slice(&input[index + 1..]);
                    return (visible, true);
                }
                visible.append(&mut self.pending);
            } else if self.pending.len() > 4096 {
                let release = self.pending.len() - self.marker.len();
                visible.extend(self.pending.drain(..release));
            }
        }
        (visible, false)
    }

    fn flush(mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

async fn disconnect_handle(handle: &mut Handle<HostKeyHandler>) {
    let _ = timeout(
        Duration::from_secs(2),
        handle.disconnect(Disconnect::ByApplication, "", ""),
    )
    .await;
}

fn map_io_error(error: io::Error) -> SshError {
    let detail = error.to_string().to_ascii_lowercase();
    if error.kind() == io::ErrorKind::NotFound
        || detail.contains("failed to lookup")
        || detail.contains("name or service not known")
        || detail.contains("nodename nor servname")
        || detail.contains("temporary failure in name resolution")
    {
        return SshError::new(
            SshErrorCode::DnsResolutionFailed,
            "无法解析服务器主机名。请检查主机地址、DNS 和网络连接。",
        );
    }
    match error.kind() {
        io::ErrorKind::ConnectionRefused => SshError::new(
            SshErrorCode::ConnectionRefused,
            "服务器拒绝连接，请检查主机地址和 SSH 端口。",
        ),
        io::ErrorKind::TimedOut => SshError::new(
            SshErrorCode::ConnectionTimeout,
            "连接服务器超时，请检查地址和网络。",
        ),
        _ => SshError::new(
            SshErrorCode::ConnectionFailed,
            format!("SSH 网络连接失败：{error}"),
        ),
    }
}

fn map_russh_error(error: russh::Error, fallback: SshErrorCode, phase: &str) -> SshError {
    match error {
        russh::Error::ConnectionTimeout => {
            SshError::new(SshErrorCode::ConnectionTimeout, format!("{phase}超时。"))
        }
        russh::Error::IO(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            map_io_error(error)
        }
        russh::Error::IO(error) if error.kind() == io::ErrorKind::TimedOut => map_io_error(error),
        russh::Error::ChannelOpenFailure(_) => {
            SshError::new(SshErrorCode::ChannelOpenFailed, format!("{phase}。"))
        }
        russh::Error::RequestDenied => SshError::new(fallback, format!("{phase}。")),
        russh::Error::HUP | russh::Error::Disconnect => {
            SshError::new(SshErrorCode::ServerClosed, "SSH 服务器已关闭连接。")
        }
        error => SshError::new(fallback, format!("{phase}：{error}")),
    }
}

#[cfg(test)]
mod shell_setup_tests {
    use super::{
        BootstrapEchoFilter, apply_host_key_decision, map_io_error, shell_bootstrap_disables_echo,
        shell_current_directory_setup,
    };
    use crate::ssh::{HostKeyCheck, HostKeyDecision, HostKeyIdentity, HostKeyStore};
    use uuid::Uuid;

    fn test_host_keys() -> (HostKeyStore, std::path::PathBuf) {
        let path = std::env::temp_dir()
            .join(format!("ai-ssh-studio-once-{}", Uuid::new_v4()))
            .join("known_hosts.json");
        (HostKeyStore::load(&path).unwrap(), path)
    }

    #[test]
    fn shell_directory_hooks_are_session_local_and_restore_terminal_echo() {
        for shell in ["/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"] {
            let setup = shell_current_directory_setup(shell).unwrap();
            assert!(setup.contains("file://"));
            assert!(setup.contains("printf"));
        }
        assert!(shell_bootstrap_disables_echo("/bin/bash"));
        assert!(shell_bootstrap_disables_echo("/usr/bin/fish"));
        assert!(!shell_bootstrap_disables_echo("/usr/bin/zsh"));
        assert!(!shell_bootstrap_disables_echo("/bin/sh"));
        assert!(shell_current_directory_setup("/bin/sh").is_none());
    }

    #[test]
    fn bootstrap_echo_filter_removes_marked_split_line_and_preserves_surrounding_output() {
        let mut filter = BootstrapEchoFilter::new(b"bootstrap command".to_vec());
        let (first, matched) = filter.strip(b"login banner\r\nprompt% printf __ai_ssh_");
        assert_eq!(first, b"login banner\r\n");
        assert!(!matched);

        let (second, matched) = filter.strip(b"studio_emit_cwd; stty echo\r\nprompt% ");
        assert_eq!(second, b"\nprompt% ");
        assert!(matched);
    }

    #[test]
    fn bootstrap_echo_filter_releases_unmatched_prompt_on_timeout() {
        let mut filter = BootstrapEchoFilter::new(b"bootstrap command".to_vec());
        let (visible, matched) = filter.strip(b"login banner\r\nprompt$ ");
        assert_eq!(visible, b"login banner\r\n");
        assert!(!matched);
        assert_eq!(filter.flush(), b"prompt$ ");
    }

    #[test]
    fn dns_failures_have_a_clear_recovery_message() {
        let error = map_io_error(std::io::Error::other(
            "failed to lookup address information: nodename nor servname provided",
        ));
        assert_eq!(error.code, crate::ssh::SshErrorCode::DnsResolutionFailed);
        assert!(error.message.contains("DNS"));
        assert!(error.message.contains("主机名"));
    }

    #[test]
    fn trust_once_accepts_the_connection_without_persisting_the_key() {
        let (host_keys, _) = test_host_keys();
        let identity = HostKeyIdentity {
            key_type: "ssh-ed25519".to_owned(),
            fingerprint_sha256: "SHA256:one-time".to_owned(),
            public_key: "ssh-ed25519 AAAA-one-time".to_owned(),
        };
        assert!(
            apply_host_key_decision(
                &host_keys,
                "example.test",
                22,
                &identity,
                HostKeyDecision::TrustOnce,
            )
            .unwrap()
        );
        assert_eq!(
            host_keys.check("example.test", 22, &identity),
            HostKeyCheck::Unknown
        );
    }

    #[test]
    fn trust_and_save_persists_the_key_for_later_connections() {
        let (host_keys, path) = test_host_keys();
        let identity = HostKeyIdentity {
            key_type: "ssh-ed25519".to_owned(),
            fingerprint_sha256: "SHA256:permanent".to_owned(),
            public_key: "ssh-ed25519 AAAA-permanent".to_owned(),
        };
        assert!(
            apply_host_key_decision(
                &host_keys,
                "example.test",
                22,
                &identity,
                HostKeyDecision::TrustAndSave,
            )
            .unwrap()
        );
        assert_eq!(
            host_keys.check("example.test", 22, &identity),
            HostKeyCheck::Trusted
        );
        if let Some(directory) = path.parent() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}
