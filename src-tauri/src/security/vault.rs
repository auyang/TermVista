use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload, consts::U12},
};
use argon2::Argon2;
use serde::Serialize;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    connections::{ConnectionProfilesStore, EncryptedVaultRecord, VaultKeyMetadata},
    security::credential_store::{
        CredentialKey, CredentialKind, CredentialStore, CredentialStoreError,
        KeyringCredentialStore,
    },
};

const KEYCHAIN_SERVICE: &str = "termvista.vault";
const RECORD_OWNER: &str = "ssh_credential";
const MASTER_PASSWORD_MIN_CHARS: usize = 12;
const MASTER_PASSWORD_MAX_BYTES: usize = 1024;
const NONCE_LENGTH: usize = 12;
const TAG_LENGTH: usize = 16;
const KEY_LENGTH: usize = 32;
const ENVELOPE_VERSION: i64 = 1;
const MARKER: &[u8] = b"TermVista credential vault v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultMode {
    Keychain,
    MasterPassword,
}

impl VaultMode {
    fn as_db_value(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::MasterPassword => "masterPassword",
        }
    }

    fn from_db_value(value: &str) -> Result<Self, String> {
        match value {
            "keychain" => Ok(Self::Keychain),
            "masterPassword" => Ok(Self::MasterPassword),
            _ => Err("凭据保险库使用了不支持的密钥保护方式。".to_owned()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub state: String,
    pub mode: Option<VaultMode>,
}

pub trait VaultKeyStore: Send + Sync {
    fn save(&self, key_id: &str, key: &[u8; KEY_LENGTH]) -> Result<(), String>;
    fn load(&self, key_id: &str) -> Result<Option<Zeroizing<[u8; KEY_LENGTH]>>, String>;
    fn forget(&self, key_id: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct KeyringVaultKeyStore;

impl VaultKeyStore for KeyringVaultKeyStore {
    fn save(&self, key_id: &str, key: &[u8; KEY_LENGTH]) -> Result<(), String> {
        let encoded = Zeroizing::new(encode_hex(key));
        keyring::Entry::new(KEYCHAIN_SERVICE, &format!("dek:{key_id}"))
            .map_err(|_| "无法访问本机安全凭据库。".to_owned())?
            .set_password(&encoded)
            .map_err(|_| "无法将保险库密钥保存到本机安全凭据库。".to_owned())
    }

    fn load(&self, key_id: &str) -> Result<Option<Zeroizing<[u8; KEY_LENGTH]>>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &format!("dek:{key_id}"))
            .map_err(|_| "无法访问本机安全凭据库。".to_owned())?;
        match entry.get_password() {
            Ok(encoded) => {
                let encoded = Zeroizing::new(encoded);
                decode_hex(&encoded).map(Some)
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("本机安全凭据库无法读取保险库密钥。".to_owned()),
        }
    }

    fn forget(&self, key_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &format!("dek:{key_id}"))
            .map_err(|_| "无法访问本机安全凭据库。".to_owned())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法从本机安全凭据库删除保险库密钥。".to_owned()),
        }
    }
}

struct ActiveKey {
    key_id: String,
    key: Zeroizing<[u8; KEY_LENGTH]>,
}

pub struct CredentialVault {
    profiles: Arc<ConnectionProfilesStore>,
    keys: Arc<dyn VaultKeyStore>,
    legacy: Arc<dyn CredentialStore>,
    operation_lock: Mutex<()>,
    active_key: Mutex<Option<ActiveKey>>,
}

impl CredentialVault {
    pub fn new(profiles: Arc<ConnectionProfilesStore>) -> Self {
        let vault = Self::with_backends(
            profiles,
            Arc::new(KeyringVaultKeyStore),
            Arc::new(KeyringCredentialStore),
        );
        let _ = vault.try_auto_unlock_keychain();
        vault
    }

    pub fn with_backends(
        profiles: Arc<ConnectionProfilesStore>,
        keys: Arc<dyn VaultKeyStore>,
        legacy: Arc<dyn CredentialStore>,
    ) -> Self {
        Self {
            profiles,
            keys,
            legacy,
            operation_lock: Mutex::new(()),
            active_key: Mutex::new(None),
        }
    }

    pub fn status(&self) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        self.status_inner()
    }

    pub fn ensure_ready_for_save(&self) -> Result<(), String> {
        let status = self.status()?;
        if status.state == "uninitialized" {
            self.initialize_keychain()?;
            return Ok(());
        }
        if status.state == "unlocked" {
            return Ok(());
        }
        if status.mode == Some(VaultMode::Keychain) {
            self.try_auto_unlock_keychain()?;
            if self.status()?.state == "unlocked" {
                return Ok(());
            }
            return Err("无法解锁本机钥匙串中的凭据保险库。".to_owned());
        }
        Err("凭据保险库已锁定，请先在设置中解锁后重试。".to_owned())
    }

    fn status_inner(&self) -> Result<VaultStatus, String> {
        let Some(metadata) = self.profiles.vault_active_key()? else {
            return Ok(VaultStatus {
                state: "uninitialized".to_owned(),
                mode: None,
            });
        };
        let mode = VaultMode::from_db_value(&metadata.mode)?;
        let unlocked = self
            .active_key
            .lock()
            .map_err(|_| "凭据保险库状态锁不可用。".to_owned())?
            .as_ref()
            .is_some_and(|active| active.key_id == metadata.key_id);
        Ok(VaultStatus {
            state: if unlocked { "unlocked" } else { "locked" }.to_owned(),
            mode: Some(mode),
        })
    }

    pub fn initialize_keychain(&self) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        self.ensure_uninitialized()?;
        let key_id = uuid::Uuid::new_v4().to_string();
        let key = random_key()?;
        let (nonce, ciphertext) = encrypt_marker(&key_id, &key)?;
        self.keys.save(&key_id, &key)?;
        let metadata = VaultKeyMetadata {
            key_id: key_id.clone(),
            mode: VaultMode::Keychain.as_db_value().to_owned(),
            salt: Vec::new(),
            check_nonce: nonce.to_vec(),
            check_ciphertext: ciphertext,
        };
        if let Err(error) = self.profiles.vault_key_create(&metadata) {
            let _ = self.keys.forget(&key_id);
            return Err(format!("无法创建保险库记录：{error}"));
        }
        self.set_active_key(key_id, key)?;
        self.status_inner()
    }

    pub fn initialize_master_password(&self, password: &str) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        self.ensure_uninitialized()?;
        validate_master_password(password)?;
        let mut salt = [0u8; 16];
        fill_random(&mut salt)?;
        let key = derive_master_key(password, &salt)?;
        let key_id = uuid::Uuid::new_v4().to_string();
        let (nonce, ciphertext) = encrypt_marker(&key_id, &key)?;
        self.profiles
            .vault_key_create(&VaultKeyMetadata {
                key_id: key_id.clone(),
                mode: VaultMode::MasterPassword.as_db_value().to_owned(),
                salt: salt.to_vec(),
                check_nonce: nonce.to_vec(),
                check_ciphertext: ciphertext,
            })
            .map_err(|error| format!("无法创建保险库记录：{error}"))?;
        self.set_active_key(key_id, key)?;
        self.status_inner()
    }

    pub fn unlock(&self, password: Option<&str>) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        let metadata = self
            .profiles
            .vault_active_key()?
            .ok_or_else(|| "凭据保险库尚未设置。".to_owned())?;
        let mode = VaultMode::from_db_value(&metadata.mode)?;
        let key = match mode {
            VaultMode::Keychain => self
                .keys
                .load(&metadata.key_id)?
                .ok_or_else(|| "本机安全凭据库中找不到保险库密钥。".to_owned())?,
            VaultMode::MasterPassword => {
                let password = password.ok_or_else(|| "请输入保险库主密码。".to_owned())?;
                if password.len() > MASTER_PASSWORD_MAX_BYTES {
                    return Err("保险库主密码长度超过安全限制。".to_owned());
                }
                derive_master_key(password, &metadata.salt)?
            }
        };
        verify_marker(&metadata, &key)?;
        self.set_active_key(metadata.key_id, key)?;
        self.status_inner()
    }

    pub fn lock(&self) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        *self
            .active_key
            .lock()
            .map_err(|_| "凭据保险库状态锁不可用。".to_owned())? = None;
        self.status_inner()
    }

    pub fn rotate_key(&self, new_master_password: Option<&str>) -> Result<VaultStatus, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        let old_metadata = self
            .profiles
            .vault_active_key()?
            .ok_or_else(|| "凭据保险库尚未设置。".to_owned())?;
        let mode = VaultMode::from_db_value(&old_metadata.mode)?;
        let (old_key_id, old_key) = self
            .active_key()
            .map_err(|_| "请先解锁凭据保险库，再执行密钥轮换。".to_owned())?;
        if old_key_id != old_metadata.key_id {
            return Err("保险库活动密钥状态不一致，未执行轮换。".to_owned());
        }

        let new_key_id = uuid::Uuid::new_v4().to_string();
        let (new_key, salt) = match mode {
            VaultMode::Keychain => {
                if new_master_password.is_some() {
                    return Err("本机安全凭据库模式不接受新的主密码。".to_owned());
                }
                (random_key()?, Vec::new())
            }
            VaultMode::MasterPassword => {
                let password =
                    new_master_password.ok_or_else(|| "请输入新的保险库主密码。".to_owned())?;
                validate_master_password(password)?;
                let mut salt = [0u8; 16];
                fill_random(&mut salt)?;
                (derive_master_key(password, &salt)?, salt.to_vec())
            }
        };
        let (check_nonce, check_ciphertext) = encrypt_marker(&new_key_id, &new_key)?;
        let new_metadata = VaultKeyMetadata {
            key_id: new_key_id.clone(),
            mode: mode.as_db_value().to_owned(),
            salt,
            check_nonce: check_nonce.to_vec(),
            check_ciphertext,
        };
        let keychain_saved = mode == VaultMode::Keychain;
        if keychain_saved {
            self.keys.save(&new_key_id, &new_key)?;
        }

        let mut transaction_committed = false;
        let rotation = (|| {
            let old_records = self.profiles.vault_records_list()?;
            let mut new_records = Vec::with_capacity(old_records.len());
            let mut reserved_nonces = HashSet::with_capacity(old_records.len() + 1);
            reserved_nonces.insert(check_nonce);
            for old_record in old_records {
                let secret = self
                    .open_record(&old_record, &old_key_id, &old_key)
                    .map_err(|_| "现有保险库记录校验失败，未修改任何凭据。".to_owned())?;
                let nonce = loop {
                    let mut candidate = [0u8; NONCE_LENGTH];
                    fill_random(&mut candidate)?;
                    if reserved_nonces.insert(candidate) {
                        break candidate;
                    }
                };
                let mut record = old_record;
                record.enc_version = ENVELOPE_VERSION;
                record.key_id = new_key_id.clone();
                record.nonce = nonce.to_vec();
                let sealed = encrypt(
                    &new_key,
                    &nonce,
                    &Self::record_aad(&record),
                    secret.as_bytes(),
                )?;
                (record.ciphertext, record.tag) = split_ciphertext_and_tag(sealed)?;
                new_records.push(record);
            }
            self.profiles
                .vault_rotate_records(&old_key_id, &new_metadata, &new_records)?;
            transaction_committed = true;
            self.set_active_key(new_key_id.clone(), Zeroizing::new(*new_key))?;
            Ok::<(), String>(())
        })();

        if rotation.is_err() && keychain_saved && !transaction_committed {
            let _ = self.keys.forget(&new_key_id);
        }
        rotation?;
        self.status_inner()
    }

    pub fn save_managed_key(&self, key_id: &str, private_key: &str) -> Result<String, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        if private_key.is_empty() || private_key.len() > 1024 * 1024 {
            return Err("SSH 私钥文件为空或超过 1 MiB 安全限制。".to_owned());
        }
        let (vault_key_id, encryption_key) = self
            .active_key()
            .map_err(|_| "请先解锁凭据保险库，再导入或生成 SSH 密钥。".to_owned())?;
        self.seal_named_record(
            "ssh_private_key",
            key_id,
            "",
            "private_key",
            private_key.as_bytes(),
            &vault_key_id,
            &encryption_key,
        )
        .map_err(|_| "无法将 SSH 私钥加密保存到凭据保险库。".to_owned())
    }

    pub fn load_managed_key(&self, key_id: &str) -> Result<Zeroizing<String>, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "凭据保险库操作锁不可用。".to_owned())?;
        let record = self
            .profiles
            .vault_record_get("ssh_private_key", key_id, "", "private_key")?
            .ok_or_else(|| "凭据保险库中找不到该 SSH 私钥。".to_owned())?;
        if self
            .active_key
            .lock()
            .map_err(|_| "凭据保险库状态锁不可用。".to_owned())?
            .is_none()
        {
            let _ = self.try_auto_unlock_keychain();
        }
        let (vault_key_id, encryption_key) = self
            .active_key()
            .map_err(|_| "凭据保险库已锁定，请先解锁后重试。".to_owned())?;
        self.open_record(&record, &vault_key_id, &encryption_key)
            .map_err(|_| "无法解密该 SSH 私钥，请检查保险库状态和数据完整性。".to_owned())
    }

    fn ensure_uninitialized(&self) -> Result<(), String> {
        if self.profiles.vault_active_key()?.is_some() {
            Err("凭据保险库已经设置。".to_owned())
        } else {
            Ok(())
        }
    }

    fn set_active_key(
        &self,
        key_id: String,
        key: Zeroizing<[u8; KEY_LENGTH]>,
    ) -> Result<(), String> {
        *self
            .active_key
            .lock()
            .map_err(|_| "凭据保险库状态锁不可用。".to_owned())? = Some(ActiveKey { key_id, key });
        Ok(())
    }

    fn try_auto_unlock_keychain(&self) -> Result<(), String> {
        let Some(metadata) = self.profiles.vault_active_key()? else {
            return Ok(());
        };
        if VaultMode::from_db_value(&metadata.mode)? != VaultMode::Keychain {
            return Ok(());
        }
        let Some(key) = self.keys.load(&metadata.key_id)? else {
            return Ok(());
        };
        verify_marker(&metadata, &key)?;
        self.set_active_key(metadata.key_id, key)
    }

    fn active_key(&self) -> Result<(String, Zeroizing<[u8; KEY_LENGTH]>), CredentialStoreError> {
        let guard = self.active_key.lock().map_err(|_| CredentialStoreError)?;
        let active = guard.as_ref().ok_or(CredentialStoreError)?;
        Ok((active.key_id.clone(), Zeroizing::new(*active.key)))
    }

    fn record_identity(key: &CredentialKey) -> (String, String, String, String) {
        (
            RECORD_OWNER.to_owned(),
            key.profile_id.clone(),
            key.username.clone(),
            credential_kind_name(key.kind).to_owned(),
        )
    }

    fn record_aad(record: &EncryptedVaultRecord) -> Vec<u8> {
        format!(
            "TermVista|vault-v{}|{}|{}|{}:{}|{}:{}|{}:{}",
            record.enc_version,
            record.kind,
            record.id,
            record.owner_type.len(),
            record.owner_type,
            record.owner_id.len(),
            record.owner_id,
            record.account.len(),
            record.account,
        )
        .into_bytes()
    }

    fn seal_record(
        &self,
        key: &CredentialKey,
        secret: &str,
        key_id: String,
        encryption_key: &[u8; KEY_LENGTH],
    ) -> Result<(), CredentialStoreError> {
        let (owner_type, owner_id, account, kind) = Self::record_identity(key);
        self.seal_named_record(
            &owner_type,
            &owner_id,
            &account,
            &kind,
            secret.as_bytes(),
            &key_id,
            encryption_key,
        )
        .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    fn seal_named_record(
        &self,
        owner_type: &str,
        owner_id: &str,
        account: &str,
        kind: &str,
        secret: &[u8],
        key_id: &str,
        encryption_key: &[u8; KEY_LENGTH],
    ) -> Result<String, CredentialStoreError> {
        let existing = self
            .profiles
            .vault_record_get(owner_type, owner_id, account, kind)
            .map_err(|_| CredentialStoreError)?;
        let mut nonce = [0u8; NONCE_LENGTH];
        let mut reserved = false;
        for _ in 0..8 {
            fill_random(&mut nonce).map_err(|_| CredentialStoreError)?;
            if self
                .profiles
                .vault_reserve_nonce(key_id, &nonce)
                .map_err(|_| CredentialStoreError)?
            {
                reserved = true;
                break;
            }
        }
        if !reserved {
            return Err(CredentialStoreError);
        }
        let mut record = EncryptedVaultRecord {
            id: existing
                .map(|record| record.id)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            owner_type: owner_type.to_owned(),
            owner_id: owner_id.to_owned(),
            account: account.to_owned(),
            kind: kind.to_owned(),
            enc_version: ENVELOPE_VERSION,
            key_id: key_id.to_owned(),
            nonce: nonce.to_vec(),
            ciphertext: Vec::new(),
            tag: Vec::new(),
        };
        let aad = Self::record_aad(&record);
        let sealed =
            encrypt(encryption_key, &nonce, &aad, secret).map_err(|_| CredentialStoreError)?;
        (record.ciphertext, record.tag) =
            split_ciphertext_and_tag(sealed).map_err(|_| CredentialStoreError)?;
        self.profiles
            .vault_record_save(&record)
            .map_err(|_| CredentialStoreError)?;
        Ok(record.id)
    }

    fn open_record(
        &self,
        record: &EncryptedVaultRecord,
        key_id: &str,
        encryption_key: &[u8; KEY_LENGTH],
    ) -> Result<Zeroizing<String>, CredentialStoreError> {
        if record.enc_version != ENVELOPE_VERSION
            || record.key_id != key_id
            || record.nonce.len() != NONCE_LENGTH
            || record.tag.len() != TAG_LENGTH
        {
            return Err(CredentialStoreError);
        }
        let nonce: [u8; NONCE_LENGTH] = record
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| CredentialStoreError)?;
        let plaintext = Zeroizing::new(
            decrypt_separated(
                encryption_key,
                &nonce,
                &Self::record_aad(record),
                &record.ciphertext,
                &record.tag,
            )
            .map_err(|_| CredentialStoreError)?,
        );
        match String::from_utf8(plaintext.to_vec()) {
            Ok(secret) => Ok(Zeroizing::new(secret)),
            Err(error) => {
                let mut invalid = error.into_bytes();
                invalid.zeroize();
                Err(CredentialStoreError)
            }
        }
    }
}

