use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use ai_ssh_studio_lib::{
    ai::{
        AiRuntime, AiTaskMode, AiTunnelProtocol, AiTunnelServices, ContextPreviewRequest,
        ContextSourceRequest,
    },
    connections::{ConnectionProfile, ConnectionProfilesStore},
    diagnostics::DiagnosticRuntime,
    editor::RemoteEditorService,
    monitor::manager::MonitorManager,
    sftp::SftpManager,
    ssh::{
        HostKeyChallenge, HostKeyIdentity, HostKeyStore, RusshBackend, SessionManager, SshAuth,
        SshConnectRequest, SshErrorCode, SshStatusEvent, TerminalSize,
    },
    tunnels::{ForwardRule, Socks5Rule, TunnelErrorCode, TunnelManager, TunnelState},
};
use russh::{
    ChannelId, ChannelOpenFailure, MethodKind, MethodSet, Pty, server,
    server::{ChannelOpenHandle, Msg, Server as _, Session},
};
use russh_sftp::{
    protocol::{
        Attrs, Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Status, StatusCode,
        Version,
    },
    server::StatusReply,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};

const TEST_USERNAME: &str = "termvista-tunnel-test";
const TEST_PASSWORD: &str = "local-tunnel-test-password";
const TEST_PROFILE: &str = "phase4b4-loopback-profile";

#[derive(Default)]
struct ServerMetrics {
    auth_count: AtomicUsize,
    direct_channels: AtomicUsize,
    expected_username: String,
    expected_password: String,
    sftp_files: StdMutex<HashMap<String, Vec<u8>>>,
}

#[derive(Clone)]
struct LocalSshServer {
    metrics: Arc<ServerMetrics>,
    channels: Arc<StdMutex<HashMap<ChannelId, russh::Channel<Msg>>>>,
}

struct LocalSshHandler {
    metrics: Arc<ServerMetrics>,
    channels: Arc<StdMutex<HashMap<ChannelId, russh::Channel<Msg>>>>,
}

impl server::Server for LocalSshServer {
    type Handler = LocalSshHandler;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        LocalSshHandler {
            metrics: Arc::clone(&self.metrics),
            channels: Arc::clone(&self.channels),
        }
    }
}

impl server::Handler for LocalSshHandler {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        username: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.metrics.auth_count.fetch_add(1, Ordering::Relaxed);
        let expected_username = if self.metrics.expected_username.is_empty() {
            TEST_USERNAME
        } else {
            self.metrics.expected_username.as_str()
        };
        let expected_password = if self.metrics.expected_password.is_empty() {
            TEST_PASSWORD
        } else {
            self.metrics.expected_password.as_str()
        };
        Ok(
            if username == expected_username && password == expected_password {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels
            .lock()
            .expect("SSH test channel lock")
            .insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        let Some(channel) = self
            .channels
            .lock()
            .expect("SSH test channel lock")
            .remove(&channel)
        else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel.id())?;
        let stream = channel.into_stream();
        let handler = JumpTestSftpHandler {
            metrics: Arc::clone(&self.metrics),
            handles: HashMap::new(),
            next_handle: 0,
        };
        tokio::spawn(async move { russh_sftp::server::run(stream, handler).await });
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.metrics.direct_channels.fetch_add(1, Ordering::Relaxed);
        if host_to_connect == "203.0.113.1" {
            drop(channel);
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        }
        reply.accept().await;
        let target = (host_to_connect.to_owned(), port_to_connect as u16);
        tokio::spawn(async move {
            let Ok(mut remote) = TcpStream::connect(target).await else {
                return;
            };
            let mut channel = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut channel, &mut remote).await;
        });
        Ok(())
    }
}

struct JumpTestSftpHandler {
    metrics: Arc<ServerMetrics>,
    handles: HashMap<String, String>,
    next_handle: u64,
}

impl JumpTestSftpHandler {
    fn canonical(path: &str) -> String {
        if path.is_empty() || path == "." {
            return "/workspace".to_owned();
        }
        if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/workspace/{path}")
        }
    }

    fn status(id: u32, status_code: StatusCode) -> Status {
        Status {
            id,
            status_code,
            error_message: status_code.to_string(),
            language_tag: "en-US".to_owned(),
        }
    }

    fn attrs(size: usize) -> FileAttributes {
        FileAttributes {
            size: Some(size as u64),
            uid: Some(1000),
            gid: Some(1000),
            permissions: Some(FileMode::REG.bits() | 0o600),
            atime: Some(1_800_000_000),
            mtime: Some(1_800_000_000),
            ..FileAttributes::empty()
        }
    }
}

