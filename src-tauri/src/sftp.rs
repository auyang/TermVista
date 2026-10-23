use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, FileType, StatusCode},
};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, Semaphore, oneshot},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ssh::{SessionManager, SessionTermination, SshError, SshErrorCode};

const SFTP_TIMEOUT: Duration = Duration::from_secs(15);
const DELETE_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const MAX_FILES_PER_TRANSFER_REQUEST: usize = 100;
const MAX_QUEUED_TRANSFERS_PER_SESSION: usize = 100;
const MAX_TRANSFER_HISTORY: usize = 500;
const MAX_AI_TEXT_FILE_BYTES: usize = 64 * 1024;
const MAX_LOCAL_GRANTS_PER_SESSION: usize = 64;
const MAX_CONCURRENT_TRANSFERS: usize = 4;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub path: String,
    pub name: String,
    pub kind: RemoteEntryKind,
    pub size_bytes: Option<u64>,
    pub modified_at_epoch_ms: Option<u64>,
    pub permissions: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner_label: Option<String>,
    pub group_label: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpOpenResult {
    pub current_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRootGrantResult {
    pub grant_id: String,
    pub current_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub relative_path: String,
    pub name: String,
    pub kind: RemoteEntryKind,
    pub size_bytes: Option<u64>,
    pub modified_at_epoch_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedLocalFile {
    pub grant_id: String,
    pub relative_path: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConfirmation {
    pub operation_id: String,
    pub server_name: String,
    pub path: String,
    pub kind: RemoteEntryKind,
    pub affected_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpError {
    pub code: SftpErrorCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SftpErrorCode {
    NotSupported,
    PermissionDenied,
    NotFound,
    AlreadyExists,
    Conflict,
    Disconnected,
    Timeout,
    Canceled,
    InvalidRemotePath,
    TransferIncomplete,
    Other,
}

#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    AwaitingConflict,
    Running,
    Completed,
    Failed,
    Canceled,
    Skipped,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub source_path: String,
    pub destination_path: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bytes_per_sec: Option<u64>,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub conflict_path: Option<String>,
    pub warning: Option<String>,
}

struct TransferRecord {
    session_id: String,
    local_grant_id: String,
    progress: Mutex<TransferProgress>,
    channel: Channel<TransferProgress>,
    cancellation: CancellationToken,
    conflict_sender: Mutex<Option<oneshot::Sender<ConflictPolicy>>>,
}

impl TransferRecord {
    async fn update(&self, update: impl FnOnce(&mut TransferProgress)) {
        let event = {
            let mut progress = self.progress.lock().await;
            update(&mut progress);
            progress.clone()
        };
        let _ = self.channel.send(event);
    }
}

struct TransferTask {
    session: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    direction: TransferDirection,
    source_path: String,
    destination_path: String,
}

impl SftpError {
    fn new(code: SftpErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_ssh(error: SshError) -> Self {
        let code = match error.code {
            SshErrorCode::SessionNotFound | SshErrorCode::SessionClosed => {
                SftpErrorCode::Disconnected
            }
            SshErrorCode::ConnectionTimeout => SftpErrorCode::Timeout,
            SshErrorCode::ChannelOpenFailed => SftpErrorCode::NotSupported,
            _ => SftpErrorCode::Other,
        };
        Self::new(code, error.message)
    }
}

impl From<russh_sftp::client::error::Error> for SftpError {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        match error {
            russh_sftp::client::error::Error::Status(status) => {
                let code = match status.status_code {
                    StatusCode::NoSuchFile => SftpErrorCode::NotFound,
                    StatusCode::PermissionDenied => SftpErrorCode::PermissionDenied,
                    StatusCode::OpUnsupported => SftpErrorCode::NotSupported,
                    StatusCode::NoConnection | StatusCode::ConnectionLost => {
                        SftpErrorCode::Disconnected
                    }
                    StatusCode::Failure
                        if status.error_message.to_ascii_lowercase().contains("exist") =>
                    {
                        SftpErrorCode::AlreadyExists
                    }
                    _ => SftpErrorCode::Other,
                };
                Self::new(code, status.error_message)
            }
            russh_sftp::client::error::Error::Timeout => {
                Self::new(SftpErrorCode::Timeout, "SFTP 服务器响应超时。")
            }
            russh_sftp::client::error::Error::IO(message) => {
                Self::new(SftpErrorCode::Disconnected, message)
            }
            russh_sftp::client::error::Error::UnexpectedBehavior(message)
                if message.contains("sender dropped") =>
            {
                Self::new(
                    SftpErrorCode::NotSupported,
                    "服务器未能启动 SFTP 子系统，SSH 终端仍可正常使用。",
                )
            }
            other => Self::new(SftpErrorCode::Other, other.to_string()),
        }
    }
}

struct ConfirmedDelete {
    session_id: String,
    path: String,
    kind: RemoteEntryKind,
    expires_at: tokio::time::Instant,
}

#[derive(Clone)]
struct LocalRootGrant {
    session_id: String,
    root: PathBuf,
}

#[derive(Default)]
struct SftpInner {
    sessions: HashMap<String, Arc<SftpSession>>,
    delete_confirmations: HashMap<String, ConfirmedDelete>,
    transfers: HashMap<String, Arc<TransferRecord>>,
    transfer_queues: HashMap<String, Arc<Semaphore>>,
    pending_transfers: HashMap<String, usize>,
    queue_conflict_policies: HashMap<String, ConflictPolicy>,
    local_grants: HashMap<String, LocalRootGrant>,
}

pub struct SftpManager {
    ssh: Arc<SessionManager>,
    inner: Mutex<SftpInner>,
    global_transfer_queue: Arc<Semaphore>,
}

impl SftpManager {
    pub fn new(ssh: Arc<SessionManager>) -> Self {
        Self {
            ssh,
            inner: Mutex::new(SftpInner::default()),
            global_transfer_queue: Arc::new(Semaphore::new(MAX_CONCURRENT_TRANSFERS)),
        }
    }

    pub async fn open(
        self: &Arc<Self>,
        session_id: &str,
        on_status: Channel<SftpStatus>,
    ) -> Result<SftpOpenResult, SftpError> {
        let existing = self.inner.lock().await.sessions.get(session_id).cloned();
        if let Some(session) = existing {
            let current_path = tokio::time::timeout(SFTP_TIMEOUT, session.canonicalize("."))
                .await
                .map_err(|_| {
                    SftpError::new(SftpErrorCode::Timeout, "读取 SFTP 当前目录超时。")
                })??;
            return Ok(SftpOpenResult { current_path });
        }

        let stream = self
            .ssh
            .open_sftp_stream(session_id)
            .await
            .map_err(SftpError::from_ssh)?;
        let session = Arc::new(
            tokio::time::timeout(SFTP_TIMEOUT, SftpSession::new(stream))
                .await
                .map_err(|_| {
                    SftpError::new(SftpErrorCode::Timeout, "初始化 SFTP 子系统超时。")
                })??,
        );
        let current_path = tokio::time::timeout(SFTP_TIMEOUT, session.canonicalize("."))
            .await
            .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "读取 SFTP 当前目录超时。"))??;
        let mut termination = self
            .ssh
            .termination_receiver(session_id)
            .await
            .map_err(SftpError::from_ssh)?;
        self.inner
            .lock()
            .await
            .sessions
            .insert(session_id.to_owned(), Arc::clone(&session));

        let manager = Arc::downgrade(self);
        let watched_session_id = session_id.to_owned();
        tauri::async_runtime::spawn(async move {
            while *termination.borrow_and_update() == SessionTermination::Running {
                if termination.changed().await.is_err() {
                    break;
                }
            }
            if let Some(manager) = manager.upgrade() {
                manager.close_session(&watched_session_id).await;
                let _ = on_status.send(SftpStatus {
                    session_id: watched_session_id,
                    state: "disconnected".to_owned(),
                    message: Some("SSH 会话已断开，SFTP 上下文已清理。".to_owned()),
                });
            }
        });

        Ok(SftpOpenResult { current_path })
    }

    pub async fn close_session(&self, session_id: &str) {
        let (session, transfers) = {
            let mut inner = self.inner.lock().await;
            inner
                .delete_confirmations
                .retain(|_, confirmation| confirmation.session_id != session_id);
            let transfers = inner
                .transfers
                .values()
                .filter(|record| record.session_id == session_id)
                .cloned()
                .collect::<Vec<_>>();
            inner.transfer_queues.remove(session_id);
            inner.pending_transfers.remove(session_id);
            inner.queue_conflict_policies.remove(session_id);
            inner
                .local_grants
                .retain(|_, grant| grant.session_id != session_id);
            (inner.sessions.remove(session_id), transfers)
        };
        for transfer in transfers {
            transfer.cancellation.cancel();
        }
        if let Some(session) = session {
            let _ = tokio::time::timeout(Duration::from_millis(500), session.close()).await;
        }
    }

    pub async fn close_all(&self) {
        let session_ids = self
            .inner
            .lock()
            .await
            .sessions
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for session_id in session_ids {
            self.close_session(&session_id).await;
        }
    }

    pub async fn list_dir(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<RemoteEntry>, SftpError> {
        let session = self.get_session(session_id).await?;
        let path = resolve_directory(&session, path).await?;
        let mut entries = tokio::time::timeout(SFTP_TIMEOUT, session.read_dir(path.clone()))
            .await
            .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "读取远程目录超时。"))??;
        let mut result = Vec::new();
        for entry in &mut entries {
            let name = entry.file_name();
            if validate_name(&name).is_err() {
                continue;
            }
            let entry_path = remote_join(&path, &name);
            result.push(remote_entry(entry_path, name, entry.metadata()));
        }
        Ok(result)
    }

    pub async fn stat(&self, session_id: &str, path: &str) -> Result<RemoteEntry, SftpError> {
        let session = self.get_session(session_id).await?;
        let path = resolve_remote_path(&session, path).await?;
        let metadata = tokio::time::timeout(SFTP_TIMEOUT, session.symlink_metadata(path.clone()))
            .await
            .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "读取远程文件属性超时。"))??;
        let name = remote_basename(&path).unwrap_or_else(|| "/".to_owned());
        Ok(remote_entry(path, name, metadata))
    }

    pub async fn read_text_for_ai(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<String, SftpError> {
        let operation = async {
            if path.len() > 4096 {
                return Err(SftpError::new(
                    SftpErrorCode::InvalidRemotePath,
                    "远程文件路径超过 AI 文本预览上限。",
                ));
            }
            let session = self.get_session(session_id).await?;
            let path = resolve_remote_path(&session, path).await?;
            if is_sensitive_ai_path(&path) {
                return Err(SftpError::new(
                    SftpErrorCode::PermissionDenied,
                    "出于安全考虑，AI 不读取 SSH 凭据、私钥、环境密钥或系统敏感目录。",
                ));
            }
            let metadata = session.symlink_metadata(path.clone()).await?;
            if metadata.file_type() != FileType::File {
                return Err(SftpError::new(
                    SftpErrorCode::InvalidRemotePath,
                    "AI 只读预览仅支持普通文本文件，不读取目录、符号链接或特殊文件。",
                ));
            }
            if metadata
                .size
                .is_some_and(|size| size > MAX_AI_TEXT_FILE_BYTES as u64)
            {
                return Err(SftpError::new(
                    SftpErrorCode::TransferIncomplete,
                    "文件超过 AI 文本预览的 64 KiB 上限。",
                ));
            }

            let mut file = session.open(path).await?;
            let opened_metadata = file.metadata().await?;
            if opened_metadata.file_type() != FileType::File {
                return Err(SftpError::new(
                    SftpErrorCode::InvalidRemotePath,
                    "打开的远程对象不是普通文件。",
                ));
            }
            if opened_metadata
                .size
                .is_some_and(|size| size > MAX_AI_TEXT_FILE_BYTES as u64)
            {
                return Err(SftpError::new(
                    SftpErrorCode::TransferIncomplete,
                    "文件超过 AI 文本预览的 64 KiB 上限。",
                ));
            }

            let mut bytes = Vec::with_capacity(
                opened_metadata
                    .size
                    .unwrap_or_default()
                    .min(MAX_AI_TEXT_FILE_BYTES as u64) as usize,
            );
            let mut buffer = [0u8; 8192];
            loop {
                let count = file.read(&mut buffer).await.map_err(|_| {
                    SftpError::new(SftpErrorCode::Disconnected, "读取远程文本文件失败。")
                })?;
                if count == 0 {
                    break;
                }
                if bytes.len().saturating_add(count) > MAX_AI_TEXT_FILE_BYTES {
                    return Err(SftpError::new(
                        SftpErrorCode::TransferIncomplete,
                        "文件超过 AI 文本预览的 64 KiB 上限。",
                    ));
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            file.close().await.map_err(|_| {
                SftpError::new(SftpErrorCode::Disconnected, "关闭远程文本文件失败。")
            })?;
            decode_ai_text(bytes)
        };

        tokio::time::timeout(SFTP_TIMEOUT, operation)
            .await
            .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "读取远程文本文件超时。"))?
    }

    pub async fn mkdir(&self, session_id: &str, parent: &str, name: &str) -> Result<(), SftpError> {
        validate_name(name)?;
        let session = self.get_session(session_id).await?;
        let parent = resolve_directory(&session, parent).await?;
        let target = remote_join(&parent, name);
        if session.try_exists(target.clone()).await? {
            return Err(SftpError::new(
                SftpErrorCode::AlreadyExists,
                "同名远程路径已存在。",
            ));
        }
        session.create_dir(target).await?;
        Ok(())
    }

    pub async fn rename(
        &self,
        session_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<String, SftpError> {
        validate_name(new_name)?;
        let session = self.get_session(session_id).await?;
        let path = resolve_remote_path(&session, path).await?;
        if path == "/" {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "不能重命名根目录。",
            ));
        }
        let parent = remote_parent(&path);
        let target = remote_join(&parent, new_name);
        if session.try_exists(target.clone()).await? {
            return Err(SftpError::new(
                SftpErrorCode::AlreadyExists,
                "目标名称已存在，未执行重命名。",
            ));
        }
        session.rename(path, target.clone()).await?;
        Ok(target)
    }

    pub async fn prepare_delete(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<DeleteConfirmation, SftpError> {
        let session = self.get_session(session_id).await?;
        let path = resolve_remote_path(&session, path).await?;
        if path == "/" {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "不能删除远程根目录。",
            ));
        }
        let metadata = session.symlink_metadata(path.clone()).await?;
        let entry = remote_entry(
            path.clone(),
            remote_basename(&path).unwrap_or_default(),
            metadata,
        );
        if entry.kind == RemoteEntryKind::Directory {
            let mut children = session.read_dir(path.clone()).await?;
            if children.next().is_some() {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "目录非空；Phase 2A 只允许删除空目录。",
                ));
            }
        }
        let server_name = self
            .ssh
            .sessions()
            .await
            .into_iter()
            .find(|summary| summary.session_id == session_id)
            .map(|summary| format!("{}:{}", summary.host, summary.port))
            .unwrap_or_else(|| "当前 SSH 会话".to_owned());
        let operation_id = Uuid::new_v4().to_string();
        self.inner.lock().await.delete_confirmations.insert(
            operation_id.clone(),
            ConfirmedDelete {
                session_id: session_id.to_owned(),
                path: path.clone(),
                kind: entry.kind,
                expires_at: tokio::time::Instant::now() + DELETE_CONFIRMATION_TIMEOUT,
            },
        );
        Ok(DeleteConfirmation {
            operation_id,
            server_name,
            path,
            kind: entry.kind,
            affected_count: 1,
        })
    }

    pub async fn delete(&self, session_id: &str, operation_id: &str) -> Result<(), SftpError> {
        let confirmation = self
            .inner
            .lock()
            .await
            .delete_confirmations
            .remove(operation_id)
            .ok_or_else(|| {
                SftpError::new(SftpErrorCode::Conflict, "删除确认已失效，请重新发起操作。")
            })?;
        if confirmation.session_id != session_id
            || confirmation.expires_at < tokio::time::Instant::now()
        {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "删除确认已过期或不属于当前服务器。",
            ));
        }
        let session = self.get_session(session_id).await?;
        let metadata = session.symlink_metadata(confirmation.path.clone()).await?;
        let current = entry_kind(metadata.file_type());
        if current != confirmation.kind {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "目标类型已变化，请重新确认删除。",
            ));
        }
        match confirmation.kind {
            RemoteEntryKind::Directory => session.remove_dir(confirmation.path).await?,
            _ => session.remove_file(confirmation.path).await?,
        }
        Ok(())
    }

    pub async fn confirmed_delete_path(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> Result<String, SftpError> {
        let inner = self.inner.lock().await;
        let confirmation = inner
            .delete_confirmations
            .get(operation_id)
            .ok_or_else(|| {
                SftpError::new(SftpErrorCode::Conflict, "删除确认已失效，请重新发起操作。")
            })?;
        if confirmation.session_id != session_id
            || confirmation.expires_at < tokio::time::Instant::now()
        {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "删除确认已过期或不属于当前服务器。",
            ));
        }
        Ok(confirmation.path.clone())
    }

    pub async fn start_transfers(
        self: &Arc<Self>,
        session_id: &str,
        direction: TransferDirection,
        local_grant_id: &str,
        source_paths: Vec<String>,
        destination_directory: &str,
        on_progress: Channel<TransferProgress>,
    ) -> Result<Vec<String>, SftpError> {
        if source_paths.is_empty() || source_paths.len() > MAX_FILES_PER_TRANSFER_REQUEST {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                format!("每次只能传输 1 到 {MAX_FILES_PER_TRANSFER_REQUEST} 个文件。"),
            ));
        }
        let session = self.get_session(session_id).await?;
        let local_grant = self.get_local_grant(session_id, local_grant_id).await?;
        let destination_directory = match direction {
            TransferDirection::Upload => resolve_directory(&session, destination_directory).await?,
            TransferDirection::Download => {
                let destination =
                    resolve_local_directory(&local_grant, destination_directory).await?;
                destination.to_string_lossy().into_owned()
            }
        };

        let mut prepared = Vec::with_capacity(source_paths.len());
        for source in source_paths {
            let (source_path, destination_path, bytes_total) = match direction {
                TransferDirection::Upload => {
                    let source_path = resolve_local_file(&local_grant, &source).await?;
                    let metadata = fs::symlink_metadata(&source_path)
                        .await
                        .map_err(local_error)?;
                    if metadata.file_type().is_symlink() || !metadata.is_file() {
                        return Err(SftpError::new(
                            SftpErrorCode::Conflict,
                            "本地来源已变化为链接或非普通文件，未加入传输队列。",
                        ));
                    }
                    let name = local_basename(&source_path)?;
                    let destination = remote_join(&destination_directory, &name);
                    (
                        source_path.to_string_lossy().into_owned(),
                        destination,
                        Some(metadata.len()),
                    )
                }
                TransferDirection::Download => {
                    let source_path = resolve_remote_path(&session, &source).await?;
                    let metadata = session.symlink_metadata(source_path.clone()).await?;
                    if metadata.file_type() != FileType::File {
                        return Err(SftpError::new(
                            SftpErrorCode::Conflict,
                            "为避免跨越链接或读取特殊文件，下载仅支持普通文件；文件夹与符号链接已拒绝。",
                        ));
                    }
                    let name = safe_download_basename(&source_path)?;
                    let destination = Path::new(&destination_directory)
                        .join(name)
                        .to_string_lossy()
                        .into_owned();
                    (source_path, destination, metadata.size)
                }
            };
            prepared.push((source_path, destination_path, bytes_total));
        }

        let (queue, tasks) = {
            let mut inner = self.inner.lock().await;
            let pending = inner
                .pending_transfers
                .get(session_id)
                .copied()
                .unwrap_or(0);
            if pending + prepared.len() > MAX_QUEUED_TRANSFERS_PER_SESSION {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "当前服务器的 SFTP 传输队列已满。",
                ));
            }
            if inner.transfers.len() + prepared.len() > MAX_TRANSFER_HISTORY {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "传输历史已满，请先清理已完成的任务。",
                ));
            }
            let queue = Arc::clone(
                inner
                    .transfer_queues
                    .entry(session_id.to_owned())
                    .or_insert_with(|| Arc::new(Semaphore::new(1))),
            );
            *inner
                .pending_transfers
                .entry(session_id.to_owned())
                .or_default() += prepared.len();
            let tasks = prepared
                .into_iter()
                .map(|(source_path, destination_path, bytes_total)| {
                    let transfer_id = Uuid::new_v4().to_string();
                    let progress = TransferProgress {
                        transfer_id: transfer_id.clone(),
                        session_id: session_id.to_owned(),
                        direction,
                        source_path: source_path.clone(),
                        destination_path: destination_path.clone(),
                        bytes_done: 0,
                        bytes_total,
                        speed_bytes_per_sec: None,
                        status: TransferStatus::Queued,
                        error: None,
                        conflict_path: None,
                        warning: None,
                    };
                    let record = Arc::new(TransferRecord {
                        session_id: session_id.to_owned(),
                        local_grant_id: local_grant_id.to_owned(),
                        progress: Mutex::new(progress.clone()),
                        channel: on_progress.clone(),
                        cancellation: CancellationToken::new(),
                        conflict_sender: Mutex::new(None),
                    });
                    let _ = on_progress.send(progress);
                    inner
                        .transfers
                        .insert(transfer_id.clone(), Arc::clone(&record));
                    TransferTask {
                        session: Arc::clone(&session),
                        record,
                        direction,
                        source_path,
                        destination_path,
                    }
                })
                .collect::<Vec<_>>();
            (queue, tasks)
        };
        let mut transfer_ids = Vec::with_capacity(tasks.len());
        for task in &tasks {
            transfer_ids.push(task.record.progress.lock().await.transfer_id.clone());
        }
        for task in tasks {
            let manager = Arc::clone(self);
            let queue = Arc::clone(&queue);
            let global_queue = Arc::clone(&self.global_transfer_queue);
            tauri::async_runtime::spawn(async move {
                manager.run_transfer(task, queue, global_queue).await;
            });
        }
        Ok(transfer_ids)
    }

    pub async fn resolve_transfer(
        &self,
        transfer_id: &str,
        policy: ConflictPolicy,
        apply_to_queue: bool,
    ) -> Result<(), SftpError> {
        let transfer = self.get_transfer(transfer_id).await?;
        let sender = transfer
            .conflict_sender
            .lock()
            .await
            .take()
            .ok_or_else(|| {
                SftpError::new(SftpErrorCode::Conflict, "此传输任务当前没有等待冲突处理。")
            })?;
        let previous_policy = if apply_to_queue {
            self.inner
                .lock()
                .await
                .queue_conflict_policies
                .insert(transfer.session_id.clone(), policy)
        } else {
            None
        };
        if sender.send(policy).is_err() {
            if apply_to_queue {
                let mut inner = self.inner.lock().await;
                if let Some(previous) = previous_policy {
                    inner
                        .queue_conflict_policies
                        .insert(transfer.session_id.clone(), previous);
                } else {
                    inner.queue_conflict_policies.remove(&transfer.session_id);
                }
            }
            return Err(SftpError::new(
                SftpErrorCode::Canceled,
                "传输任务已结束，无法处理冲突。",
            ));
        }
        Ok(())
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> Result<(), SftpError> {
        let transfer = self.get_transfer(transfer_id).await?;
        transfer.cancellation.cancel();
        Ok(())
    }

    pub async fn retry_transfer(
        self: &Arc<Self>,
        transfer_id: &str,
        on_progress: Channel<TransferProgress>,
    ) -> Result<Vec<String>, SftpError> {
        let transfer = self.get_transfer(transfer_id).await?;
        let progress = transfer.progress.lock().await.clone();
        if !matches!(
            progress.status,
            TransferStatus::Failed | TransferStatus::Canceled
        ) {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "只有失败或已取消的传输任务可以重试；任务目标和连接状态会重新校验。",
            ));
        }
        let grant = self
            .get_local_grant(&progress.session_id, &transfer.local_grant_id)
            .await?;
        let (sources, destination_directory) = match progress.direction {
            TransferDirection::Upload => {
                let absolute = PathBuf::from(&progress.source_path);
                let relative = absolute.strip_prefix(&grant.root).map_err(|_| {
                    SftpError::new(
                        SftpErrorCode::PermissionDenied,
                        "失败任务的本地来源已超出原授权文件夹。",
                    )
                })?;
                let relative = relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                (vec![relative], remote_parent(&progress.destination_path))
            }
            TransferDirection::Download => {
                let destination = PathBuf::from(&progress.destination_path);
                let parent = destination.parent().ok_or_else(|| {
                    SftpError::new(SftpErrorCode::InvalidRemotePath, "下载目标目录无效。")
                })?;
                let relative = parent.strip_prefix(&grant.root).map_err(|_| {
                    SftpError::new(
                        SftpErrorCode::PermissionDenied,
                        "失败任务的本地目标已超出原授权文件夹。",
                    )
                })?;
                let relative = relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                (vec![progress.source_path], relative)
            }
        };
        self.start_transfers(
            &progress.session_id,
            progress.direction,
            &transfer.local_grant_id,
            sources,
            &destination_directory,
            on_progress,
        )
        .await
    }

    pub async fn list_transfers(&self, session_id: &str) -> Vec<TransferProgress> {
        let records = self
            .inner
            .lock()
            .await
            .transfers
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        for record in records {
            let progress = record.progress.lock().await.clone();
            if progress.session_id == session_id {
                result.push(progress);
            }
        }
        result.sort_by(|left, right| left.transfer_id.cmp(&right.transfer_id));
        result
    }

    pub async fn clear_completed_transfers(&self, session_id: &str) {
        let mut inner = self.inner.lock().await;
        let mut remove_ids = Vec::new();
        for (transfer_id, record) in &inner.transfers {
            let progress = record.progress.lock().await;
            if progress.session_id == session_id
                && matches!(
                    progress.status,
                    TransferStatus::Completed
                        | TransferStatus::Failed
                        | TransferStatus::Canceled
                        | TransferStatus::Skipped
                )
            {
                remove_ids.push(transfer_id.clone());
            }
        }
        for transfer_id in remove_ids {
            inner.transfers.remove(&transfer_id);
        }
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Arc<SftpSession>, SftpError> {
        self.inner
            .lock()
            .await
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                SftpError::new(
                    SftpErrorCode::Disconnected,
                    "当前 SSH 标签尚未打开 SFTP 子系统。",
                )
            })
    }

    pub async fn grant_local_root(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<LocalRootGrantResult, SftpError> {
        self.get_session(session_id).await?;
        let selected_metadata = fs::symlink_metadata(path).await.map_err(local_error)?;
        if !selected_metadata.is_dir() || selected_metadata.file_type().is_symlink() {
            return Err(SftpError::new(
                SftpErrorCode::PermissionDenied,
                "本地授权路径必须是实际文件夹，不能是符号链接。",
            ));
        }
        let root = fs::canonicalize(path).await.map_err(local_error)?;
        let grant_id = Uuid::new_v4().to_string();
        {
            let mut inner = self.inner.lock().await;
            if inner
                .local_grants
                .values()
                .filter(|grant| grant.session_id == session_id)
                .count()
                >= MAX_LOCAL_GRANTS_PER_SESSION
            {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "当前 SSH 会话的本地授权数量已达上限，请重新连接后再授权。",
                ));
            }
            inner.local_grants.insert(
                grant_id.clone(),
                LocalRootGrant {
                    session_id: session_id.to_owned(),
                    root: root.clone(),
                },
            );
        }
        Ok(LocalRootGrantResult {
            grant_id,
            current_path: root.to_string_lossy().into_owned(),
        })
    }

    pub async fn grant_local_files(
        &self,
        session_id: &str,
        paths: Vec<String>,
    ) -> Result<Vec<GrantedLocalFile>, SftpError> {
        self.get_session(session_id).await?;
        if paths.is_empty() || paths.len() > MAX_FILES_PER_TRANSFER_REQUEST {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                format!("一次最多拖入 {MAX_FILES_PER_TRANSFER_REQUEST} 个文件。"),
            ));
        }
        let mut roots = HashMap::<PathBuf, String>::new();
        let mut granted = Vec::with_capacity(paths.len());
        for raw_path in paths {
            let selected = PathBuf::from(&raw_path);
            let selected_metadata = fs::symlink_metadata(&selected).await.map_err(local_error)?;
            if selected_metadata.file_type().is_symlink() || !selected_metadata.is_file() {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "系统拖入目前仅支持普通文件；文件夹和符号链接不会自动递归或跟随。",
                ));
            }
            let canonical = fs::canonicalize(&selected).await.map_err(local_error)?;
            let parent = canonical
                .parent()
                .ok_or_else(|| {
                    SftpError::new(
                        SftpErrorCode::InvalidRemotePath,
                        "无法确定拖入文件的本地父文件夹。",
                    )
                })?
                .to_path_buf();
            let grant_id = if let Some(grant_id) = roots.get(&parent) {
                grant_id.clone()
            } else {
                let grant_id = Uuid::new_v4().to_string();
                roots.insert(parent, grant_id.clone());
                grant_id
            };
            let name = local_basename(&canonical)?;
            granted.push(GrantedLocalFile {
                grant_id,
                relative_path: name.clone(),
                name,
            });
        }
        let mut inner = self.inner.lock().await;
        let active_grants = inner
            .local_grants
            .values()
            .filter(|grant| grant.session_id == session_id)
            .count();
        if active_grants + roots.len() > MAX_LOCAL_GRANTS_PER_SESSION {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "当前 SSH 会话的本地授权数量已达上限。",
            ));
        }
        for (root, grant_id) in roots {
            inner.local_grants.insert(
                grant_id,
                LocalRootGrant {
                    session_id: session_id.to_owned(),
                    root,
                },
            );
        }
        Ok(granted)
    }

    pub async fn list_local_dir(
        &self,
        session_id: &str,
        grant_id: &str,
        relative_path: &str,
    ) -> Result<Vec<LocalEntry>, SftpError> {
        self.get_session(session_id).await?;
        let grant = self.get_local_grant(session_id, grant_id).await?;
        let directory = resolve_local_directory(&grant, relative_path).await?;
        let mut reader = fs::read_dir(directory).await.map_err(local_error)?;
        let mut entries = Vec::new();
        while let Some(entry) = reader.next_entry().await.map_err(local_error)? {
            if entries.len() >= 5000 {
                return Err(SftpError::new(
                    SftpErrorCode::Conflict,
                    "本地目录超过 5000 项，请先缩小到较小的子目录。",
                ));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .await
                .map_err(local_error)?;
            let kind = if metadata.file_type().is_symlink() {
                RemoteEntryKind::Symlink
            } else if metadata.is_dir() {
                RemoteEntryKind::Directory
            } else if metadata.is_file() {
                RemoteEntryKind::File
            } else {
                RemoteEntryKind::Other
            };
            let mut relative = PathBuf::from(relative_path);
            if relative_path.is_empty() {
                relative.clear();
            }
            relative.push(&name);
            entries.push(LocalEntry {
                relative_path: relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
                name,
                kind,
                size_bytes: metadata.is_file().then_some(metadata.len()),
                modified_at_epoch_ms: metadata.modified().ok().and_then(system_time_epoch_ms),
            });
        }
        Ok(entries)
    }

    async fn get_local_grant(
        &self,
        session_id: &str,
        grant_id: &str,
    ) -> Result<LocalRootGrant, SftpError> {
        let inner = self.inner.lock().await;
        find_local_grant(&inner.local_grants, session_id, grant_id)
            .cloned()
            .ok_or_else(|| {
                SftpError::new(
                    SftpErrorCode::PermissionDenied,
                    "本地目录授权不存在、已过期或不属于当前 SSH 会话，请重新选择文件夹。",
                )
            })
    }

    async fn get_transfer(&self, transfer_id: &str) -> Result<Arc<TransferRecord>, SftpError> {
        self.inner
            .lock()
            .await
            .transfers
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| SftpError::new(SftpErrorCode::NotFound, "传输任务不存在或已清理。"))
    }

    pub async fn transfer_session_id(&self, transfer_id: &str) -> Result<String, SftpError> {
        let transfer = self.get_transfer(transfer_id).await?;
        Ok(transfer.progress.lock().await.session_id.clone())
    }

    async fn run_transfer(
        self: Arc<Self>,
        task: TransferTask,
        queue: Arc<Semaphore>,
        global_queue: Arc<Semaphore>,
    ) {
        let session_id = task.record.progress.lock().await.session_id.clone();
        self.run_transfer_inner(&task, queue, global_queue).await;
        let mut inner = self.inner.lock().await;
        if let Some(pending) = inner.pending_transfers.get_mut(&session_id) {
            *pending = pending.saturating_sub(1);
            if *pending == 0 {
                inner.pending_transfers.remove(&session_id);
                inner.queue_conflict_policies.remove(&session_id);
            }
        }
    }

    async fn run_transfer_inner(
        &self,
        task: &TransferTask,
        queue: Arc<Semaphore>,
        global_queue: Arc<Semaphore>,
    ) {
        let record = &task.record;
        let permit = tokio::select! {
            _ = record.cancellation.cancelled() => {
                record.update(|progress| progress.status = TransferStatus::Canceled).await;
                return;
            }
            result = queue.acquire_owned() => match result {
                Ok(permit) => permit,
                Err(_) => {
                    record.update(|progress| {
                        progress.status = TransferStatus::Failed;
                        progress.error = Some("传输队列已关闭。".to_owned());
                    }).await;
                    return;
                }
            }
        };
        let _global_permit = tokio::select! {
            _ = record.cancellation.cancelled() => {
                record.update(|progress| progress.status = TransferStatus::Canceled).await;
                drop(permit);
                return;
            }
            result = global_queue.acquire_owned() => match result {
                Ok(permit) => permit,
                Err(_) => {
                    record.update(|progress| {
                        progress.status = TransferStatus::Failed;
                        progress.error = Some("全局传输队列已关闭。".to_owned());
                    }).await;
                    drop(permit);
                    return;
                }
            }
        };
        if record.cancellation.is_cancelled() {
            record
                .update(|progress| progress.status = TransferStatus::Canceled)
                .await;
            drop(permit);
            return;
        }

        let target_exists = match task.direction {
            TransferDirection::Upload => {
                remote_path_exists(task.session.as_ref(), &task.destination_path).await
            }
            TransferDirection::Download => local_path_exists(&task.destination_path).await,
        };
        let target_exists = match target_exists {
            Ok(value) => value,
            Err(error) => {
                record
                    .update(|progress| {
                        progress.status = TransferStatus::Failed;
                        progress.error = Some(error.message);
                    })
                    .await;
                drop(permit);
                return;
            }
        };

        let mut destination_path = task.destination_path.clone();
        let mut overwrite = false;
        if target_exists {
            let queued_policy = self
                .inner
                .lock()
                .await
                .queue_conflict_policies
                .get(&record.session_id)
                .copied();
            let policy = if let Some(policy) = queued_policy {
                Some(policy)
            } else {
                let (sender, receiver) = oneshot::channel();
                *record.conflict_sender.lock().await = Some(sender);
                record
                    .update(|progress| {
                        progress.status = TransferStatus::AwaitingConflict;
                        progress.conflict_path = Some(destination_path.clone());
                    })
                    .await;
                let policy = tokio::select! {
                    _ = record.cancellation.cancelled() => None,
                    result = receiver => result.ok(),
                };
                *record.conflict_sender.lock().await = None;
                policy
            };
            let Some(policy) = policy else {
                record
                    .update(|progress| progress.status = TransferStatus::Canceled)
                    .await;
                drop(permit);
                return;
            };
            match policy {
                ConflictPolicy::Skip => {
                    record
                        .update(|progress| {
                            progress.status = TransferStatus::Skipped;
                            progress.conflict_path = None;
                        })
                        .await;
                    drop(permit);
                    return;
                }
                ConflictPolicy::Overwrite => {
                    overwrite = true;
                    if let Err(error) = self
                        .ensure_overwritable(
                            task.direction,
                            &destination_path,
                            task.session.as_ref(),
                        )
                        .await
                    {
                        record
                            .update(|progress| {
                                progress.status = TransferStatus::Failed;
                                progress.error = Some(error.message);
                            })
                            .await;
                        drop(permit);
                        return;
                    }
                }
                ConflictPolicy::Rename => {
                    match self
                        .unique_destination(
                            task.direction,
                            &destination_path,
                            task.session.as_ref(),
                        )
                        .await
                    {
                        Ok(path) => destination_path = path,
                        Err(error) => {
                            record
                                .update(|progress| {
                                    progress.status = TransferStatus::Failed;
                                    progress.error = Some(error.message);
                                })
                                .await;
                            drop(permit);
                            return;
                        }
                    }
                }
            }
        }

        record
            .update(|progress| {
                progress.status = TransferStatus::Running;
                progress.destination_path = destination_path.clone();
                progress.conflict_path = None;
                progress.error = None;
            })
            .await;
        let result = match task.direction {
            TransferDirection::Upload => self.upload_file(task, &destination_path, overwrite).await,
            TransferDirection::Download => {
                self.download_file(task, &destination_path, overwrite).await
            }
        };
        match result {
            Ok(warning) => {
                let total = record.progress.lock().await.bytes_total;
                record
                    .update(|progress| {
                        progress.status = TransferStatus::Completed;
                        progress.bytes_done = total.unwrap_or(progress.bytes_done);
                        progress.speed_bytes_per_sec = None;
                        progress.warning = warning;
                    })
                    .await;
            }
            Err(error)
                if error.code == SftpErrorCode::Canceled || record.cancellation.is_cancelled() =>
            {
                record
                    .update(|progress| {
                        progress.status = TransferStatus::Canceled;
                        progress.speed_bytes_per_sec = None;
                        progress.error = Some(error.message);
                    })
                    .await;
            }
            Err(error) => {
                record
                    .update(|progress| {
                        progress.status = TransferStatus::Failed;
                        progress.speed_bytes_per_sec = None;
                        progress.error = Some(error.message);
                    })
                    .await;
            }
        }
        drop(permit);
    }

    async fn upload_file(
        &self,
        task: &TransferTask,
        target: &str,
        overwrite: bool,
    ) -> Result<Option<String>, SftpError> {
        let mut source = File::open(&task.source_path).await.map_err(local_error)?;
        let size = source.metadata().await.map_err(local_error)?.len();
        task.record
            .update(|progress| progress.bytes_total = Some(size))
            .await;
        let parent = remote_parent(target);
        let temporary = remote_join(&parent, &format!(".ais-{}.part", Uuid::new_v4()));
        let mut destination = task
            .session
            .open_with_flags(
                temporary.clone(),
                russh_sftp::protocol::OpenFlags::CREATE
                    | russh_sftp::protocol::OpenFlags::EXCLUDE
                    | russh_sftp::protocol::OpenFlags::WRITE,
            )
            .await?;
        let copied = copy_stream(&mut source, &mut destination, &task.record, Some(size)).await;
        let finalized = if copied.is_ok() && !task.record.cancellation.is_cancelled() {
            destination.sync_all().await.map_err(SftpError::from)
        } else {
            copied
        };
        let shutdown = if finalized.is_ok() {
            destination
                .shutdown()
                .await
                .map_err(|error| io_error(error.to_string()))
        } else {
            Ok(())
        };
        drop(destination);
        if let Err(error) = finalized.and(shutdown) {
            let _ = task.session.remove_file(temporary).await;
            return Err(error);
        }
        if task.record.cancellation.is_cancelled() {
            let _ = task.session.remove_file(temporary).await;
            return Err(SftpError::new(SftpErrorCode::Canceled, "上传已取消。"));
        }
        let warning = if overwrite {
            match commit_remote_overwrite(task.session.as_ref(), &temporary, target).await {
                Ok(warning) => warning,
                Err(error) => {
                    let _ = task.session.remove_file(temporary).await;
                    return Err(error);
                }
            }
        } else {
            if let Err(error) = task
                .session
                .rename(temporary.clone(), target.to_owned())
                .await
            {
                let _ = task.session.remove_file(temporary).await;
                return Err(SftpError::from(error));
            }
            None
        };
        Ok(warning)
    }

    async fn download_file(
        &self,
        task: &TransferTask,
        target: &str,
        overwrite: bool,
    ) -> Result<Option<String>, SftpError> {
        let metadata = task
            .session
            .symlink_metadata(task.source_path.clone())
            .await?;
        if metadata.file_type() != FileType::File {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "远程下载源已变为非普通文件，传输已停止。",
            ));
        }
        let total = metadata.size;
        task.record
            .update(|progress| progress.bytes_total = total)
            .await;
        let mut source = task.session.open(task.source_path.clone()).await?;
        if source.metadata().await?.file_type() != FileType::File {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "打开的远程下载源不是普通文件，传输已停止。",
            ));
        }
        let target_path = PathBuf::from(target);
        let temporary = target_path.with_file_name(format!(".ais-{}.part", Uuid::new_v4()));
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(local_error)?;
        let copied = copy_stream(&mut source, &mut destination, &task.record, total).await;
        let finalized = if copied.is_ok() && !task.record.cancellation.is_cancelled() {
            destination.sync_all().await.map_err(local_error)
        } else {
            copied
        };
        let shutdown = if finalized.is_ok() {
            destination.shutdown().await.map_err(local_error)
        } else {
            Ok(())
        };
        drop(destination);
        if let Err(error) = finalized.and(shutdown) {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
        if task.record.cancellation.is_cancelled() {
            let _ = fs::remove_file(&temporary).await;
            return Err(SftpError::new(SftpErrorCode::Canceled, "下载已取消。"));
        }
        let result = if overwrite {
            commit_local_overwrite(&temporary, &target_path).await
        } else {
            match fs::hard_link(&temporary, &target_path).await {
                Ok(()) => {
                    fs::remove_file(&temporary).await.map_err(local_error)?;
                    Ok(None)
                }
                Err(error) => Err(local_error(error)),
            }
        };
        if result.is_err() {
            let _ = fs::remove_file(&temporary).await;
        }
        result
    }

    async fn ensure_overwritable(
        &self,
        direction: TransferDirection,
        target: &str,
        session: &SftpSession,
    ) -> Result<(), SftpError> {
        let is_directory = match direction {
            TransferDirection::Upload => {
                session.symlink_metadata(target.to_owned()).await?.is_dir()
            }
            TransferDirection::Download => fs::symlink_metadata(target)
                .await
                .map_err(local_error)?
                .is_dir(),
        };
        if is_directory {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "目标是文件夹，不能用单文件传输覆盖。",
            ));
        }
        Ok(())
    }

    async fn unique_destination(
        &self,
        direction: TransferDirection,
        target: &str,
        session: &SftpSession,
    ) -> Result<String, SftpError> {
        for index in 1..1000 {
            let parent = match direction {
                TransferDirection::Upload => remote_parent(target),
                TransferDirection::Download => Path::new(target)
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_string_lossy()
                    .into_owned(),
            };
            let name = path_basename(target).ok_or_else(|| {
                SftpError::new(SftpErrorCode::InvalidRemotePath, "目标文件名无效。")
            })?;
            let renamed = copy_name(&name, index);
            let candidate = match direction {
                TransferDirection::Upload => remote_join(&parent, &renamed),
                TransferDirection::Download => Path::new(&parent)
                    .join(renamed)
                    .to_string_lossy()
                    .into_owned(),
            };
            let exists = match direction {
                TransferDirection::Upload => remote_path_exists(session, &candidate).await?,
                TransferDirection::Download => local_path_exists(&candidate).await?,
            };
            if !exists {
                return Ok(candidate);
            }
        }
        Err(SftpError::new(
            SftpErrorCode::Conflict,
            "无法生成不冲突的文件名。",
        ))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStatus {
    pub session_id: String,
    pub state: String,
    pub message: Option<String>,
}

async fn resolve_directory(session: &SftpSession, path: &str) -> Result<String, SftpError> {
    let path = validate_remote_path(path)?;
    tokio::time::timeout(SFTP_TIMEOUT, session.canonicalize(path))
        .await
        .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "解析远程目录超时。"))?
        .map_err(Into::into)
}

