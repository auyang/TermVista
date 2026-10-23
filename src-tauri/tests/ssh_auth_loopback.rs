use std::{
    borrow::Cow,
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use ai_ssh_studio_lib::ssh::{
    AuthPromptEvent, HostKeyChallenge, HostKeyIdentity, HostKeyStore, RusshBackend, SessionManager,
    SshAuth, SshConnectRequest, SshError, SshErrorCode, SshStatusEvent, TerminalSize,
};
use russh::{
    ChannelId, MethodKind, MethodSet, Pty, server,
    server::{ChannelOpenHandle, Msg, Server as _, Session},
};
use tauri::ipc::{Channel, InvokeResponseBody};
use zeroize::Zeroizing;

const TEST_USERNAME: &str = "termvista-local-test";
const TEST_PASSWORD: &str = "local-test-password";
const TEST_OTP: &str = "123456";
const KEY_PASSPHRASE: &str = "local-test-key-passphrase";

#[derive(Default)]
struct ServerMetrics {
    pty_requests: AtomicUsize,
    shell_requests: AtomicUsize,
}

#[derive(Clone, Default)]
struct LocalSshServer {
    metrics: Arc<ServerMetrics>,
}

impl server::Server for LocalSshServer {
    type Handler = LocalSshHandler;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        LocalSshHandler {
            metrics: Arc::clone(&self.metrics),
            keyboard_step: 0,
        }
    }
}

struct LocalSshHandler {
    metrics: Arc<ServerMetrics>,
    keyboard_step: u8,
}

impl server::Handler for LocalSshHandler {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        username: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if username == TEST_USERNAME && password == TEST_PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        username: &str,
        _public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if username == TEST_USERNAME {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        username: &str,
        _submethods: &str,
        mut response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        if username != TEST_USERNAME {
            return Ok(server::Auth::reject());
        }
        let answer = response
            .as_mut()
            .and_then(Iterator::next)
            .map(|value| String::from_utf8_lossy(&value).into_owned());
        match (self.keyboard_step, answer.as_deref()) {
            (0, None) => {
                self.keyboard_step = 1;
                Ok(prompt(
                    "Password",
                    "Password:",
                    "Enter the local test password.",
                ))
            }
            (1, Some(TEST_PASSWORD)) => {
                self.keyboard_step = 2;
                Ok(prompt(
                    "One-time code",
                    "Verification code:",
                    "Enter the local test OTP.",
                ))
            }
            (2, Some(TEST_OTP)) => Ok(server::Auth::Accept),
            _ => Ok(server::Auth::reject()),
        }
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
        self.metrics.pty_requests.fetch_add(1, Ordering::Relaxed);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.metrics.shell_requests.fetch_add(1, Ordering::Relaxed);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"\n__AI_SSH_STUDIO_SHELL__/bin/bash\n".as_slice())?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }
}

fn prompt(name: &'static str, label: &'static str, instructions: &'static str) -> server::Auth {
    server::Auth::Partial {
        name: Cow::Borrowed(name),
        instructions: Cow::Borrowed(instructions),
        prompts: Cow::Owned(vec![(Cow::Borrowed(label), false)]),
    }
}

