use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

use ai::{
    AiRuntime, AiStreamEvent, ChatAccepted, ConnectionTestResult, ContextPreview,
    ContextPreviewRequest, ProviderInput, ProviderModelOption, ProviderView,
};
use connections::{
    AuditAction, AuditOutcome, ConnectionGroup, ConnectionProfile, ConnectionProfilesStore,
    SshConfigImportResult, SshKeyMetadata,
};
use diagnostics::{
    DiagnosticEvent, DiagnosticGrantSummary, DiagnosticPlanApproveRequest,
    DiagnosticPlanCreateRequest, DiagnosticPlanPreview, DiagnosticPlanReviseRequest,
    DiagnosticReportPreview, DiagnosticRunSummary, DiagnosticRuntime,
    DiagnosticShareApproveRequest, DiagnosticShareGrantSummary, DiagnosticTemplateDescriptor,
};
use editor::{
    EditorCompareResult, EditorError, RemoteDocument, RemoteEditorService, RemoteSaveResult,
    SaveCapabilities,
};
use monitor::{
    manager::MonitorManager,
    models::{MonitorEvent, MonitorSnapshot, MonitorSubscriptionId},
};
use security::credential_store::{
    CredentialKey, CredentialKind, CredentialStatus, CredentialStore,
};
use security::vault::{CredentialVault, VaultStatus};
use sftp::{
    ConflictPolicy, DeleteConfirmation, GrantedLocalFile, LocalEntry, LocalRootGrantResult,
    RemoteEntry, SftpError, SftpErrorCode, SftpManager, SftpOpenResult, SftpStatus,
    TransferDirection, TransferProgress,
};
use ssh::{
    AuthPromptEvent, HostKeyChallenge, HostKeyDecision, HostKeyStore, RusshBackend, SessionManager,
    SessionSummary, SshAuth, SshConnectRequest, SshError, SshErrorCode, SshStatusEvent,
    TerminalSize,
};
use tauri::{
    Emitter, Manager, State, WindowEvent,
    ipc::{Channel, InvokeResponseBody},
};
use tunnels::{ForwardRule, ForwardRuntime, TunnelManager};