fn decode_ai_text(bytes: Vec<u8>) -> Result<String, SftpError> {
    let text = String::from_utf8(bytes).map_err(|_| {
        SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "文件不是有效的 UTF-8 文本，已拒绝 AI 预览。",
        )
    })?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "文件包含二进制控制字符，已拒绝 AI 文本预览。",
        ));
    }
    Ok(text)
}

async fn resolve_remote_path(session: &SftpSession, path: &str) -> Result<String, SftpError> {
    validate_remote_path(path)?;
    if path.starts_with('/') {
        Ok(path.to_owned())
    } else {
        tokio::time::timeout(SFTP_TIMEOUT, session.canonicalize(path))
            .await
            .map_err(|_| SftpError::new(SftpErrorCode::Timeout, "解析远程路径超时。"))?
            .map_err(Into::into)
    }
}

fn validate_remote_path(path: &str) -> Result<&str, SftpError> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "远程路径为空或包含不支持的字符。",
        ));
    }
    Ok(path)
}

fn validate_name(name: &str) -> Result<(), SftpError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "名称必须是单个有效的 POSIX 路径组件。",
        ));
    }
    Ok(())
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn remote_parent(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(index) => path[..index].to_owned(),
    }
}

fn remote_basename(path: &str) -> Option<String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn safe_download_basename(path: &str) -> Result<String, SftpError> {
    if path.ends_with('/') {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "远程下载路径必须指向单个文件。",
        ));
    }
    let name = remote_basename(path)
        .ok_or_else(|| SftpError::new(SftpErrorCode::InvalidRemotePath, "远程文件名无效。"))?;
    validate_name(&name)?;
    Ok(name)
}

