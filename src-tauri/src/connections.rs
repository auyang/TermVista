use std::{path::Path, sync::Mutex, time::SystemTime};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum AuditAction {
    SshConnection,
    CredentialSaved,
    CredentialForgotten,
    HostKeyTrusted,
    HostKeyRotated,
    HostKeyForgotten,
    SftpMutation,
    SftpTransferStarted,
    SftpConflictResolved,
    AiContextShared,
    ReadOnlyDiagnosticStarted,
}

impl AuditAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::SshConnection => "ssh_connection",
            Self::CredentialSaved => "credential_saved",
            Self::CredentialForgotten => "credential_forgotten",
            Self::HostKeyTrusted => "host_key_trusted",
            Self::HostKeyRotated => "host_key_rotated",
            Self::HostKeyForgotten => "host_key_forgotten",
            Self::SftpMutation => "sftp_mutation",
            Self::SftpTransferStarted => "sftp_transfer_started",
            Self::SftpConflictResolved => "sftp_conflict_resolved",
            Self::AiContextShared => "ai_context_shared",
            Self::ReadOnlyDiagnosticStarted => "readonly_diagnostic_started",
        }
    }
}

#[derive(Clone, Copy)]
pub enum AuditOutcome {
    Succeeded,
    Failed,
    Canceled,
}

