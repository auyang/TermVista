use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use russh_sftp::{
    client::{RawSftpSession, SftpSession},
    protocol::{FileAttributes, FileMode, FileType, OpenFlags, Packet, StatusCode},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, OwnedMutexGuard},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    sftp::{SftpError, SftpErrorCode, SftpManager},
    ssh::{HostKeyIdentity, SessionManager, SessionSecurityBinding, SshState},
};

use super::codec::{self, CodecError, LineEnding, TextEncoding};

const SFTP_TIMEOUT: Duration = Duration::from_secs(15);
const EDITABLE_LIMIT: usize = 2 * 1024 * 1024;
const LARGE_EDIT_LIMIT: usize = 10 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 48 * 1024;
const IO_CHUNK: usize = 64 * 1024;
const POSIX_RENAME: &str = "posix-rename@openssh.com";
const FSYNC: &str = "fsync@openssh.com";
const HARDLINK: &str = "hardlink@openssh.com";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDocument {
    pub document_id: String,
    pub connection_id: String,
    pub session_id: String,
    pub canonical_path: String,
    pub display_name: String,
    pub text: Option<String>,
    pub sha256: Option<String>,
    pub size_bytes: u64,
    pub modified_at_sec: Option<u32>,
    pub permissions: Option<u32>,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    pub sensitive: bool,
    pub preview_only: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EditorErrorCode {
    Disconnected,
    Conflict,
    NotSupported,
    PermissionDenied,
    NotFound,
    InvalidPath,
    Binary,
    UnknownEncoding,
    TooLarge,
    InvalidContent,
    InvalidRequest,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorError {
    pub code: EditorErrorCode,
    pub message: String,
    pub draft_retained: bool,
}

impl EditorError {
    fn new(code: EditorErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            draft_retained: true,
        }
    }
}

impl From<SftpError> for EditorError {
    fn from(error: SftpError) -> Self {
        let code = match error.code {
            SftpErrorCode::Disconnected | SftpErrorCode::Timeout => EditorErrorCode::Disconnected,
            SftpErrorCode::PermissionDenied => EditorErrorCode::PermissionDenied,
            SftpErrorCode::NotFound => EditorErrorCode::NotFound,
            SftpErrorCode::InvalidRemotePath => EditorErrorCode::InvalidPath,
            SftpErrorCode::NotSupported => EditorErrorCode::NotSupported,
            _ => EditorErrorCode::Other,
        };
        Self::new(code, error.message)
    }
}

impl From<russh_sftp::client::error::Error> for EditorError {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as ClientError;
        let code = match &error {
            ClientError::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => EditorErrorCode::NotFound,
                StatusCode::PermissionDenied => EditorErrorCode::PermissionDenied,
                StatusCode::OpUnsupported => EditorErrorCode::NotSupported,
                StatusCode::NoConnection | StatusCode::ConnectionLost => {
                    EditorErrorCode::Disconnected
                }
                _ => EditorErrorCode::Other,
            },
            ClientError::Timeout | ClientError::IO(_) => EditorErrorCode::Disconnected,
            _ => EditorErrorCode::Other,
        };
        Self::new(code, error.to_string())
    }
}