fn remote_entry(path: String, name: String, metadata: FileAttributes) -> RemoteEntry {
    let kind = entry_kind(metadata.file_type());
    let modified_at_epoch_ms = metadata.mtime.map(|seconds| u64::from(seconds) * 1000);
    let permissions = metadata.permissions.map(|mode| {
        let type_char = match kind {
            RemoteEntryKind::File => '-',
            RemoteEntryKind::Directory => 'd',
            RemoteEntryKind::Symlink => 'l',
            RemoteEntryKind::Other => '?',
        };
        let bits = mode & 0o777;
        let mut text = String::with_capacity(10);
        text.push(type_char);
        for mask in [
            0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001,
        ] {
            let index = text.len() - 1;
            let character = match index % 3 {
                0 => 'r',
                1 => 'w',
                _ => 'x',
            };
            text.push(if bits & mask == 0 { '-' } else { character });
        }
        text
    });
    RemoteEntry {
        path,
        name,
        kind,
        size_bytes: metadata.size,
        modified_at_epoch_ms,
        permissions,
        uid: metadata.uid,
        gid: metadata.gid,
        owner_label: metadata.user,
        group_label: metadata.group,
    }
}

fn entry_kind(file_type: FileType) -> RemoteEntryKind {
    match file_type {
        FileType::Dir => RemoteEntryKind::Directory,
        FileType::File => RemoteEntryKind::File,
        FileType::Symlink => RemoteEntryKind::Symlink,
        FileType::Other => RemoteEntryKind::Other,
    }
}