impl CredentialStore for CredentialVault {
    fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| CredentialStoreError)?;
        if secret.is_empty() {
            return Err(CredentialStoreError);
        }
        let (key_id, encryption_key) = self.active_key()?;
        self.seal_record(key, secret, key_id, &encryption_key)
    }

    fn load(&self, key: &CredentialKey) -> Result<Option<Zeroizing<String>>, CredentialStoreError> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| CredentialStoreError)?;
        let (owner_type, owner_id, account, kind) = Self::record_identity(key);
        let record = self
            .profiles
            .vault_record_get(&owner_type, &owner_id, &account, &kind)
            .map_err(|_| CredentialStoreError)?;
        if let Some(record) = record {
            if self
                .active_key
                .lock()
                .map_err(|_| CredentialStoreError)?
                .is_none()
            {
                let _ = self.try_auto_unlock_keychain();
            }
            let (key_id, encryption_key) = self.active_key()?;
            return self
                .open_record(&record, &key_id, &encryption_key)
                .map(Some);
        }

        let legacy = self.legacy.load(key)?;
        if let Some(secret) = legacy {
            if let Ok((key_id, encryption_key)) = self.active_key() {
                let _ = self.seal_record(key, &secret, key_id, &encryption_key);
            }
            return Ok(Some(secret));
        }
        Ok(None)
    }

    fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| CredentialStoreError)?;
        let (owner_type, owner_id, account, kind) = Self::record_identity(key);
        self.profiles
            .vault_record_delete(&owner_type, &owner_id, &account, &kind)
            .map_err(|_| CredentialStoreError)?;
        self.legacy.forget(key)
    }
}

