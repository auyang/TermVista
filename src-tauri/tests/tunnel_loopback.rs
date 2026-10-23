use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use ai_ssh_studio_lib::{
    ssh::{
        HostKeyChallenge, HostKeyIdentity, HostKeyStore, RusshBackend, SessionManager, SshAuth,
        SshConnectRequest, SshStatusEvent, TerminalSize,
    },
    tunnels::{ForwardRule, TunnelErrorCode, TunnelManager, TunnelState},
};
use russh::{
    ChannelId, ChannelOpenFailure, MethodKind, MethodSet, Pty, server,
    server::{ChannelOpenHandle, Msg, Server as _, Session},
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
}

#[derive(Clone)]
struct LocalSshServer {
    metrics: Arc<ServerMetrics>,
}

struct LocalSshHandler {
    metrics: Arc<ServerMetrics>,
}

impl server::Server for LocalSshServer {
    type Handler = LocalSshHandler;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        LocalSshHandler {
            metrics: Arc::clone(&self.metrics),
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
        Ok(if username == TEST_USERNAME && password == TEST_PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
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

    let tunnel_manager = TunnelManager::default();
    let local_port = unused_local_port().await;
    let rule = ForwardRule {
        id: "local-echo".to_owned(),
        profile_id: TEST_PROFILE.to_owned(),
        name: "本机回环 TCP echo".to_owned(),
        local_host: "127.0.0.1".to_owned(),
        local_port: u32::from(local_port),
        target_host: "127.0.0.1".to_owned(),
        target_port: u32::from(echo_port),
        created_at: 1,
        updated_at: 1,
    };

    let mut mismatched_rule = rule.clone();
    mismatched_rule.profile_id = "another-profile".to_owned();
    let mismatch = tunnel_manager
        .start(&mismatched_rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap_err();
    assert_eq!(mismatch.code, TunnelErrorCode::SessionProfileMismatch);

    let started = tunnel_manager
        .start(&rule, &session_id, Arc::clone(&sessions))
        .await
        .unwrap();
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
    assert_eq!(runtime.bytes_from_local, (payload.len() + 300).to_string());
    assert_eq!(runtime.bytes_to_local, (payload.len() + 300).to_string());
    assert_eq!(
        server_metrics.auth_count.load(Ordering::Relaxed),
        1,
        "各 TCP 通道复用同一个已认证 SSH 会话"
    );
    assert_eq!(server_metrics.direct_channels.load(Ordering::Relaxed), 101);

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
    assert_eq!(server_metrics.direct_channels.load(Ordering::Relaxed), 102);
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
    tunnel_manager.stop_session(&session_id).await;
    sessions.disconnect(&session_id).await.unwrap();
    assert!(TcpStream::connect(("127.0.0.1", local_port)).await.is_err());
    assert_eq!(server_metrics.auth_count.load(Ordering::Relaxed), 1);

    echo_task.abort();
    server_handle.shutdown("Phase 4B-4 loopback test finished".to_owned());
    server_task.await.unwrap().unwrap();
    std::fs::remove_dir_all(test_dir).unwrap();
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