async fn remote_path_exists(session: &SftpSession, path: &str) -> Result<bool, SftpError> {
    match session.symlink_metadata(path.to_owned()).await {
        Ok(_) => Ok(true),
        Err(error) if SftpError::from(error.clone()).code == SftpErrorCode::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn local_path_exists(path: &str) -> Result<bool, SftpError> {
    match fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(local_error(error)),
    }
}

async fn copy_stream<R, W>(
    reader: &mut R,
    writer: &mut W,
    record: &TransferRecord,
    bytes_total: Option<u64>,
) -> Result<(), SftpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let started = Instant::now();
    let mut last_report = started;
    let mut bytes_done = 0_u64;
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    loop {
        let count = tokio::select! {
            _ = record.cancellation.cancelled() => {
                return Err(SftpError::new(SftpErrorCode::Canceled, "传输已取消。"));
            }
            result = reader.read(&mut buffer) => result.map_err(|error| io_error(error.to_string()))?,
        };
        if count == 0 {
            break;
        }
        let next_total = bytes_done.saturating_add(count as u64);
        if bytes_total.map(|total| next_total > total).unwrap_or(false) {
            return Err(SftpError::new(
                SftpErrorCode::TransferIncomplete,
                "传输内容超过文件属性报告的大小，源文件可能在传输期间发生变化。",
            ));
        }
        tokio::select! {
            _ = record.cancellation.cancelled() => {
                return Err(SftpError::new(SftpErrorCode::Canceled, "传输已取消。"));
            }
            result = writer.write_all(&buffer[..count]) => result.map_err(|error| io_error(error.to_string()))?,
        }
        bytes_done = next_total;
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL
            || bytes_total
                .map(|total| bytes_done >= total)
                .unwrap_or(false)
        {
            let seconds = started.elapsed().as_secs_f64().max(0.001);
            let speed = (bytes_done as f64 / seconds) as u64;
            record
                .update(|progress| {
                    progress.bytes_done = bytes_done;
                    progress.speed_bytes_per_sec = Some(speed);
                })
                .await;
            last_report = Instant::now();
        }
    }
    if let Some(total) = bytes_total
        && total != bytes_done
    {
        return Err(SftpError::new(
            SftpErrorCode::TransferIncomplete,
            format!("文件属性报告 {total} 字节，实际传输 {bytes_done} 字节；未提交不完整文件。"),
        ));
    }
    writer
        .flush()
        .await
        .map_err(|error| io_error(error.to_string()))?;
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    let speed = (bytes_done as f64 / seconds) as u64;
    record
        .update(|progress| {
            progress.bytes_done = bytes_done;
            progress.speed_bytes_per_sec = Some(speed);
        })
        .await;
    Ok(())
}

