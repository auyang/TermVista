use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use ai_ssh_studio_lib::{
    editor::{RemoteEditorService, SaveStatus},
    sftp::SftpManager,
    ssh::{
        HostKeyChallenge, HostKeyIdentity, HostKeyStore, RusshBackend, SessionManager, SshAuth,
        SshConnectRequest, SshStatusEvent, TerminalSize,
    },
};
use russh::{
    ChannelId, MethodKind, MethodSet, Pty, server,
    server::{ChannelOpenHandle, Msg, Server as _, Session},
};
use russh_sftp::{
    protocol::{
        Attrs, Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Packet, Status,
        StatusCode, Version,
    },
    server::StatusReply,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::task::JoinHandle;

const TEST_USERNAME: &str = "termvista-editor-local";
const TEST_PASSWORD: &str = "local-editor-password";

#[derive(Clone)]
struct StoredFile {
    bytes: Vec<u8>,
    permissions: u32,
    uid: u32,
    gid: u32,
    mtime: u32,
}

type TestFiles = Arc<Mutex<HashMap<String, StoredFile>>>;

#[derive(Clone, Default)]
struct LocalSshServer {
    channels: Arc<Mutex<HashMap<ChannelId, russh::Channel<Msg>>>>,
    files: Option<TestFiles>,
}

impl server::Server for LocalSshServer {
    type Handler = LocalSshHandler;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        LocalSshHandler {
            channels: Arc::clone(&self.channels),
            files: self
                .files
                .as_ref()
                .expect("test file system is set")
                .clone(),
        }
    }
}

struct LocalSshHandler {
    channels: Arc<Mutex<HashMap<ChannelId, russh::Channel<Msg>>>>,
    files: TestFiles,
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

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels
            .lock()
            .expect("channel map lock")
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
        let Some(channel_stream) = self
            .channels
            .lock()
            .expect("channel map lock")
            .remove(&channel)
        else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        let stream = channel_stream.into_stream();
        let handler = TestSftpHandler {
            files: self.files.clone(),
            handles: HashMap::new(),
            directory_handles: HashMap::new(),
            next_handle: 0,
        };
        tokio::spawn(async move { russh_sftp::server::run(stream, handler).await });
        Ok(())
    }
}

struct TestSftpHandler {
    files: TestFiles,
    handles: HashMap<String, String>,
    directory_handles: HashMap<String, (String, bool)>,
    next_handle: u64,
}

impl TestSftpHandler {
    fn status(id: u32, status_code: StatusCode) -> Status {
        Status {
            id,
            status_code,
            error_message: status_code.to_string(),
            language_tag: "en-US".to_owned(),
        }
    }

    fn attributes(file: &StoredFile) -> FileAttributes {
        FileAttributes {
            size: Some(file.bytes.len() as u64),
            uid: Some(file.uid),
            gid: Some(file.gid),
            permissions: Some(file.permissions),
            atime: Some(file.mtime),
            mtime: Some(file.mtime),
            ..FileAttributes::empty()
        }
    }

    fn get_path(&self, handle: &str) -> Result<String, StatusReply> {
        self.handles
            .get(handle)
            .cloned()
            .ok_or_else(|| StatusReply::new(StatusCode::Failure).with_message("invalid handle"))
    }

    fn parse_paths(data: &[u8]) -> Result<(String, String), StatusReply> {
        fn next(data: &[u8], cursor: &mut usize) -> Option<String> {
            let len_bytes = data.get(*cursor..cursor.checked_add(4)?)?;
            let length = u32::from_be_bytes(len_bytes.try_into().ok()?) as usize;
            *cursor += 4;
            let value = data.get(*cursor..cursor.checked_add(length)?)?;
            *cursor += length;
            String::from_utf8(value.to_vec()).ok()
        }
        let mut cursor = 0;
        let first = next(data, &mut cursor);
        let second = next(data, &mut cursor);
        match (first, second, cursor == data.len()) {
            (Some(first), Some(second), true) => Ok((first, second)),
            _ => Err(StatusReply::new(StatusCode::BadMessage)),
        }
    }