impl From<std::io::Error> for EditorError {
    fn from(error: std::io::Error) -> Self {
        Self::new(EditorErrorCode::Disconnected, error.to_string())
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveStatus {
    Saved,
    Conflict,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSaveResult {
    pub status: SaveStatus,
    pub document_id: String,
    pub request_id: String,
    pub canonical_path: String,
    pub new_sha256: Option<String>,
    pub current_sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub verified: bool,
    pub durable_write: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCompareResult {
    pub canonical_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub modified_at_sec: Option<u32>,
    pub text: Option<String>,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCapabilities {
    pub safe_replace_existing: bool,
    pub safe_create_new: bool,
    pub fsync: bool,
    pub note: String,
}

#[derive(Clone)]
struct DocumentState {
    public: RemoteDocument,
    endpoint_host: String,
    endpoint_port: u16,
    endpoint_username: String,
    host_key: HostKeyIdentity,
    ai_revision: u64,
    ai_buffer_hash: String,
    ai_dirty: bool,
}

#[derive(Clone)]
struct EditorTransport {
    raw: Arc<RawSftpSession>,
    extensions: HashMap<String, String>,
}

#[derive(Default)]
struct EditorInner {
    documents: HashMap<String, DocumentState>,
    open_paths: HashMap<String, String>,
    save_locks: HashMap<String, Arc<Mutex<()>>>,
    completed_requests: HashMap<String, RemoteSaveResult>,
    pending_staging: HashMap<String, Vec<String>>,
}

pub struct RemoteEditorService {
    ssh: Arc<SessionManager>,
    sftp: Arc<SftpManager>,
    inner: Mutex<EditorInner>,
    transports: Mutex<HashMap<String, Arc<EditorTransport>>>,
    session_file_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl RemoteEditorService {
    pub fn new(ssh: Arc<SessionManager>, sftp: Arc<SftpManager>) -> Self {
        Self {
            ssh,
            sftp,
            inner: Mutex::new(EditorInner::default()),
            transports: Mutex::new(HashMap::new()),
            session_file_locks: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open(
        &self,
        session_id: &str,
        remote_path: &str,
        allow_large: bool,
    ) -> Result<RemoteDocument, EditorError> {
        let _operation_guard = self.session_file_operation_guard(session_id).await;
        let (public, binding) = self
            .read_snapshot(session_id, remote_path, allow_large, None)
            .await?;
        let dedupe_key = document_key(&public.connection_id, session_id, &public.canonical_path);
        let mut inner = self.inner.lock().await;
        if let Some(existing_id) = inner.open_paths.get(&dedupe_key).cloned()
            && let Some(state) = inner.documents.get(&existing_id)
        {
            return Ok(state.public.clone());
        }
        let document_id = public.document_id.clone();
        let state = DocumentState {
            public: public.clone(),
            endpoint_host: binding.summary.host,
            endpoint_port: binding.summary.port,
            endpoint_username: binding.summary.username,
            host_key: binding.identity,
            ai_revision: 0,
            ai_buffer_hash: hash_hex(public.text.as_deref().unwrap_or_default().as_bytes()),
            ai_dirty: false,
        };
        inner.open_paths.insert(dedupe_key, document_id.clone());
        inner.documents.insert(document_id, state);
        Ok(public)
    }

    pub async fn save(
        &self,
        document_id: &str,
        expected_sha256: &str,
        new_text: &str,
        request_id: &str,
        confirm_sensitive: bool,
    ) -> Result<RemoteSaveResult, EditorError> {
        validate_request_id(request_id)?;
        if new_text.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "编辑内容超过 10 MiB 上限，远程文件未修改。",
            ));
        }
        let lock = self.save_lock(document_id).await?;
        let _guard = lock.lock().await;
        let result_key = format!("{document_id}:{request_id}");
        if let Some(result) = self
            .inner
            .lock()
            .await
            .completed_requests
            .get(&result_key)
            .cloned()
        {
            return Ok(result);
        }
        let state = self.document(document_id).await?;
        let _operation_guard = self
            .session_file_operation_guard(&state.public.session_id)
            .await;
        if state.public.read_only || state.public.preview_only {
            return Err(EditorError::new(
                EditorErrorCode::NotSupported,
                state
                    .public
                    .read_only_reason
                    .unwrap_or_else(|| "此文件为只读。".to_owned()),
            ));
        }
        if state.public.sha256.as_deref() != Some(expected_sha256) {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "编辑器中的文件版本已变化，请重新读取并比较。",
            ));
        }
        if state.public.sensitive && !confirm_sensitive {
            return Err(EditorError::new(
                EditorErrorCode::PermissionDenied,
                "此路径可能包含敏感配置；需要在界面中明确确认后再保存。",
            ));
        }
        let binding = self.active_binding(&state.public.session_id).await?;
        ensure_same_binding(&state, &binding)?;
        let sftp = self.sftp.get_session(&state.public.session_id).await?;
        let transport = self.transport(&state.public.session_id).await?;
        let current_attributes = transport
            .raw
            .lstat(state.public.canonical_path.clone())
            .await?
            .attrs;
        if current_attributes.file_type() != FileType::File {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "远程目标已不再是普通文件。编辑草稿仍保留。",
            ));
        }
        let current_bytes =
            read_file_limited(&sftp, &state.public.canonical_path, LARGE_EDIT_LIMIT + 1).await?;
        if current_bytes.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "远程文件现已超过编辑上限。编辑草稿仍保留。",
            ));
        }
        let current_hash = hash_hex(&current_bytes);
        if Some(current_hash.as_str()) != state.public.sha256.as_deref() {
            return Ok(RemoteSaveResult {
                status: SaveStatus::Conflict,
                document_id: document_id.to_owned(),
                request_id: request_id.to_owned(),
                canonical_path: state.public.canonical_path,
                new_sha256: None,
                current_sha256: Some(current_hash),
                size_bytes: Some(current_bytes.len() as u64),
                verified: false,
                durable_write: false,
                message: Some(
                    "远程文件自打开后已发生变化，保存已阻止。请比较差异或另存为。".to_owned(),
                ),
            });
        }
        if current_attributes.permissions.is_none()
            || current_attributes.uid.is_none()
            || current_attributes.gid.is_none()
        {
            return Err(EditorError::new(
                EditorErrorCode::NotSupported,
                "服务器未返回原文件权限或所有者信息，无法安全确认替换后的访问属性。",
            ));
        }
        let bytes = codec::encode(new_text, state.public.encoding, state.public.line_ending)
            .map_err(codec_error)?;
        if bytes.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "编码后的文件超过 10 MiB 编辑上限。",
            ));
        }
        let parent = remote_parent(&state.public.canonical_path);
        let staging_path = remote_join(&parent, &format!(".termvista-save-{}", Uuid::new_v4()));
        let durable_write = transport.extensions.contains_key(FSYNC);
        self.cleanup_pending_staging(&transport, document_id).await;
        if let Err(error) = stage_file(&transport, &staging_path, &bytes, durable_write).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        let mut staging_attributes = FileAttributes::empty();
        staging_attributes.permissions = Some(current_attributes.permissions.unwrap_or(0));
        staging_attributes.uid = current_attributes.uid;
        staging_attributes.gid = current_attributes.gid;
        if let Err(error) = transport
            .raw
            .setstat(staging_path.clone(), staging_attributes)
            .await
        {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error.into());
        }
        if durable_write && let Err(error) = fsync_path(&transport, &staging_path).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        let staged_bytes = match read_file_limited(&sftp, &staging_path, LARGE_EDIT_LIMIT + 1).await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error);
            }
        };
        let new_hash = hash_hex(&bytes);
        if staged_bytes.len() != bytes.len() || hash_hex(&staged_bytes) != new_hash {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(EditorError::new(
                EditorErrorCode::Other,
                "暂存文件校验失败，原文件未提交，编辑草稿仍保留。",
            ));
        }
        let before_commit = match transport
            .raw
            .lstat(state.public.canonical_path.clone())
            .await
        {
            Ok(attributes) => attributes.attrs,
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error.into());
            }
        };
        if before_commit.file_type() != FileType::File {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "提交前远程目标类型已变化，保存已阻止。",
            ));
        }
        let before_commit_bytes = match read_file_limited(
            &sftp,
            &state.public.canonical_path,
            LARGE_EDIT_LIMIT + 1,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error);
            }
        };
        if hash_hex(&before_commit_bytes) != current_hash {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Ok(RemoteSaveResult {
                status: SaveStatus::Conflict,
                document_id: document_id.to_owned(),
                request_id: request_id.to_owned(),
                canonical_path: state.public.canonical_path,
                new_sha256: None,
                current_sha256: Some(hash_hex(&before_commit_bytes)),
                size_bytes: Some(before_commit_bytes.len() as u64),
                verified: false,
                durable_write: false,
                message: Some("提交前检测到远程文件变化，保存已阻止。".to_owned()),
            });
        }
        if !transport.extensions.contains_key(POSIX_RENAME) {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Ok(RemoteSaveResult {
                status: SaveStatus::Unsupported,
                document_id: document_id.to_owned(),
                request_id: request_id.to_owned(),
                canonical_path: state.public.canonical_path,
                new_sha256: None,
                current_sha256: Some(current_hash),
                size_bytes: None,
                verified: false,
                durable_write: false,
                message: Some(
                    "服务器未声明 OpenSSH 安全替换扩展。原文件保持不变，可另存为新文件。"
                        .to_owned(),
                ),
            });
        }
        match posix_rename(&transport, &staging_path, &state.public.canonical_path).await {
            Ok(()) => {}
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error);
            }
        }
        let after_commit = transport
            .raw
            .lstat(state.public.canonical_path.clone())
            .await?
            .attrs;
        if after_commit.file_type() != FileType::File {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "提交结果无法确认：远程目标状态已变化。草稿仍保留，请重新检查远程文件。",
            ));
        }
        let verified_bytes =
            read_file_limited(&sftp, &state.public.canonical_path, LARGE_EDIT_LIMIT + 1).await?;
        let verified_hash = hash_hex(&verified_bytes);
        if verified_hash != new_hash {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "替换后回读内容与待保存内容不一致。草稿仍保留，请重新检查远程文件。",
            ));
        }
        let warning = if durable_write {
            Some("内容已回读校验。模式和所有者信息已复制；SFTP 无法完整保留 ACL、扩展属性或安全标签。跨客户端修改仍可能发生在最后一次校验与替换之间。".to_owned())
        } else {
            Some("内容已回读校验。模式和所有者信息已复制；SFTP 无法完整保留 ACL、扩展属性或安全标签。服务器未声明 fsync，断电持久化无保证；跨客户端并发仍有竞态窗口。".to_owned())
        };
        let result = RemoteSaveResult {
            status: SaveStatus::Saved,
            document_id: document_id.to_owned(),
            request_id: request_id.to_owned(),
            canonical_path: state.public.canonical_path.clone(),
            new_sha256: Some(verified_hash.clone()),
            current_sha256: None,
            size_bytes: Some(verified_bytes.len() as u64),
            verified: true,
            durable_write,
            message: warning,
        };
        self.update_saved_document(
            document_id,
            verified_hash,
            verified_bytes.len() as u64,
            after_commit,
        )
        .await?;
        self.inner
            .lock()
            .await
            .completed_requests
            .insert(result_key, result.clone());
        Ok(result)
    }

    pub async fn register_ai_buffer_revision(
        &self,
        document_id: &str,
        session_id: &str,
        revision: u64,
        dirty: bool,
        current_text: &str,
    ) -> Result<(), EditorError> {
        if current_text.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "编辑缓冲超过 10 MiB 上限，不能用于 AI 上下文。",
            ));
        }
        let binding = self
            .ssh
            .security_binding(session_id)
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Disconnected, error.message))?;
        let mut inner = self.inner.lock().await;
        let state = inner.documents.get_mut(document_id).ok_or_else(|| {
            EditorError::new(EditorErrorCode::NotFound, "远程编辑文档已关闭或不存在。")
        })?;
        if state.public.session_id != session_id
            || state.host_key.fingerprint_sha256 != binding.identity.fingerprint_sha256
        {
            return Err(EditorError::new(
                EditorErrorCode::InvalidRequest,
                "编辑文档与当前 SSH 会话或主机身份不匹配。",
            ));
        }
        if revision < state.ai_revision {
            return Err(EditorError::new(
                EditorErrorCode::InvalidRequest,
                "编辑缓冲版本已更新，请重新预览当前内容。",
            ));
        }
        state.ai_revision = revision;
        state.ai_buffer_hash = hash_hex(current_text.as_bytes());
        state.ai_dirty = dirty;
        Ok(())
    }

    pub async fn unregister_ai_buffer_revision(&self, document_id: &str) {
        if let Some(state) = self.inner.lock().await.documents.get_mut(document_id) {
            state.ai_revision = state.ai_revision.saturating_add(1);
            state.ai_dirty = false;
            state.ai_buffer_hash.clear();
        }
    }

    pub async fn validate_ai_buffer_revision(
        &self,
        document_id: &str,
        session_id: &str,
        revision: u64,
        require_dirty: bool,
        expected_text: Option<&str>,
    ) -> Result<(String, String), EditorError> {
        let binding = self
            .ssh
            .security_binding(session_id)
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Disconnected, error.message))?;
        let state = self
            .inner
            .lock()
            .await
            .documents
            .get(document_id)
            .cloned()
            .ok_or_else(|| {
                EditorError::new(EditorErrorCode::NotFound, "远程编辑文档已关闭或不存在。")
            })?;
        if state.public.session_id != session_id
            || state.host_key.fingerprint_sha256 != binding.identity.fingerprint_sha256
        {
            return Err(EditorError::new(
                EditorErrorCode::InvalidRequest,
                "编辑文档与当前 SSH 会话或主机身份不匹配。",
            ));
        }
        if state.public.sensitive {
            return Err(EditorError::new(
                EditorErrorCode::InvalidRequest,
                "敏感远程文件不能作为 AI 上下文。",
            ));
        }
        if state.ai_revision != revision {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "编辑缓冲在预览后发生变化，请重新预览。",
            ));
        }
        if require_dirty && !state.ai_dirty {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "当前编辑缓冲已保存或不再处于未保存状态。",
            ));
        }
        if expected_text.is_some_and(|text| hash_hex(text.as_bytes()) != state.ai_buffer_hash) {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "编辑缓冲内容与注册版本不一致，请重新预览。",
            ));
        }
        Ok((state.public.canonical_path, state.ai_buffer_hash))
    }

    pub async fn save_as(
        &self,
        document_id: &str,
        expected_sha256: &str,
        new_path: &str,
        new_text: &str,
        request_id: &str,
        confirm_sensitive: bool,
    ) -> Result<RemoteSaveResult, EditorError> {
        validate_request_id(request_id)?;
        validate_path(new_path)?;
        if new_text.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "编辑内容超过 10 MiB 上限。",
            ));
        }
        let lock = self.save_lock(document_id).await?;
        let _guard = lock.lock().await;
        let result_key = format!("{document_id}:{request_id}");
        if let Some(result) = self
            .inner
            .lock()
            .await
            .completed_requests
            .get(&result_key)
            .cloned()
        {
            return Ok(result);
        }
        let state = self.document(document_id).await?;
        let _operation_guard = self
            .session_file_operation_guard(&state.public.session_id)
            .await;
        if state.public.read_only || state.public.preview_only {
            return Err(EditorError::new(
                EditorErrorCode::NotSupported,
                "只读文件不能另存。",
            ));
        }
        if state.public.sha256.as_deref() != Some(expected_sha256) {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "文件版本已变化，请先比较远程内容。",
            ));
        }
        let binding = self.active_binding(&state.public.session_id).await?;
        ensure_same_binding(&state, &binding)?;
        let sftp = self.sftp.get_session(&state.public.session_id).await?;
        let transport = self.transport(&state.public.session_id).await?;
        if !transport.extensions.contains_key(HARDLINK) {
            return Err(EditorError::new(
                EditorErrorCode::NotSupported,
                "服务器未声明 OpenSSH 安全新建链接扩展；为了避免覆盖同名目标，本次不执行另存为。",
            ));
        }
        let dest_parent_input = remote_parent(new_path);
        let dest_name = remote_basename(new_path);
        validate_name(dest_name)?;
        let dest_parent = sftp.canonicalize(dest_parent_input).await?;
        validate_path(&dest_parent)?;
        let target_path = remote_join(&dest_parent, dest_name);
        ensure_absent(&transport, &target_path).await?;
        let sensitive = is_sensitive_path(&target_path);
        if sensitive && !confirm_sensitive {
            return Err(EditorError::new(
                EditorErrorCode::PermissionDenied,
                "目标路径可能包含敏感配置；请明确确认后再继续。",
            ));
        }
        let bytes = codec::encode(new_text, state.public.encoding, state.public.line_ending)
            .map_err(codec_error)?;
        if bytes.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "编码后的文件超过 10 MiB 上限。",
            ));
        }
        let current =
            read_file_limited(&sftp, &state.public.canonical_path, LARGE_EDIT_LIMIT + 1).await?;
        if hash_hex(&current) != expected_sha256 {
            return Ok(RemoteSaveResult {
                status: SaveStatus::Conflict,
                document_id: document_id.to_owned(),
                request_id: request_id.to_owned(),
                canonical_path: state.public.canonical_path,
                new_sha256: None,
                current_sha256: Some(hash_hex(&current)),
                size_bytes: Some(current.len() as u64),
                verified: false,
                durable_write: false,
                message: Some("原文件发生变化，另存操作已停止。".to_owned()),
            });
        }
        let staging_path =
            remote_join(&dest_parent, &format!(".termvista-save-{}", Uuid::new_v4()));
        let durable_write = transport.extensions.contains_key(FSYNC);
        if let Err(error) = stage_file(&transport, &staging_path, &bytes, durable_write).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        if durable_write && let Err(error) = fsync_path(&transport, &staging_path).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        let staged_bytes = match read_file_limited(&sftp, &staging_path, LARGE_EDIT_LIMIT + 1).await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error);
            }
        };
        let new_hash = hash_hex(&bytes);
        if staged_bytes.len() != bytes.len() || hash_hex(&staged_bytes) != new_hash {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(EditorError::new(
                EditorErrorCode::Other,
                "暂存文件校验失败。",
            ));
        }
        if let Err(error) = ensure_absent(&transport, &target_path).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        let current = match read_file_limited(
            &sftp,
            &state.public.canonical_path,
            LARGE_EDIT_LIMIT + 1,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cleanup_staging(&transport, document_id, &staging_path)
                    .await;
                return Err(error);
            }
        };
        if hash_hex(&current) != expected_sha256 {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "另存为期间原文件发生变化；新目标未创建，编辑草稿保留。",
            ));
        }
        if let Err(error) = hardlink_new_file(&transport, &staging_path, &target_path).await {
            self.cleanup_staging(&transport, document_id, &staging_path)
                .await;
            return Err(error);
        }
        self.cleanup_staging(&transport, document_id, &staging_path)
            .await;
        let verified = read_file_limited(&sftp, &target_path, LARGE_EDIT_LIMIT + 1).await?;
        if hash_hex(&verified) != new_hash {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "另存文件已创建，但回读校验未通过。原文件与本地草稿均保留。",
            ));
        }
        let new_attributes = transport.raw.lstat(target_path.clone()).await?.attrs;
        let result = RemoteSaveResult {
            status: SaveStatus::Saved,
            document_id: document_id.to_owned(),
            request_id: request_id.to_owned(),
            canonical_path: target_path.clone(),
            new_sha256: Some(new_hash.clone()),
            current_sha256: None,
            size_bytes: Some(verified.len() as u64),
            verified: true,
            durable_write,
            message: Some(if durable_write {
                "已通过独占硬链接创建新文件并回读校验；原文件未修改。".to_owned()
            } else {
                "已通过独占硬链接创建新文件并回读校验；原文件未修改，但服务器未声明 fsync。"
                    .to_owned()
            }),
        };
        self.rename_document_path(
            document_id,
            target_path,
            new_hash,
            verified.len() as u64,
            new_attributes,
        )
        .await?;
        self.inner
            .lock()
            .await
            .completed_requests
            .insert(result_key, result.clone());
        Ok(result)
    }

    pub async fn compare(&self, document_id: &str) -> Result<EditorCompareResult, EditorError> {
        let state = self.document(document_id).await?;
        let _operation_guard = self
            .session_file_operation_guard(&state.public.session_id)
            .await;
        let binding = self.active_binding(&state.public.session_id).await?;
        ensure_same_binding(&state, &binding)?;
        let sftp = self.sftp.get_session(&state.public.session_id).await?;
        let transport = self.transport(&state.public.session_id).await?;
        let attrs = transport
            .raw
            .lstat(state.public.canonical_path.clone())
            .await?
            .attrs;
        if attrs.file_type() != FileType::File {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "远程目标不再是普通文件。",
            ));
        }
        let bytes =
            read_file_limited(&sftp, &state.public.canonical_path, LARGE_EDIT_LIMIT + 1).await?;
        if bytes.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "远程文件超过差异比较上限。",
            ));
        }
        let decoded = codec::decode(&bytes).map_err(codec_error)?;
        Ok(EditorCompareResult {
            canonical_path: state.public.canonical_path,
            sha256: hash_hex(&bytes),
            size_bytes: bytes.len() as u64,
            modified_at_sec: attrs.mtime,
            text: Some(decoded.text),
            encoding: decoded.encoding,
            line_ending: decoded.line_ending,
        })
    }

    pub async fn capabilities(&self, session_id: &str) -> Result<SaveCapabilities, EditorError> {
        self.active_binding(session_id).await?;
        let transport = self.transport(session_id).await?;
        let safe_replace_existing = transport.extensions.contains_key(POSIX_RENAME);
        let safe_create_new = transport.extensions.contains_key(HARDLINK);
        let fsync = transport.extensions.contains_key(FSYNC);
        let note = match (safe_replace_existing, safe_create_new, fsync) {
            (true, true, true) => {
                "服务器声明受控替换、仅新建硬链接和 fsync；仍存在跨客户端最后检查竞态。"
            }
            (true, true, false) => {
                "服务器声明受控替换和仅新建硬链接，但未声明 fsync；写入后会回读校验。"
            }
            (true, false, true) => "服务器支持受控替换与 fsync；不支持安全另存为新文件。",
            (true, false, false) => "服务器支持受控替换，但未声明 fsync 或安全新建链接。",
            (false, true, true) => "服务器支持安全新建链接与 fsync；原文件只读，另存为可用。",
            (false, true, false) => "服务器支持安全新建链接；原文件只读，且未声明 fsync。",
            (false, false, true) => "服务器支持 fsync，但不支持安全替换或安全新建链接。",
            (false, false, false) => "服务器未声明安全替换、安全新建链接或 fsync。",
        };
        Ok(SaveCapabilities {
            safe_replace_existing,
            safe_create_new,
            fsync,
            note: note.to_owned(),
        })
    }

    pub async fn reload(&self, document_id: &str) -> Result<RemoteDocument, EditorError> {
        let state = self.document(document_id).await?;
        let _operation_guard = self
            .session_file_operation_guard(&state.public.session_id)
            .await;
        let (public, binding) = self
            .read_snapshot(
                &state.public.session_id,
                &state.public.canonical_path,
                true,
                Some(document_id),
            )
            .await?;
        ensure_same_binding(&state, &binding)?;
        let mut inner = self.inner.lock().await;
        let stored = inner.documents.get_mut(document_id).ok_or_else(|| {
            EditorError::new(EditorErrorCode::NotFound, "远程编辑文档已关闭或不存在。")
        })?;
        stored.public = public.clone();
        Ok(public)
    }

    pub async fn rebind(
        &self,
        document_id: &str,
        new_session_id: &str,
    ) -> Result<RemoteDocument, EditorError> {
        let mut state = self.document(document_id).await?;
        let _operation_guard = self.session_file_operation_guard(new_session_id).await;
        let binding = self.active_binding(new_session_id).await?;
        if binding.summary.profile_id != state.public.connection_id
            || binding.summary.host != state.endpoint_host
            || binding.summary.port != state.endpoint_port
            || binding.summary.username != state.endpoint_username
            || binding.identity != state.host_key
        {
            return Err(EditorError::new(
                EditorErrorCode::PermissionDenied,
                "重连目标的配置、地址或主机指纹与原编辑会话不一致。",
            ));
        }
        let sftp = self.sftp.get_session(new_session_id).await?;
        let transport = self.transport(new_session_id).await?;
        let current_attrs = transport
            .raw
            .lstat(state.public.canonical_path.clone())
            .await?
            .attrs;
        if current_attrs.file_type() != FileType::File {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "重连后的目标不再是普通文件。",
            ));
        }
        let current =
            read_file_limited(&sftp, &state.public.canonical_path, LARGE_EDIT_LIMIT + 1).await?;
        let current_hash = hash_hex(&current);
        if Some(current_hash.as_str()) != state.public.sha256.as_deref() {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "远程文件自断线后已变化。草稿保留，不能自动绑定到新版本。",
            ));
        }
        let old_key = document_key(
            &state.public.connection_id,
            &state.public.session_id,
            &state.public.canonical_path,
        );
        let new_key = document_key(
            &state.public.connection_id,
            new_session_id,
            &state.public.canonical_path,
        );
        self.cleanup_pending_staging(&transport, document_id).await;
        state.public.session_id = new_session_id.to_owned();
        state.endpoint_host = binding.summary.host;
        state.endpoint_port = binding.summary.port;
        state.endpoint_username = binding.summary.username;
        state.host_key = binding.identity;
        let public = state.public.clone();
        let mut inner = self.inner.lock().await;
        if inner
            .open_paths
            .get(&new_key)
            .is_some_and(|existing_id| existing_id != document_id)
        {
            return Err(EditorError::new(
                EditorErrorCode::Conflict,
                "新 SSH 会话已打开同一路径；请先关闭重复编辑标签再绑定草稿。",
            ));
        }
        inner.open_paths.remove(&old_key);
        inner.open_paths.insert(new_key, document_id.to_owned());
        inner.documents.insert(document_id.to_owned(), state);
        Ok(public)
    }

    pub async fn close_document(&self, document_id: &str) {
        let Ok(save_lock) = self.save_lock(document_id).await else {
            return;
        };
        let _save_guard = save_lock.lock().await;
        let Some(session_id) = self.session_id_for_document(document_id).await else {
            return;
        };
        let _operation_guard = self.session_file_operation_guard(&session_id).await;
        let mut inner = self.inner.lock().await;
        if let Some(state) = inner.documents.remove(document_id) {
            inner.open_paths.remove(&document_key(
                &state.public.connection_id,
                &state.public.session_id,
                &state.public.canonical_path,
            ));
        }
        inner
            .completed_requests
            .retain(|key, _| !key.starts_with(&format!("{document_id}:")));
    }

    pub async fn close_session_transport(&self, session_id: &str) {
        if let Some(transport) = self.transports.lock().await.remove(session_id) {
            let _ = transport.raw.close_session();
        }
    }

    pub async fn session_file_operation_guard(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.session_file_locks.lock().await;
            Arc::clone(
                locks
                    .entry(session_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        lock.lock_owned().await
    }

    pub async fn path_is_open(&self, session_id: &str, path: &str) -> bool {
        self.inner.lock().await.documents.values().any(|state| {
            state.public.session_id == session_id && state.public.canonical_path == path
        })
    }

    pub async fn path_or_descendant_is_open(&self, session_id: &str, path: &str) -> bool {
        let canonical_path = match self.sftp.get_session(session_id).await {
            Ok(sftp) => sftp
                .canonicalize(path.to_owned())
                .await
                .unwrap_or_else(|_| path.to_owned()),
            Err(_) => path.to_owned(),
        };
        let path = canonical_path.trim_end_matches('/');
        self.inner.lock().await.documents.values().any(|state| {
            if state.public.session_id != session_id {
                return false;
            }
            let open_path = state.public.canonical_path.as_str();
            open_path == path
                || path.is_empty()
                || path == "/"
                || open_path
                    .strip_prefix(path)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
    }

    pub async fn session_id_for_document(&self, document_id: &str) -> Option<String> {
        self.inner
            .lock()
            .await
            .documents
            .get(document_id)
            .map(|state| state.public.session_id.clone())
    }

    pub async fn close_all(&self) {
        let mut inner = self.inner.lock().await;
        inner.documents.clear();
        inner.open_paths.clear();
        inner.completed_requests.clear();
        inner.pending_staging.clear();
        drop(inner);
        let transports = std::mem::take(&mut *self.transports.lock().await);
        for (_, transport) in transports {
            let _ = transport.raw.close_session();
        }
        self.session_file_locks.lock().await.clear();
    }

    async fn read_snapshot(
        &self,
        session_id: &str,
        remote_path: &str,
        allow_large: bool,
        document_id: Option<&str>,
    ) -> Result<(RemoteDocument, SessionSecurityBinding), EditorError> {
        validate_path(remote_path)?;
        let binding = self.active_binding(session_id).await?;
        let sftp = self.sftp.get_session(session_id).await?;
        let requested_metadata = sftp.symlink_metadata(remote_path.to_owned()).await?;
        if requested_metadata.file_type().is_symlink() {
            return Err(EditorError::new(
                EditorErrorCode::InvalidPath,
                "此路径是符号链接。请通过 SFTP 打开其真实目标路径后再编辑。",
            ));
        }
        let canonical_path = sftp.canonicalize(remote_path.to_owned()).await?;
        validate_path(&canonical_path)?;
        let transport = self.transport(session_id).await?;
        let attributes = transport.raw.lstat(canonical_path.clone()).await?.attrs;
        if attributes.file_type() != FileType::File {
            return Err(EditorError::new(
                EditorErrorCode::InvalidPath,
                "只允许编辑普通远程文件。",
            ));
        }
        let size_bytes = attributes.size.unwrap_or(0);
        let forced_preview = size_bytes > LARGE_EDIT_LIMIT as u64;
        let needs_large_confirmation = size_bytes > EDITABLE_LIMIT as u64 && !allow_large;
        let preview_only = forced_preview || needs_large_confirmation;
        let sensitive = is_sensitive_path(&canonical_path);
        let max_read = if preview_only {
            PREVIEW_LIMIT
        } else {
            LARGE_EDIT_LIMIT + 1
        };
        let read = if preview_only {
            read_file_prefix(&sftp, &canonical_path, max_read).await?
        } else {
            read_file_limited(&sftp, &canonical_path, max_read).await?
        };
        if !preview_only && read.len() > LARGE_EDIT_LIMIT {
            return Err(EditorError::new(
                EditorErrorCode::TooLarge,
                "文件超过 10 MiB 编辑上限，已停止完整读取。",
            ));
        }
        let digest = (!preview_only).then(|| hash_hex(&read));
        let (text, encoding, line_ending, content_read_only_reason) = match codec::decode(&read) {
            Ok(decoded) => {
                let reason = if decoded.line_ending == LineEnding::Mixed {
                    Some(
                        "文件包含混合换行符。为避免静默改写原始格式，此文件以只读方式打开。"
                            .to_owned(),
                    )
                } else {
                    None
                };
                (
                    Some(decoded.text),
                    decoded.encoding,
                    decoded.line_ending,
                    reason,
                )
            }
            Err(CodecError::Binary) => {
                return Err(EditorError::new(
                    EditorErrorCode::Binary,
                    "此文件包含二进制数据，未在 Monaco 中打开。",
                ));
            }
            Err(CodecError::UnknownEncoding | CodecError::InvalidUtf16) => (
                None,
                TextEncoding::Unknown,
                LineEnding::Lf,
                Some("无法无损识别此文件编码。文件保持只读，未进行字符替换。".to_owned()),
            ),
            Err(CodecError::MixedLineEndings) => unreachable!(),
        };
        let read_only_reason = if forced_preview {
            Some("文件超过 10 MiB，仅显示受限预览。可下载到本机处理。".to_owned())
        } else if needs_large_confirmation {
            Some("文件超过 2 MiB。继续编辑前请确认设备内存和性能影响。".to_owned())
        } else {
            content_read_only_reason
        };
        let public = RemoteDocument {
            document_id: document_id
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            connection_id: binding.summary.profile_id.clone(),
            session_id: session_id.to_owned(),
            canonical_path: canonical_path.clone(),
            display_name: remote_basename(&canonical_path).to_owned(),
            text,
            sha256: digest,
            size_bytes,
            modified_at_sec: attributes.mtime,
            permissions: attributes.permissions,
            encoding,
            line_ending,
            read_only: preview_only || read_only_reason.is_some(),
            read_only_reason,
            sensitive,
            preview_only,
        };
        Ok((public, binding))
    }

    async fn active_binding(
        &self,
        session_id: &str,
    ) -> Result<SessionSecurityBinding, EditorError> {
        let binding = self
            .ssh
            .security_binding(session_id)
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Disconnected, error.message))?;
        if binding.summary.state != SshState::Connected {
            return Err(EditorError::new(
                EditorErrorCode::Disconnected,
                "SSH 会话已断开。编辑缓冲仍保留，重连后需重新校验主机与文件版本。",
            ));
        }
        Ok(binding)
    }

    async fn transport(&self, session_id: &str) -> Result<Arc<EditorTransport>, EditorError> {
        let active_ids = self
            .ssh
            .sessions()
            .await
            .into_iter()
            .map(|session| session.session_id)
            .collect::<HashSet<_>>();
        let stale = {
            let mut transports = self.transports.lock().await;
            let stale_ids = transports
                .keys()
                .filter(|id| !active_ids.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            stale_ids
                .into_iter()
                .filter_map(|id| transports.remove(&id))
                .collect::<Vec<_>>()
        };
        for transport in stale {
            let _ = transport.raw.close_session();
        }
        self.sftp.get_session(session_id).await?;
        let mut transports = self.transports.lock().await;
        if let Some(transport) = transports.get(session_id) {
            return Ok(Arc::clone(transport));
        }
        let stream = self
            .ssh
            .open_sftp_stream(session_id)
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Disconnected, error.message))?;
        let raw = Arc::new(RawSftpSession::new(stream));
        let version = timeout(SFTP_TIMEOUT, raw.init())
            .await
            .map_err(|_| {
                EditorError::new(
                    EditorErrorCode::Disconnected,
                    "初始化远程编辑 SFTP 子系统超时。",
                )
            })?
            .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?;
        let transport = Arc::new(EditorTransport {
            raw,
            extensions: version.extensions,
        });
        transports.insert(session_id.to_owned(), Arc::clone(&transport));
        Ok(transport)
    }

    async fn document(&self, document_id: &str) -> Result<DocumentState, EditorError> {
        self.inner
            .lock()
            .await
            .documents
            .get(document_id)
            .cloned()
            .ok_or_else(|| {
                EditorError::new(EditorErrorCode::NotFound, "远程编辑文档已关闭或不存在。")
            })
    }

    async fn save_lock(&self, document_id: &str) -> Result<Arc<Mutex<()>>, EditorError> {
        let mut inner = self.inner.lock().await;
        if !inner.documents.contains_key(document_id) {
            return Err(EditorError::new(
                EditorErrorCode::NotFound,
                "远程编辑文档已关闭或不存在。",
            ));
        }
        let key = inner
            .documents
            .get(document_id)
            .map(|state| {
                format!(
                    "{}:{}",
                    state.public.session_id, state.public.canonical_path
                )
            })
            .unwrap_or_default();
        Ok(Arc::clone(
            inner
                .save_locks
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    async fn cleanup_staging(&self, transport: &EditorTransport, document_id: &str, path: &str) {
        if let Err(error) = transport.raw.remove(path.to_owned()).await
            && !matches!(
                error,
                russh_sftp::client::error::Error::Status(ref status)
                    if status.status_code == StatusCode::NoSuchFile
            )
        {
            self.inner
                .lock()
                .await
                .pending_staging
                .entry(document_id.to_owned())
                .or_default()
                .push(path.to_owned());
        }
    }

    async fn cleanup_pending_staging(&self, transport: &EditorTransport, document_id: &str) {
        let pending = self
            .inner
            .lock()
            .await
            .pending_staging
            .remove(document_id)
            .unwrap_or_default();
        let mut remaining = Vec::new();
        for path in pending {
            if !is_editor_staging_path(path.as_str()) {
                continue;
            }
            match transport.raw.lstat(path.clone()).await {
                Ok(attributes) if attributes.attrs.file_type() == FileType::File => {
                    if let Err(error) = transport.raw.remove(path.clone()).await
                        && !matches!(
                            error,
                            russh_sftp::client::error::Error::Status(ref status)
                                if status.status_code == StatusCode::NoSuchFile
                        )
                    {
                        remaining.push(path);
                    }
                }
                Ok(_) => remaining.push(path),
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == StatusCode::NoSuchFile => {}
                Err(_) => remaining.push(path),
            }
        }
        if !remaining.is_empty() {
            self.inner
                .lock()
                .await
                .pending_staging
                .insert(document_id.to_owned(), remaining);
        }
    }

    async fn update_saved_document(
        &self,
        document_id: &str,
        digest: String,
        size_bytes: u64,
        attributes: FileAttributes,
    ) -> Result<(), EditorError> {
        let mut inner = self.inner.lock().await;
        let state = inner.documents.get_mut(document_id).ok_or_else(|| {
            EditorError::new(EditorErrorCode::NotFound, "保存完成后编辑文档已关闭。")
        })?;
        state.public.sha256 = Some(digest);
        state.public.size_bytes = size_bytes;
        state.public.modified_at_sec = attributes.mtime;
        state.public.permissions = attributes.permissions;
        Ok(())
    }

    async fn rename_document_path(
        &self,
        document_id: &str,
        new_path: String,
        digest: String,
        size_bytes: u64,
        attributes: FileAttributes,
    ) -> Result<(), EditorError> {
        let mut inner = self.inner.lock().await;
        let old_key = inner
            .documents
            .get(document_id)
            .map(|state| {
                document_key(
                    &state.public.connection_id,
                    &state.public.session_id,
                    &state.public.canonical_path,
                )
            })
            .ok_or_else(|| EditorError::new(EditorErrorCode::NotFound, "另存后编辑文档已关闭。"))?;
        inner.open_paths.remove(&old_key);
        let state = inner
            .documents
            .get_mut(document_id)
            .ok_or_else(|| EditorError::new(EditorErrorCode::NotFound, "另存后编辑文档已关闭。"))?;
        state.public.canonical_path = new_path.clone();
        state.public.display_name = remote_basename(&new_path).to_owned();
        state.public.sha256 = Some(digest);
        state.public.size_bytes = size_bytes;
        state.public.modified_at_sec = attributes.mtime;
        state.public.permissions = attributes.permissions;
        let new_key = document_key(
            &state.public.connection_id,
            &state.public.session_id,
            &new_path,
        );
        let _ = state;
        inner.open_paths.insert(new_key, document_id.to_owned());
        Ok(())
    }
}

fn ensure_same_binding(
    state: &DocumentState,
    binding: &SessionSecurityBinding,
) -> Result<(), EditorError> {
    if binding.summary.profile_id != state.public.connection_id
        || binding.summary.host != state.endpoint_host
        || binding.summary.port != state.endpoint_port
        || binding.summary.username != state.endpoint_username
        || binding.identity != state.host_key
    {
        return Err(EditorError::new(
            EditorErrorCode::PermissionDenied,
            "当前 SSH 会话与打开文件时的连接身份或可信主机指纹不一致。",
        ));
    }
    if binding.summary.session_id != state.public.session_id {
        return Err(EditorError::new(
            EditorErrorCode::Disconnected,
            "SSH 会话已变化。请重新连接并先验证远程文件版本。",
        ));
    }
    Ok(())
}

async fn stage_file(
    transport: &EditorTransport,
    path: &str,
    bytes: &[u8],
    require_fsync: bool,
) -> Result<(), EditorError> {
    let mut attributes = FileAttributes::empty();
    attributes.set_type(FileMode::REG);
    attributes.permissions = Some(0o100600);
    let handle = transport
        .raw
        .open(
            path.to_owned(),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            attributes,
        )
        .await
        .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?
        .handle;
    let write_result = async {
        for (index, chunk) in bytes.chunks(IO_CHUNK).enumerate() {
            transport
                .raw
                .write(handle.clone(), (index * IO_CHUNK) as u64, chunk.to_vec())
                .await
                .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?;
        }
        if require_fsync {
            transport
                .raw
                .fsync(handle.clone())
                .await
                .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?;
        }
        transport
            .raw
            .close(handle.clone())
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?;
        Ok::<(), EditorError>(())
    }
    .await;
    if write_result.is_err() {
        let _ = transport.raw.close(handle).await;
    }
    write_result
}

async fn fsync_path(transport: &EditorTransport, path: &str) -> Result<(), EditorError> {
    let handle = transport
        .raw
        .open(path.to_owned(), OpenFlags::WRITE, FileAttributes::empty())
        .await
        .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()))?
        .handle;
    let result = transport
        .raw
        .fsync(handle.clone())
        .await
        .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()));
    let close_result = transport
        .raw
        .close(handle)
        .await
        .map(|_| ())
        .map_err(|error| EditorError::new(EditorErrorCode::Other, error.to_string()));
    result.and(close_result)
}