async fn commit_remote_overwrite(
    session: &SftpSession,
    temporary: &str,
    target: &str,
) -> Result<Option<String>, SftpError> {
    let backup = remote_join(
        &remote_parent(target),
        &format!(".ais-{}.backup", Uuid::new_v4()),
    );
    session.rename(target.to_owned(), backup.clone()).await?;
    if let Err(error) = session
        .rename(temporary.to_owned(), target.to_owned())
        .await
    {
        let restore = session.rename(backup.clone(), target.to_owned()).await;
        let _ = session.remove_file(temporary.to_owned()).await;
        if let Err(restore_error) = restore {
            return Err(SftpError::new(
                SftpErrorCode::TransferIncomplete,
                format!("新文件提交失败，旧文件暂留在 {backup}；恢复失败：{restore_error}"),
            ));
        }
        return Err(error.into());
    }
    match session.remove_file(backup.clone()).await {
        Ok(()) => Ok(None),
        Err(error) => Ok(Some(format!(
            "新文件已提交；旧文件备份未能清理：{backup}（{error}）"
        ))),
    }
}

async fn commit_local_overwrite(
    temporary: &Path,
    target: &Path,
) -> Result<Option<String>, SftpError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let backup = parent.join(format!(".ais-{}.backup", Uuid::new_v4()));
    fs::rename(target, &backup).await.map_err(local_error)?;
    if let Err(error) = fs::rename(temporary, target).await {
        let restore = fs::rename(&backup, target).await;
        let _ = fs::remove_file(temporary).await;
        if let Err(restore_error) = restore {
            return Err(SftpError::new(
                SftpErrorCode::TransferIncomplete,
                format!(
                    "新文件提交失败，旧文件暂留在 {}；恢复失败：{restore_error}",
                    backup.display()
                ),
            ));
        }
        return Err(local_error(error));
    }
    match fs::remove_file(&backup).await {
        Ok(()) => Ok(None),
        Err(error) => Ok(Some(format!(
            "新文件已提交；旧文件备份未能清理：{}（{error}）",
            backup.display()
        ))),
    }
}