    fn canonical(path: &str) -> String {
        if path == "." || path.is_empty() {
            return "/workspace".to_owned();
        }
        let path = if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/workspace/{path}")
        };
        let mut components = Vec::new();
        for component in path.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    components.pop();
                }
                value => components.push(value),
            }
        }
        format!("/{}", components.join("/"))
    }
}

impl russh_sftp::server::Handler for TestSftpHandler {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error {
        StatusReply::new(StatusCode::OpUnsupported)
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let mut version = Version::new();
        version
            .extensions
            .insert("posix-rename@openssh.com".to_owned(), "1".to_owned());
        version
            .extensions
            .insert("hardlink@openssh.com".to_owned(), "1".to_owned());
        version
            .extensions
            .insert("fsync@openssh.com".to_owned(), "1".to_owned());
        Ok(version)
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = Self::canonical(&filename);
        let mut files = self.files.lock().expect("test files lock");
        if pflags.contains(OpenFlags::CREATE) && pflags.contains(OpenFlags::EXCLUDE) {
            if files.contains_key(&path) {
                return Err(StatusReply::new(StatusCode::Failure));
            }
            files.insert(
                path.clone(),
                StoredFile {
                    bytes: Vec::new(),
                    permissions: FileMode::REG.bits() | 0o600,
                    uid: 1000,
                    gid: 1000,
                    mtime: 1_800_000_000,
                },
            );
        } else if pflags.contains(OpenFlags::CREATE) {
            files.entry(path.clone()).or_insert_with(|| StoredFile {
                bytes: Vec::new(),
                permissions: FileMode::REG.bits() | 0o600,
                uid: 1000,
                gid: 1000,
                mtime: 1_800_000_000,
            });
        } else if !files.contains_key(&path) {
            return Err(StatusReply::new(StatusCode::NoSuchFile));
        }
        if pflags.contains(OpenFlags::TRUNCATE)
            && let Some(file) = files.get_mut(&path)
        {
            file.bytes.clear();
        }
        drop(files);
        self.next_handle += 1;
        let handle = format!("test-handle-{}", self.next_handle);
        self.handles.insert(handle.clone(), path);
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        self.directory_handles.remove(&handle);
        Ok(Self::status(id, StatusCode::Ok))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        self.next_handle += 1;
        let handle = format!("test-directory-{}", self.next_handle);
        self.directory_handles
            .insert(handle.clone(), (Self::canonical(&path), false));
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some((directory, sent)) = self.directory_handles.get_mut(&handle) else {
            return Err(StatusReply::new(StatusCode::Failure));
        };
        if *sent {
            return Err(StatusReply::new(StatusCode::Eof));
        }
        *sent = true;
        let prefix = if directory == "/" {
            "/".to_owned()
        } else {
            format!("{directory}/")
        };
        let files = self.files.lock().expect("test files lock");
        let mut entries = std::collections::BTreeMap::new();
        for (path, file) in files.iter() {
            let Some(relative) = path.strip_prefix(&prefix) else {
                continue;
            };
            if relative.is_empty() {
                continue;
            }
            let name = relative.split('/').next().unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let attrs = if relative.contains('/') {
                FileAttributes {
                    permissions: Some(FileMode::DIR.bits() | 0o755),
                    ..FileAttributes::dummy()
                }
            } else {
                Self::attributes(file)
            };
            entries.entry(name.to_owned()).or_insert(attrs);
        }
        Ok(Name {
            id,
            files: entries
                .into_iter()
                .map(|(name, attrs)| File::new(name, attrs))
                .collect(),
        })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self.get_path(&handle)?;
        let files = self.files.lock().expect("test files lock");
        let file = files
            .get(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start >= file.bytes.len() {
            return Err(StatusReply::new(StatusCode::Eof));
        }
        let end = start.saturating_add(len as usize).min(file.bytes.len());
        Ok(Data {
            id,
            data: file.bytes[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        _id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self.get_path(&handle)?;
        let mut files = self.files.lock().expect("test files lock");
        let file = files
            .get_mut(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        let start = usize::try_from(offset).map_err(|_| StatusReply::new(StatusCode::Failure))?;
        let end = start
            .checked_add(data.len())
            .ok_or_else(|| StatusReply::new(StatusCode::Failure))?;
        if file.bytes.len() < end {
            file.bytes.resize(end, 0);
        }
        file.bytes[start..end].copy_from_slice(&data);
        Ok(Self::status(_id, StatusCode::Ok))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let path = self.get_path(&handle)?;
        self.lstat(id, path).await
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = Self::canonical(&path);
        let mut files = self.files.lock().expect("test files lock");
        let file = files
            .get_mut(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        if let Some(permissions) = attrs.permissions {
            file.permissions = permissions;
        }
        if let Some(uid) = attrs.uid {
            file.uid = uid;
        }
        if let Some(gid) = attrs.gid {
            file.gid = gid;
        }
        Ok(Self::status(id, StatusCode::Ok))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let path = self.get_path(&handle)?;
        self.setstat(id, path, attrs).await
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let path = Self::canonical(&filename);
        self.files
            .lock()
            .expect("test files lock")
            .remove(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        Ok(Self::status(id, StatusCode::Ok))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(Self::canonical(&path))],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let path = Self::canonical(&path);
        let files = self.files.lock().expect("test files lock");
        let file = files
            .get(&path)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        Ok(Attrs {
            id,
            attrs: Self::attributes(file),
        })
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let oldpath = Self::canonical(&oldpath);
        let newpath = Self::canonical(&newpath);
        let mut files = self.files.lock().expect("test files lock");
        if files.contains_key(&newpath) {
            return Err(StatusReply::new(StatusCode::Failure));
        }
        let file = files
            .remove(&oldpath)
            .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
        files.insert(newpath, file);
        Ok(Self::status(id, StatusCode::Ok))
    }

    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        let status = match request.as_str() {
            "fsync@openssh.com" => Self::status(id, StatusCode::Ok),
            "hardlink@openssh.com" => {
                let (source, destination) = Self::parse_paths(&data)?;
                let source = Self::canonical(&source);
                let destination = Self::canonical(&destination);
                let mut files = self.files.lock().expect("test files lock");
                if files.contains_key(&destination) {
                    return Err(StatusReply::new(StatusCode::Failure));
                }
                let file = files
                    .get(&source)
                    .cloned()
                    .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
                files.insert(destination, file);
                Self::status(id, StatusCode::Ok)
            }
            "posix-rename@openssh.com" => {
                let (source, destination) = Self::parse_paths(&data)?;
                let source = Self::canonical(&source);
                let destination = Self::canonical(&destination);
                let mut files = self.files.lock().expect("test files lock");
                let file = files
                    .remove(&source)
                    .ok_or_else(|| StatusReply::new(StatusCode::NoSuchFile))?;
                files.insert(destination, file);
                Self::status(id, StatusCode::Ok)
            }
            _ => return Err(StatusReply::new(StatusCode::OpUnsupported)),
        };
        Ok(Packet::Status(status))
    }
}

struct TestServer {
    port: u16,
    identity: HostKeyIdentity,
    files: TestFiles,
    task: JoinHandle<Result<(), std::io::Error>>,
}

async fn start_server(file_path: &str, initial_bytes: &[u8]) -> TestServer {
    let files = Arc::new(Mutex::new(HashMap::from([(
        file_path.to_owned(),
        StoredFile {
            bytes: initial_bytes.to_vec(),
            permissions: FileMode::REG.bits() | 0o644,
            uid: 1000,
            gid: 1000,
            mtime: 1_800_000_000,
        },
    )])));
    let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
    let server_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let identity =
        HostKeyIdentity::from_openssh(&server_key.public_key().to_openssh().unwrap()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        auth_rejection_time: Duration::ZERO,
        keys: vec![server_key],
        methods: MethodSet::from(&[MethodKind::Password][..]),
        ..server::Config::default()
    });
    let server_files = Arc::clone(&files);
    let task = tokio::spawn(async move {
        let mut server = LocalSshServer {
            channels: Arc::default(),
            files: Some(server_files),
        };
        server.run_on_socket(config, &listener).await
    });
    TestServer {
        port,
        identity,
        files,
        task,
    }
}

async fn connect(sessions: &SessionManager, port: u16) -> String {
    sessions
        .connect(
            SshConnectRequest {
                attempt_id: uuid::Uuid::new_v4().to_string(),
                profile_id: format!("phase4b3-loopback-{port}"),
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
            Channel::<InvokeResponseBody>::new(|_| Ok(())),
            Channel::<SshStatusEvent>::new(|_| Ok(())),
            Channel::<HostKeyChallenge>::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap()
}

fn read_test_file(files: &TestFiles, path: &str) -> Vec<u8> {
    files
        .lock()
        .expect("test files lock")
        .get(path)
        .expect("test file exists")
        .bytes
        .clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_editor_round_trip_conflict_and_server_isolation_use_loopback_sftp_only() {
    let path = "/workspace/settings.json";
    let first_server = start_server(path, b"{\"name\":\"alpha\"}\r\n").await;
    let second_server = start_server(path, b"{\"name\":\"bravo\"}\r\n").await;
    first_server.files.lock().expect("test files lock").insert(
        "/workspace/existing.txt".to_owned(),
        StoredFile {
            bytes: b"keep-existing\n".to_vec(),
            permissions: FileMode::REG.bits() | 0o644,
            uid: 1000,
            gid: 1000,
            mtime: 1_800_000_000,
        },
    );
    let test_directory =
        std::env::temp_dir().join(format!("termvista-editor-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&test_directory).unwrap();
    let host_keys = Arc::new(HostKeyStore::load(test_directory.join("known-hosts.json")).unwrap());
    host_keys
        .trust("127.0.0.1", first_server.port, &first_server.identity)
        .unwrap();
    host_keys
        .trust("127.0.0.1", second_server.port, &second_server.identity)
        .unwrap();
    let sessions = Arc::new(SessionManager::new(Arc::new(RusshBackend), host_keys));
    let first_session = connect(&sessions, first_server.port).await;
    let second_session = connect(&sessions, second_server.port).await;
    let sftp = Arc::new(SftpManager::new(Arc::clone(&sessions)));
    sftp.open(&first_session, Channel::new(|_| Ok(())))
        .await
        .unwrap();
    sftp.open(&second_session, Channel::new(|_| Ok(())))
        .await
        .unwrap();
    let editor = RemoteEditorService::new(Arc::clone(&sessions), Arc::clone(&sftp));

    let first = editor.open(&first_session, path, false).await.unwrap();
    let second = editor.open(&second_session, path, false).await.unwrap();
    assert_ne!(first.document_id, second.document_id);
    assert_ne!(first.session_id, second.session_id);
    assert_eq!(first.text.as_deref(), Some("{\"name\":\"alpha\"}\n"));
    assert_eq!(second.text.as_deref(), Some("{\"name\":\"bravo\"}\n"));
    assert!(editor.path_is_open(&first_session, path).await);
    assert!(
        editor
            .path_or_descendant_is_open(&first_session, "/workspace/")
            .await
    );
    assert!(
        editor
            .path_or_descendant_is_open(&second_session, "/workspace")
            .await
    );
    assert!(
        !editor
            .path_is_open(&first_session, "/workspace/other.json")
            .await
    );

    let saved = editor
        .save(
            &first.document_id,
            first.sha256.as_deref().unwrap(),
            "{\"name\":\"updated\"}\n",
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(saved.status, SaveStatus::Saved);
    assert!(saved.verified);
    assert_eq!(
        read_test_file(&first_server.files, path),
        b"{\"name\":\"updated\"}\r\n"
    );
    assert_eq!(
        read_test_file(&second_server.files, path),
        b"{\"name\":\"bravo\"}\r\n"
    );

    let saved_hash = saved.new_sha256.as_deref().unwrap();
    let existing_target = editor
        .save_as(
            &first.document_id,
            saved_hash,
            "/workspace/existing.txt",
            "must not replace\n",
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(
        existing_target.code,
        ai_ssh_studio_lib::editor::EditorErrorCode::Conflict
    );
    assert_eq!(
        read_test_file(&first_server.files, "/workspace/existing.txt"),
        b"keep-existing\n"
    );

    let saved_as = editor
        .save_as(
            &first.document_id,
            saved_hash,
            "/workspace/copy.json",
            "{\"name\":\"copy\"}\n",
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(saved_as.status, SaveStatus::Saved);
    assert!(saved_as.verified);
    assert_eq!(
        read_test_file(&first_server.files, path),
        b"{\"name\":\"updated\"}\r\n"
    );
    assert_eq!(
        read_test_file(&first_server.files, "/workspace/copy.json"),
        b"{\"name\":\"copy\"}\r\n"
    );
    assert!(
        editor
            .path_or_descendant_is_open(&first_session, "/workspace/copy.json")
            .await
    );

    let conflict_baseline = saved_as.new_sha256.unwrap();
    first_server
        .files
        .lock()
        .expect("test files lock")
        .get_mut("/workspace/copy.json")
        .unwrap()
        .bytes = b"{\"name\":\"outside\"}\r\n".to_vec();
    let conflict = editor
        .save(
            &first.document_id,
            &conflict_baseline,
            "{\"name\":\"draft\"}\n",
            &uuid::Uuid::new_v4().to_string(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(conflict.status, SaveStatus::Conflict);
    assert_eq!(
        read_test_file(&first_server.files, "/workspace/copy.json"),
        b"{\"name\":\"outside\"}\r\n"
    );

    editor.close_all().await;
    sftp.close_session(&first_session).await;
    sftp.close_session(&second_session).await;
    sessions.disconnect(&first_session).await.unwrap();
    sessions.disconnect(&second_session).await.unwrap();
    first_server.task.abort();
    second_server.task.abort();
    std::fs::remove_dir_all(test_directory).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "仅用于手动原生 UI 联调；启动后按 Ctrl-C 停止"]
async fn isolated_ui_fixture_for_manual_editor_testing() {
    let path = "/workspace/phase4b3-demo.json";
    let server = start_server(
        path,
        b"{\r\n  \"phase\": \"Phase 4B-3\",\r\n  \"data\": \"loopback SSH/SFTP test file\"\r\n}\r\n",
    )
    .await;
    server.files.lock().expect("test files lock").insert(
        "/workspace/notes.md".to_owned(),
        StoredFile {
            bytes: b"# Isolated editor fixture\r\n\r\nThis file is served over local SSH/SFTP.\r\n"
                .to_vec(),
            permissions: FileMode::REG.bits() | 0o644,
            uid: 1000,
            gid: 1000,
            mtime: 1_800_000_000,
        },
    );
    println!("ISOLATED_UI_FIXTURE host=127.0.0.1 port={}", server.port);
    println!("ISOLATED_UI_FIXTURE username={TEST_USERNAME} password={TEST_PASSWORD}");
    println!(
        "ISOLATED_UI_FIXTURE fingerprint={}",
        server.identity.fingerprint_sha256
    );
    println!("ISOLATED_UI_FIXTURE remote_path={path}");
    println!("ISOLATED_UI_FIXTURE press Ctrl-C to stop the loopback-only server");
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