fn credential_kind_name(kind: CredentialKind) -> &'static str {
    match kind {
        CredentialKind::Password => "password",
        CredentialKind::PrivateKeyPassphrase => "private-key-passphrase",
    }
}

fn validate_master_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MASTER_PASSWORD_MIN_CHARS
        || password.len() > MASTER_PASSWORD_MAX_BYTES
    {
        return Err(format!(
            "保险库主密码至少需要 {MASTER_PASSWORD_MIN_CHARS} 个字符，且不能超过 {MASTER_PASSWORD_MAX_BYTES} 字节。"
        ));
    }
    Ok(())
}

fn fill_random(output: &mut [u8]) -> Result<(), String> {
    getrandom::fill(output).map_err(|_| "系统安全随机数生成器不可用。".to_owned())
}

fn random_key() -> Result<Zeroizing<[u8; KEY_LENGTH]>, String> {
    let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
    fill_random(&mut *key)?;
    Ok(key)
}

fn derive_master_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LENGTH]>, String> {
    if salt.len() < 16 {
        return Err("保险库主密钥盐值无效。".to_owned());
    }
    let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|_| "无法从保险库主密码派生加密密钥。".to_owned())?;
    Ok(key)
}

fn encrypt(
    key: &[u8; KEY_LENGTH],
    nonce: &[u8; NONCE_LENGTH],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化 AES-256-GCM 加密器。".to_owned())?;
    let nonce = Nonce::<U12>::from(*nonce);
    cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "AES-256-GCM 加密失败。".to_owned())
}