fn validate_local_relative_path(path: &str) -> Result<PathBuf, SftpError> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "本地路径必须相对于当前授权文件夹。",
        ));
    }
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SftpError::new(
                    SftpErrorCode::InvalidRemotePath,
                    "本地路径不能包含根路径或上级目录跳转。",
                ));
            }
        }
    }
    Ok(relative)
}

async fn resolve_local_directory(
    grant: &LocalRootGrant,
    relative: &str,
) -> Result<PathBuf, SftpError> {
    let relative = validate_local_relative_path(relative)?;
    let mut candidate = grant.root.clone();
    for component in relative.components() {
        candidate.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)
            .await
            .map_err(local_error)?;
        if metadata.file_type().is_symlink() {
            return Err(SftpError::new(
                SftpErrorCode::PermissionDenied,
                "本地目录包含符号链接，已拒绝跟随访问。",
            ));
        }
        if !metadata.is_dir() {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "本地目标不是文件夹。",
            ));
        }
    }
    let canonical = fs::canonicalize(&candidate).await.map_err(local_error)?;
    if !canonical.starts_with(&grant.root) {
        return Err(SftpError::new(
            SftpErrorCode::PermissionDenied,
            "本地路径超出了用户授权的文件夹范围。",
        ));
    }
    Ok(canonical)
}