impl russh_sftp::server::Handler for JumpTestSftpHandler {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error {
        StatusReply::new(StatusCode::OpUnsupported)
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(Self::canonical(&path))],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = Self::canonical(&path);
        let files = self
            .metrics
            .sftp_files
            .lock()
            .expect("SFTP test files lock");
        let file = files
            .get(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        Ok(Attrs {
            id,
            attrs: Self::attrs(file.len()),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = Self::canonical(&filename);
        if !self
            .metrics
            .sftp_files
            .lock()
            .expect("SFTP test files lock")
            .contains_key(&path)
        {
            return Err(StatusReply::new(StatusCode::NoSuchFile));
        }
        self.next_handle += 1;
        let handle = format!("proxyjump-file-{}", self.next_handle);
        self.handles.insert(handle.clone(), path);
        Ok(Handle { id, handle })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let path = self
            .handles
            .get(&handle)
            .cloned()
            .ok_or_else(|| StatusReply::new(StatusCode::Failure))?;
        self.stat(id, path).await
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self
            .handles
            .get(&handle)
            .cloned()
            .ok_or_else(|| StatusReply::new(StatusCode::Failure))?;
        let files = self
            .metrics
            .sftp_files
            .lock()
            .expect("SFTP test files lock");
        let bytes = files
            .get(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start >= bytes.len() {
            return Err(StatusReply::new(StatusCode::Eof));
        }
        let end = start.saturating_add(len as usize).min(bytes.len());
        Ok(Data {
            id,
            data: bytes[start..end].to_vec(),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(Self::status(id, StatusCode::Ok))
    }
}

#[tokio::test]
async fn local_forward_uses_verified_session_transfers_large_payloads_and_releases_resources() {
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let host_identity =
        HostKeyIdentity::from_openssh(&server_key.public_key().to_openssh().unwrap()).unwrap();
    let ssh_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ssh_port = ssh_listener.local_addr().unwrap().port();
    let server_config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(&[MethodKind::Password][..]),
        ..server::Config::default()
    });
    let server_metrics = Arc::new(ServerMetrics::default());
    let metrics_for_task = Arc::clone(&server_metrics);
    let (handle_tx, handle_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            metrics: metrics_for_task,
            channels: Arc::new(StdMutex::new(HashMap::new())),
        };
        let running = server.run_on_socket(server_config, &ssh_listener);
        let _ = handle_tx.send(running.handle());
        running.await
    });
    let server_handle = handle_rx.await.unwrap();

    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    let echo_task = spawn_echo_server(echo_listener);

    let test_dir = std::env::temp_dir().join(format!("termvista-tunnel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&test_dir).unwrap();
    let host_keys = Arc::new(HostKeyStore::load(test_dir.join("known-hosts.json")).unwrap());
    host_keys
        .trust("127.0.0.1", ssh_port, &host_identity)
        .unwrap();
    let sessions = Arc::new(SessionManager::new(Arc::new(RusshBackend), host_keys));
    let session_id = connect(Arc::clone(&sessions), ssh_port).await;
    assert_eq!(server_metrics.auth_count.load(Ordering::Relaxed), 1);

    let tunnel_manager = Arc::new(TunnelManager::default());
    let local_port = unused_local_port().await;
    let rule = ForwardRule {
        id: "local-echo".to_owned(),
        profile_id: TEST_PROFILE.to_owned(),
        name: "本机回环 TCP echo".to_owned(),
        group_name: String::new(),
        local_host: "127.0.0.1".to_owned(),
        local_port: u32::from(local_port),
        target_host: "127.0.0.1".to_owned(),
        target_port: u32::from(echo_port),
        created_at: 1,
        updated_at: 1,
    };

    let check = tunnel_manager
        .check_tcp_target(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    assert!(
        check.reachable,
        "isolated loopback TCP target should accept a channel"
    );
    assert!(check.elapsed_ms.is_some());

    let profiles =
        Arc::new(ConnectionProfilesStore::open(test_dir.join("connections.sqlite3")).unwrap());
    profiles
        .save(&ConnectionProfile {
            id: TEST_PROFILE.to_owned(),
            name: "Loopback SSH".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: ssh_port,
            username: TEST_USERNAME.to_owned(),
            group_name: String::new(),
            group_id: None,
            sort_order: 0,
            auth_method: "password".to_owned(),
            private_key_path: String::new(),
            key_ref: None,
            jump_profile_id: None,
            environment: "test".to_owned(),
            favorite: false,
            last_connected_at: None,
            auto_reconnect: false,
            credential_accounts: Vec::new(),
        })
        .unwrap();
    profiles.forward_rule_save(&rule).unwrap();
    profiles
        .save(&ConnectionProfile {
            id: "other-profile".to_owned(),
            name: "Other profile".to_owned(),
            host: "192.0.2.20".to_owned(),
            port: 22,
            username: "other".to_owned(),
            group_name: String::new(),
            group_id: None,
            sort_order: 1,
            auth_method: "password".to_owned(),
            private_key_path: String::new(),
            key_ref: None,
            jump_profile_id: None,
            environment: "test".to_owned(),
            favorite: false,
            last_connected_at: None,
            auto_reconnect: false,
            credential_accounts: Vec::new(),
        })
        .unwrap();
    let mut cross_profile_rule = rule.clone();
    cross_profile_rule.id = "cross-profile-rule".to_owned();
    cross_profile_rule.profile_id = "other-profile".to_owned();
    profiles.forward_rule_save(&cross_profile_rule).unwrap();
    std::fs::write(
        test_dir.join("ai_providers.json"),
        serde_json::json!({
            "version": 1,
            "providers": [{
                "id": "test-ollama",
                "name": "Loopback Ollama test",
                "kind": "ollama",
                "baseUrl": "http://127.0.0.1:11434",
                "model": "not-called-by-preview",
                "timeoutSeconds": 30,
                "allowInsecureHttp": false
            }]
        })
        .to_string(),
    )
    .unwrap();
    let monitor = Arc::new(MonitorManager::new(Arc::clone(&sessions)));
    let sftp = Arc::new(SftpManager::new(Arc::clone(&sessions)));
    let editor = Arc::new(RemoteEditorService::new(
        Arc::clone(&sessions),
        Arc::clone(&sftp),
    ));
    let diagnostics = Arc::new(DiagnosticRuntime::new(
        Arc::clone(&sessions),
        Arc::clone(&monitor),
        Arc::clone(&sftp),
    ));
    let ai = AiRuntime::new(
        test_dir.join("ai_providers.json"),
        Arc::clone(&sessions),
        monitor,
        sftp,
        editor,
        diagnostics,
        AiTunnelServices {
            profiles: Arc::clone(&profiles),
            tunnels: Arc::clone(&tunnel_manager),
        },
    )
    .unwrap();
    ai.set_active_session(Some(&session_id)).await;
    let preview = ai
        .context_preview(ContextPreviewRequest {
            session_id: session_id.clone(),
            provider_id: "test-ollama".to_owned(),
            prompt: "MySQL client cannot connect".to_owned(),
            sources: vec![ContextSourceRequest::TunnelRule {
                rule_id: rule.id.clone(),
                protocol: AiTunnelProtocol::LocalTcp,
            }],
            include_history: false,
            mode: AiTaskMode::TunnelDiagnose,
            ui_language: "zh-CN".to_owned(),
        })
        .await
        .unwrap();
    assert!(preview.redacted_preview.contains("tunnel.probe"));
    assert!(preview.redacted_preview.contains("local-echo"));
    assert!(preview.redacted_preview.contains("reachable"));
    let cross_profile = ai
        .context_preview(ContextPreviewRequest {
            session_id: session_id.clone(),
            provider_id: "test-ollama".to_owned(),
            prompt: "analyze".to_owned(),
            sources: vec![ContextSourceRequest::TunnelRule {
                rule_id: cross_profile_rule.id,
                protocol: AiTunnelProtocol::LocalTcp,
            }],
            include_history: false,
            mode: AiTaskMode::TunnelDiagnose,
            ui_language: "en-US".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(cross_profile.code, "sessionMismatch");

    let mut mismatched_rule = rule.clone();
    mismatched_rule.profile_id = "another-profile".to_owned();
    let mismatch = tunnel_manager
        .start(&mismatched_rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap_err();
    assert_eq!(mismatch.code, TunnelErrorCode::SessionProfileMismatch);

    let first_manager = Arc::clone(&tunnel_manager);
    let first_sessions = Arc::clone(&sessions);
    let first_session_id = session_id.clone();
    let first_rule = rule.clone();
    let first_start = tokio::spawn(async move {
        first_manager
            .start(&first_rule, &first_session_id, first_sessions)
            .await
    });
    let second_manager = Arc::clone(&tunnel_manager);
    let second_sessions = Arc::clone(&sessions);
    let second_session_id = session_id.clone();
    let second_rule = rule.clone();
    let second_start = tokio::spawn(async move {
        second_manager
            .start(&second_rule, &second_session_id, second_sessions)
            .await
    });
    let first_result = first_start.await.unwrap();
    let second_result = second_start.await.unwrap();
    let (started, rejected) = match (first_result, second_result) {
        (Ok(started), Err(rejected)) | (Err(rejected), Ok(started)) => (started, rejected),
        (first, second) => panic!("并发启动同一规则只能有一个成功：{first:?} / {second:?}"),
    };
    assert_eq!(rejected.code, TunnelErrorCode::RuleRunning);
    assert_eq!(started.state, TunnelState::Running);
    assert_eq!(
        started.local_address.as_deref(),
        Some(format!("127.0.0.1:{local_port}").as_str())
    );

    let payload = (0_usize..10 * 1024 * 1024)
        .map(|index| (index.wrapping_mul(31) % 251) as u8)
        .collect::<Vec<_>>();
    let descriptors_before_transfer = descriptor_count();
    let transfer_started_at = Instant::now();
    let echoed = send_and_receive(local_port, &payload).await;
    let transfer_elapsed = transfer_started_at.elapsed();
    assert_eq!(echoed, payload, "大数据双向传输应保持字节一致");
    let transfer_mib_per_second = 10.0 / transfer_elapsed.as_secs_f64().max(0.001);
    eprintln!(
        "隔离转发实测：10 MiB 双向往返用时 {:.2}s，约 {:.2} MiB/s",
        transfer_elapsed.as_secs_f64(),
        transfer_mib_per_second
    );

    let rate_manager = Arc::clone(&tunnel_manager);
    let rate_rule_id = rule.id.clone();
    let rate_observer = tokio::spawn(async move {
        timeout(Duration::from_secs(5), async move {
            loop {
                let runtime = rate_manager
                    .runtime_list()
                    .await
                    .into_iter()
                    .find(|item| item.rule_id == rate_rule_id)
                    .unwrap();
                if runtime.active_connections > 0 && runtime.bytes_per_second_from_local > 0 {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or(false)
    });
    let slow_payload = vec![0x5a; 32 * 1024];
    let mut slow_stream = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    for chunk in slow_payload.chunks(1024) {
        slow_stream.write_all(chunk).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    slow_stream.shutdown().await.unwrap();
    let mut slow_echo = Vec::new();
    slow_stream.read_to_end(&mut slow_echo).await.unwrap();
    assert_eq!(slow_echo, slow_payload, "慢速双向流量也应逐字节保持一致");
    assert!(
        rate_observer.await.unwrap(),
        "活动连接期间应观察到真实连接数和非零实时速率"
    );

    for index in 0..100_u8 {
        let short_payload = [index, index.wrapping_add(1), index.wrapping_add(2)];
        assert_eq!(
            send_and_receive(local_port, &short_payload).await,
            short_payload
        );
    }
    wait_for_connections_to_drain(&tunnel_manager, &rule.id).await;
    let runtime = tunnel_manager
        .runtime_list()
        .await
        .into_iter()
        .find(|item| item.rule_id == rule.id)
        .unwrap();
    let expected_bytes = payload.len() + slow_payload.len() + 300;
    assert_eq!(runtime.bytes_from_local, expected_bytes.to_string());
    assert_eq!(runtime.bytes_to_local, expected_bytes.to_string());
    assert_eq!(
        server_metrics.auth_count.load(Ordering::Relaxed),
        1,
        "各 TCP 通道复用同一个已认证 SSH 会话"
    );
    assert_eq!(server_metrics.direct_channels.load(Ordering::Relaxed), 103);

    let unreachable_rule = ForwardRule {
        id: "unreachable-target".to_owned(),
        name: "不可达目标验证".to_owned(),
        local_port: u32::from(unused_local_port().await),
        target_host: "203.0.113.1".to_owned(),
        target_port: 3306,
        ..rule.clone()
    };
    tunnel_manager
        .start(&unreachable_rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    let mut unreachable_local =
        TcpStream::connect(("127.0.0.1", unreachable_rule.local_port as u16))
            .await
            .unwrap();
    unreachable_local.write_all(b"probe").await.unwrap();
    timeout(Duration::from_secs(5), async {
        loop {
            let runtime = tunnel_manager
                .runtime_list()
                .await
                .into_iter()
                .find(|runtime| runtime.rule_id == unreachable_rule.id)
                .unwrap();
            if runtime.last_error_code == Some(TunnelErrorCode::RemoteRejected) {
                assert_eq!(runtime.state, TunnelState::Running);
                assert!(
                    runtime
                        .last_error_message
                        .as_deref()
                        .is_some_and(|message| message.contains("拒绝建立远端 TCP 通道"))
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("不可达目标应返回可读错误");
    tunnel_manager.stop(&unreachable_rule.id).await.unwrap();
    assert_eq!(server_metrics.direct_channels.load(Ordering::Relaxed), 104);
    if let (Some(before), Some(after)) = (descriptors_before_transfer, descriptor_count()) {
        assert!(
            after <= before + 8,
            "100 条短连接结束后文件描述符应回到基线附近：基线 {before}，结束 {after}"
        );
        eprintln!("隔离转发资源检查：文件描述符基线 {before}，结束 {after}");
    }

    let duplicate = ForwardRule {
        id: "duplicate-listener".to_owned(),
        ..rule.clone()
    };
    let bind_error = tunnel_manager
        .start(&duplicate, &session_id, Arc::clone(&sessions))
        .await
        .unwrap_err();
    assert_eq!(bind_error.code, TunnelErrorCode::BindInUse);

    tunnel_manager.stop(&rule.id).await.unwrap();
    assert!(TcpStream::connect(("127.0.0.1", local_port)).await.is_err());

    let restart = tunnel_manager
        .start(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    assert_eq!(restart.state, TunnelState::Running);
    let shutdown_rule = ForwardRule {
        id: "shutdown-rule".to_owned(),
        local_port: u32::from(unused_local_port().await),
        ..rule.clone()
    };
    tunnel_manager
        .start(&shutdown_rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    tunnel_manager.shutdown_all().await;
    assert!(TcpStream::connect(("127.0.0.1", local_port)).await.is_err());
    assert!(
        TcpStream::connect(("127.0.0.1", shutdown_rule.local_port as u16))
            .await
            .is_err()
    );

    tunnel_manager
        .start(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    server_handle.shutdown("Phase 4B-4 isolated SSH disconnect".to_owned());
    timeout(Duration::from_secs(10), async {
        loop {
            let runtime = tunnel_manager
                .runtime_list()
                .await
                .into_iter()
                .find(|runtime| runtime.rule_id == rule.id)
                .unwrap();
            if runtime.state == TunnelState::Stopped
                && runtime.last_error_code == Some(TunnelErrorCode::ConnectionLost)
                && TcpStream::connect(("127.0.0.1", local_port)).await.is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("SSH 会话意外断开后，监听端口必须释放且状态恢复为已停止");
    assert_eq!(server_metrics.auth_count.load(Ordering::Relaxed), 1);

    echo_task.abort();
    server_task.await.unwrap().unwrap();
    std::fs::remove_dir_all(test_dir).unwrap();
}

#[tokio::test]
async fn socks5_loopback_connects_remote_ipv4_ipv6_and_domains_and_releases_resources() {
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let host_identity =
        HostKeyIdentity::from_openssh(&server_key.public_key().to_openssh().unwrap()).unwrap();
    let ssh_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ssh_port = ssh_listener.local_addr().unwrap().port();
    let server_config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(&[MethodKind::Password][..]),
        ..server::Config::default()
    });
    let metrics = Arc::new(ServerMetrics::default());
    let metrics_for_task = Arc::clone(&metrics);
    let (handle_tx, handle_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            metrics: metrics_for_task,
            channels: Arc::new(StdMutex::new(HashMap::new())),
        };
        let running = server.run_on_socket(server_config, &ssh_listener);
        let _ = handle_tx.send(running.handle());
        running.await
    });
    let server_handle = handle_rx.await.unwrap();

    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    let echo_task = spawn_echo_server(echo_listener);
    let ipv6_echo = match TcpListener::bind("[::1]:0").await {
        Ok(listener) => {
            let port = listener.local_addr().unwrap().port();
            Some((port, spawn_echo_server(listener)))
        }
        Err(_) => None,
    };

    let test_dir = std::env::temp_dir().join(format!("termvista-socks5-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&test_dir).unwrap();
    let host_keys = Arc::new(HostKeyStore::load(test_dir.join("known-hosts.json")).unwrap());
    host_keys
        .trust("127.0.0.1", ssh_port, &host_identity)
        .unwrap();
    let sessions = Arc::new(SessionManager::new(Arc::new(RusshBackend), host_keys));
    let session_id = connect(Arc::clone(&sessions), ssh_port).await;
    let tunnel_manager = Arc::new(TunnelManager::default());
    let local_port = unused_local_port().await;
    let rule = Socks5Rule {
        id: "socks5-echo".to_owned(),
        profile_id: TEST_PROFILE.to_owned(),
        name: "本机 SOCKS5 测试".to_owned(),
        group_name: String::new(),
        local_host: "127.0.0.1".to_owned(),
        local_port: u32::from(local_port),
        created_at: 1,
        updated_at: 1,
    };

    let mut external_rule = rule.clone();
    external_rule.local_host = "0.0.0.0".to_owned();
    assert_eq!(
        tunnel_manager
            .start_socks5(&external_rule, &session_id, Arc::clone(&sessions))
            .await
            .unwrap_err()
            .code,
        TunnelErrorCode::InvalidRule
    );

    let started = tunnel_manager
        .start_socks5(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    assert_eq!(started.state, TunnelState::Running);
    assert_eq!(
        started.local_address.as_deref(),
        Some(format!("127.0.0.1:{local_port}").as_str())
    );

    socks5_roundtrip(
        local_port,
        vec![
            5,
            1,
            0,
            1,
            127,
            0,
            0,
            1,
            (echo_port >> 8) as u8,
            echo_port as u8,
        ],
        b"SOCKS5 IPv4 over verified SSH",
    )
    .await;

    let domain = b"localhost";
    let mut domain_request = vec![5, 1, 0, 3, domain.len() as u8];
    domain_request.extend_from_slice(domain);
    domain_request.extend_from_slice(&echo_port.to_be_bytes());
    socks5_roundtrip(local_port, domain_request, b"SOCKS5 remote DNS").await;

    if let Some((port, _)) = &ipv6_echo {
        let mut ipv6_request = vec![5, 1, 0, 4];
        ipv6_request.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        ipv6_request.extend_from_slice(&port.to_be_bytes());
        socks5_roundtrip(local_port, ipv6_request, b"SOCKS5 IPv6 over verified SSH").await;
    }

    let mut unsupported = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    unsupported.write_all(&[5, 1, 0]).await.unwrap();
    let mut method_reply = [0; 2];
    unsupported.read_exact(&mut method_reply).await.unwrap();
    assert_eq!(method_reply, [5, 0]);
    unsupported
        .write_all(&[5, 3, 0, 1, 127, 0, 0, 1, 0, 53])
        .await
        .unwrap();
    let mut command_reply = [0; 10];
    unsupported.read_exact(&mut command_reply).await.unwrap();
    assert_eq!(command_reply[1], 7, "UDP ASSOCIATE 必须被拒绝");

    let mut no_auth_method = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
    no_auth_method.write_all(&[5, 1, 2]).await.unwrap();
    let mut rejected_method = [0; 2];
    no_auth_method
        .read_exact(&mut rejected_method)
        .await
        .unwrap();
    assert_eq!(rejected_method, [5, 0xff]);
    drop(no_auth_method);
    drop(unsupported);

    let mut pending = Vec::new();
    for _ in 0..65 {
        let mut client = TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        client
            .write_all(&[
                5,
                1,
                0,
                5,
                1,
                0,
                1,
                127,
                0,
                0,
                1,
                (echo_port >> 8) as u8,
                echo_port as u8,
            ])
            .await
            .unwrap();
        pending.push(client);
    }
    timeout(Duration::from_secs(5), async {
        loop {
            let runtime = tunnel_manager
                .socks5_runtime_list()
                .await
                .into_iter()
                .find(|item| item.rule_id == rule.id)
                .unwrap();
            if runtime.active_connections == 64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("SOCKS5 并发连接数应受限为 64");
    drop(pending);
    timeout(Duration::from_secs(5), async {
        loop {
            if tunnel_manager
                .socks5_runtime_list()
                .await
                .into_iter()
                .find(|item| item.rule_id == rule.id)
                .is_some_and(|runtime| runtime.active_connections == 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("SOCKS5 客户端关闭后应释放并发配额");

    assert!(metrics.direct_channels.load(Ordering::Relaxed) >= 2);
    tunnel_manager.shutdown_all().await;
    assert!(TcpStream::connect(("127.0.0.1", local_port)).await.is_err());

    tunnel_manager
        .start_socks5(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
    server_handle.shutdown("Phase 4D SOCKS5 isolated SSH disconnect".to_owned());
    timeout(Duration::from_secs(10), async {
        loop {
            let runtime = tunnel_manager
                .socks5_runtime_list()
                .await
                .into_iter()
                .find(|item| item.rule_id == rule.id)
                .unwrap();
            if runtime.state == TunnelState::Stopped
                && runtime.last_error_code == Some(TunnelErrorCode::ConnectionLost)
                && TcpStream::connect(("127.0.0.1", local_port)).await.is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("SSH 断开后 SOCKS5 监听和活动客户端应释放");

    echo_task.abort();
    if let Some((_, task)) = ipv6_echo {
        task.abort();
    }
    server_task.await.unwrap().unwrap();
    std::fs::remove_dir_all(test_dir).unwrap();
}

#[tokio::test]
async fn proxyjump_uses_verified_jump_and_target_servers_and_keeps_sftp_editor_available() {
    let (jump_port, jump_identity, jump_metrics, jump_task) =
        start_local_ssh_server("jump-user", "jump-password", None).await;
    let (target_port, target_identity, target_metrics, target_task) = start_local_ssh_server(
        "target-user",
        "target-password",
        Some((
            "/workspace/behind-jump.txt",
            b"target reached through ProxyJump\n",
        )),
    )
    .await;

    let test_dir =
        std::env::temp_dir().join(format!("termvista-proxyjump-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&test_dir).unwrap();
    let host_keys = Arc::new(HostKeyStore::load(test_dir.join("known-hosts.json")).unwrap());
    host_keys
        .trust("127.0.0.1", jump_port, &jump_identity)
        .unwrap();
    host_keys
        .trust("127.0.0.1", target_port, &target_identity)
        .unwrap();
    let sessions = Arc::new(SessionManager::new(Arc::new(RusshBackend), host_keys));

    let jump_session_id = connect_with_route(
        Arc::clone(&sessions),
        "jump-profile",
        jump_port,
        "jump-user",
        "jump-password",
        None,
        None,
    )
    .await
    .unwrap();
    let jump_binding = sessions.security_binding(&jump_session_id).await.unwrap();
    assert_eq!(
        jump_binding.identity.fingerprint_sha256,
        jump_identity.fingerprint_sha256
    );

    let wrong_route = connect_with_route(
        Arc::clone(&sessions),
        "target-profile",
        target_port,
        "target-user",
        "target-password",
        Some("different-jump-profile"),
        Some(&jump_session_id),
    )
    .await
    .unwrap_err();
    assert_eq!(wrong_route.code, SshErrorCode::JumpHostUnavailable);
    assert_eq!(target_metrics.auth_count.load(Ordering::Relaxed), 0);

    let target_session_id = connect_with_route(
        Arc::clone(&sessions),
        "target-profile",
        target_port,
        "target-user",
        "target-password",
        Some("jump-profile"),
        Some(&jump_session_id),
    )
    .await
    .unwrap();
    let target_binding = sessions.security_binding(&target_session_id).await.unwrap();
    assert_eq!(
        target_binding.identity.fingerprint_sha256,
        target_identity.fingerprint_sha256
    );
    assert_ne!(
        jump_binding.identity.fingerprint_sha256,
        target_binding.identity.fingerprint_sha256
    );
    assert_eq!(jump_metrics.auth_count.load(Ordering::Relaxed), 1);
    assert_eq!(target_metrics.auth_count.load(Ordering::Relaxed), 1);
    assert_eq!(jump_metrics.direct_channels.load(Ordering::Relaxed), 1);

    sessions
        .resize(
            &target_session_id,
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        )
        .await
        .unwrap();
    let sftp = Arc::new(SftpManager::new(Arc::clone(&sessions)));
    let sftp_open = sftp
        .open(&target_session_id, Channel::new(|_| Ok(())))
        .await
        .unwrap();
    assert_eq!(sftp_open.current_path, "/workspace");
    let editor = RemoteEditorService::new(Arc::clone(&sessions), sftp);
    let document = editor
        .open(&target_session_id, "/workspace/behind-jump.txt", false)
        .await
        .unwrap();
    assert_eq!(
        document.text.as_deref(),
        Some("target reached through ProxyJump\n")
    );

    sessions.disconnect(&target_session_id).await.unwrap();
    sessions.disconnect(&jump_session_id).await.unwrap();
    jump_task.abort();
    target_task.abort();
    std::fs::remove_dir_all(test_dir).unwrap();
}

async fn socks5_roundtrip(local_port: u16, request: Vec<u8>, payload: &[u8]) {
    let mut stream = timeout(
        Duration::from_secs(5),
        TcpStream::connect(("127.0.0.1", local_port)),
    )
    .await
    .expect("SOCKS5 本地连接超时")
    .expect("SOCKS5 本地监听连接失败");
    stream.write_all(&[5, 1, 0]).await.unwrap();
    let mut method_reply = [0; 2];
    stream.read_exact(&mut method_reply).await.unwrap();
    assert_eq!(method_reply, [5, 0]);
    stream.write_all(&request).await.unwrap();
    let mut connect_reply = [0; 10];
    stream.read_exact(&mut connect_reply).await.unwrap();
    assert_eq!(connect_reply[0], 5);
    assert_eq!(connect_reply[1], 0, "SOCKS5 CONNECT 应成功");
    stream.write_all(payload).await.unwrap();
    stream.shutdown().await.unwrap();
    let mut echoed = Vec::new();
    timeout(Duration::from_secs(5), stream.read_to_end(&mut echoed))
        .await
        .expect("SOCKS5 SSH 数据通道响应超时")
        .unwrap();
    assert_eq!(echoed, payload);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "仅用于手动原生 UI 联调；启动后按 Ctrl-C 停止"]
async fn isolated_tunnel_ui_fixture_for_manual_tunnel_testing() {
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let host_identity = ai_ssh_studio_lib::ssh::HostKeyIdentity::from_openssh(
        &server_key.public_key().to_openssh().unwrap(),
    )
    .unwrap();
    let ssh_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ssh_port = ssh_listener.local_addr().unwrap().port();
    let server_config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(&[MethodKind::Password][..]),
        ..server::Config::default()
    });
    let metrics = Arc::new(ServerMetrics::default());
    let metrics_for_task = Arc::clone(&metrics);
    let (handle_tx, handle_rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            metrics: metrics_for_task,
            channels: Arc::new(StdMutex::new(HashMap::new())),
        };
        let running = server.run_on_socket(server_config, &ssh_listener);
        let _ = handle_tx.send(running.handle());
        running.await
    });
    let _server_handle = handle_rx.await.unwrap();

    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    let _echo_task = spawn_echo_server(echo_listener);

    println!("ISOLATED_TUNNEL_UI host=127.0.0.1 ssh_port={ssh_port}");
    println!("ISOLATED_TUNNEL_UI username={TEST_USERNAME} password={TEST_PASSWORD}");
    println!(
        "ISOLATED_TUNNEL_UI fingerprint={}",
        host_identity.fingerprint_sha256
    );
    println!("ISOLATED_TUNNEL_UI tcp_echo_target=127.0.0.1:{echo_port}");
    println!("ISOLATED_TUNNEL_UI only loopback; press Ctrl-C to stop");

    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

#[cfg(unix)]
fn descriptor_count() -> Option<usize> {
    std::fs::read_dir("/dev/fd")
        .ok()
        .map(|entries| entries.count())
}

#[cfg(not(unix))]
fn descriptor_count() -> Option<usize> {
    None
}

fn spawn_echo_server(listener: TcpListener) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut contents = Vec::new();
                if stream.read_to_end(&mut contents).await.is_ok() {
                    let _ = stream.write_all(&contents).await;
                    let _ = stream.shutdown().await;
                }
            });
        }
    })
}

async fn unused_local_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

async fn send_and_receive(port: u16, payload: &[u8]) -> Vec<u8> {
    let mut stream = timeout(
        Duration::from_secs(5),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .expect("本地隧道连接超时")
    .expect("本地隧道连接失败");
    stream.write_all(payload).await.unwrap();
    stream.shutdown().await.unwrap();
    let mut response = Vec::new();
    timeout(Duration::from_secs(20), stream.read_to_end(&mut response))
        .await
        .expect("读取隧道响应超时")
        .unwrap();
    response
}

async fn wait_for_connections_to_drain(manager: &TunnelManager, rule_id: &str) {
    timeout(Duration::from_secs(10), async {
        loop {
            if manager
                .runtime_list()
                .await
                .iter()
                .find(|runtime| runtime.rule_id == rule_id)
                .is_some_and(|runtime| runtime.active_connections == 0)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("本地转发连接未能完成清理");
}

async fn start_local_ssh_server(
    username: &str,
    password: &str,
    sftp_file: Option<(&str, &[u8])>,
) -> (u16, HostKeyIdentity, Arc<ServerMetrics>, JoinHandle<()>) {
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let identity =
        HostKeyIdentity::from_openssh(&server_key.public_key().to_openssh().unwrap()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(&[MethodKind::Password][..]),
        ..server::Config::default()
    });
    let mut metrics = ServerMetrics {
        expected_username: username.to_owned(),
        expected_password: password.to_owned(),
        ..ServerMetrics::default()
    };
    if let Some((path, contents)) = sftp_file {
        metrics
            .sftp_files
            .get_mut()
            .expect("SFTP test files lock")
            .insert(path.to_owned(), contents.to_vec());
    }
    let metrics = Arc::new(metrics);
    let metrics_for_task = Arc::clone(&metrics);
    let task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            metrics: metrics_for_task,
            channels: Arc::new(StdMutex::new(HashMap::new())),
        };
        let _ = server.run_on_socket(config, &listener).await;
    });
    (port, identity, metrics, task)
}

async fn connect_with_route(
    sessions: Arc<SessionManager>,
    profile_id: &str,
    port: u16,
    username: &str,
    password: &str,
    jump_profile_id: Option<&str>,
    jump_session_id: Option<&str>,
) -> Result<String, ai_ssh_studio_lib::ssh::SshError> {
    sessions
        .connect(
            SshConnectRequest {
                attempt_id: uuid::Uuid::new_v4().to_string(),
                profile_id: profile_id.to_owned(),
                host: "127.0.0.1".to_owned(),
                port,
                username: username.to_owned(),
                auth: SshAuth::Password {
                    password: password.to_owned(),
                },
                jump_profile_id: jump_profile_id.map(str::to_owned),
                jump_session_id: jump_session_id.map(str::to_owned),
                initial_size: TerminalSize {
                    cols: 100,
                    rows: 30,
                },
            },
            Channel::<InvokeResponseBody>::new(|_| Ok(())),
            Channel::<SshStatusEvent>::new(|_| Ok(())),
            Channel::<HostKeyChallenge>::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
        )
        .await
}

async fn connect(sessions: Arc<SessionManager>, port: u16) -> String {
    sessions
        .connect(
            SshConnectRequest {
                attempt_id: uuid::Uuid::new_v4().to_string(),
                profile_id: TEST_PROFILE.to_owned(),
                host: "127.0.0.1".to_owned(),
                port,
                username: TEST_USERNAME.to_owned(),
                auth: SshAuth::Password {
                    password: TEST_PASSWORD.to_owned(),
                },
                jump_profile_id: None,
                jump_session_id: None,
                initial_size: TerminalSize {
                    cols: 100,
                    rows: 30,
                },
            },
            Channel::new(|_| Ok(())),
            Channel::<SshStatusEvent>::new(|_| Ok(())),
            Channel::<HostKeyChallenge>::new(|_| Ok(())),
            Channel::new(|body: InvokeResponseBody| {
                let _ = body;
                Ok(())
            }),
        )
        .await
        .unwrap()
}