async fn posix_rename(
    transport: &EditorTransport,
    old_path: &str,
    new_path: &str,
) -> Result<(), EditorError> {
    let mut payload = Vec::with_capacity(old_path.len() + new_path.len() + 8);
    append_sftp_string(&mut payload, old_path.as_bytes())?;
    append_sftp_string(&mut payload, new_path.as_bytes())?;
    match transport.raw.extended(POSIX_RENAME, payload).await {
        Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
        Ok(Packet::Status(status)) => Err(EditorError::new(
            EditorErrorCode::NotSupported,
            format!("服务器未能完成受控文件替换：{}", status.error_message),
        )),
        Ok(_) => Err(EditorError::new(
            EditorErrorCode::Other,
            "服务器对安全替换请求返回了意外响应。",
        )),
        Err(error) => Err(EditorError::new(EditorErrorCode::Other, error.to_string())),
    }
}

async fn ensure_absent(transport: &EditorTransport, path: &str) -> Result<(), EditorError> {
    match transport.raw.lstat(path.to_owned()).await {
        Ok(_) => Err(EditorError::new(
            EditorErrorCode::Conflict,
            "另存为目标已存在；现有文件未修改。",
        )),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

async fn hardlink_new_file(
    transport: &EditorTransport,
    source_path: &str,
    target_path: &str,
) -> Result<(), EditorError> {
    if !transport.extensions.contains_key(HARDLINK) {
        return Err(EditorError::new(
            EditorErrorCode::NotSupported,
            "服务器未声明安全新建文件扩展。",
        ));
    }
    let mut payload = Vec::with_capacity(source_path.len() + target_path.len() + 8);
    append_sftp_string(&mut payload, source_path.as_bytes())?;
    append_sftp_string(&mut payload, target_path.as_bytes())?;
    match transport.raw.extended(HARDLINK, payload).await {
        Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
        Ok(Packet::Status(status)) => Err(EditorError::new(
            if status.status_code == StatusCode::Failure {
                EditorErrorCode::Conflict
            } else {
                EditorErrorCode::NotSupported
            },
            format!("安全新建文件失败，目标未被覆盖：{}", status.error_message),
        )),
        Ok(_) => Err(EditorError::new(
            EditorErrorCode::Other,
            "服务器对安全新建文件请求返回了意外响应。",
        )),
        Err(error) => Err(EditorError::new(EditorErrorCode::Other, error.to_string())),
    }
}

fn append_sftp_string(target: &mut Vec<u8>, value: &[u8]) -> Result<(), EditorError> {
    let length = u32::try_from(value.len()).map_err(|_| {
        EditorError::new(
            EditorErrorCode::InvalidPath,
            "远程路径长度超过 SFTP 协议限制。",
        )
    })?;
    target.extend_from_slice(&length.to_be_bytes());
    target.extend_from_slice(value);
    Ok(())
}

async fn read_file_limited(
    session: &SftpSession,
    path: &str,
    limit: usize,
) -> Result<Vec<u8>, EditorError> {
    read_file(session, path, limit, true).await
}

async fn read_file_prefix(
    session: &SftpSession,
    path: &str,
    limit: usize,
) -> Result<Vec<u8>, EditorError> {
    read_file(session, path, limit, false).await
}

async fn read_file(
    session: &SftpSession,
    path: &str,
    limit: usize,
    reject_larger_files: bool,
) -> Result<Vec<u8>, EditorError> {
    let mut file = timeout(SFTP_TIMEOUT, session.open(path.to_owned()))
        .await
        .map_err(|_| EditorError::new(EditorErrorCode::Disconnected, "读取远程文件超时。"))??;
    let attrs = file.metadata().await?;
    if attrs.file_type() != FileType::File {
        return Err(EditorError::new(
            EditorErrorCode::InvalidPath,
            "打开的远程对象不是普通文件。",
        ));
    }
    if reject_larger_files && attrs.size.is_some_and(|size| size > limit as u64) {
        return Err(EditorError::new(
            EditorErrorCode::TooLarge,
            "远程文件超过读取上限。",
        ));
    }
    let mut bytes = Vec::with_capacity(attrs.size.unwrap_or(0).min(limit as u64) as usize);
    let mut buffer = vec![0; IO_CHUNK.min(limit.max(1))];
    loop {
        if bytes.len() >= limit {
            if reject_larger_files {
                let mut probe = [0u8; 1];
                if file.read(&mut probe).await.map_err(|error| {
                    EditorError::new(EditorErrorCode::Disconnected, error.to_string())
                })? > 0
                {
                    bytes.push(probe[0]);
                }
            }
            break;
        }
        let length = buffer.len().min(limit - bytes.len());
        let read = file
            .read(&mut buffer[..length])
            .await
            .map_err(|error| EditorError::new(EditorErrorCode::Disconnected, error.to_string()))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    file.close().await?;
    Ok(bytes)
}

fn validate_path(path: &str) -> Result<(), EditorError> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(EditorError::new(
            EditorErrorCode::InvalidPath,
            "远程路径为空、过长或包含无效字符。",
        ));
    }
    if path.split('/').any(|component| component == "..") {
        return Err(EditorError::new(
            EditorErrorCode::InvalidPath,
            "远程路径不能包含 `..`。",
        ));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), EditorError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains(['/', '\0'])
    {
        return Err(EditorError::new(
            EditorErrorCode::InvalidPath,
            "文件名为空、过长或包含路径分隔符。",
        ));
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), EditorError> {
    if Uuid::parse_str(request_id).is_err() {
        return Err(EditorError::new(
            EditorErrorCode::InvalidRequest,
            "保存请求编号无效。",
        ));
    }
    Ok(())
}

fn codec_error(error: CodecError) -> EditorError {
    match error {
        CodecError::Binary => {
            EditorError::new(EditorErrorCode::Binary, "二进制文件不能作为文本保存。")
        }
        CodecError::UnknownEncoding | CodecError::InvalidUtf16 => EditorError::new(
            EditorErrorCode::UnknownEncoding,
            "文件编码无法无损还原，保存已停止。",
        ),
        CodecError::MixedLineEndings => EditorError::new(
            EditorErrorCode::InvalidContent,
            "文件含有混合换行符，未选择统一转换策略。",
        ),
    }
}

fn document_key(connection_id: &str, session_id: &str, path: &str) -> String {
    format!("{connection_id}:{session_id}:{path}")
}

fn hash_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn remote_basename(path: &str) -> &str {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("/")
}

fn remote_parent(path: &str) -> String {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/".to_owned(),
        Some((parent, _)) => parent.to_owned(),
    }
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn is_editor_staging_path(path: &str) -> bool {
    remote_basename(path)
        .strip_prefix(".termvista-save-")
        .is_some_and(|id| Uuid::parse_str(id).is_ok())
}

fn is_sensitive_path(path: &str) -> bool {
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
    use super::{is_sensitive_path, remote_basename, remote_join, remote_parent, validate_path};

    #[test]
    fn paths_reject_parent_traversal_and_boundaries() {
        assert!(validate_path("/etc/nginx/nginx.conf").is_ok());
        assert!(validate_path("/etc/../passwd").is_err());
        assert!(validate_path("/tmp/a\0b").is_err());
    }

    #[test]
    fn remote_path_helpers_keep_posix_semantics_and_unicode() {
        assert_eq!(remote_parent("/tmp/配置.yml"), "/tmp");
        assert_eq!(remote_basename("/tmp/配置.yml"), "配置.yml");
        assert_eq!(remote_join("/", "x"), "/x");
        assert_eq!(remote_join("/tmp", "x"), "/tmp/x");
    }

    #[test]
    fn sensitive_files_are_flagged_without_logging_or_rejecting_reads() {
        assert!(is_sensitive_path("/etc/ssh/sshd_config"));
        assert!(is_sensitive_path("/home/user/.ssh/config"));
        assert!(is_sensitive_path("/srv/app/.env"));
        assert!(is_sensitive_path("/srv/app/.env.production"));
        assert!(is_sensitive_path("/home/user/.aws/credentials"));
        assert!(!is_sensitive_path("/srv/app/config.yaml"));
    }
}