async fn resolve_local_file(grant: &LocalRootGrant, relative: &str) -> Result<PathBuf, SftpError> {
    let relative = validate_local_relative_path(relative)?;
    if relative.as_os_str().is_empty() {
        return Err(SftpError::new(
            SftpErrorCode::InvalidRemotePath,
            "请选择授权文件夹中的一个文件。",
        ));
    }
    let mut candidate = grant.root.clone();
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        candidate.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)
            .await
            .map_err(local_error)?;
        if metadata.file_type().is_symlink() {
            return Err(SftpError::new(
                SftpErrorCode::PermissionDenied,
                "本地传输不跟随符号链接。",
            ));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "本地路径的中间部分不是文件夹。",
            ));
        }
        if index + 1 == components.len() && !metadata.is_file() {
            return Err(SftpError::new(
                SftpErrorCode::Conflict,
                "只支持普通文件传输，不跟随目录或特殊文件。",
            ));
        }
    }
    let canonical = fs::canonicalize(&candidate).await.map_err(local_error)?;
    if !canonical.starts_with(&grant.root) {
        return Err(SftpError::new(
            SftpErrorCode::PermissionDenied,
            "本地路径超出了用户授权的文件夹范围。",
        ));
    }
    Ok(canonical)
}

fn system_time_epoch_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn find_local_grant<'a>(
    grants: &'a HashMap<String, LocalRootGrant>,
    session_id: &str,
    grant_id: &str,
) -> Option<&'a LocalRootGrant> {
    grants
        .get(grant_id)
        .filter(|grant| grant.session_id == session_id)
}