impl AuditOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "group")]
    pub group_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub auth_method: String,
    pub private_key_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<String>,
    pub environment: String,
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<i64>,
    pub auto_reconnect: bool,
    #[serde(default)]
    pub credential_accounts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportResult {
    pub imported: Vec<String>,
    pub skipped_existing_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultKeyMetadata {
    pub key_id: String,
    pub mode: String,
    pub salt: Vec<u8>,
    pub check_nonce: Vec<u8>,
    pub check_ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedVaultRecord {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub account: String,
    pub kind: String,
    pub enc_version: i64,
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub tag: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyMetadata {
    pub id: String,
    pub alias: String,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
    pub storage_kind: String,
    pub secret_ref: Option<String>,
    pub path_ref: Option<String>,
    pub created_at: i64,
    pub references: usize,
}

pub struct ConnectionProfilesStore {
    connection: Mutex<Connection>,
}

impl ConnectionProfilesStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建连接配置目录：{error}"))?;
        }
        let connection = Connection::open(path).map_err(database_error)?;
        let has_existing_data = std::fs::metadata(path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if version > 3 {
            return Err(format!(
                "连接数据库版本 {version} 高于当前应用支持的版本 3；为保护用户数据，已停止启动。"
            ));
        }
        let phase4b_identity_pending = !migration_applied(&connection, "phase4b_identity_v1")?;
        let phase4b_envelope_pending =
            !migration_applied(&connection, "phase4b_vault_envelope_v2")?;
        let phase4b_nonce_ledger_pending =
            !migration_applied(&connection, "phase4b_nonce_ledger_v3")?;
        if has_existing_data && version < 3 {
            backup_database_before_phase4a_migration(&connection, path)?;
        } else if has_existing_data
            && (phase4b_identity_pending
                || phase4b_envelope_pending
                || phase4b_nonce_ledger_pending)
        {
            backup_database_before_phase4b_migration(&connection, path)?;
        }
        Self::from_connection(connection)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS connection_profiles (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    group_name TEXT NOT NULL,
                    auth_method TEXT NOT NULL,
                    private_key_path TEXT NOT NULL,
                    environment TEXT NOT NULL,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    last_connected_at INTEGER,
                    auto_reconnect INTEGER NOT NULL DEFAULT 0,
                    credential_accounts TEXT NOT NULL DEFAULT '[]'
                 );
                 CREATE INDEX IF NOT EXISTS idx_connection_profiles_recent
                    ON connection_profiles(is_favorite DESC, last_connected_at DESC, name COLLATE NOCASE ASC);
                 CREATE TABLE IF NOT EXISTS app_migrations (
                    name TEXT PRIMARY KEY NOT NULL,
                    applied_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS client_operation_audit (
                    id TEXT PRIMARY KEY NOT NULL,
                    occurred_at INTEGER NOT NULL,
                    action TEXT NOT NULL CHECK (action IN (
                        'ssh_connection', 'credential_saved', 'credential_forgotten',
                        'host_key_trusted', 'host_key_rotated', 'host_key_forgotten',
                        'sftp_mutation', 'sftp_transfer_started', 'sftp_conflict_resolved',
                        'ai_context_shared', 'readonly_diagnostic_started'
                    )),
                    profile_id TEXT,
                    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'canceled'))
                 );
                 CREATE INDEX IF NOT EXISTS idx_client_operation_audit_recent
                    ON client_operation_audit(occurred_at DESC);
                 CREATE TABLE IF NOT EXISTS app_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    schema_version INTEGER NOT NULL,
                    revision INTEGER NOT NULL,
                    settings_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO app_migrations(name, applied_at)
                    VALUES ('phase3b_client_operation_audit_v1', CAST(strftime('%s','now') AS INTEGER) * 1000);
                 INSERT OR IGNORE INTO app_migrations(name, applied_at)
                    VALUES ('phase4a_settings_v1', CAST(strftime('%s','now') AS INTEGER) * 1000);
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(database_error)?;
        migrate_phase4b_identity(&mut connection)?;
        migrate_phase4b_vault_envelope(&mut connection)?;
        migrate_phase4b_nonce_ledger(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn get_settings_record(&self) -> Result<Option<(String, u64)>, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .query_row(
                "SELECT settings_json, revision FROM app_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get::<_, u64>(1)?)),
            )
            .optional()
            .map_err(database_error)
    }

    pub fn save_settings_record(
        &self,
        expected_revision: u64,
        settings_json: &str,
    ) -> Result<u64, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let current_revision = transaction
            .query_row(
                "SELECT revision FROM app_settings WHERE id = 1",
                [],
                |row| row.get::<_, u64>(0),
            )
            .optional()
            .map_err(database_error)?
            .unwrap_or(0);
        if current_revision != expected_revision {
            return Err("设置已在其他窗口更新，请重新加载后再试。".to_owned());
        }
        let revision = current_revision + 1;
        transaction
            .execute(
                "INSERT INTO app_settings(id, schema_version, revision, settings_json, updated_at)
                 VALUES (1, 1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    revision = excluded.revision,
                    settings_json = excluded.settings_json,
                    updated_at = excluded.updated_at",
                params![revision, settings_json, unix_time_millis()],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(revision)
    }

    pub fn bootstrap(
        &self,
        legacy_profiles: &[ConnectionProfile],
    ) -> Result<Vec<ConnectionProfile>, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let imported = transaction
            .query_row(
                "SELECT 1 FROM app_migrations WHERE name = 'import_local_storage_profiles_v1'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error)?
            .is_some();

        if !imported {
            let count: i64 = transaction
                .query_row("SELECT COUNT(*) FROM connection_profiles", [], |row| {
                    row.get(0)
                })
                .map_err(database_error)?;
            if count == 0 {
                for profile in legacy_profiles {
                    upsert(&transaction, profile)?;
                }
            }
            transaction
                .execute(
                    "INSERT INTO app_migrations(name, applied_at) VALUES ('import_local_storage_profiles_v1', ?1)",
                    [unix_time_millis()],
                )
                .map_err(database_error)?;
        }

        let profiles = list_from(&transaction)?;
        transaction.commit().map_err(database_error)?;
        Ok(profiles)
    }

    pub fn list(&self) -> Result<Vec<ConnectionProfile>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        list_from(&connection)
    }

    pub fn save(&self, profile: &ConnectionProfile) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let previous_group_id: Option<Option<String>> = transaction
            .query_row(
                "SELECT group_id FROM connection_profiles WHERE id = ?1",
                [&profile.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        upsert(&transaction, profile)?;
        if previous_group_id.as_ref() != Some(&profile.group_id) {
            if let Some(previous_group_id) = previous_group_id {
                normalize_profile_order(&transaction, previous_group_id.as_deref(), None)?;
            }
            normalize_profile_order(
                &transaction,
                profile.group_id.as_deref(),
                Some((&profile.id, profile.sort_order)),
            )?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn import_ssh_config_profiles(
        &self,
        mut profiles: Vec<ConnectionProfile>,
    ) -> Result<SshConfigImportResult, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let group_id = ensure_group_for_name(&transaction, "SSH Config")?;
        let mut sort_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connection_profiles WHERE group_id = ?1",
                [&group_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut result = SshConfigImportResult {
            imported: Vec::new(),
            skipped_existing_names: Vec::new(),
        };
        let mut imported_names = std::collections::HashSet::new();
        for profile in &mut profiles {
            let name = profile.name.trim().to_owned();
            if name.is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
                return Err("SSH Config 中存在无效的主机别名，未导入任何连接。".to_owned());
            }
            let already_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM connection_profiles WHERE name = ?1 COLLATE NOCASE)",
                    [&name],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if already_exists || !imported_names.insert(name.to_ascii_lowercase()) {
                result.skipped_existing_names.push(name);
                continue;
            }
            profile.name = name.clone();
            profile.group_name = "SSH Config".to_owned();
            profile.group_id = Some(group_id.clone());
            profile.sort_order = sort_order;
            sort_order += 1;
            upsert(&transaction, profile)?;
            result.imported.push(name);
        }
        transaction.commit().map_err(database_error)?;
        Ok(result)
    }

    pub fn groups_list(&self) -> Result<Vec<ConnectionGroup>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        list_groups(&connection)
    }

    pub fn group_create(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<ConnectionGroup, String> {
        let name = validate_group_name(name)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        if let Some(parent_id) = parent_id {
            ensure_group_exists(&transaction, parent_id)?;
        }
        let sort_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connection_groups WHERE parent_id IS ?1",
                [parent_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let group = ConnectionGroup {
            id: Uuid::new_v4().to_string(),
            parent_id: parent_id.map(str::to_owned),
            name,
            sort_order,
        };
        transaction
            .execute(
                "INSERT INTO connection_groups(id, parent_id, name, sort_order) VALUES (?1, ?2, ?3, ?4)",
                params![group.id, group.parent_id, group.name, group.sort_order],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(group)
    }

    pub fn group_rename(&self, group_id: &str, name: &str) -> Result<(), String> {
        let name = validate_group_name(name)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let changed = transaction
            .execute(
                "UPDATE connection_groups SET name = ?1 WHERE id = ?2",
                params![name, group_id],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err("找不到要修改的连接分组。".to_owned());
        }
        sync_legacy_group_paths(&transaction)?;
        transaction.commit().map_err(database_error)
    }

    pub fn group_move(
        &self,
        group_id: &str,
        parent_id: Option<&str>,
        sort_order: i64,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        ensure_group_exists(&transaction, group_id)?;
        let source_parent_id: Option<String> = transaction
            .query_row(
                "SELECT parent_id FROM connection_groups WHERE id = ?1",
                [group_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if let Some(parent_id) = parent_id {
            ensure_group_exists(&transaction, parent_id)?;
            let is_descendant: bool = transaction
                .query_row(
                    "WITH RECURSIVE descendants(id) AS (
                        SELECT id FROM connection_groups WHERE parent_id = ?1
                        UNION ALL
                        SELECT child.id FROM connection_groups child JOIN descendants d ON child.parent_id = d.id
                     ) SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                    params![group_id, parent_id],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if group_id == parent_id || is_descendant {
                return Err("不能将分组移动到自身或其子级中。".to_owned());
            }
        }

        let mut destination_order = {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM connection_groups
                     WHERE parent_id IS ?1 ORDER BY sort_order, name COLLATE NOCASE, id",
                )
                .map_err(database_error)?;
            statement
                .query_map([parent_id], |row| row.get::<_, String>(0))
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?
        };
        destination_order.retain(|id| id != group_id);
        let insertion_index = usize::try_from(sort_order.max(0))
            .unwrap_or(usize::MAX)
            .min(destination_order.len());
        destination_order.insert(insertion_index, group_id.to_owned());

        let mut source_order = if source_parent_id.as_deref() != parent_id {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM connection_groups
                     WHERE parent_id IS ?1 AND id != ?2
                     ORDER BY sort_order, name COLLATE NOCASE, id",
                )
                .map_err(database_error)?;
            statement
                .query_map(params![source_parent_id, group_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?
        } else {
            Vec::new()
        };
        transaction
            .execute(
                "UPDATE connection_groups SET parent_id = ?1, sort_order = -1 WHERE id = ?2",
                params![parent_id, group_id],
            )
            .map_err(database_error)?;

        for (index, id) in destination_order.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE connection_groups SET sort_order = ?1 WHERE id = ?2",
                    params![i64::try_from(index).unwrap_or(i64::MAX), id],
                )
                .map_err(database_error)?;
        }
        for (index, id) in source_order.drain(..).enumerate() {
            transaction
                .execute(
                    "UPDATE connection_groups SET sort_order = ?1 WHERE id = ?2",
                    params![i64::try_from(index).unwrap_or(i64::MAX), id],
                )
                .map_err(database_error)?;
        }
        sync_legacy_group_paths(&transaction)?;
        transaction.commit().map_err(database_error)
    }

    pub fn group_delete_if_empty(&self, group_id: &str) -> Result<bool, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let referenced: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM connection_profiles WHERE group_id = ?1)
                    OR EXISTS(SELECT 1 FROM connection_groups WHERE parent_id = ?1)",
                [group_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if referenced {
            return Ok(false);
        }
        let deleted = transaction
            .execute("DELETE FROM connection_groups WHERE id = ?1", [group_id])
            .map_err(database_error)?
            > 0;
        transaction.commit().map_err(database_error)?;
        Ok(deleted)
    }

    pub fn profile_move(
        &self,
        profile_id: &str,
        group_id: Option<&str>,
        sort_order: i64,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let source_group_id: Option<String> = transaction
            .query_row(
                "SELECT group_id FROM connection_profiles WHERE id = ?1",
                [profile_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "找不到要移动的连接配置。".to_owned())?;
        let group_path = match group_id {
            Some(group_id) => group_path(&transaction, group_id)?,
            None => String::new(),
        };

        let mut destination_order = {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM connection_profiles
                     WHERE group_id IS ?1 ORDER BY sort_order, name COLLATE NOCASE, id",
                )
                .map_err(database_error)?;
            statement
                .query_map([group_id], |row| row.get::<_, String>(0))
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?
        };
        destination_order.retain(|id| id != profile_id);
        let insertion_index = usize::try_from(sort_order.max(0))
            .unwrap_or(usize::MAX)
            .min(destination_order.len());
        destination_order.insert(insertion_index, profile_id.to_owned());

        let source_order = if source_group_id.as_deref() != group_id {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM connection_profiles
                     WHERE group_id IS ?1 AND id != ?2
                     ORDER BY sort_order, name COLLATE NOCASE, id",
                )
                .map_err(database_error)?;
            statement
                .query_map(params![source_group_id, profile_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?
        } else {
            Vec::new()
        };
        let changed = transaction
            .execute(
                "UPDATE connection_profiles SET group_id = ?1, group_name = ?2, sort_order = -1 WHERE id = ?3",
                params![group_id, group_path, profile_id],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err("找不到要移动的连接配置。".to_owned());
        }
        for (index, id) in destination_order.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE connection_profiles SET sort_order = ?1 WHERE id = ?2",
                    params![i64::try_from(index).unwrap_or(i64::MAX), id],
                )
                .map_err(database_error)?;
        }
        for (index, id) in source_order.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE connection_profiles SET sort_order = ?1 WHERE id = ?2",
                    params![i64::try_from(index).unwrap_or(i64::MAX), id],
                )
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn vault_active_key(&self) -> Result<Option<VaultKeyMetadata>, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .query_row(
                "SELECT key_id, mode, salt, check_nonce, check_ciphertext
                 FROM credential_vault_keys WHERE is_active = 1 LIMIT 1",
                [],
                |row| {
                    Ok(VaultKeyMetadata {
                        key_id: row.get(0)?,
                        mode: row.get(1)?,
                        salt: row.get(2)?,
                        check_nonce: row.get(3)?,
                        check_ciphertext: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)
    }

    pub fn vault_key_create(&self, metadata: &VaultKeyMetadata) -> Result<(), String> {
        if metadata.check_nonce.len() != 12 {
            return Err("保险库验证 nonce 格式无效。".to_owned());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO credential_vault_keys(key_id, mode, salt, check_nonce, check_ciphertext, created_at, is_active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                params![
                    metadata.key_id,
                    metadata.mode,
                    metadata.salt,
                    metadata.check_nonce,
                    metadata.check_ciphertext,
                    unix_time_millis(),
                ],
            )
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO credential_vault_nonce_ledger(key_id, nonce, reserved_at)
                 VALUES (?1, ?2, ?3)",
                params![metadata.key_id, metadata.check_nonce, unix_time_millis()],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn vault_records_list(&self) -> Result<Vec<EncryptedVaultRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT id, owner_type, owner_id, account, kind, enc_version, key_id, nonce, ciphertext, tag
                 FROM credential_vault_records ORDER BY id",
            )
            .map_err(database_error)?;
        statement
            .query_map([], |row| {
                Ok(EncryptedVaultRecord {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    account: row.get(3)?,
                    kind: row.get(4)?,
                    enc_version: row.get(5)?,
                    key_id: row.get(6)?,
                    nonce: row.get(7)?,
                    ciphertext: row.get(8)?,
                    tag: row.get(9)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)
    }

    pub fn vault_rotate_records(
        &self,
        expected_active_key_id: &str,
        metadata: &VaultKeyMetadata,
        records: &[EncryptedVaultRecord],
    ) -> Result<(), String> {
        if metadata.key_id == expected_active_key_id || metadata.check_nonce.len() != 12 {
            return Err("新保险库密钥元数据无效。".to_owned());
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let active_key_id: Option<String> = transaction
            .query_row(
                "SELECT key_id FROM credential_vault_keys WHERE is_active = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if active_key_id.as_deref() != Some(expected_active_key_id) {
            return Err("保险库状态已变化，未执行密钥轮换；请刷新后重试。".to_owned());
        }
        let record_count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM credential_vault_records", [], |row| {
                row.get(0)
            })
            .map_err(database_error)?;
        if usize::try_from(record_count).ok() != Some(records.len()) {
            return Err("保险库记录在轮换期间发生变化，数据未修改；请重试。".to_owned());
        }
        if records.iter().any(|record| {
            record.key_id != metadata.key_id
                || record.enc_version != 1
                || record.nonce.len() != 12
                || record.tag.len() != 16
        }) {
            return Err("待写入的保险库记录格式无效，轮换已取消。".to_owned());
        }
        let deactivated = transaction
            .execute(
                "UPDATE credential_vault_keys SET is_active = 0 WHERE key_id = ?1 AND is_active = 1",
                [expected_active_key_id],
            )
            .map_err(database_error)?;
        if deactivated != 1 {
            return Err("保险库活动密钥已变化，轮换已取消。".to_owned());
        }
        transaction
            .execute(
                "INSERT INTO credential_vault_keys(key_id, mode, salt, check_nonce, check_ciphertext, created_at, is_active)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                params![
                    metadata.key_id,
                    metadata.mode,
                    metadata.salt,
                    metadata.check_nonce,
                    metadata.check_ciphertext,
                    unix_time_millis(),
                ],
            )
            .map_err(database_error)?;
        reserve_rotation_nonce(&transaction, &metadata.key_id, &metadata.check_nonce)?;
        for record in records {
            reserve_rotation_nonce(&transaction, &metadata.key_id, &record.nonce)?;
            let updated = transaction
                .execute(
                    "UPDATE credential_vault_records
                     SET enc_version = ?1, key_id = ?2, nonce = ?3, ciphertext = ?4, tag = ?5, updated_at = ?6
                     WHERE id = ?7 AND key_id = ?8",
                    params![
                        record.enc_version,
                        record.key_id,
                        record.nonce,
                        record.ciphertext,
                        record.tag,
                        unix_time_millis(),
                        record.id,
                        expected_active_key_id,
                    ],
                )
                .map_err(database_error)?;
            if updated != 1 {
                return Err("保险库记录在轮换期间发生变化，事务已回滚。".to_owned());
            }
        }
        transaction.commit().map_err(database_error)
    }

    pub fn vault_record_id(
        &self,
        owner_type: &str,
        owner_id: &str,
        account: &str,
        kind: &str,
    ) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .query_row(
                "SELECT id FROM credential_vault_records
                 WHERE owner_type = ?1 AND owner_id = ?2 AND account = ?3 AND kind = ?4",
                params![owner_type, owner_id, account, kind],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    pub fn vault_record_get(
        &self,
        owner_type: &str,
        owner_id: &str,
        account: &str,
        kind: &str,
    ) -> Result<Option<EncryptedVaultRecord>, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .query_row(
                "SELECT id, owner_type, owner_id, account, kind, enc_version, key_id, nonce, ciphertext, tag
                 FROM credential_vault_records
                 WHERE owner_type = ?1 AND owner_id = ?2 AND account = ?3 AND kind = ?4",
                params![owner_type, owner_id, account, kind],
                |row| {
                    Ok(EncryptedVaultRecord {
                        id: row.get(0)?,
                        owner_type: row.get(1)?,
                        owner_id: row.get(2)?,
                        account: row.get(3)?,
                        kind: row.get(4)?,
                        enc_version: row.get(5)?,
                        key_id: row.get(6)?,
                        nonce: row.get(7)?,
                        ciphertext: row.get(8)?,
                        tag: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)
    }

    pub fn vault_reserve_nonce(&self, key_id: &str, nonce: &[u8]) -> Result<bool, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .execute(
                "INSERT OR IGNORE INTO credential_vault_nonce_ledger(key_id, nonce, reserved_at)
                 VALUES (?1, ?2, ?3)",
                params![key_id, nonce, unix_time_millis()],
            )
            .map(|changed| changed == 1)
            .map_err(database_error)
    }

    pub fn vault_record_save(&self, record: &EncryptedVaultRecord) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let existing_id = transaction
            .query_row(
                "SELECT id FROM credential_vault_records
                 WHERE owner_type = ?1 AND owner_id = ?2 AND account = ?3 AND kind = ?4",
                params![
                    record.owner_type,
                    record.owner_id,
                    record.account,
                    record.kind
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(database_error)?;
        if existing_id.as_deref().is_some_and(|id| id != record.id) {
            return Err("保险库记录标识已变化，请重新尝试保存。".to_owned());
        }
        transaction
            .execute(
                "INSERT INTO credential_vault_records(id, owner_type, owner_id, account, kind, enc_version, key_id, nonce, ciphertext, tag, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(owner_type, owner_id, account, kind) DO UPDATE SET
                    enc_version = excluded.enc_version, key_id = excluded.key_id, nonce = excluded.nonce,
                    ciphertext = excluded.ciphertext, tag = excluded.tag, updated_at = excluded.updated_at",
                params![
                    record.id,
                    record.owner_type,
                    record.owner_id,
                    record.account,
                    record.kind,
                    record.enc_version,
                    record.key_id,
                    record.nonce,
                    record.ciphertext,
                    record.tag,
                    unix_time_millis(),
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn vault_record_delete(
        &self,
        owner_type: &str,
        owner_id: &str,
        account: &str,
        kind: &str,
    ) -> Result<bool, String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .execute(
                "DELETE FROM credential_vault_records
                 WHERE owner_type = ?1 AND owner_id = ?2 AND account = ?3 AND kind = ?4",
                params![owner_type, owner_id, account, kind],
            )
            .map(|changed| changed > 0)
            .map_err(database_error)
    }

    pub fn ssh_key_save(&self, key: &SshKeyMetadata) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?
            .execute(
                "INSERT INTO ssh_keys(id, alias, key_type, fingerprint, public_key, storage_kind, secret_ref, path_ref, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    key.id,
                    key.alias,
                    key.key_type,
                    key.fingerprint,
                    key.public_key,
                    key.storage_kind,
                    key.secret_ref,
                    key.path_ref,
                    key.created_at,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn ssh_key_list(&self) -> Result<Vec<SshKeyMetadata>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT k.id, k.alias, k.key_type, k.fingerprint, k.public_key, k.storage_kind,
                        k.secret_ref, k.path_ref, k.created_at,
                        (SELECT COUNT(*) FROM connection_profiles p WHERE p.key_ref = k.id)
                 FROM ssh_keys k ORDER BY k.alias COLLATE NOCASE, k.created_at",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(SshKeyMetadata {
                    id: row.get(0)?,
                    alias: row.get(1)?,
                    key_type: row.get(2)?,
                    fingerprint: row.get(3)?,
                    public_key: row.get(4)?,
                    storage_kind: row.get(5)?,
                    secret_ref: row.get(6)?,
                    path_ref: row.get(7)?,
                    created_at: row.get(8)?,
                    references: usize::try_from(row.get::<_, i64>(9)?.max(0)).unwrap_or(usize::MAX),
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
    }

    pub fn ssh_key_get(&self, key_id: &str) -> Result<Option<SshKeyMetadata>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        connection
            .query_row(
                "SELECT k.id, k.alias, k.key_type, k.fingerprint, k.public_key, k.storage_kind,
                        k.secret_ref, k.path_ref, k.created_at,
                        (SELECT COUNT(*) FROM connection_profiles p WHERE p.key_ref = k.id)
                 FROM ssh_keys k WHERE k.id = ?1",
                [key_id],
                |row| {
                    Ok(SshKeyMetadata {
                        id: row.get(0)?,
                        alias: row.get(1)?,
                        key_type: row.get(2)?,
                        fingerprint: row.get(3)?,
                        public_key: row.get(4)?,
                        storage_kind: row.get(5)?,
                        secret_ref: row.get(6)?,
                        path_ref: row.get(7)?,
                        created_at: row.get(8)?,
                        references: usize::try_from(row.get::<_, i64>(9)?.max(0))
                            .unwrap_or(usize::MAX),
                    })
                },
            )
            .optional()
            .map_err(database_error)
    }

    pub fn ssh_key_delete_if_unreferenced(&self, key_id: &str) -> Result<bool, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        let transaction = connection.transaction().map_err(database_error)?;
        let references: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM connection_profiles WHERE key_ref = ?1",
                [key_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if references > 0 {
            return Err(format!(
                "该 SSH 密钥仍被 {references} 个连接引用，不能删除。"
            ));
        }
        let deleted = transaction
            .execute("DELETE FROM ssh_keys WHERE id = ?1", [key_id])
            .map_err(database_error)?
            > 0;
        if deleted {
            transaction
                .execute(
                    "DELETE FROM credential_vault_records
                     WHERE owner_type = 'ssh_private_key' AND owner_id = ?1 AND kind = 'private_key'",
                    [key_id],
                )
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)?;
        Ok(deleted)
    }

    pub fn delete(&self, profile_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        connection
            .execute(
                "DELETE FROM connection_profiles WHERE id = ?1",
                [profile_id],
            )
            .map(|changed| changed > 0)
            .map_err(database_error)
    }

    pub fn mark_connected(&self, profile_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        connection
            .execute(
                "UPDATE connection_profiles SET last_connected_at = ?1 WHERE id = ?2",
                params![unix_time_millis(), profile_id],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn clear_recent(&self) -> Result<usize, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        connection
            .execute(
                "UPDATE connection_profiles SET last_connected_at = NULL",
                [],
            )
            .map_err(database_error)
    }

    pub fn record_audit_event(
        &self,
        action: AuditAction,
        profile_id: Option<&str>,
        outcome: AuditOutcome,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "连接配置数据库锁已损坏。".to_owned())?;
        connection
            .execute(
                "INSERT INTO client_operation_audit(id, occurred_at, action, profile_id, outcome)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    unix_time_millis(),
                    action.as_str(),
                    profile_id,
                    outcome.as_str(),
                ],
            )
            .map_err(database_error)?;
        connection
            .execute(
                "DELETE FROM client_operation_audit
                 WHERE id NOT IN (
                    SELECT id FROM client_operation_audit ORDER BY occurred_at DESC LIMIT 5000
                 )",
                [],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

fn upsert(connection: &Connection, profile: &ConnectionProfile) -> Result<(), String> {
    let group_id = match profile.group_id.as_deref() {
        Some(group_id) if group_exists(connection, group_id)? => group_id.to_owned(),
        Some(_) => return Err("连接配置引用的分组不存在。".to_owned()),
        None => ensure_group_for_name(connection, &profile.group_name)?,
    };
    let credential_accounts = serde_json::to_string(&profile.credential_accounts)
        .map_err(|error| format!("无法序列化连接账户标记：{error}"))?;
    connection
        .execute(
            "INSERT INTO connection_profiles (
                id, name, host, port, username, group_name, auth_method, private_key_path,
                environment, is_favorite, last_connected_at, auto_reconnect, credential_accounts,
                group_id, sort_order, key_ref
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                group_name = excluded.group_name,
                auth_method = excluded.auth_method,
                private_key_path = excluded.private_key_path,
                environment = excluded.environment,
                is_favorite = excluded.is_favorite,
                last_connected_at = excluded.last_connected_at,
                auto_reconnect = excluded.auto_reconnect,
                credential_accounts = excluded.credential_accounts,
                group_id = excluded.group_id,
                sort_order = excluded.sort_order,
                key_ref = excluded.key_ref",
            params![
                profile.id,
                profile.name,
                profile.host,
                profile.port,
                profile.username,
                profile.group_name,
                profile.auth_method,
                profile.private_key_path,
                profile.environment,
                profile.favorite,
                profile.last_connected_at,
                profile.auto_reconnect,
                credential_accounts,
                group_id,
                profile.sort_order,
                profile.key_ref,
            ],
        )
        .map(|_| ())
        .map_err(database_error)
}

fn normalize_profile_order(
    connection: &Connection,
    group_id: Option<&str>,
    insert_profile: Option<(&str, i64)>,
) -> Result<(), String> {
    let mut ordered_ids = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM connection_profiles
                 WHERE group_id IS ?1 AND (?2 IS NULL OR id != ?2)
                 ORDER BY sort_order, name COLLATE NOCASE, id",
            )
            .map_err(database_error)?;
        statement
            .query_map(params![group_id, insert_profile.map(|(id, _)| id)], |row| {
                row.get::<_, String>(0)
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?
    };
    if let Some((profile_id, requested_order)) = insert_profile {
        let insertion_index = usize::try_from(requested_order.max(0))
            .unwrap_or(usize::MAX)
            .min(ordered_ids.len());
        ordered_ids.insert(insertion_index, profile_id.to_owned());
    }
    for (index, profile_id) in ordered_ids.iter().enumerate() {
        connection
            .execute(
                "UPDATE connection_profiles SET sort_order = ?1 WHERE id = ?2",
                params![i64::try_from(index).unwrap_or(i64::MAX), profile_id],
            )
            .map_err(database_error)?;
    }
    Ok(())
}

fn list_from(connection: &Connection) -> Result<Vec<ConnectionProfile>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, host, port, username, group_name, auth_method, private_key_path,
                    environment, is_favorite, last_connected_at, auto_reconnect, credential_accounts,
                    group_id, sort_order, key_ref
             FROM connection_profiles
             ORDER BY is_favorite DESC, last_connected_at DESC, name COLLATE NOCASE ASC",
        )
        .map_err(database_error)?;
    let rows = statement
        .query_map([], |row| {
            let credential_accounts_json: String = row.get(12)?;
            let credential_accounts =
                serde_json::from_str(&credential_accounts_json).unwrap_or_default();
            Ok(ConnectionProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                username: row.get(4)?,
                group_name: row.get(5)?,
                auth_method: row.get(6)?,
                private_key_path: row.get(7)?,
                environment: row.get(8)?,
                favorite: row.get(9)?,
                last_connected_at: row.get(10)?,
                auto_reconnect: row.get(11)?,
                credential_accounts,
                group_id: row.get(13)?,
                sort_order: row.get(14)?,
                key_ref: row.get(15)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

fn migration_applied(connection: &Connection, name: &str) -> Result<bool, String> {
    let has_table = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_migrations')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(database_error)?;
    if !has_table {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn migrate_phase4b_identity(connection: &mut Connection) -> Result<(), String> {
    if migration_applied(connection, "phase4b_identity_v1")? {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(database_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS connection_groups (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT REFERENCES connection_groups(id) ON DELETE RESTRICT,
                name TEXT NOT NULL CHECK (length(trim(name)) > 0),
                sort_order INTEGER NOT NULL DEFAULT 0
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_groups_root_name
                ON connection_groups(name COLLATE NOCASE) WHERE parent_id IS NULL;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_groups_child_name
                ON connection_groups(parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_connection_groups_order
                ON connection_groups(parent_id, sort_order, name COLLATE NOCASE);
             CREATE TABLE IF NOT EXISTS credential_vault_keys (
                key_id TEXT PRIMARY KEY NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('keychain', 'masterPassword')),
                salt BLOB NOT NULL,
                check_nonce BLOB NOT NULL,
                check_ciphertext BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_vault_active_key
                ON credential_vault_keys(is_active) WHERE is_active = 1;
             CREATE TABLE IF NOT EXISTS credential_vault_nonce_ledger (
                key_id TEXT NOT NULL REFERENCES credential_vault_keys(key_id) ON DELETE RESTRICT,
                nonce BLOB NOT NULL,
                reserved_at INTEGER NOT NULL,
                PRIMARY KEY(key_id, nonce)
             );
             CREATE TABLE IF NOT EXISTS credential_vault_records (
                id TEXT PRIMARY KEY NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                account TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL,
                enc_version INTEGER NOT NULL DEFAULT 1,
                key_id TEXT NOT NULL REFERENCES credential_vault_keys(key_id) ON DELETE RESTRICT,
                nonce BLOB NOT NULL,
                ciphertext BLOB NOT NULL,
                tag BLOB NOT NULL DEFAULT X'',
                updated_at INTEGER NOT NULL,
                UNIQUE(owner_type, owner_id, account, kind),
                UNIQUE(key_id, nonce)
             );
             CREATE TABLE IF NOT EXISTS ssh_keys (
                id TEXT PRIMARY KEY NOT NULL,
                alias TEXT NOT NULL,
                key_type TEXT NOT NULL,
                fingerprint TEXT NOT NULL UNIQUE,
                public_key TEXT NOT NULL,
                storage_kind TEXT NOT NULL CHECK (storage_kind IN ('path', 'vault')),
                secret_ref TEXT,
                path_ref TEXT,
                created_at INTEGER NOT NULL,
                CHECK ((storage_kind = 'vault' AND secret_ref IS NOT NULL AND path_ref IS NULL)
                    OR (storage_kind = 'path' AND secret_ref IS NULL AND path_ref IS NOT NULL))
             );
             CREATE INDEX IF NOT EXISTS idx_ssh_keys_alias ON ssh_keys(alias COLLATE NOCASE);",
        )
        .map_err(database_error)?;
    ensure_column(
        &transaction,
        "connection_profiles",
        "group_id",
        "ALTER TABLE connection_profiles ADD COLUMN group_id TEXT REFERENCES connection_groups(id) ON DELETE RESTRICT",
    )?;
    ensure_column(
        &transaction,
        "connection_profiles",
        "sort_order",
        "ALTER TABLE connection_profiles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &transaction,
        "connection_profiles",
        "key_ref",
        "ALTER TABLE connection_profiles ADD COLUMN key_ref TEXT REFERENCES ssh_keys(id) ON DELETE RESTRICT",
    )?;
    transaction
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_connection_profiles_group_order
                ON connection_profiles(group_id, sort_order, name COLLATE NOCASE);",
        )
        .map_err(database_error)?;

    let ungrouped = {
        let mut statement = transaction
            .prepare("SELECT id, group_name FROM connection_profiles WHERE group_id IS NULL OR group_id = ''")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?
    };
    ensure_group_for_name(&transaction, "默认分组")?;
    for (profile_id, legacy_name) in ungrouped {
        let group_id = ensure_group_for_name(&transaction, &legacy_name)?;
        transaction
            .execute(
                "UPDATE connection_profiles SET group_id = ?1 WHERE id = ?2",
                params![group_id, profile_id],
            )
            .map_err(database_error)?;
    }
    transaction
        .execute(
            "INSERT INTO app_migrations(name, applied_at) VALUES ('phase4b_identity_v1', ?1)",
            [unix_time_millis()],
        )
        .map_err(database_error)?;
    transaction.commit().map_err(database_error)
}

fn migrate_phase4b_vault_envelope(connection: &mut Connection) -> Result<(), String> {
    if migration_applied(connection, "phase4b_vault_envelope_v2")? {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(database_error)?;
    ensure_column(
        &transaction,
        "credential_vault_records",
        "enc_version",
        "ALTER TABLE credential_vault_records ADD COLUMN enc_version INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        &transaction,
        "credential_vault_records",
        "tag",
        "ALTER TABLE credential_vault_records ADD COLUMN tag BLOB NOT NULL DEFAULT X''",
    )?;
    transaction
        .execute(
            "UPDATE credential_vault_records
             SET tag = substr(ciphertext, length(ciphertext) - 15, 16),
                 ciphertext = substr(ciphertext, 1, length(ciphertext) - 16)
             WHERE length(tag) = 0 AND length(ciphertext) >= 16",
            [],
        )
        .map_err(database_error)?;
    let invalid_records: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM credential_vault_records
                WHERE enc_version != 1 OR length(nonce) != 12 OR length(tag) != 16
             )",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if invalid_records {
        return Err("凭据保险库记录格式无效，迁移已回滚且原数据库备份已保留。".to_owned());
    }
    transaction
        .execute(
            "INSERT INTO app_migrations(name, applied_at) VALUES ('phase4b_vault_envelope_v2', ?1)",
            [unix_time_millis()],
        )
        .map_err(database_error)?;
    transaction.commit().map_err(database_error)
}

fn migrate_phase4b_nonce_ledger(connection: &mut Connection) -> Result<(), String> {
    if migration_applied(connection, "phase4b_nonce_ledger_v3")? {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(database_error)?;
    let invalid_marker_nonce: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_vault_keys WHERE length(check_nonce) != 12)",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if invalid_marker_nonce {
        return Err("保险库主密钥验证 nonce 无效，迁移已回滚。".to_owned());
    }
    let marker_collision: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM credential_vault_keys k
                JOIN credential_vault_records r
                  ON r.key_id = k.key_id AND r.nonce = k.check_nonce
            )",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if marker_collision {
        return Err(
            "保险库主密钥验证 nonce 与已有凭据记录重复。为保护数据，迁移已停止；原数据库备份已保留。"
                .to_owned(),
        );
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO credential_vault_nonce_ledger(key_id, nonce, reserved_at)
             SELECT key_id, check_nonce, created_at FROM credential_vault_keys",
            [],
        )
        .map_err(database_error)?;
    transaction
        .execute(
            "INSERT INTO app_migrations(name, applied_at) VALUES ('phase4b_nonce_ledger_v3', ?1)",
            [unix_time_millis()],
        )
        .map_err(database_error)?;
    transaction.commit().map_err(database_error)
}

fn reserve_rotation_nonce(
    transaction: &Transaction<'_>,
    key_id: &str,
    nonce: &[u8],
) -> Result<(), String> {
    let reserved = transaction
        .execute(
            "INSERT OR IGNORE INTO credential_vault_nonce_ledger(key_id, nonce, reserved_at)
             VALUES (?1, ?2, ?3)",
            params![key_id, nonce, unix_time_millis()],
        )
        .map_err(database_error)?;
    if reserved != 1 {
        return Err("保险库 nonce 重复，密钥轮换事务已回滚。".to_owned());
    }
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_statement: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(database_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?;
    if !columns.iter().any(|existing| existing == column) {
        connection
            .execute_batch(alter_statement)
            .map_err(database_error)?;
    }
    Ok(())
}

fn list_groups(connection: &Connection) -> Result<Vec<ConnectionGroup>, String> {
    let mut statement = connection
        .prepare("SELECT id, parent_id, name, sort_order FROM connection_groups ORDER BY parent_id, sort_order, name COLLATE NOCASE")
        .map_err(database_error)?;
    statement
        .query_map([], |row| {
            Ok(ConnectionGroup {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)
}

fn validate_group_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 || name.contains(['/', '\\']) {
        return Err("分组名称须为 1–80 个字符，不能包含路径分隔符。".to_owned());
    }
    Ok(name.to_owned())
}

fn ensure_group_exists(connection: &Connection, group_id: &str) -> Result<(), String> {
    if group_exists(connection, group_id)? {
        Ok(())
    } else {
        Err("找不到指定的连接分组。".to_owned())
    }
}

fn group_exists(connection: &Connection, group_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM connection_groups WHERE id = ?1)",
            [group_id],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn ensure_group_for_name(connection: &Connection, name: &str) -> Result<String, String> {
    let name = if name.trim().is_empty() {
        "默认分组"
    } else {
        name.trim()
    };
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM connection_groups WHERE parent_id IS NULL AND name = ?1 COLLATE NOCASE",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO connection_groups(id, parent_id, name, sort_order) VALUES (?1, NULL, ?2, 0)",
            params![id, name],
        )
        .map_err(database_error)?;
    Ok(id)
}

fn group_path(connection: &Connection, group_id: &str) -> Result<String, String> {
    let mut names = Vec::new();
    let mut next_id = Some(group_id.to_owned());
    while let Some(id) = next_id {
        if names.len() >= 64 {
            return Err("分组层级超过安全上限或检测到循环。".to_owned());
        }
        let item = connection
            .query_row(
                "SELECT name, parent_id FROM connection_groups WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "找不到指定的连接分组。".to_owned())?;
        names.push(item.0);
        next_id = item.1;
    }
    names.reverse();
    Ok(names.join("/"))
}

fn sync_legacy_group_paths(connection: &Connection) -> Result<(), String> {
    let profiles = {
        let mut statement = connection
            .prepare("SELECT id, group_id FROM connection_profiles WHERE group_id IS NOT NULL")
            .map_err(database_error)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?
    };
    for (profile_id, group_id) in profiles {
        let path = group_path(connection, &group_id)?;
        connection
            .execute(
                "UPDATE connection_profiles SET group_name = ?1 WHERE id = ?2",
                params![path, profile_id],
            )
            .map_err(database_error)?;
    }
    Ok(())
}

fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn backup_database_before_phase4a_migration(
    connection: &Connection,
    database_path: &Path,
) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(database_error)?;
    let parent = database_path
        .parent()
        .ok_or_else(|| "无法确定连接数据库所在目录，已停止迁移。".to_owned())?;
    let backup_path = parent.join(format!(
        "connections.sqlite3.phase4a-{}-{}.bak",
        unix_time_millis(),
        Uuid::new_v4()
    ));
    let backup_path_text = backup_path.to_string_lossy().into_owned();
    if let Err(error) = connection.execute("VACUUM INTO ?1", [&backup_path_text]) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(format!(
            "无法创建 Phase 4A 数据迁移备份，原数据库未修改：{}",
            database_error(error)
        ));
    }
    #[cfg(unix)]
    if let Err(error) = std::fs::set_permissions(
        &backup_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    ) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(format!(
            "无法保护 Phase 4A 数据迁移备份的文件权限，原数据库未修改：{error}"
        ));
    }
    Ok(())
}

fn backup_database_before_phase4b_migration(
    connection: &Connection,
    database_path: &Path,
) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(database_error)?;
    let parent = database_path
        .parent()
        .ok_or_else(|| "无法确定连接数据库所在目录，已停止迁移。".to_owned())?;
    let backup_path = parent.join(format!(
        "connections.sqlite3.phase4b-{}-{}.bak",
        unix_time_millis(),
        Uuid::new_v4()
    ));
    let backup_path_text = backup_path.to_string_lossy().into_owned();
    if let Err(error) = connection.execute("VACUUM INTO ?1", [&backup_path_text]) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(format!(
            "无法创建 Phase 4B 数据迁移备份，原数据库未修改：{}",
            database_error(error)
        ));
    }
    #[cfg(unix)]
    if let Err(error) = std::fs::set_permissions(
        &backup_path,
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    ) {
        let _ = std::fs::remove_file(&backup_path);
        return Err(format!(
            "无法保护 Phase 4B 数据迁移备份的文件权限，原数据库未修改：{error}"
        ));
    }
    Ok(())
}

fn database_error(error: rusqlite::Error) -> String {
    format!("连接配置数据库操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_owned(),
            name: format!("测试 {id}"),
            host: format!("{id}.example.invalid"),
            port: 22,
            username: "tester".to_owned(),
            group_name: "默认分组".to_owned(),
            group_id: None,
            sort_order: 0,
            auth_method: "password".to_owned(),
            private_key_path: String::new(),
            key_ref: None,
            environment: "test".to_owned(),
            favorite: false,
            last_connected_at: None,
            auto_reconnect: false,
            credential_accounts: Vec::new(),
        }
    }

    fn insert_legacy_profile(connection: &Connection, profile: &ConnectionProfile) {
        connection
            .execute(
                "INSERT INTO connection_profiles (
                    id, name, host, port, username, group_name, auth_method, private_key_path,
                    environment, is_favorite, last_connected_at, auto_reconnect, credential_accounts
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    profile.id,
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.group_name,
                    profile.auth_method,
                    profile.private_key_path,
                    profile.environment,
                    profile.favorite,
                    profile.last_connected_at,
                    profile.auto_reconnect,
                    serde_json::to_string(&profile.credential_accounts).unwrap(),
                ],
            )
            .unwrap();
    }

    fn memory_store() -> ConnectionProfilesStore {
        ConnectionProfilesStore::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn imports_local_storage_profiles_only_once() {
        let store = memory_store();
        let first = profile("one");
        assert_eq!(
            store.bootstrap(std::slice::from_ref(&first)).unwrap()[0].id,
            first.id
        );
        let imported = store.list().unwrap();
        let first_group_id = imported[0].group_id.clone();
        assert!(first_group_id.is_some());
        let result = store.bootstrap(&[profile("stale")]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, first.id);
        assert_eq!(result[0].group_id, first_group_id);
    }

    #[test]
    fn clearing_recent_connections_keeps_profiles_and_favorites() {
        let store = memory_store();
        let mut item = profile("one");
        item.favorite = true;
        item.last_connected_at = Some(123);
        store.save(&item).unwrap();

        assert_eq!(store.clear_recent().unwrap(), 1);
        let remaining = store.list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].favorite);
        assert_eq!(remaining[0].last_connected_at, None);
    }

    #[test]
    fn nested_groups_reject_cycles_and_profile_moves_keep_key_references() {
        let store = memory_store();
        let parent = store.group_create("A", None).unwrap();
        let child = store.group_create("B", Some(&parent.id)).unwrap();
        let key_id = "managed-key";
        store
            .ssh_key_save(&SshKeyMetadata {
                id: key_id.to_owned(),
                alias: "test-key".to_owned(),
                key_type: "ssh-ed25519".to_owned(),
                fingerprint: "SHA256:test".to_owned(),
                public_key: "ssh-ed25519 AAAA".to_owned(),
                storage_kind: "vault".to_owned(),
                secret_ref: Some("vault:test".to_owned()),
                path_ref: None,
                created_at: 1,
                references: 0,
            })
            .unwrap();
        let mut profile = profile("host-one");
        profile.group_name = "A/B".to_owned();
        profile.group_id = Some(child.id.clone());
        profile.key_ref = Some(key_id.to_owned());
        store.save(&profile).unwrap();

        assert!(store.group_move(&parent.id, Some(&child.id), 0).is_err());
        assert!(store.group_move(&parent.id, Some(&parent.id), 0).is_err());
        store.profile_move("host-one", Some(&parent.id), 0).unwrap();
        let moved = store.list().unwrap().remove(0);
        assert_eq!(moved.group_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(moved.group_name, "A");
        assert_eq!(moved.key_ref.as_deref(), Some(key_id));
        assert_eq!(store.ssh_key_list().unwrap()[0].references, 1);
        assert!(!store.group_delete_if_empty(&parent.id).unwrap());
    }

    #[test]
    fn moving_groups_and_profiles_reindexes_order_and_supports_the_root() {
        let store = memory_store();
        let first_group = store.group_create("第一组", None).unwrap();
        let second_group = store.group_create("第二组", None).unwrap();
        store.group_move(&second_group.id, None, 1).unwrap();
        let root_groups = store
            .groups_list()
            .unwrap()
            .into_iter()
            .filter(|group| group.parent_id.is_none())
            .collect::<Vec<_>>();
        let first_index = root_groups
            .iter()
            .position(|group| group.id == first_group.id)
            .unwrap();
        let second_index = root_groups
            .iter()
            .position(|group| group.id == second_group.id)
            .unwrap();
        assert!(second_index < first_index);
        assert_eq!(root_groups[second_index].sort_order, 1);
        assert_eq!(root_groups[first_index].sort_order, 2);

        let mut first = profile("first-profile");
        first.group_name = first_group.name.clone();
        first.group_id = Some(first_group.id.clone());
        first.sort_order = 0;
        let mut second = profile("second-profile");
        second.group_name = first_group.name.clone();
        second.group_id = Some(first_group.id.clone());
        second.sort_order = 1;
        let mut third = profile("third-profile");
        third.group_name = first_group.name.clone();
        third.group_id = Some(first_group.id.clone());
        third.sort_order = 2;
        store.save(&first).unwrap();
        store.save(&second).unwrap();
        store.save(&third).unwrap();

        store
            .profile_move("third-profile", Some(&first_group.id), 0)
            .unwrap();
        let mut ordered_profiles = store
            .list()
            .unwrap()
            .into_iter()
            .filter(|profile| profile.group_id.as_deref() == Some(first_group.id.as_str()))
            .collect::<Vec<_>>();
        ordered_profiles.sort_by_key(|profile| profile.sort_order);
        assert_eq!(
            ordered_profiles
                .iter()
                .map(|profile| profile.id.as_str())
                .collect::<Vec<_>>(),
            ["third-profile", "first-profile", "second-profile"]
        );
        assert_eq!(ordered_profiles[0].sort_order, 0);
        assert_eq!(ordered_profiles[1].sort_order, 1);
        assert_eq!(ordered_profiles[2].sort_order, 2);

        store.profile_move("first-profile", None, 0).unwrap();
        let root_profile = store
            .list()
            .unwrap()
            .into_iter()
            .find(|profile| profile.id == "first-profile")
            .unwrap();
        assert_eq!(root_profile.group_id, None);
        assert_eq!(root_profile.group_name, "");
    }

    #[test]
    fn saving_a_profile_into_another_group_reindexes_both_groups() {
        let store = memory_store();
        let source = store.group_create("来源", None).unwrap();
        let destination = store.group_create("目标", None).unwrap();
        for (id, group, order) in [
            ("source-first", &source, 0),
            ("source-second", &source, 1),
            ("destination-first", &destination, 0),
        ] {
            let mut item = profile(id);
            item.group_id = Some(group.id.clone());
            item.group_name = group.name.clone();
            item.sort_order = order;
            store.save(&item).unwrap();
        }

        let mut moved = store
            .list()
            .unwrap()
            .into_iter()
            .find(|item| item.id == "source-second")
            .unwrap();
        moved.group_id = Some(destination.id.clone());
        moved.group_name = destination.name.clone();
        moved.sort_order = 0;
        store.save(&moved).unwrap();

        let profiles = store.list().unwrap();
        let order_for = |group_id: &str| {
            let mut items = profiles
                .iter()
                .filter(|item| item.group_id.as_deref() == Some(group_id))
                .collect::<Vec<_>>();
            items.sort_by_key(|item| item.sort_order);
            items
        };
        let source_items = order_for(&source.id);
        assert_eq!(source_items.len(), 1);
        assert_eq!(source_items[0].id, "source-first");
        assert_eq!(source_items[0].sort_order, 0);

        let destination_items = order_for(&destination.id);
        assert_eq!(destination_items.len(), 2);
        assert_eq!(destination_items[0].id, "source-second");
        assert_eq!(destination_items[0].sort_order, 0);
        assert_eq!(destination_items[1].id, "destination-first");
        assert_eq!(destination_items[1].sort_order, 1);
    }

    #[test]
    fn ssh_config_import_skips_existing_names_without_overwriting_profiles() {
        let store = memory_store();
        let mut existing = profile("Build-Server");
        existing.name = "Build-Server".to_owned();
        store.save(&existing).unwrap();
        let existing_stored = store.list().unwrap()[0].clone();
        let incoming = ConnectionProfile {
            id: "imported-id".to_owned(),
            name: "build-server".to_owned(),
            host: "192.0.2.10".to_owned(),
            port: 2202,
            username: "other-user".to_owned(),
            group_name: "SSH Config".to_owned(),
            group_id: None,
            sort_order: 0,
            auth_method: "password".to_owned(),
            private_key_path: String::new(),
            key_ref: None,
            environment: "development".to_owned(),
            favorite: false,
            last_connected_at: None,
            auto_reconnect: false,
            credential_accounts: Vec::new(),
        };

        let result = store.import_ssh_config_profiles(vec![incoming]).unwrap();
        assert!(result.imported.is_empty());
        assert_eq!(result.skipped_existing_names, ["build-server"]);
        let stored = store.list().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0], existing_stored);
    }

    #[test]
    fn deletion_removes_only_the_selected_profile() {
        let store = memory_store();
        store.save(&profile("one")).unwrap();
        store.save(&profile("two")).unwrap();

        assert!(store.delete("one").unwrap());
        assert_eq!(
            store
                .list()
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
    }

    #[test]
    fn audit_migration_preserves_existing_profiles_and_stores_only_allowlisted_metadata() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE connection_profiles (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    group_name TEXT NOT NULL,
                    auth_method TEXT NOT NULL,
                    private_key_path TEXT NOT NULL,
                    environment TEXT NOT NULL,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    last_connected_at INTEGER,
                    auto_reconnect INTEGER NOT NULL DEFAULT 0,
                    credential_accounts TEXT NOT NULL DEFAULT '[]'
                 );
                 CREATE TABLE app_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);",
            )
            .unwrap();
        let legacy_profile = profile("legacy-profile");
        insert_legacy_profile(&connection, &legacy_profile);

        let store = ConnectionProfilesStore::from_connection(connection).unwrap();
        let actual_profiles = store.list().unwrap();
        let mut expected_profile = legacy_profile;
        expected_profile.group_id = actual_profiles[0].group_id.clone();
        assert_eq!(actual_profiles, [expected_profile]);
        store
            .record_audit_event(
                AuditAction::CredentialSaved,
                Some("legacy-profile"),
                AuditOutcome::Succeeded,
            )
            .unwrap();

        let connection = store.connection.lock().unwrap();
        let (action, profile_id, outcome): (String, String, String) = connection
            .query_row(
                "SELECT action, profile_id, outcome FROM client_operation_audit",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (action.as_str(), profile_id.as_str(), outcome.as_str()),
            ("credential_saved", "legacy-profile", "succeeded",)
        );

        let mut statement = connection
            .prepare("PRAGMA table_info(client_operation_audit)")
            .unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            ["id", "occurred_at", "action", "profile_id", "outcome"]
        );
    }

    #[test]
    fn phase4b_migration_backup_can_restore_existing_connection_data() {
        let directory =
            std::env::temp_dir().join(format!("termvista-phase4b-restore-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("connections.sqlite3");
        let mut legacy_profile = profile("phase4b-user-data");
        legacy_profile.name = "生产跳板".to_owned();
        legacy_profile.host = "bastion.example.test".to_owned();
        legacy_profile.group_name = "基础设施/生产".to_owned();
        legacy_profile.auth_method = "privateKey".to_owned();
        legacy_profile.private_key_path = "~/.ssh/id_ed25519".to_owned();
        legacy_profile.favorite = true;
        legacy_profile.last_connected_at = Some(1_700_000_000_000);
        legacy_profile.credential_accounts = vec!["root".to_owned()];
        {
            let connection = Connection::open(&database_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE connection_profiles (
                        id TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL,
                        host TEXT NOT NULL,
                        port INTEGER NOT NULL,
                        username TEXT NOT NULL,
                        group_name TEXT NOT NULL,
                        auth_method TEXT NOT NULL,
                        private_key_path TEXT NOT NULL,
                        environment TEXT NOT NULL,
                        is_favorite INTEGER NOT NULL DEFAULT 0,
                        last_connected_at INTEGER,
                        auto_reconnect INTEGER NOT NULL DEFAULT 0,
                        credential_accounts TEXT NOT NULL DEFAULT '[]'
                     );
                     CREATE TABLE app_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
                     INSERT INTO app_migrations(name, applied_at) VALUES ('phase4a_settings_v1', 1);
                     PRAGMA user_version = 3;",
                )
                .unwrap();
            insert_legacy_profile(&connection, &legacy_profile);
        }

        let migrated = ConnectionProfilesStore::open(&database_path).unwrap();
        let migrated_profiles = migrated.list().unwrap();
        assert_eq!(migrated_profiles.len(), 1);
        let mut expected = legacy_profile.clone();
        expected.group_id = migrated_profiles[0].group_id.clone();
        assert_eq!(migrated_profiles[0], expected);
        drop(migrated);

        let backup_path = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with(".bak"))
            })
            .expect("迁移前应保留 SQLite 备份");
        let backup = Connection::open(&backup_path).unwrap();
        let (restored_name, restored_host, restored_group, restored_key_path): (
            String,
            String,
            String,
            String,
        ) = backup
            .query_row(
                "SELECT name, host, group_name, private_key_path FROM connection_profiles WHERE id = ?1",
                [&legacy_profile.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(restored_name, legacy_profile.name);
        assert_eq!(restored_host, legacy_profile.host);
        assert_eq!(restored_group, legacy_profile.group_name);
        assert_eq!(restored_key_path, legacy_profile.private_key_path);
        drop(backup);

        let restore_path = directory.join("restored.sqlite3");
        std::fs::copy(&backup_path, &restore_path).unwrap();
        let restored = ConnectionProfilesStore::open(&restore_path).unwrap();
        let restored_profiles = restored.list().unwrap();
        assert_eq!(restored_profiles.len(), 1);
        let mut expected_restored = legacy_profile;
        expected_restored.group_id = restored_profiles[0].group_id.clone();
        assert_eq!(restored_profiles[0], expected_restored);
        drop(restored);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn phase4b_vault_envelope_migration_splits_legacy_gcm_tag() {
        let directory =
            std::env::temp_dir().join(format!("termvista-vault-envelope-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("connections.sqlite3");
        drop(ConnectionProfilesStore::open(&database_path).unwrap());

        let legacy_ciphertext = (0u8..32).collect::<Vec<_>>();
        let nonce = [7u8; 12];
        {
            let connection = Connection::open(&database_path).unwrap();
            connection
                .execute_batch(
                    "PRAGMA foreign_keys = OFF;
                     DROP TABLE credential_vault_records;
                     CREATE TABLE credential_vault_records (
                        id TEXT PRIMARY KEY NOT NULL,
                        owner_type TEXT NOT NULL,
                        owner_id TEXT NOT NULL,
                        account TEXT NOT NULL DEFAULT '',
                        kind TEXT NOT NULL,
                        key_id TEXT NOT NULL,
                        nonce BLOB NOT NULL,
                        ciphertext BLOB NOT NULL,
                        updated_at INTEGER NOT NULL,
                        UNIQUE(owner_type, owner_id, account, kind),
                        UNIQUE(key_id, nonce)
                     );
                     DELETE FROM app_migrations WHERE name = 'phase4b_vault_envelope_v2';",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO credential_vault_records(
                        id, owner_type, owner_id, account, kind, key_id, nonce, ciphertext, updated_at
                     ) VALUES ('legacy-record', 'ssh_credential', 'profile-a', 'root', 'password', 'key-a', ?1, ?2, 1)",
                    params![nonce.as_slice(), legacy_ciphertext],
                )
                .unwrap();
        }

        let migrated = ConnectionProfilesStore::open(&database_path).unwrap();
        let record = migrated
            .vault_record_get("ssh_credential", "profile-a", "root", "password")
            .unwrap()
            .unwrap();
        assert_eq!(record.enc_version, 1);
        assert_eq!(record.nonce, nonce);
        assert_eq!(record.ciphertext, (0u8..16).collect::<Vec<_>>());
        assert_eq!(record.tag, (16u8..32).collect::<Vec<_>>());
        drop(migrated);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn nonce_migration_backfills_existing_vault_marker_nonces() {
        let store = memory_store();
        let metadata = VaultKeyMetadata {
            key_id: "legacy-vault-key".to_owned(),
            mode: "masterPassword".to_owned(),
            salt: vec![3; 16],
            check_nonce: vec![7; 12],
            check_ciphertext: vec![9; 32],
        };
        store.vault_key_create(&metadata).unwrap();

        let mut connection = store.connection.lock().unwrap();
        connection
            .execute(
                "DELETE FROM credential_vault_nonce_ledger WHERE key_id = ?1 AND nonce = ?2",
                params![metadata.key_id, metadata.check_nonce],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM app_migrations WHERE name = 'phase4b_nonce_ledger_v3'",
                [],
            )
            .unwrap();

        migrate_phase4b_nonce_ledger(&mut connection).unwrap();
        let marker_reserved: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM credential_vault_nonce_ledger WHERE key_id = ?1 AND nonce = ?2)",
                params![metadata.key_id, metadata.check_nonce],
                |row| row.get(0),
            )
            .unwrap();
        assert!(marker_reserved);
    }

    #[test]
    fn nonce_migration_stops_when_legacy_marker_nonce_matches_a_record() {
        let store = memory_store();
        let metadata = VaultKeyMetadata {
            key_id: "colliding-legacy-vault-key".to_owned(),
            mode: "masterPassword".to_owned(),
            salt: vec![3; 16],
            check_nonce: vec![7; 12],
            check_ciphertext: vec![9; 32],
        };
        store.vault_key_create(&metadata).unwrap();
        {
            let connection = store.connection.lock().unwrap();
            connection
                .execute(
                    "DELETE FROM credential_vault_nonce_ledger WHERE key_id = ?1 AND nonce = ?2",
                    params![metadata.key_id, metadata.check_nonce],
                )
                .unwrap();
            connection
                .execute(
                    "DELETE FROM app_migrations WHERE name = 'phase4b_nonce_ledger_v3'",
                    [],
                )
                .unwrap();
        }
        assert!(
            store
                .vault_reserve_nonce(&metadata.key_id, &metadata.check_nonce)
                .unwrap()
        );
        store
            .vault_record_save(&EncryptedVaultRecord {
                id: "record-with-marker-nonce".to_owned(),
                owner_type: "ssh_credential".to_owned(),
                owner_id: "profile-one".to_owned(),
                account: "root".to_owned(),
                kind: "password".to_owned(),
                enc_version: 1,
                key_id: metadata.key_id.clone(),
                nonce: metadata.check_nonce.clone(),
                ciphertext: vec![4; 8],
                tag: vec![5; 16],
            })
            .unwrap();

        let mut connection = store.connection.lock().unwrap();
        let error = migrate_phase4b_nonce_ledger(&mut connection).unwrap_err();
        assert!(error.contains("nonce 与已有凭据记录重复"));
        let migration_recorded: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = 'phase4b_nonce_ledger_v3')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!migration_recorded);
    }

    #[test]
    fn vault_rotation_nonce_collision_rolls_back_active_key_and_records() {
        let store = memory_store();
        let old_metadata = VaultKeyMetadata {
            key_id: "old-vault-key".to_owned(),
            mode: "masterPassword".to_owned(),
            salt: vec![1; 16],
            check_nonce: vec![2; 12],
            check_ciphertext: vec![3; 32],
        };
        store.vault_key_create(&old_metadata).unwrap();
        let old_record = EncryptedVaultRecord {
            id: "credential-one".to_owned(),
            owner_type: "ssh_credential".to_owned(),
            owner_id: "profile-one".to_owned(),
            account: "root".to_owned(),
            kind: "password".to_owned(),
            enc_version: 1,
            key_id: old_metadata.key_id.clone(),
            nonce: vec![4; 12],
            ciphertext: vec![5; 8],
            tag: vec![6; 16],
        };
        store
            .vault_reserve_nonce(&old_metadata.key_id, &old_record.nonce)
            .unwrap();
        store.vault_record_save(&old_record).unwrap();

        let new_metadata = VaultKeyMetadata {
            key_id: "new-vault-key".to_owned(),
            mode: "masterPassword".to_owned(),
            salt: vec![7; 16],
            check_nonce: vec![8; 12],
            check_ciphertext: vec![9; 32],
        };
        let mut reencrypted = old_record.clone();
        reencrypted.key_id = new_metadata.key_id.clone();
        reencrypted.nonce = new_metadata.check_nonce.clone();
        assert!(
            store
                .vault_rotate_records(&old_metadata.key_id, &new_metadata, &[reencrypted])
                .is_err()
        );

        assert_eq!(
            store.vault_active_key().unwrap().unwrap().key_id,
            old_metadata.key_id
        );
        assert_eq!(store.vault_records_list().unwrap(), [old_record]);
    }

    #[test]
    fn phase4a_migration_backs_up_existing_database_and_settings_use_revision_cas() {
        let directory =
            std::env::temp_dir().join(format!("termvista-migration-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("connections.sqlite3");
        {
            let connection = Connection::open(&database_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE connection_profiles (
                        id TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL,
                        host TEXT NOT NULL,
                        port INTEGER NOT NULL,
                        username TEXT NOT NULL,
                        group_name TEXT NOT NULL,
                        auth_method TEXT NOT NULL,
                        private_key_path TEXT NOT NULL,
                        environment TEXT NOT NULL,
                        is_favorite INTEGER NOT NULL DEFAULT 0,
                        last_connected_at INTEGER,
                        auto_reconnect INTEGER NOT NULL DEFAULT 0,
                        credential_accounts TEXT NOT NULL DEFAULT '[]'
                     );
                     CREATE TABLE app_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
                     PRAGMA user_version = 2;",
                )
                .unwrap();
            insert_legacy_profile(&connection, &profile("legacy-user-data"));
        }

        let store = ConnectionProfilesStore::open(&database_path).unwrap();
        let profiles = store.list().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "legacy-user-data");
        assert!(profiles[0].group_id.is_some());
        let backup_count = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .count();
        assert_eq!(backup_count, 1);

        let first_revision = store
            .save_settings_record(0, "{\"schemaVersion\":1}")
            .unwrap();
        assert_eq!(first_revision, 1);
        assert!(store.save_settings_record(0, "{}").is_err());
        assert_eq!(
            store.get_settings_record().unwrap(),
            Some(("{\"schemaVersion\":1}".to_owned(), 1))
        );
        drop(store);

        let reopened = ConnectionProfilesStore::open(&database_path).unwrap();
        let reopened_profiles = reopened.list().unwrap();
        assert_eq!(reopened_profiles.len(), 1);
        assert_eq!(reopened_profiles[0].id, "legacy-user-data");
        assert!(reopened_profiles[0].group_id.is_some());
        assert_eq!(
            std::fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
                .count(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