fn decrypt(
    key: &[u8; KEY_LENGTH],
    nonce: &[u8; NONCE_LENGTH],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "无法初始化 AES-256-GCM 解密器。".to_owned())?;
    let nonce = Nonce::<U12>::from(*nonce);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "保险库数据校验失败，请检查密钥、数据完整性和记录归属。".to_owned())
}

fn split_ciphertext_and_tag(sealed: Vec<u8>) -> Result<(Vec<u8>, Vec<u8>), String> {
    if sealed.len() < TAG_LENGTH {
        return Err("AES-256-GCM 密文缺少认证标签。".to_owned());
    }
    let mut ciphertext = sealed;
    let tag = ciphertext.split_off(ciphertext.len() - TAG_LENGTH);
    Ok((ciphertext, tag))
}

fn decrypt_separated(
    key: &[u8; KEY_LENGTH],
    nonce: &[u8; NONCE_LENGTH],
    aad: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
) -> Result<Vec<u8>, String> {
    if tag.len() != TAG_LENGTH {
        return Err("AES-256-GCM 认证标签长度无效。".to_owned());
    }
    let mut sealed = Vec::with_capacity(ciphertext.len() + tag.len());
    sealed.extend_from_slice(ciphertext);
    sealed.extend_from_slice(tag);
    decrypt(key, nonce, aad, &sealed)
}