fn local_basename(path: &Path) -> Result<String, SftpError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            SftpError::new(
                SftpErrorCode::InvalidRemotePath,
                "本地文件名无法转换为 UTF-8。",
            )
        })
}

fn path_basename(path: &str) -> Option<String> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn copy_name(name: &str, index: usize) -> String {
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    let suffix = if index == 1 {
        " (copy)".to_owned()
    } else {
        format!(" (copy {index})")
    };
    format!("{stem}{suffix}{extension}")
}

fn local_error(error: std::io::Error) -> SftpError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => SftpErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => SftpErrorCode::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => SftpErrorCode::AlreadyExists,
        std::io::ErrorKind::TimedOut => SftpErrorCode::Timeout,
        _ => SftpErrorCode::Other,
    };
    SftpError::new(code, format!("本地文件操作失败：{error}"))
}

fn io_error(message: String) -> SftpError {
    SftpError::new(SftpErrorCode::Other, format!("文件流传输失败：{message}"))
}

fn is_sensitive_ai_path(path: &str) -> bool {
    let normalized = path.to_ascii_lowercase();
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let file_name = segments.last().copied().unwrap_or_default();
    normalized == "/etc"
        || normalized.starts_with("/etc/")
        || segments
            .iter()
            .any(|segment| matches!(*segment, ".ssh" | ".gnupg" | ".aws" | ".azure" | ".kube"))
        || file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || [
            ".pem", ".key", ".p12", ".pfx", ".p7b", ".p7c", ".crt", ".cer",
        ]
        .iter()
        .any(|suffix| file_name.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::PathBuf};

    use uuid::Uuid;

    use super::{
        LocalRootGrant, RemoteEntryKind, copy_name, decode_ai_text, find_local_grant,
        is_sensitive_ai_path, remote_basename, remote_join, remote_parent, resolve_local_directory,
        safe_download_basename, validate_local_relative_path, validate_name, validate_remote_path,
    };

    #[test]
    fn remote_paths_use_posix_separators_and_preserve_unicode_names() {
        assert_eq!(
            remote_join("/home/用户", "my file.txt"),
            "/home/用户/my file.txt"
        );
        assert_eq!(remote_parent("/home/用户/my file.txt"), "/home/用户");
        assert_eq!(
            remote_basename("/home/用户/my file.txt").as_deref(),
            Some("my file.txt")
        );
        assert_eq!(remote_join("/", "tmp"), "/tmp");
    }

    #[test]
    fn ai_source_blocks_credentials_and_private_key_paths() {
        for path in [
            "/home/user/.ssh/config",
            "/home/user/.env.local",
            "/opt/app/id_ed25519_work",
            "/etc/app/config.yaml",
            "/srv/app/tls/server.pem",
        ] {
            assert!(is_sensitive_ai_path(path), "{path} must be blocked");
        }
        assert!(!is_sensitive_ai_path("/srv/app/config.yaml"));
    }

    #[test]
    fn rejects_path_components_that_could_escape_the_selected_directory() {
        assert!(validate_name("..").is_err());
        assert!(validate_name("child/name").is_err());
        assert!(validate_remote_path("C:\\temp").is_err());
        assert!(validate_remote_path("/home/用户/file name").is_ok());
        assert!(safe_download_basename("/tmp/..").is_err());
        assert!(safe_download_basename("/tmp/").is_err());
        assert!(safe_download_basename("/").is_err());
        assert_eq!(
            safe_download_basename("/tmp/report.txt").unwrap(),
            "report.txt"
        );
    }

    #[test]
    fn local_paths_must_remain_relative_to_the_authorized_root() {
        assert!(validate_local_relative_path("../outside").is_err());
        assert!(validate_local_relative_path("nested/../../outside").is_err());
        assert!(validate_local_relative_path("/outside").is_err());
        assert_eq!(
            validate_local_relative_path("用户目录/report 1.txt").unwrap(),
            PathBuf::from("用户目录/report 1.txt")
        );
    }

    #[test]
    fn local_grants_cannot_be_reused_by_another_ssh_session() {
        let grant = LocalRootGrant {
            session_id: "session-a".to_owned(),
            root: PathBuf::from("/tmp/termvista-session-a"),
        };
        let grants = HashMap::from([("grant-a".to_owned(), grant)]);

        assert!(find_local_grant(&grants, "session-a", "grant-a").is_some());
        assert!(find_local_grant(&grants, "session-b", "grant-a").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_directory_browser_refuses_symlink_traversal() {
        use std::{fs as std_fs, os::unix::fs::symlink};

        let base = std::env::temp_dir().join(format!("termvista-sftp-scope-{}", Uuid::new_v4()));
        let root = base.join("root");
        let outside = base.join("outside");
        std_fs::create_dir_all(&root).unwrap();
        std_fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("outside-link")).unwrap();
        let grant = LocalRootGrant {
            session_id: "test-session".to_owned(),
            root: root.clone(),
        };

        assert!(
            resolve_local_directory(&grant, "outside-link")
                .await
                .is_err()
        );
        assert!(resolve_local_directory(&grant, "../outside").await.is_err());

        std_fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn file_kind_contract_is_stable_for_confirmation_dialogs() {
        assert_eq!(RemoteEntryKind::Directory, RemoteEntryKind::Directory);
        assert_ne!(RemoteEntryKind::Symlink, RemoteEntryKind::File);
    }

    #[test]
    fn conflict_copy_names_keep_extensions_and_hidden_files() {
        assert_eq!(copy_name("report.txt", 1), "report (copy).txt");
        assert_eq!(copy_name("report.txt", 2), "report (copy 2).txt");
        assert_eq!(copy_name(".profile", 1), ".profile (copy)");
        assert_eq!(copy_name("报告 (final).txt", 1), "报告 (final) (copy).txt");
    }

    #[test]
    fn ai_text_preview_rejects_binary_or_invalid_utf8() {
        assert_eq!(
            decode_ai_text(b"line 1\nline 2\tend".to_vec()).unwrap(),
            "line 1\nline 2\tend"
        );
        assert!(decode_ai_text(vec![0x00, 0xff]).is_err());
        assert!(decode_ai_text(b"text\x1b[31m".to_vec()).is_err());
    }
}