pub mod ai;
pub mod connections;
pub mod diagnostics;
pub mod editor;
pub mod monitor;
pub mod native_clipboard;
pub mod security;
pub mod settings;
pub mod sftp;
pub mod ssh;
pub mod tunnels;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn application_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectResult {
    session_id: String,
    credential_saved: bool,
    credential_warning: Option<String>,
    profile_warning: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthPromptReply {
    attempt_id: String,
    prompt_id: String,
    responses: Vec<String>,
}

impl Drop for AuthPromptReply {
    fn drop(&mut self) {
        for response in &mut self.responses {
            response.zeroize();
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn connection_profiles_bootstrap(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    legacy_profiles: Vec<ConnectionProfile>,
) -> Result<Vec<ConnectionProfile>, String> {
    profiles.bootstrap(&legacy_profiles)
}

#[tauri::command]
fn connection_profiles_list(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
) -> Result<Vec<ConnectionProfile>, String> {
    profiles.list()
}

#[tauri::command(rename_all = "camelCase")]
fn connection_profile_save(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    profile: ConnectionProfile,
) -> Result<(), String> {
    profiles.save(&profile)
}

#[tauri::command(rename_all = "camelCase")]
async fn connection_profile_delete(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    profile_id: String,
) -> Result<bool, String> {
    tunnels
        .delete_profile_and_stop_tunnels(&profile_id, || profiles.delete(&profile_id))
        .await
}

#[tauri::command(rename_all = "camelCase")]
fn tunnel_rules_list(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    profile_id: Option<String>,
) -> Result<Vec<ForwardRule>, String> {
    profiles.forward_rules_list(profile_id.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
async fn tunnel_rule_save(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    mut rule: ForwardRule,
) -> Result<ForwardRule, String> {
    let rule_id = rule.id.clone();
    tunnels
        .with_rule_stopped(&rule_id, || {
            rule.validate_and_normalize()
                .map_err(|error| error.message)?;
            rule.updated_at = tunnels::models::now_millis();
            profiles.forward_rule_save(&rule).map_err(|error| {
                if error.contains("UNIQUE constraint failed") {
                    "此服务器已经有规则使用了该本地端口。".to_owned()
                } else if error.contains("FOREIGN KEY constraint failed") {
                    "绑定的服务器配置已不存在，请重新选择服务器。".to_owned()
                } else {
                    error
                }
            })?;
            Ok(rule)
        })
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn tunnel_rule_delete(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    rule_id: String,
) -> Result<bool, String> {
    tunnels
        .delete_rule_if_stopped(&rule_id, || profiles.forward_rule_delete(&rule_id))
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn tunnel_start(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    sessions: State<'_, Arc<SessionManager>>,
    rule_id: String,
    session_id: String,
) -> Result<ForwardRuntime, tunnels::models::TunnelError> {
    tunnels
        .start_loaded(
            || {
                profiles
                    .forward_rules_list(None)
                    .map_err(|_| {
                        tunnels::models::TunnelError::new(
                            tunnels::models::TunnelErrorCode::Internal,
                            "无法读取端口转发规则。",
                        )
                    })?
                    .into_iter()
                    .find(|rule| rule.id == rule_id)
                    .ok_or_else(|| {
                        tunnels::models::TunnelError::new(
                            tunnels::models::TunnelErrorCode::InvalidRule,
                            "找不到端口转发规则。",
                        )
                    })
            },
            &session_id,
            sessions.inner().clone(),
        )
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn tunnel_stop(
    tunnels: State<'_, Arc<TunnelManager>>,
    rule_id: String,
) -> Result<ForwardRuntime, tunnels::models::TunnelError> {
    tunnels.stop(&rule_id).await
}

#[tauri::command]
async fn tunnel_status_list(
    tunnels: State<'_, Arc<TunnelManager>>,
) -> Result<Vec<ForwardRuntime>, String> {
    Ok(tunnels.runtime_list().await)
}

#[tauri::command]
fn connection_profiles_clear_recent(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
) -> Result<usize, String> {
    profiles.clear_recent()
}

#[tauri::command]
fn connection_groups_list(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
) -> Result<Vec<ConnectionGroup>, String> {
    profiles.groups_list()
}

#[tauri::command(rename_all = "camelCase")]
fn connection_group_create(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    name: String,
    parent_id: Option<String>,
) -> Result<ConnectionGroup, String> {
    profiles.group_create(&name, parent_id.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
fn connection_group_rename(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    group_id: String,
    name: String,
) -> Result<(), String> {
    profiles.group_rename(&group_id, &name)
}

#[tauri::command(rename_all = "camelCase")]
fn connection_group_move(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    group_id: String,
    parent_id: Option<String>,
    sort_order: i64,
) -> Result<(), String> {
    profiles.group_move(&group_id, parent_id.as_deref(), sort_order)
}

#[tauri::command(rename_all = "camelCase")]
fn connection_group_delete(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    group_id: String,
) -> Result<bool, String> {
    profiles.group_delete_if_empty(&group_id)
}

#[tauri::command(rename_all = "camelCase")]
fn connection_profile_move(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    profile_id: String,
    group_id: Option<String>,
    sort_order: i64,
) -> Result<(), String> {
    profiles.profile_move(&profile_id, group_id.as_deref(), sort_order)
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_config_preview(path: String) -> Result<ssh::config::SshConfigPreview, String> {
    tauri::async_runtime::spawn_blocking(move || ssh::config::preview(&PathBuf::from(path)))
        .await
        .map_err(|_| "SSH Config 预览任务失败。".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_config_import(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    path: String,
    aliases: Vec<String>,
) -> Result<SshConfigImportResult, String> {
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected_aliases = aliases
            .into_iter()
            .map(|alias| alias.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        if selected_aliases.is_empty() {
            return Err("请至少选择一个 SSH Config 主机项。".to_owned());
        }
        let preview = ssh::config::preview(&PathBuf::from(path))?;
        let import_profiles = preview
            .entries
            .into_iter()
            .filter(|entry| {
                entry.importable && selected_aliases.contains(&entry.alias.to_ascii_lowercase())
            })
            .map(|entry| ConnectionProfile {
                id: uuid::Uuid::new_v4().to_string(),
                name: entry.alias,
                host: entry.hostname,
                port: entry.port,
                username: entry.username,
                group_name: "SSH Config".to_owned(),
                group_id: None,
                sort_order: 0,
                auth_method: if entry.identity_file.is_some() {
                    "privateKey".to_owned()
                } else {
                    "password".to_owned()
                },
                private_key_path: entry.identity_file.unwrap_or_default(),
                key_ref: None,
                environment: "development".to_owned(),
                favorite: false,
                last_connected_at: None,
                auto_reconnect: false,
                credential_accounts: Vec::new(),
            })
            .collect::<Vec<_>>();
        if import_profiles.is_empty() {
            return Err("所选项目已不在配置中，或含当前不支持的动态字段。请重新预览。".to_owned());
        }
        profiles.import_ssh_config_profiles(import_profiles)
    })
    .await
    .map_err(|_| "SSH Config 导入任务失败。".to_owned())?
}

#[allow(clippy::too_many_arguments)]
async fn open_ssh_session(
    sessions: &SessionManager,
    ai: &Arc<AiRuntime>,
    diagnostics: &Arc<DiagnosticRuntime>,
    request: SshConnectRequest,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<SshStatusEvent>,
    on_host_key: Channel<HostKeyChallenge>,
    on_auth_prompt: Channel<AuthPromptEvent>,
) -> Result<String, SshError> {
    let session_id = sessions
        .connect(request, on_data, on_status, on_host_key, on_auth_prompt)
        .await?;
    ai.watch_session(session_id.clone()).await;
    diagnostics.watch_session(session_id.clone()).await;
    Ok(session_id)
}

fn credential_key(profile_id: String, username: String, kind: CredentialKind) -> CredentialKey {
    CredentialKey {
        profile_id,
        username,
        kind,
    }
}

fn ssh_error(code: SshErrorCode, message: &'static str) -> SshError {
    SshError::new(code, message)
}

fn record_audit(
    profiles: &ConnectionProfilesStore,
    action: AuditAction,
    profile_id: Option<&str>,
    outcome: AuditOutcome,
) {
    let _ = profiles.record_audit_event(action, profile_id, outcome);
}

async fn record_session_audit(
    profiles: &ConnectionProfilesStore,
    sessions: &SessionManager,
    session_id: &str,
    action: AuditAction,
    outcome: AuditOutcome,
) {
    let profile_id = sessions
        .sessions()
        .await
        .into_iter()
        .find(|session| session.session_id == session_id)
        .map(|session| session.profile_id);
    record_audit(profiles, action, profile_id.as_deref(), outcome);
}

async fn save_credential(
    store: Arc<dyn CredentialStore>,
    key: CredentialKey,
    secret: Zeroizing<String>,
) -> Result<(), ()> {
    tauri::async_runtime::spawn_blocking(move || store.save(&key, &secret))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn load_credential(
    store: Arc<dyn CredentialStore>,
    key: CredentialKey,
) -> Result<Option<Zeroizing<String>>, ()> {
    tauri::async_runtime::spawn_blocking(move || store.load(&key))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn load_managed_private_key(
    vault: Arc<CredentialVault>,
    key_id: String,
) -> Result<Zeroizing<String>, SshError> {
    tauri::async_runtime::spawn_blocking(move || vault.load_managed_key(&key_id))
        .await
        .map_err(|_| {
            ssh_error(
                SshErrorCode::CredentialStoreUnavailable,
                "无法读取 SSH 密钥保险库。",
            )
        })?
        .map_err(|_| {
            ssh_error(
                SshErrorCode::CredentialStoreUnavailable,
                "SSH 密钥保险库已锁定或不可用。",
            )
        })
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
async fn ssh_connect(
    state: State<'_, Arc<SessionManager>>,
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    credentials: State<'_, Arc<dyn CredentialStore>>,
    vault: State<'_, Arc<CredentialVault>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    attempt_id: String,
    profile_id: String,
    host: String,
    port: u16,
    username: String,
    mut auth: SshAuth,
    remember_credential: bool,
    initial_size: TerminalSize,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<SshStatusEvent>,
    on_host_key: Channel<HostKeyChallenge>,
    on_auth_prompt: Channel<AuthPromptEvent>,
) -> Result<SshConnectResult, SshError> {
    if let SshAuth::PrivateKey {
        key_ref: Some(key_id),
        private_key_data,
        ..
    } = &mut auth
        && private_key_data.is_none()
    {
        *private_key_data =
            Some(load_managed_private_key(vault.inner().clone(), key_id.clone()).await?);
    }
    let remembered = if remember_credential {
        match &auth {
            SshAuth::Password { password } => {
                Some((CredentialKind::Password, Zeroizing::new(password.clone())))
            }
            SshAuth::PrivateKey {
                passphrase: Some(passphrase),
                ..
            } if !passphrase.is_empty() => Some((
                CredentialKind::PrivateKeyPassphrase,
                Zeroizing::new(passphrase.clone()),
            )),
            SshAuth::PrivateKey { .. } | SshAuth::KeyboardInteractive => None,
        }
    } else {
        None
    };
    let key = remembered
        .as_ref()
        .map(|(kind, _)| credential_key(profile_id.clone(), username.clone(), *kind));
    let profile_id_for_recent = profile_id.clone();
    let session_result = open_ssh_session(
        state.inner().as_ref(),
        ai.inner(),
        diagnostics.inner(),
        SshConnectRequest {
            attempt_id,
            profile_id,
            host,
            port,
            username,
            auth,
            initial_size,
        },
        on_data,
        on_status,
        on_host_key,
        on_auth_prompt,
    )
    .await;
    let session_id = match session_result {
        Ok(session_id) => session_id,
        Err(error) => {
            let outcome = if error.code == SshErrorCode::Canceled {
                AuditOutcome::Canceled
            } else {
                AuditOutcome::Failed
            };
            record_audit(
                profiles.inner(),
                AuditAction::SshConnection,
                Some(&profile_id_for_recent),
                outcome,
            );
            return Err(error);
        }
    };
    record_audit(
        profiles.inner(),
        AuditAction::SshConnection,
        Some(&profile_id_for_recent),
        AuditOutcome::Succeeded,
    );
    let profile_warning = match settings::should_remember_recent_connection(profiles.inner()) {
        Ok(true) => profiles
            .mark_connected(&profile_id_for_recent)
            .err()
            .map(|_| "SSH 已连接，但无法更新最近连接时间。请检查本机连接配置数据库。".to_owned()),
        Ok(false) => None,
        Err(error) => Some(format!(
            "SSH 已连接，但最近连接设置无法读取，未更新历史记录：{error}"
        )),
    };

    let mut credential_warning = None;
    let credential_saved = if let (Some(key), Some((_, secret))) = (key, remembered) {
        match save_credential(credentials.inner().clone(), key, secret).await {
            Ok(()) => {
                record_audit(
                    profiles.inner(),
                    AuditAction::CredentialSaved,
                    Some(&profile_id_for_recent),
                    AuditOutcome::Succeeded,
                );
                true
            }
            Err(()) => {
                credential_warning = Some(
                    "SSH 已连接，但加密保险库未设置、已锁定或本机安全凭据库不可用；凭据仅用于本次连接。请在设置的“连接与安全”中检查保险库状态。"
                        .to_owned(),
                );
                false
            }
        }
    } else {
        false
    };

    Ok(SshConnectResult {
        session_id,
        credential_saved,
        credential_warning,
        profile_warning,
    })
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
async fn ssh_connect_saved(
    state: State<'_, Arc<SessionManager>>,
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    credentials: State<'_, Arc<dyn CredentialStore>>,
    vault: State<'_, Arc<CredentialVault>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    attempt_id: String,
    profile_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    private_key_path: Option<String>,
    key_ref: Option<String>,
    initial_size: TerminalSize,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<SshStatusEvent>,
    on_host_key: Channel<HostKeyChallenge>,
    on_auth_prompt: Channel<AuthPromptEvent>,
) -> Result<SshConnectResult, SshError> {
    let auth = match auth_method.as_str() {
        "privateKey" => {
            let key_ref = key_ref.filter(|key_ref| !key_ref.trim().is_empty());
            let path = private_key_path
                .filter(|path| !path.trim().is_empty())
                .unwrap_or_default();
            if path.is_empty() && key_ref.is_none() {
                return Err(ssh_error(
                    SshErrorCode::PrivateKeyInvalid,
                    "请先选择 SSH 私钥或私钥文件路径。",
                ));
            }
            let private_key_data = match key_ref {
                Some(key_id) => {
                    Some(load_managed_private_key(vault.inner().clone(), key_id).await?)
                }
                None => None,
            };
            let passphrase = load_credential(
                credentials.inner().clone(),
                credential_key(
                    profile_id.clone(),
                    username.clone(),
                    CredentialKind::PrivateKeyPassphrase,
                ),
            )
            .await
            .map_err(|()| {
                ssh_error(
                    SshErrorCode::CredentialStoreUnavailable,
                    "本机系统凭据库当前不可用，请手动输入私钥口令后重试。",
                )
            })?;
            SshAuth::PrivateKey {
                private_key_path: path,
                key_ref: None,
                private_key_data,
                passphrase: passphrase.map(|secret| secret.to_string()),
            }
        }
        "keyboardInteractive" => {
            return Err(ssh_error(
                SshErrorCode::CredentialMissing,
                "多重提示认证需要在 SSH 登录窗口中逐项输入，不能自动连接。",
            ));
        }
        "password" => {
            let password = load_credential(
                credentials.inner().clone(),
                credential_key(
                    profile_id.clone(),
                    username.clone(),
                    CredentialKind::Password,
                ),
            )
            .await
            .map_err(|()| {
                ssh_error(
                    SshErrorCode::CredentialStoreUnavailable,
                    "本机系统凭据库当前不可用，请手动输入 SSH 密码。",
                )
            })?
            .ok_or_else(|| {
                ssh_error(
                    SshErrorCode::CredentialMissing,
                    "没有找到已保存的 SSH 密码，请输入本次连接凭据。",
                )
            })?;
            SshAuth::Password {
                password: password.to_string(),
            }
        }
        _ => {
            return Err(ssh_error(
                SshErrorCode::PrivateKeyInvalid,
                "连接配置中的认证方式无效，请编辑服务器配置。",
            ));
        }
    };

    let profile_id_for_recent = profile_id.clone();
    let session_result = open_ssh_session(
        state.inner().as_ref(),
        ai.inner(),
        diagnostics.inner(),
        SshConnectRequest {
            attempt_id,
            profile_id,
            host,
            port,
            username,
            auth,
            initial_size,
        },
        on_data,
        on_status,
        on_host_key,
        on_auth_prompt,
    )
    .await;
    let session_id = match session_result {
        Ok(session_id) => session_id,
        Err(error) => {
            let outcome = if error.code == SshErrorCode::Canceled {
                AuditOutcome::Canceled
            } else {
                AuditOutcome::Failed
            };
            record_audit(
                profiles.inner(),
                AuditAction::SshConnection,
                Some(&profile_id_for_recent),
                outcome,
            );
            return Err(error);
        }
    };
    record_audit(
        profiles.inner(),
        AuditAction::SshConnection,
        Some(&profile_id_for_recent),
        AuditOutcome::Succeeded,
    );
    let profile_warning = match settings::should_remember_recent_connection(profiles.inner()) {
        Ok(true) => profiles
            .mark_connected(&profile_id_for_recent)
            .err()
            .map(|_| "SSH 已连接，但无法更新最近连接时间。请检查本机连接配置数据库。".to_owned()),
        Ok(false) => None,
        Err(error) => Some(format!(
            "SSH 已连接，但最近连接设置无法读取，未更新历史记录：{error}"
        )),
    };
    Ok(SshConnectResult {
        session_id,
        credential_saved: true,
        credential_warning: None,
        profile_warning,
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_credential_status(
    credentials: State<'_, Arc<dyn CredentialStore>>,
    profile_id: String,
    username: String,
    kind: CredentialKind,
) -> Result<CredentialStatus, SshError> {
    let key = credential_key(profile_id, username, kind);
    Ok(credential_status(credentials.inner().clone(), key).await)
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_credential_save(
    credentials: State<'_, Arc<dyn CredentialStore>>,
    vault: State<'_, Arc<CredentialVault>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    profile_id: String,
    username: String,
    password: String,
) -> Result<(), SshError> {
    let password = Zeroizing::new(password);
    if password.is_empty() || password.len() > 4096 {
        return Err(ssh_error(
            SshErrorCode::CredentialMissing,
            "SSH 密码为空或超过安全长度限制。",
        ));
    }
    let profile = profiles
        .list()
        .map_err(|_| {
            ssh_error(
                SshErrorCode::CredentialStoreUnavailable,
                "无法读取服务器配置，未保存 SSH 密码。",
            )
        })?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            ssh_error(
                SshErrorCode::CredentialMissing,
                "服务器配置不存在，无法保存 SSH 密码。",
            )
        })?;
    if profile.auth_method != "password"
        || username.trim().is_empty()
        || username == "未设置"
        || profile.username != username
    {
        return Err(ssh_error(
            SshErrorCode::CredentialMissing,
            "请先保存使用密码认证且用户名一致的服务器配置。",
        ));
    }

    vault
        .ensure_ready_for_save()
        .map_err(|message| SshError::new(SshErrorCode::CredentialStoreUnavailable, message))?;

    let key = credential_key(profile_id.clone(), username, CredentialKind::Password);
    save_credential(credentials.inner().clone(), key, password)
        .await
        .map_err(|_| {
            ssh_error(
                SshErrorCode::CredentialStoreUnavailable,
                "无法将 SSH 密码保存到本机加密保险库；未保存明文副本。请检查保险库是否已设置并解锁。",
            )
        })?;
    record_audit(
        profiles.inner(),
        AuditAction::CredentialSaved,
        Some(&profile_id),
        AuditOutcome::Succeeded,
    );
    Ok(())
}

async fn credential_status(
    store: Arc<dyn CredentialStore>,
    key: CredentialKey,
) -> CredentialStatus {
    match load_credential(store, key).await {
        Ok(Some(_)) => CredentialStatus::Saved,
        Ok(None) => CredentialStatus::Missing,
        Err(()) => CredentialStatus::Unavailable,
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_credential_forget(
    credentials: State<'_, Arc<dyn CredentialStore>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    profile_id: String,
    username: String,
    kind: CredentialKind,
) -> Result<(), SshError> {
    let profile_id_for_audit = profile_id.clone();
    let key = credential_key(profile_id, username, kind);
    tauri::async_runtime::spawn_blocking({
        let credentials = credentials.inner().clone();
        move || credentials.forget(&key)
    })
    .await
    .map_err(|_| {
        ssh_error(
            SshErrorCode::CredentialStoreUnavailable,
            "系统凭据库操作失败。",
        )
    })?
    .map_err(|_| {
        ssh_error(
            SshErrorCode::CredentialStoreUnavailable,
            "无法从系统凭据库删除登录凭据。",
        )
    })?;
    record_audit(
        profiles.inner(),
        AuditAction::CredentialForgotten,
        Some(&profile_id_for_audit),
        AuditOutcome::Succeeded,
    );
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_auth_respond(
    state: State<'_, Arc<SessionManager>>,
    mut reply: AuthPromptReply,
) -> Result<(), SshError> {
    let responses = std::mem::take(&mut reply.responses)
        .into_iter()
        .map(Zeroizing::new)
        .collect();
    state
        .auth_response(&reply.attempt_id, &reply.prompt_id, responses)
        .await
}

#[tauri::command]
async fn ssh_keys_list(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
) -> Result<Vec<SshKeyMetadata>, String> {
    let profiles = profiles.inner().clone();
    tauri::async_runtime::spawn_blocking(move || security::ssh_keys::list(&profiles))
        .await
        .map_err(|_| "无法读取 SSH 密钥列表。".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_key_generate(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    vault: State<'_, Arc<CredentialVault>>,
    alias: String,
    key_type: String,
    rsa_bits: Option<u16>,
    passphrase: String,
) -> Result<SshKeyMetadata, String> {
    let profiles = profiles.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let passphrase = Zeroizing::new(passphrase);
        security::ssh_keys::generate(&profiles, &vault, &alias, &key_type, rsa_bits, &passphrase)
    })
    .await
    .map_err(|_| "SSH 密钥生成任务失败。".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_key_import(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    vault: State<'_, Arc<CredentialVault>>,
    path: String,
    alias: String,
    passphrase: Option<String>,
) -> Result<SshKeyMetadata, String> {
    let profiles = profiles.inner().clone();
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let passphrase = passphrase.map(Zeroizing::new);
        security::ssh_keys::import_openssh_file(
            &profiles,
            &vault,
            &PathBuf::from(path),
            &alias,
            passphrase.as_deref().map(String::as_str),
        )
    })
    .await
    .map_err(|_| "SSH 私钥导入任务失败。".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_key_export(
    vault: State<'_, Arc<CredentialVault>>,
    key_id: String,
    path: String,
    current_passphrase: Option<String>,
    export_passphrase: String,
) -> Result<(), String> {
    let vault = vault.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current_passphrase = current_passphrase.map(Zeroizing::new);
        let export_passphrase = Zeroizing::new(export_passphrase);
        security::ssh_keys::export_encrypted(
            &vault,
            &key_id,
            &PathBuf::from(path),
            current_passphrase.as_deref().map(String::as_str),
            &export_passphrase,
        )
    })
    .await
    .map_err(|_| "SSH 私钥导出任务失败。".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
fn ssh_key_delete(
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    key_id: String,
) -> Result<bool, String> {
    security::ssh_keys::delete(profiles.inner(), &key_id)
}

#[tauri::command]
fn credential_vault_status(vault: State<'_, Arc<CredentialVault>>) -> Result<VaultStatus, String> {
    vault.status()
}

#[tauri::command]
fn credential_vault_initialize_keychain(
    vault: State<'_, Arc<CredentialVault>>,
) -> Result<VaultStatus, String> {
    vault.initialize_keychain()
}

#[tauri::command(rename_all = "camelCase")]
fn credential_vault_initialize_master_password(
    vault: State<'_, Arc<CredentialVault>>,
    password: String,
) -> Result<VaultStatus, String> {
    let password = Zeroizing::new(password);
    vault.initialize_master_password(password.as_str())
}

#[tauri::command(rename_all = "camelCase")]
fn credential_vault_unlock(
    vault: State<'_, Arc<CredentialVault>>,
    password: Option<String>,
) -> Result<VaultStatus, String> {
    let password = password.map(Zeroizing::new);
    vault.unlock(password.as_deref().map(String::as_str))
}

#[tauri::command]
fn credential_vault_lock(vault: State<'_, Arc<CredentialVault>>) -> Result<VaultStatus, String> {
    vault.lock()
}

#[tauri::command(rename_all = "camelCase")]
fn credential_vault_rotate(
    vault: State<'_, Arc<CredentialVault>>,
    new_master_password: Option<String>,
) -> Result<VaultStatus, String> {
    let password = new_master_password.map(Zeroizing::new);
    vault.rotate_key(password.as_deref().map(String::as_str))
}

#[tauri::command]
fn trusted_hosts_list(host_keys: State<'_, Arc<HostKeyStore>>) -> Vec<ssh::TrustedHostSummary> {
    host_keys.list()
}

#[tauri::command(rename_all = "camelCase")]
fn trusted_host_forget(
    host_keys: State<'_, Arc<HostKeyStore>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    host: String,
    port: u16,
) -> Result<bool, SshError> {
    let forgotten = host_keys.forget(&host, port)?;
    if forgotten {
        record_audit(
            profiles.inner(),
            AuditAction::HostKeyForgotten,
            None,
            AuditOutcome::Succeeded,
        );
    }
    Ok(forgotten)
}

#[tauri::command(rename_all = "camelCase")]
fn trusted_host_rotate_verified(
    host_keys: State<'_, Arc<HostKeyStore>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    attempt_id: String,
    openssh_public_key: String,
    independently_verified: bool,
) -> Result<(), SshError> {
    host_keys.rotate_verified(&attempt_id, &openssh_public_key, independently_verified)?;
    record_audit(
        profiles.inner(),
        AuditAction::HostKeyRotated,
        None,
        AuditOutcome::Succeeded,
    );
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_host_key_decision(
    state: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    attempt_id: String,
    decision: HostKeyDecision,
) -> Result<(), SshError> {
    state.decide_host_key(&attempt_id, decision).await?;
    if decision != HostKeyDecision::Reject {
        record_audit(
            profiles.inner(),
            AuditAction::HostKeyTrusted,
            None,
            AuditOutcome::Succeeded,
        );
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_cancel_connect(
    state: State<'_, Arc<SessionManager>>,
    attempt_id: String,
) -> Result<(), SshError> {
    state.cancel_connect(&attempt_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_write(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), SshError> {
    state.write(&session_id, data).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_ack_output(
    state: State<'_, Arc<SessionManager>>,
    attempt_id: String,
    bytes: usize,
) -> Result<(), SshError> {
    state.acknowledge_output(&attempt_id, bytes).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ssh_resize(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), SshError> {
    state.resize(&session_id, TerminalSize { cols, rows }).await
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
async fn ssh_disconnect(
    state: State<'_, Arc<SessionManager>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    editor: State<'_, Arc<RemoteEditorService>>,
    sftp: State<'_, Arc<SftpManager>>,
    monitor: State<'_, Arc<MonitorManager>>,
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    session_id: String,
) -> Result<(), SshError> {
    tunnels.stop_session(&session_id).await;
    ai.close_session(&session_id).await;
    diagnostics.close_session(&session_id).await;
    monitor.stop_session(&session_id).await;
    editor.close_session_transport(&session_id).await;
    sftp.close_session(&session_id).await;
    state.disconnect(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn monitor_start(
    state: State<'_, Arc<MonitorManager>>,
    session_id: String,
    on_update: Channel<MonitorEvent>,
) -> Result<MonitorSubscriptionId, SshError> {
    state.start(session_id, on_update).await
}

#[tauri::command(rename_all = "camelCase")]
async fn monitor_set_active(
    state: State<'_, Arc<MonitorManager>>,
    ai: State<'_, Arc<AiRuntime>>,
    session_id: Option<String>,
) -> Result<(), SshError> {
    state.set_active_session(session_id.as_deref()).await;
    ai.set_active_session(session_id.as_deref()).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn monitor_stop(
    state: State<'_, Arc<MonitorManager>>,
    subscription_id: String,
) -> Result<(), SshError> {
    state.stop(&subscription_id).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn monitor_snapshot(
    state: State<'_, Arc<MonitorManager>>,
    session_id: String,
) -> Result<Option<MonitorSnapshot>, SshError> {
    Ok(state.snapshot(&session_id).await)
}

#[tauri::command]
async fn ssh_sessions(
    state: State<'_, Arc<SessionManager>>,
) -> Result<Vec<SessionSummary>, SshError> {
    Ok(state.sessions().await)
}

#[tauri::command]
async fn ssh_close_all(
    state: State<'_, Arc<SessionManager>>,
    tunnels: State<'_, Arc<TunnelManager>>,
    editor: State<'_, Arc<RemoteEditorService>>,
    sftp: State<'_, Arc<SftpManager>>,
    monitor: State<'_, Arc<MonitorManager>>,
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
) -> Result<(), SshError> {
    tunnels.shutdown_all().await;
    ai.close_all().await;
    diagnostics.close_all().await;
    monitor.close_all().await;
    for session in state.sessions().await {
        editor.close_session_transport(&session.session_id).await;
    }
    sftp.close_all().await;
    state.disconnect_all().await;
    Ok(())
}

#[tauri::command]
async fn ai_provider_list(
    state: State<'_, Arc<AiRuntime>>,
) -> Result<Vec<ProviderView>, ai::AiError> {
    Ok(state.provider_list().await)
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_provider_save(
    state: State<'_, Arc<AiRuntime>>,
    input: ProviderInput,
) -> Result<ProviderView, ai::AiError> {
    state.provider_save(input).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_provider_test(
    state: State<'_, Arc<AiRuntime>>,
    provider_id: String,
) -> Result<ConnectionTestResult, ai::AiError> {
    Ok(state.provider_test(&provider_id).await)
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_ollama_models(
    state: State<'_, Arc<AiRuntime>>,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<Vec<ProviderModelOption>, ai::AiError> {
    state.ollama_models(base_url, allow_insecure_http).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_context_preview(
    state: State<'_, Arc<AiRuntime>>,
    request: ContextPreviewRequest,
) -> Result<ContextPreview, ai::AiError> {
    state.context_preview(request).await
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_chat_start(
    state: State<'_, Arc<AiRuntime>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    session_id: String,
    provider_id: String,
    snapshot_id: String,
    on_event: Channel<AiStreamEvent>,
) -> Result<ChatAccepted, ai::AiError> {
    let audit_session_id = session_id.clone();
    let result = state
        .chat_start(session_id, provider_id, snapshot_id, on_event)
        .await;
    if result.is_ok() {
        record_session_audit(
            profiles.inner(),
            sessions.inner(),
            &audit_session_id,
            AuditAction::AiContextShared,
            AuditOutcome::Succeeded,
        )
        .await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_chat_cancel(
    state: State<'_, Arc<AiRuntime>>,
    request_id: String,
) -> Result<bool, ai::AiError> {
    Ok(state.chat_cancel(&request_id).await)
}

#[tauri::command(rename_all = "camelCase")]
async fn ai_conversation_clear(
    state: State<'_, Arc<AiRuntime>>,
    session_id: String,
) -> Result<(), ai::AiError> {
    state.conversation_clear(&session_id).await;
    Ok(())
}

#[tauri::command]
fn diagnostic_templates_list() -> Vec<DiagnosticTemplateDescriptor> {
    DiagnosticRuntime::templates()
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_plan_create(
    state: State<'_, Arc<DiagnosticRuntime>>,
    request: DiagnosticPlanCreateRequest,
) -> Result<DiagnosticPlanPreview, diagnostics::DiagnosticError> {
    state.create_plan(request).await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_plan_revise(
    state: State<'_, Arc<DiagnosticRuntime>>,
    request: DiagnosticPlanReviseRequest,
) -> Result<DiagnosticPlanPreview, diagnostics::DiagnosticError> {
    state.revise_plan(request).await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_plan_approve(
    state: State<'_, Arc<DiagnosticRuntime>>,
    request: DiagnosticPlanApproveRequest,
) -> Result<DiagnosticGrantSummary, diagnostics::DiagnosticError> {
    state.approve_plan(request).await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_start(
    state: State<'_, Arc<DiagnosticRuntime>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    plan_id: String,
    grant_id: String,
    on_event: Channel<DiagnosticEvent>,
) -> Result<String, diagnostics::DiagnosticError> {
    let result = state.start(plan_id, grant_id, on_event).await;
    let run_id = match &result {
        Ok(run_id) => run_id,
        Err(_) => return result,
    };
    if let Some(session_id) = state.session_id_for_run(run_id).await {
        record_session_audit(
            profiles.inner(),
            sessions.inner(),
            &session_id,
            AuditAction::ReadOnlyDiagnosticStarted,
            AuditOutcome::Succeeded,
        )
        .await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_cancel(
    state: State<'_, Arc<DiagnosticRuntime>>,
    run_id: String,
    session_id: String,
) -> Result<bool, diagnostics::DiagnosticError> {
    state.cancel(&run_id, &session_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_run_get(
    state: State<'_, Arc<DiagnosticRuntime>>,
    run_id: String,
    session_id: String,
) -> Result<DiagnosticRunSummary, diagnostics::DiagnosticError> {
    state.get_run(&run_id, &session_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_report_preview(
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    run_id: String,
    session_id: String,
    provider_id: String,
    evidence_ids: Vec<String>,
) -> Result<DiagnosticReportPreview, ai::AiError> {
    ai.diagnostic_report_preview(
        diagnostics.inner(),
        &run_id,
        &session_id,
        &provider_id,
        evidence_ids,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_share_approve(
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    request: DiagnosticShareApproveRequest,
) -> Result<DiagnosticShareGrantSummary, ai::AiError> {
    ai.diagnostic_share_approve(diagnostics.inner(), request)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn diagnostic_report_generate(
    ai: State<'_, Arc<AiRuntime>>,
    diagnostics: State<'_, Arc<DiagnosticRuntime>>,
    share_grant_id: String,
    on_event: Channel<AiStreamEvent>,
) -> Result<ChatAccepted, ai::AiError> {
    ai.diagnostic_report_generate(diagnostics.inner(), &share_grant_id, on_event)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_open(
    editor: State<'_, Arc<RemoteEditorService>>,
    session_id: String,
    remote_path: String,
    allow_large: bool,
) -> Result<RemoteDocument, EditorError> {
    editor.open(&session_id, &remote_path, allow_large).await
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_save_capabilities(
    editor: State<'_, Arc<RemoteEditorService>>,
    session_id: String,
) -> Result<SaveCapabilities, EditorError> {
    editor.capabilities(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)] // Tauri 将每个 IPC 字段作为独立命令参数注入。
async fn editor_save(
    editor: State<'_, Arc<RemoteEditorService>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    document_id: String,
    expected_sha256: String,
    new_text: String,
    request_id: String,
    confirm_sensitive: bool,
) -> Result<RemoteSaveResult, EditorError> {
    let audit_session_id = editor.session_id_for_document(&document_id).await;
    let result = editor
        .save(
            &document_id,
            &expected_sha256,
            &new_text,
            &request_id,
            confirm_sensitive,
        )
        .await;
    if let Some(session_id) = audit_session_id {
        let outcome = match &result {
            Ok(result) if result.status == editor::SaveStatus::Saved && result.verified => {
                AuditOutcome::Succeeded
            }
            _ => AuditOutcome::Failed,
        };
        record_session_audit(
            profiles.inner(),
            sessions.inner(),
            &session_id,
            AuditAction::SftpMutation,
            outcome,
        )
        .await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)] // Tauri 将每个 IPC 字段作为独立命令参数注入。
async fn editor_save_as(
    editor: State<'_, Arc<RemoteEditorService>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    document_id: String,
    expected_sha256: String,
    new_path: String,
    new_text: String,
    request_id: String,
    confirm_sensitive: bool,
) -> Result<RemoteSaveResult, EditorError> {
    let audit_session_id = editor.session_id_for_document(&document_id).await;
    let result = editor
        .save_as(
            &document_id,
            &expected_sha256,
            &new_path,
            &new_text,
            &request_id,
            confirm_sensitive,
        )
        .await;
    if let Some(session_id) = audit_session_id {
        let outcome = match &result {
            Ok(result) if result.status == editor::SaveStatus::Saved && result.verified => {
                AuditOutcome::Succeeded
            }
            _ => AuditOutcome::Failed,
        };
        record_session_audit(
            profiles.inner(),
            sessions.inner(),
            &session_id,
            AuditAction::SftpMutation,
            outcome,
        )
        .await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_compare(
    editor: State<'_, Arc<RemoteEditorService>>,
    document_id: String,
) -> Result<EditorCompareResult, EditorError> {
    editor.compare(&document_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_reload(
    editor: State<'_, Arc<RemoteEditorService>>,
    document_id: String,
) -> Result<RemoteDocument, EditorError> {
    editor.reload(&document_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_rebind(
    editor: State<'_, Arc<RemoteEditorService>>,
    document_id: String,
    new_session_id: String,
) -> Result<RemoteDocument, EditorError> {
    editor.rebind(&document_id, &new_session_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_close(
    editor: State<'_, Arc<RemoteEditorService>>,
    document_id: String,
) -> Result<(), EditorError> {
    editor.close_document(&document_id).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn editor_ai_buffer_revision_register(
    editor: State<'_, Arc<RemoteEditorService>>,
    document_id: String,
    session_id: String,
    revision: u64,
    dirty: bool,
    current_text: String,
) -> Result<(), EditorError> {
    editor
        .register_ai_buffer_revision(&document_id, &session_id, revision, dirty, &current_text)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_open(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    on_status: Channel<SftpStatus>,
) -> Result<SftpOpenResult, SftpError> {
    state.open(&session_id, on_status).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_close(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
) -> Result<(), SftpError> {
    state.close_session(&session_id).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_list_dir(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteEntry>, SftpError> {
    state.list_dir(&session_id, &path).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_stat(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    path: String,
) -> Result<RemoteEntry, SftpError> {
    state.stat(&session_id, &path).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_local_grant_root(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    path: String,
) -> Result<LocalRootGrantResult, SftpError> {
    state.grant_local_root(&session_id, &path).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_local_list_dir(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    grant_id: String,
    relative_path: String,
) -> Result<Vec<LocalEntry>, SftpError> {
    state
        .list_local_dir(&session_id, &grant_id, &relative_path)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_local_grant_files(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
    paths: Vec<String>,
) -> Result<Vec<GrantedLocalFile>, SftpError> {
    state.grant_local_files(&session_id, paths).await
}

#[tauri::command]
fn sftp_clipboard_file_paths() -> Result<Vec<String>, String> {
    native_clipboard::read_file_paths()
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_mkdir(
    state: State<'_, Arc<SftpManager>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    session_id: String,
    parent: String,
    name: String,
) -> Result<(), SftpError> {
    let result = state.mkdir(&session_id, &parent, &name).await;
    let outcome = if result.is_ok() {
        AuditOutcome::Succeeded
    } else {
        AuditOutcome::Failed
    };
    record_session_audit(
        profiles.inner(),
        sessions.inner(),
        &session_id,
        AuditAction::SftpMutation,
        outcome,
    )
    .await;
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_rename(
    state: State<'_, Arc<SftpManager>>,
    editor: State<'_, Arc<RemoteEditorService>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<String, SftpError> {
    let _file_operation_guard = editor.session_file_operation_guard(&session_id).await;
    if editor.path_or_descendant_is_open(&session_id, &path).await {
        return Err(SftpError {
            code: SftpErrorCode::Conflict,
            message: "此文件已在编辑器中打开。请先关闭编辑标签，再重命名。".to_owned(),
        });
    }
    let result = state.rename(&session_id, &path, &new_name).await;
    let outcome = if result.is_ok() {
        AuditOutcome::Succeeded
    } else {
        AuditOutcome::Failed
    };
    record_session_audit(
        profiles.inner(),
        sessions.inner(),
        &session_id,
        AuditAction::SftpMutation,
        outcome,
    )
    .await;
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_prepare_delete(
    state: State<'_, Arc<SftpManager>>,
    editor: State<'_, Arc<RemoteEditorService>>,
    session_id: String,
    path: String,
) -> Result<DeleteConfirmation, SftpError> {
    let _file_operation_guard = editor.session_file_operation_guard(&session_id).await;
    if editor.path_or_descendant_is_open(&session_id, &path).await {
        return Err(SftpError {
            code: SftpErrorCode::Conflict,
            message: "此文件已在编辑器中打开。请先关闭编辑标签，再删除。".to_owned(),
        });
    }
    state.prepare_delete(&session_id, &path).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_delete(
    state: State<'_, Arc<SftpManager>>,
    editor: State<'_, Arc<RemoteEditorService>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    session_id: String,
    operation_id: String,
) -> Result<(), SftpError> {
    let path = state
        .confirmed_delete_path(&session_id, &operation_id)
        .await?;
    let _file_operation_guard = editor.session_file_operation_guard(&session_id).await;
    if editor.path_or_descendant_is_open(&session_id, &path).await {
        return Err(SftpError {
            code: SftpErrorCode::Conflict,
            message: "此文件已在编辑器中打开。请先关闭编辑标签，再删除。".to_owned(),
        });
    }
    let result = state.delete(&session_id, &operation_id).await;
    let outcome = if result.is_ok() {
        AuditOutcome::Succeeded
    } else {
        AuditOutcome::Failed
    };
    record_session_audit(
        profiles.inner(),
        sessions.inner(),
        &session_id,
        AuditAction::SftpMutation,
        outcome,
    )
    .await;
    result
}

#[tauri::command(rename_all = "camelCase")]
// Tauri 将 Channel 与传输参数作为独立 IPC 参数传入。
#[allow(clippy::too_many_arguments)]
async fn sftp_transfer_start(
    state: State<'_, Arc<SftpManager>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    session_id: String,
    direction: TransferDirection,
    local_grant_id: String,
    source_paths: Vec<String>,
    destination_directory: String,
    on_progress: Channel<TransferProgress>,
) -> Result<Vec<String>, SftpError> {
    let result = state
        .start_transfers(
            &session_id,
            direction,
            &local_grant_id,
            source_paths,
            &destination_directory,
            on_progress,
        )
        .await;
    let outcome = if result.is_ok() {
        AuditOutcome::Succeeded
    } else {
        AuditOutcome::Failed
    };
    record_session_audit(
        profiles.inner(),
        sessions.inner(),
        &session_id,
        AuditAction::SftpTransferStarted,
        outcome,
    )
    .await;
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_transfer_resolve(
    state: State<'_, Arc<SftpManager>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    transfer_id: String,
    policy: ConflictPolicy,
    apply_to_queue: bool,
) -> Result<(), SftpError> {
    let session_id = state.transfer_session_id(&transfer_id).await?;
    let result = state
        .resolve_transfer(&transfer_id, policy, apply_to_queue)
        .await;
    if result.is_ok() {
        record_session_audit(
            profiles.inner(),
            sessions.inner(),
            &session_id,
            AuditAction::SftpConflictResolved,
            AuditOutcome::Succeeded,
        )
        .await;
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_transfer_cancel(
    state: State<'_, Arc<SftpManager>>,
    transfer_id: String,
) -> Result<(), SftpError> {
    state.cancel_transfer(&transfer_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_transfer_retry(
    state: State<'_, Arc<SftpManager>>,
    sessions: State<'_, Arc<SessionManager>>,
    profiles: State<'_, Arc<ConnectionProfilesStore>>,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<Vec<String>, SftpError> {
    let session_id = state.transfer_session_id(&transfer_id).await?;
    let result = state.retry_transfer(&transfer_id, on_progress).await;
    let outcome = if result.is_ok() {
        AuditOutcome::Succeeded
    } else {
        AuditOutcome::Failed
    };
    record_session_audit(
        profiles.inner(),
        sessions.inner(),
        &session_id,
        AuditAction::SftpTransferStarted,
        outcome,
    )
    .await;
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_transfer_list(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
) -> Result<Vec<TransferProgress>, SftpError> {
    Ok(state.list_transfers(&session_id).await)
}

#[tauri::command(rename_all = "camelCase")]
async fn sftp_transfer_clear_completed(
    state: State<'_, Arc<SftpManager>>,
    session_id: String,
) -> Result<(), SftpError> {
    state.clear_completed_transfers(&session_id).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let known_hosts_path = app.path().app_data_dir()?.join("known_hosts.json");
            let connection_profiles_path = app.path().app_data_dir()?.join("connections.sqlite3");
            let connection_profiles = Arc::new(
                ConnectionProfilesStore::open(connection_profiles_path)
                    .map_err(std::io::Error::other)?,
            );
            let host_keys = Arc::new(
                HostKeyStore::load(known_hosts_path)
                    .map_err(|error| std::io::Error::other(error.message))?,
            );
            let sessions = Arc::new(SessionManager::new(
                Arc::new(RusshBackend),
                Arc::clone(&host_keys),
            ));
            let tunnel_app = app.handle().clone();
            let tunnels = Arc::new(TunnelManager::new(move |runtime| {
                let _ = tunnel_app.emit("tunnel-runtime", runtime);
            }));
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
            let ai_config_path = app.path().app_config_dir()?.join("ai_providers.json");
            let ai = Arc::new(
                AiRuntime::new(
                    ai_config_path,
                    Arc::clone(&sessions),
                    Arc::clone(&monitor),
                    Arc::clone(&sftp),
                    Arc::clone(&editor),
                    Arc::clone(&diagnostics),
                )
                .map_err(|error| std::io::Error::other(error.message))?,
            );
            let credential_vault = Arc::new(CredentialVault::new(Arc::clone(&connection_profiles)));
            let credentials: Arc<dyn CredentialStore> = credential_vault.clone();
            app.manage(Arc::clone(&sessions));
            app.manage(Arc::clone(&tunnels));
            app.manage(connection_profiles);
            app.manage(host_keys);
            app.manage(credential_vault);
            app.manage(credentials);
            app.manage(Arc::clone(&monitor));
            app.manage(Arc::clone(&sftp));
            app.manage(editor);
            app.manage(ai);
            app.manage(diagnostics);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let sessions = window.state::<Arc<SessionManager>>().inner().clone();
                let tunnels = window.state::<Arc<TunnelManager>>().inner().clone();
                let sftp = window.state::<Arc<SftpManager>>().inner().clone();
                let editor = window.state::<Arc<RemoteEditorService>>().inner().clone();
                let monitor = window.state::<Arc<MonitorManager>>().inner().clone();
                let ai = window.state::<Arc<AiRuntime>>().inner().clone();
                let diagnostics = window.state::<Arc<DiagnosticRuntime>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    tunnels.shutdown_all().await;
                    editor.close_all().await;
                    ai.close_all().await;
                    diagnostics.close_all().await;
                    monitor.close_all().await;
                    sftp.close_all().await;
                    sessions.disconnect_all().await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            application_exit,
            connection_profiles_bootstrap,
            connection_profiles_list,
            connection_profile_save,
            connection_profile_delete,
            tunnel_rules_list,
            tunnel_rule_save,
            tunnel_rule_delete,
            tunnel_start,
            tunnel_stop,
            tunnel_status_list,
            connection_profiles_clear_recent,
            connection_groups_list,
            connection_group_create,
            connection_group_rename,
            connection_group_move,
            connection_group_delete,
            connection_profile_move,
            ssh_config_preview,
            ssh_config_import,
            ssh_connect,
            ssh_connect_saved,
            ssh_credential_status,
            ssh_credential_save,
            ssh_credential_forget,
            ssh_auth_respond,
            ssh_keys_list,
            ssh_key_generate,
            ssh_key_import,
            ssh_key_export,
            ssh_key_delete,
            credential_vault_status,
            credential_vault_initialize_keychain,
            credential_vault_initialize_master_password,
            credential_vault_unlock,
            credential_vault_lock,
            credential_vault_rotate,
            ssh_host_key_decision,
            ssh_cancel_connect,
            ssh_write,
            ssh_ack_output,
            ssh_resize,
            ssh_disconnect,
            ssh_sessions,
            ssh_close_all,
            trusted_hosts_list,
            trusted_host_forget,
            trusted_host_rotate_verified,
            settings::settings_get,
            settings::settings_patch,
            settings::app_metadata_get,
            settings::app_diagnostics_copyable,
            ai_provider_list,
            ai_provider_save,
            ai_provider_test,
            ai_ollama_models,
            ai_context_preview,
            ai_chat_start,
            ai_chat_cancel,
            ai_conversation_clear,
            diagnostic_templates_list,
            diagnostic_plan_create,
            diagnostic_plan_revise,
            diagnostic_plan_approve,
            diagnostic_start,
            diagnostic_cancel,
            diagnostic_run_get,
            diagnostic_report_preview,
            diagnostic_share_approve,
            diagnostic_report_generate,
            editor_open,
            editor_save_capabilities,
            editor_save,
            editor_save_as,
            editor_compare,
            editor_reload,
            editor_rebind,
            editor_close,
            editor_ai_buffer_revision_register,
            monitor_start,
            monitor_set_active,
            monitor_stop,
            monitor_snapshot,
            sftp_open,
            sftp_close,
            sftp_list_dir,
            sftp_stat,
            sftp_local_grant_root,
            sftp_local_list_dir,
            sftp_local_grant_files,
            sftp_clipboard_file_paths,
            sftp_mkdir,
            sftp_rename,
            sftp_prepare_delete,
            sftp_delete,
            sftp_transfer_start,
            sftp_transfer_resolve,
            sftp_transfer_cancel,
            sftp_transfer_retry,
            sftp_transfer_list,
            sftp_transfer_clear_completed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod credential_failure_tests {
    use super::{credential_status, load_credential, save_credential};
    use crate::security::credential_store::{
        CredentialKey, CredentialKind, CredentialStatus, CredentialStore, CredentialStoreError,
    };
    use std::sync::Arc;
    use zeroize::Zeroizing;

    struct FailingCredentialStore;

    impl CredentialStore for FailingCredentialStore {
        fn save(&self, _key: &CredentialKey, _secret: &str) -> Result<(), CredentialStoreError> {
            Err(CredentialStoreError)
        }

        fn load(
            &self,
            _key: &CredentialKey,
        ) -> Result<Option<Zeroizing<String>>, CredentialStoreError> {
            Err(CredentialStoreError)
        }

        fn forget(&self, _key: &CredentialKey) -> Result<(), CredentialStoreError> {
            Err(CredentialStoreError)
        }
    }

    #[tokio::test]
    async fn unavailable_credential_store_never_falls_back_to_plaintext() {
        let store: Arc<dyn CredentialStore> = Arc::new(FailingCredentialStore);
        let key = CredentialKey {
            profile_id: "isolated-test-profile".to_owned(),
            username: "test-user".to_owned(),
            kind: CredentialKind::Password,
        };

        assert!(
            save_credential(
                Arc::clone(&store),
                key.clone(),
                Zeroizing::new("temporary-test-secret".to_owned()),
            )
            .await
            .is_err()
        );
        assert!(
            load_credential(Arc::clone(&store), key.clone())
                .await
                .is_err()
        );
        assert_eq!(
            credential_status(store, key).await,
            CredentialStatus::Unavailable
        );
    }
}