fn encrypt_marker(
    key_id: &str,
    key: &[u8; KEY_LENGTH],
) -> Result<([u8; NONCE_LENGTH], Vec<u8>), String> {
    let mut nonce = [0u8; NONCE_LENGTH];
    fill_random(&mut nonce)?;
    let aad = format!("TermVista|vault-v1|marker|{key_id}");
    let ciphertext = encrypt(key, &nonce, aad.as_bytes(), MARKER)?;
    Ok((nonce, ciphertext))
}

fn verify_marker(metadata: &VaultKeyMetadata, key: &[u8; KEY_LENGTH]) -> Result<(), String> {
    let nonce: [u8; NONCE_LENGTH] = metadata
        .check_nonce
        .as_slice()
        .try_into()
        .map_err(|_| "保险库验证数据无效。".to_owned())?;
    let aad = format!("TermVista|vault-v1|marker|{}", metadata.key_id);
    let plaintext = decrypt(key, &nonce, aad.as_bytes(), &metadata.check_ciphertext)?;
    if plaintext == MARKER {
        Ok(())
    } else {
        Err("保险库密钥验证失败。".to_owned())
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> Result<Zeroizing<[u8; KEY_LENGTH]>, String> {
    if value.len() != KEY_LENGTH * 2 {
        return Err("本机安全凭据库中的保险库密钥格式无效。".to_owned());
    }
    let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        key[index] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Ok(key)
}

fn hex_digit(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err("本机安全凭据库中的保险库密钥格式无效。".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryKeyStore(Mutex<HashMap<String, Zeroizing<[u8; KEY_LENGTH]>>>);

    impl VaultKeyStore for MemoryKeyStore {
        fn save(&self, key_id: &str, key: &[u8; KEY_LENGTH]) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "test key store lock failed".to_owned())?
                .insert(key_id.to_owned(), Zeroizing::new(*key));
            Ok(())
        }

        fn load(&self, key_id: &str) -> Result<Option<Zeroizing<[u8; KEY_LENGTH]>>, String> {
            Ok(self
                .0
                .lock()
                .map_err(|_| "test key store lock failed".to_owned())?
                .get(key_id)
                .map(|key| Zeroizing::new(**key)))
        }

        fn forget(&self, key_id: &str) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "test key store lock failed".to_owned())?
                .remove(key_id);
            Ok(())
        }
    }

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<HashMap<String, Zeroizing<String>>>);

    impl CredentialStore for MemoryCredentialStore {
        fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError> {
            self.0
                .lock()
                .map_err(|_| CredentialStoreError)?
                .insert(key.account_name(), Zeroizing::new(secret.to_owned()));
            Ok(())
        }

        fn load(
            &self,
            key: &CredentialKey,
        ) -> Result<Option<Zeroizing<String>>, CredentialStoreError> {
            Ok(self
                .0
                .lock()
                .map_err(|_| CredentialStoreError)?
                .get(&key.account_name())
                .map(|secret| Zeroizing::new(secret.to_string())))
        }

        fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError> {
            self.0
                .lock()
                .map_err(|_| CredentialStoreError)?
                .remove(&key.account_name());
            Ok(())
        }
    }

    fn test_vault() -> (CredentialVault, std::path::PathBuf) {
        let database_path =
            std::env::temp_dir().join(format!("termvista-vault-{}.sqlite3", uuid::Uuid::new_v4()));
        let profiles = Arc::new(ConnectionProfilesStore::open(&database_path).unwrap());
        let vault = CredentialVault::with_backends(
            profiles,
            Arc::new(MemoryKeyStore::default()),
            Arc::new(MemoryCredentialStore::default()),
        );
        (vault, database_path)
    }

    fn password_key() -> CredentialKey {
        CredentialKey {
            profile_id: "profile-a".to_owned(),
            username: "root".to_owned(),
            kind: CredentialKind::Password,
        }
    }

    #[test]
    fn master_password_round_trips_and_wrong_password_does_not_unlock() {
        let (vault, path) = test_vault();
        let key = password_key();
        assert_eq!(vault.status().unwrap().state, "uninitialized");
        vault
            .initialize_master_password("a-very-long-test-password")
            .unwrap();
        vault.save(&key, "test-secret-only").unwrap();
        assert_eq!(
            vault.load(&key).unwrap().as_deref().map(String::as_str),
            Some("test-secret-only")
        );
        assert_eq!(vault.lock().unwrap().state, "locked");
        assert!(vault.unlock(Some("wrong-password-value")).is_err());
        assert_eq!(vault.status().unwrap().state, "locked");
        assert!(vault.unlock(Some("a-very-long-test-password")).is_ok());
        assert_eq!(
            vault.load(&key).unwrap().as_deref().map(String::as_str),
            Some("test-secret-only")
        );
        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn missing_system_key_blocks_vault_access_without_plaintext_fallback() {
        let path = std::env::temp_dir().join(format!(
            "termvista-keychain-failure-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let profiles = Arc::new(ConnectionProfilesStore::open(&path).unwrap());
        let key_store = Arc::new(MemoryKeyStore::default());
        let vault = CredentialVault::with_backends(
            Arc::clone(&profiles),
            key_store.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let credential = password_key();
        vault.initialize_keychain().unwrap();
        vault
            .save(&credential, "secret-must-stay-encrypted")
            .unwrap();

        let identity = CredentialVault::record_identity(&credential);
        let record = profiles
            .vault_record_get(&identity.0, &identity.1, &identity.2, &identity.3)
            .unwrap()
            .unwrap();
        assert!(
            !record
                .ciphertext
                .windows(b"secret-must-stay-encrypted".len())
                .any(|window| window == b"secret-must-stay-encrypted")
        );

        vault.lock().unwrap();
        let metadata = profiles.vault_active_key().unwrap().unwrap();
        key_store.forget(&metadata.key_id).unwrap();
        assert!(vault.unlock(None).is_err());
        assert!(vault.load(&credential).is_err());
        assert_eq!(vault.status().unwrap().state, "locked");

        drop(vault);
        drop(profiles);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn nonce_ledger_rejects_reuse_for_the_same_encryption_key() {
        let (vault, path) = test_vault();
        vault
            .initialize_master_password("a-very-long-test-password")
            .unwrap();
        let (key_id, _) = vault.active_key().unwrap();
        let metadata = vault.profiles.vault_active_key().unwrap().unwrap();
        assert_eq!(metadata.key_id, key_id);
        assert!(
            !vault
                .profiles
                .vault_reserve_nonce(&key_id, &metadata.check_nonce)
                .unwrap(),
            "主密钥验证标记 nonce 应在密钥创建时登记"
        );
        let nonce = [0x5au8; NONCE_LENGTH];

        assert!(vault.profiles.vault_reserve_nonce(&key_id, &nonce).unwrap());
        assert!(!vault.profiles.vault_reserve_nonce(&key_id, &nonce).unwrap());

        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn master_password_rotation_reencrypts_credentials_and_changes_unlock_secret() {
        let (vault, path) = test_vault();
        let credential = password_key();
        vault
            .initialize_master_password("original-master-password")
            .unwrap();
        vault.save(&credential, "rotation-test-secret").unwrap();
        vault
            .save_managed_key("managed-key", "encrypted-openssh-key")
            .unwrap();
        let old_key_id = vault.profiles.vault_active_key().unwrap().unwrap().key_id;

        let status = vault
            .rotate_key(Some("replacement-master-password"))
            .unwrap();
        assert_eq!(status.state, "unlocked");
        let new_key_id = vault.profiles.vault_active_key().unwrap().unwrap().key_id;
        assert_ne!(new_key_id, old_key_id);
        assert_eq!(
            vault
                .load(&credential)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("rotation-test-secret")
        );
        assert_eq!(
            vault.load_managed_key("managed-key").unwrap().as_str(),
            "encrypted-openssh-key"
        );
        assert!(
            vault
                .profiles
                .vault_records_list()
                .unwrap()
                .iter()
                .all(|record| record.key_id == new_key_id)
        );

        vault.lock().unwrap();
        assert!(vault.unlock(Some("original-master-password")).is_err());
        assert_eq!(
            vault
                .unlock(Some("replacement-master-password"))
                .unwrap()
                .state,
            "unlocked"
        );
        assert_eq!(
            vault
                .load(&credential)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("rotation-test-secret")
        );

        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn keychain_rotation_reencrypts_records_and_keeps_existing_backup_key() {
        let path =
            std::env::temp_dir().join(format!("termvista-vault-{}.sqlite3", uuid::Uuid::new_v4()));
        let profiles = Arc::new(ConnectionProfilesStore::open(&path).unwrap());
        let keys = Arc::new(MemoryKeyStore::default());
        let vault = CredentialVault::with_backends(
            profiles,
            keys.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let credential = password_key();
        vault.initialize_keychain().unwrap();
        vault.save(&credential, "keychain-rotation-secret").unwrap();
        let old_key_id = vault.profiles.vault_active_key().unwrap().unwrap().key_id;

        assert_eq!(vault.rotate_key(None).unwrap().state, "unlocked");
        let new_key_id = vault.profiles.vault_active_key().unwrap().unwrap().key_id;
        assert_ne!(new_key_id, old_key_id);
        assert_eq!(
            vault
                .load(&credential)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("keychain-rotation-secret")
        );
        assert_eq!(
            vault.lock().and_then(|_| vault.unlock(None)).unwrap().state,
            "unlocked"
        );
        assert!(keys.load(&old_key_id).unwrap().is_some());

        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn vault_rotation_rejects_corrupted_record_without_switching_key() {
        let (vault, path) = test_vault();
        let credential = password_key();
        vault
            .initialize_master_password("original-master-password")
            .unwrap();
        vault
            .save(&credential, "untouched-database-secret")
            .unwrap();
        let old_key_id = vault.profiles.vault_active_key().unwrap().unwrap().key_id;
        let identity = CredentialVault::record_identity(&credential);
        let mut damaged = vault
            .profiles
            .vault_record_get(&identity.0, &identity.1, &identity.2, &identity.3)
            .unwrap()
            .unwrap();
        damaged.tag[0] ^= 1;
        vault.profiles.vault_record_save(&damaged).unwrap();

        assert!(
            vault
                .rotate_key(Some("replacement-master-password"))
                .is_err()
        );
        assert_eq!(
            vault.profiles.vault_active_key().unwrap().unwrap().key_id,
            old_key_id
        );
        assert_eq!(
            vault
                .profiles
                .vault_record_get(&identity.0, &identity.1, &identity.2, &identity.3)
                .unwrap()
                .unwrap()
                .key_id,
            old_key_id
        );

        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn vault_ciphertext_is_authenticated_to_the_record_identity() {
        let (vault, path) = test_vault();
        let key = password_key();
        vault
            .initialize_master_password("a-very-long-test-password")
            .unwrap();
        let (key_id, encryption_key) = vault.active_key().unwrap();
        vault.save(&key, "identity-bound-secret").unwrap();
        let nonce = [4u8; NONCE_LENGTH];
        let mut record = EncryptedVaultRecord {
            id: "record-a".to_owned(),
            owner_type: "ssh_credential".to_owned(),
            owner_id: "profile-a".to_owned(),
            account: "root".to_owned(),
            kind: "password".to_owned(),
            enc_version: ENVELOPE_VERSION,
            key_id: key_id.clone(),
            nonce: nonce.to_vec(),
            ciphertext: Vec::new(),
            tag: Vec::new(),
        };
        let aad_a = CredentialVault::record_aad(&record);
        (record.ciphertext, record.tag) =
            split_ciphertext_and_tag(encrypt(&encryption_key, &nonce, &aad_a, b"bound").unwrap())
                .unwrap();
        assert!(
            decrypt_separated(
                &encryption_key,
                &nonce,
                &aad_a,
                &record.ciphertext,
                &record.tag
            )
            .is_ok()
        );
        record.owner_id = "profile-b".to_owned();
        let aad_b = CredentialVault::record_aad(&record);
        assert!(
            decrypt_separated(
                &encryption_key,
                &nonce,
                &aad_b,
                &record.ciphertext,
                &record.tag
            )
            .is_err()
        );
        record.owner_id = "profile-a".to_owned();
        let aad_a = CredentialVault::record_aad(&record);
        let mut tampered = record.ciphertext.clone();
        tampered[0] ^= 1;
        assert!(
            decrypt_separated(&encryption_key, &nonce, &aad_a, &tampered, &record.tag).is_err()
        );
        let mut tampered_tag = record.tag.clone();
        tampered_tag[0] ^= 1;
        assert!(
            decrypt_separated(
                &encryption_key,
                &nonce,
                &aad_a,
                &record.ciphertext,
                &tampered_tag
            )
            .is_err()
        );
        assert!(!key_id.is_empty());
        drop(vault);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_secure_credentials_remain_readable_and_are_migrated_when_unlocked() {
        let (vault, path) = test_vault();
        let key = password_key();
        vault.legacy.save(&key, "legacy-secure-secret").unwrap();
        assert_eq!(
            vault.load(&key).unwrap().as_deref().map(String::as_str),
            Some("legacy-secure-secret")
        );
        vault
            .initialize_master_password("a-very-long-test-password")
            .unwrap();
        assert_eq!(
            vault.load(&key).unwrap().as_deref().map(String::as_str),
            Some("legacy-secure-secret")
        );
        assert!(vault.legacy.load(&key).unwrap().is_some());
        let (owner_type, owner_id, account, kind) = CredentialVault::record_identity(&key);
        assert!(
            vault
                .profiles
                .vault_record_get(&owner_type, &owner_id, &account, &kind)
                .unwrap()
                .is_some()
        );
        drop(vault);
        let _ = std::fs::remove_file(path);
    }
}