#[tokio::test]
async fn password_private_key_and_multiround_keyboard_auth_open_real_pty_sessions() {
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let public_key = server_key.public_key().to_openssh().unwrap();
    let identity = HostKeyIdentity::from_openssh(&public_key).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let server_config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(
            &[
                MethodKind::Password,
                MethodKind::PublicKey,
                MethodKind::KeyboardInteractive,
            ][..],
        ),
        ..server::Config::default()
    });
    let server_metrics = Arc::new(ServerMetrics::default());
    let (server_handle_tx, server_handle_rx) = tokio::sync::oneshot::channel();
    let server_metrics_for_task = Arc::clone(&server_metrics);
    let server_task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            metrics: server_metrics_for_task,
        };
        let running_server = server.run_on_socket(server_config, &listener);
        let _ = server_handle_tx.send(running_server.handle());
        running_server.await
    });
    let server_handle = server_handle_rx.await.unwrap();

    let test_directory =
        std::env::temp_dir().join(format!("termvista-ssh-auth-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&test_directory).unwrap();

    let mut unknown_key_rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let unknown_key = russh::keys::PrivateKey::random(
        &mut unknown_key_rng,
        russh::keys::ssh_key::Algorithm::Ed25519,
    )
    .unwrap();
    let unknown_identity =
        HostKeyIdentity::from_openssh(&unknown_key.public_key().to_openssh().unwrap()).unwrap();
    let mismatched_host_keys =
        Arc::new(HostKeyStore::load(test_directory.join("mismatched-known-hosts.json")).unwrap());
    mismatched_host_keys
        .trust("127.0.0.1", port, &unknown_identity)
        .unwrap();
    let mismatched_sessions = Arc::new(SessionManager::new(
        Arc::new(RusshBackend),
        mismatched_host_keys,
    ));
    let mismatch = connect(
        Arc::clone(&mismatched_sessions),
        port,
        SshAuth::Password {
            password: TEST_PASSWORD.to_owned(),
        },
        Vec::new(),
        Arc::new(AtomicUsize::new(0)),
    )
    .await
    .unwrap_err();
    assert_eq!(mismatch.code, SshErrorCode::HostKeyMismatch);
    assert!(mismatch.message.contains("连接已停止"));

    let host_keys = Arc::new(HostKeyStore::load(test_directory.join("known-hosts.json")).unwrap());
    host_keys.trust("127.0.0.1", port, &identity).unwrap();
    let sessions = Arc::new(SessionManager::new(Arc::new(RusshBackend), host_keys));

    let password_session = connect(
        Arc::clone(&sessions),
        port,
        SshAuth::Password {
            password: TEST_PASSWORD.to_owned(),
        },
        Vec::new(),
        Arc::new(AtomicUsize::new(0)),
    )
    .await
    .unwrap();
    wait_for_sessions(&server_metrics, 1).await;
    sessions.disconnect(&password_session).await.unwrap();
    assert_eq!(
        server_metrics.pty_requests.load(Ordering::Relaxed),
        1,
        "密码认证应申请 PTY"
    );

    let keyboard_prompts = Arc::new(AtomicUsize::new(0));
    let keyboard_session = connect(
        Arc::clone(&sessions),
        port,
        SshAuth::KeyboardInteractive,
        vec![TEST_PASSWORD.to_owned(), TEST_OTP.to_owned()],
        Arc::clone(&keyboard_prompts),
    )
    .await
    .unwrap();
    assert_eq!(keyboard_prompts.load(Ordering::Relaxed), 2);
    wait_for_sessions(&server_metrics, 2).await;
    sessions.disconnect(&keyboard_session).await.unwrap();
    assert_eq!(
        server_metrics.pty_requests.load(Ordering::Relaxed),
        2,
        "Keyboard-Interactive 应申请 PTY"
    );

    let mut client_key_rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let client_key = russh::keys::PrivateKey::random(
        &mut client_key_rng,
        russh::keys::ssh_key::Algorithm::Ed25519,
    )
    .unwrap();
    let encrypted_key = client_key
        .encrypt(&mut getrandom::SysRng, KEY_PASSPHRASE)
        .unwrap();
    let key_path = test_directory.join("client_key");
    std::fs::write(
        &key_path,
        encrypted_key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let invalid_key_session = connect(
        Arc::clone(&sessions),
        port,
        SshAuth::PrivateKey {
            private_key_path: key_path.display().to_string(),
            key_ref: None,
            private_key_data: None,
            passphrase: Some("wrong-test-passphrase".to_owned()),
        },
        Vec::new(),
        Arc::new(AtomicUsize::new(0)),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_key_session.code, SshErrorCode::PrivateKeyInvalid);
    assert!(invalid_key_session.message.contains("私钥口令"));

    let key_session = connect(
        Arc::clone(&sessions),
        port,
        SshAuth::PrivateKey {
            private_key_path: key_path.display().to_string(),
            key_ref: None,
            private_key_data: None,
            passphrase: Some(KEY_PASSPHRASE.to_owned()),
        },
        Vec::new(),
        Arc::new(AtomicUsize::new(0)),
    )
    .await
    .unwrap();
    wait_for_sessions(&server_metrics, 3).await;
    sessions.disconnect(&key_session).await.unwrap();

    assert_eq!(
        server_metrics.pty_requests.load(Ordering::Relaxed),
        3,
        "每个认证方式都应申请 PTY"
    );
    assert_eq!(
        server_metrics.shell_requests.load(Ordering::Relaxed),
        3,
        "每个认证方式都应启动 Shell"
    );
    server_handle.shutdown("Phase 4B local auth tests finished".to_owned());
    server_task.await.unwrap().unwrap();
    std::fs::remove_dir_all(test_directory).unwrap();
}

async fn wait_for_sessions(metrics: &ServerMetrics, expected: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let pty_requests = metrics.pty_requests.load(Ordering::Relaxed);
            let shell_requests = metrics.shell_requests.load(Ordering::Relaxed);
            if pty_requests >= expected && shell_requests >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等待第 {expected} 个 PTY Shell 请求超时"));
}

async fn connect(
    sessions: Arc<SessionManager>,
    port: u16,
    auth: SshAuth,
    mut answers: Vec<String>,
    prompt_count: Arc<AtomicUsize>,
) -> Result<String, SshError> {
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let answers = Arc::new(Mutex::new(VecDeque::from(std::mem::take(&mut answers))));
    let prompt_sessions = Arc::clone(&sessions);
    let prompt_answers = Arc::clone(&answers);
    let prompt_counter = Arc::clone(&prompt_count);
    let on_auth_prompt: Channel<AuthPromptEvent> = Channel::new(move |body: InvokeResponseBody| {
        let InvokeResponseBody::Json(json) = body else {
            return Ok(());
        };
        let prompt: AuthPromptEvent = serde_json::from_str(&json).unwrap();
        prompt_counter.fetch_add(1, Ordering::Relaxed);
        let Some(answer) = prompt_answers.lock().unwrap().pop_front() else {
            panic!("测试服务器请求了多余的认证响应");
        };
        let sessions = Arc::clone(&prompt_sessions);
        tokio::runtime::Handle::current().spawn(async move {
            sessions
                .auth_response(
                    &prompt.attempt_id,
                    &prompt.prompt_id,
                    vec![Zeroizing::new(answer)],
                )
                .await
                .unwrap();
        });
        Ok(())
    });

    sessions
        .connect(
            SshConnectRequest {
                attempt_id,
                profile_id: "phase4b-local-auth-test".to_owned(),
                host: "127.0.0.1".to_owned(),
                port,
                username: TEST_USERNAME.to_owned(),
                auth,
                initial_size: TerminalSize {
                    cols: 100,
                    rows: 30,
                },
            },
            Channel::new(|_| Ok(())),
            Channel::<SshStatusEvent>::new(|_| Ok(())),
            Channel::<HostKeyChallenge>::new(|_| Ok(())),
            on_auth_prompt,
        )
        .await
}
