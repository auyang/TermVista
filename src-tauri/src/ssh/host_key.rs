use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use russh::keys::{
    PublicKeyOrCertificate,
    ssh_key::{Certificate, HashAlg, PublicKey},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::types::{SshError, SshErrorCode};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyIdentity {
    pub key_type: String,
    pub fingerprint_sha256: String,
    pub public_key: String,
}

impl HostKeyIdentity {
    pub fn from_server_key(presented: &PublicKeyOrCertificate) -> Result<Self, SshError> {
        let public_key = presented.public_key();
        let fingerprint_sha256 = public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key_text = match presented {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.to_openssh(),
            PublicKeyOrCertificate::Certificate(certificate) => certificate.to_openssh(),
        }
        .map_err(|_| {
            SshError::new(
                SshErrorCode::Internal,
                "无法读取服务器提供的 SSH 主机密钥。",
            )
        })?;

        Ok(Self {
            key_type: public_key.algorithm().to_string(),
            fingerprint_sha256,
            public_key: public_key_text,
        })
    }

    pub fn from_openssh(text: &str) -> Result<Self, SshError> {
        let text = text.trim();
        let presented = if let Ok(key) = PublicKey::from_openssh(text) {
            PublicKeyOrCertificate::from(key)
        } else if let Ok(certificate) = Certificate::from_openssh(text) {
            PublicKeyOrCertificate::from(certificate)
        } else {
            return Err(SshError::new(
                SshErrorCode::HostKeyMismatch,
                "请输入有效的 OpenSSH 公钥或主机证书。",
            ));
        };
        Self::from_server_key(&presented)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostKeyCheck {
    Trusted,
    Unknown,
    Mismatch {
        prior_fingerprint: String,
        current_fingerprint: String,
        key_type: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedHostKey {
    host: String,
    port: u16,
    key_type: String,
    fingerprint_sha256: String,
    public_key: String,
    #[serde(default)]
    first_trusted_at: u64,
    #[serde(default)]
    last_verified_at: u64,
    #[serde(default = "default_source")]
    source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHostSummary {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint_sha256: String,
    pub first_trusted_at: u64,
    pub last_verified_at: u64,
    pub source: String,
}

pub struct HostKeyStore {
    path: PathBuf,
    entries: Mutex<Vec<TrustedHostKey>>,
    pending_mismatches: Mutex<HashMap<String, PendingHostKeyMismatch>>,
}

#[derive(Clone)]
struct PendingHostKeyMismatch {
    host: String,
    port: u16,
    prior_fingerprint: String,
    observed: HostKeyIdentity,
    observed_at: u64,
}

impl HostKeyStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, SshError> {
        let path = path.into();
        let mut entries: Vec<TrustedHostKey> = if path.exists() {
            let bytes = fs::read(&path).map_err(|_| {
                SshError::new(
                    SshErrorCode::Internal,
                    "无法读取已保存的 SSH 主机密钥记录。",
                )
            })?;
            serde_json::from_slice(&bytes).map_err(|_| {
                SshError::new(
                    SshErrorCode::Internal,
                    "SSH 主机密钥记录格式无效，已停止自动信任服务器。",
                )
            })?
        } else {
            Vec::new()
        };

        let mut changed = false;
        let now = now_epoch_seconds();
        for entry in &mut entries {
            if entry.first_trusted_at == 0 {
                entry.first_trusted_at = now;
                changed = true;
            }
            if entry.last_verified_at == 0 {
                entry.last_verified_at = entry.first_trusted_at;
                changed = true;
            }
            if entry.source.is_empty() {
                entry.source = default_source();
                changed = true;
            }
        }

        let store = Self {
            path,
            entries: Mutex::new(entries),
            pending_mismatches: Mutex::new(HashMap::new()),
        };
        if changed {
            let entries = store
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            store.persist(&entries)?;
        }
        Ok(store)
    }

    pub fn check(&self, host: &str, port: u16, identity: &HostKeyIdentity) -> HostKeyCheck {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(index) = entries
            .iter()
            .position(|entry| entry.port == port && entry.host.eq_ignore_ascii_case(host))
        else {
            return HostKeyCheck::Unknown;
        };

        let prior = &entries[index];
        if prior.fingerprint_sha256 == identity.fingerprint_sha256 {
            let now = now_epoch_seconds();
            let should_persist = now.saturating_sub(prior.last_verified_at) >= 60;
            if should_persist {
                entries[index].last_verified_at = now;
                let snapshot = entries.clone();
                drop(entries);
                let _ = self.persist(&snapshot);
            }
            HostKeyCheck::Trusted
        } else {
            HostKeyCheck::Mismatch {
                prior_fingerprint: prior.fingerprint_sha256.clone(),
                current_fingerprint: identity.fingerprint_sha256.clone(),
                key_type: identity.key_type.clone(),
            }
        }
    }

    pub fn list(&self) -> Vec<TrustedHostSummary> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|entry| TrustedHostSummary {
                host: entry.host.clone(),
                port: entry.port,
                key_type: entry.key_type.clone(),
                fingerprint_sha256: entry.fingerprint_sha256.clone(),
                first_trusted_at: entry.first_trusted_at,
                last_verified_at: entry.last_verified_at,
                source: entry.source.clone(),
            })
            .collect()
    }

    pub fn forget(&self, host: &str, port: u16) -> Result<bool, SshError> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = entries.clone();
        entries.retain(|entry| !(entry.port == port && entry.host.eq_ignore_ascii_case(host)));
        if entries.len() == previous.len() {
            return Ok(false);
        }
        if let Err(error) = self.persist(&entries) {
            *entries = previous;
            return Err(error);
        }
        Ok(true)
    }

    pub fn trust(&self, host: &str, port: u16, identity: &HostKeyIdentity) -> Result<(), SshError> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(prior) = entries
            .iter()
            .find(|entry| entry.port == port && entry.host.eq_ignore_ascii_case(host))
        {
            return if prior.fingerprint_sha256 == identity.fingerprint_sha256 {
                Ok(())
            } else {
                Err(SshError::new(
                    SshErrorCode::HostKeyMismatch,
                    "服务器主机密钥已变化。为防止中间人攻击，本次连接已拒绝。",
                ))
            };
        }

        entries.push(TrustedHostKey {
            host: host.to_owned(),
            port,
            key_type: identity.key_type.clone(),
            fingerprint_sha256: identity.fingerprint_sha256.clone(),
            public_key: identity.public_key.clone(),
            first_trusted_at: now_epoch_seconds(),
            last_verified_at: now_epoch_seconds(),
            source: default_source(),
        });
        if let Err(error) = self.persist(&entries) {
            entries.pop();
            return Err(error);
        }
        Ok(())
    }

    pub fn remember_mismatch(
        &self,
        attempt_id: &str,
        host: &str,
        port: u16,
        identity: &HostKeyIdentity,
    ) -> Result<(), SshError> {
        let prior_fingerprint = {
            let entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let prior = entries
                .iter()
                .find(|entry| entry.port == port && entry.host.eq_ignore_ascii_case(host))
                .ok_or_else(|| {
                    SshError::new(
                        SshErrorCode::HostKeyMismatch,
                        "可信主机记录已变化。请重新连接并核对服务器身份。",
                    )
                })?;
            if prior.fingerprint_sha256 == identity.fingerprint_sha256 {
                return Err(SshError::new(
                    SshErrorCode::HostKeyMismatch,
                    "服务器密钥已与可信记录一致。请重新连接。",
                ));
            }
            prior.fingerprint_sha256.clone()
        };

        let now = now_epoch_seconds();
        let mut pending = self
            .pending_mismatches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, item| now.saturating_sub(item.observed_at) <= 600);
        if pending.len() >= 128
            && !pending.contains_key(attempt_id)
            && let Some(oldest_id) = pending
                .iter()
                .min_by_key(|(_, item)| item.observed_at)
                .map(|(id, _)| id.clone())
        {
            pending.remove(&oldest_id);
        }
        pending.insert(
            attempt_id.to_owned(),
            PendingHostKeyMismatch {
                host: host.to_owned(),
                port,
                prior_fingerprint,
                observed: identity.clone(),
                observed_at: now,
            },
        );
        Ok(())
    }

    pub fn rotate_verified(
        &self,
        attempt_id: &str,
        openssh_public_key: &str,
        independently_verified: bool,
    ) -> Result<(), SshError> {
        if !independently_verified {
            return Err(SshError::new(
                SshErrorCode::HostKeyMismatch,
                "请先通过独立可信渠道核对新主机密钥。",
            ));
        }
        if openssh_public_key.len() > 64 * 1024 {
            return Err(SshError::new(
                SshErrorCode::HostKeyMismatch,
                "公钥文本过长，无法安全验证。",
            ));
        }

        let now = now_epoch_seconds();
        let pending = {
            let mut mismatches = self
                .pending_mismatches
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let item = mismatches.get(attempt_id).cloned().ok_or_else(|| {
                SshError::new(
                    SshErrorCode::HostKeyMismatch,
                    "本次指纹异常已过期。请重新连接并重新核对。",
                )
            })?;
            if now.saturating_sub(item.observed_at) > 600 {
                mismatches.remove(attempt_id);
                return Err(SshError::new(
                    SshErrorCode::HostKeyMismatch,
                    "本次指纹异常已过期。请重新连接并重新核对。",
                ));
            }
            item
        };
        let verified_identity = HostKeyIdentity::from_openssh(openssh_public_key)?;
        if verified_identity.fingerprint_sha256 != pending.observed.fingerprint_sha256
            || verified_identity.key_type != pending.observed.key_type
        {
            return Err(SshError::new(
                SshErrorCode::HostKeyMismatch,
                "独立核验的公钥与本次连接观察到的指纹不一致；记录未更改。",
            ));
        }

        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = entries
            .iter()
            .position(|entry| {
                entry.port == pending.port && entry.host.eq_ignore_ascii_case(&pending.host)
            })
            .ok_or_else(|| {
                SshError::new(
                    SshErrorCode::HostKeyMismatch,
                    "可信主机记录已被移除。请重新连接并核对服务器身份。",
                )
            })?;
        let entry = &mut entries[index];
        if entry.fingerprint_sha256 != pending.prior_fingerprint {
            return Err(SshError::new(
                SshErrorCode::HostKeyMismatch,
                "可信主机记录在确认期间发生变化。请重新连接并核对。",
            ));
        }

        let previous = entry.clone();
        entry.key_type = verified_identity.key_type;
        entry.fingerprint_sha256 = verified_identity.fingerprint_sha256;
        entry.public_key = verified_identity.public_key;
        entry.last_verified_at = now;
        entry.source = "verified-manual-rotation".to_owned();
        if let Err(error) = self.persist(&entries) {
            entries[index] = previous;
            return Err(error);
        }
        self.pending_mismatches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(attempt_id);
        Ok(())
    }

    fn persist(&self, entries: &[TrustedHostKey]) -> Result<(), SshError> {
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|_| {
            SshError::new(SshErrorCode::Internal, "无法创建 SSH 主机密钥记录目录。")
        })?;

        let temp_path = parent.join(format!(".known-hosts-{}.tmp", Uuid::new_v4()));
        let serialized = serde_json::to_vec_pretty(entries)
            .map_err(|_| SshError::new(SshErrorCode::Internal, "无法编码 SSH 主机密钥记录。"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|_| SshError::new(SshErrorCode::Internal, "无法写入 SSH 主机密钥记录。"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| {
                    SshError::new(SshErrorCode::Internal, "无法设置主机密钥记录的安全权限。")
                })?;
        }
        file.write_all(&serialized)
            .map_err(|_| SshError::new(SshErrorCode::Internal, "无法保存 SSH 主机密钥记录。"))?;
        file.sync_all().map_err(|_| {
            SshError::new(SshErrorCode::Internal, "无法完成 SSH 主机密钥记录写入。")
        })?;
        fs::rename(&temp_path, &self.path).map_err(|_| {
            SshError::new(SshErrorCode::Internal, "无法原子更新 SSH 主机密钥记录。")
        })?;
        Ok(())
    }
}

fn default_source() -> String {
    "manual".to_owned()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{HostKeyCheck, HostKeyIdentity, HostKeyStore};
    use uuid::Uuid;

    fn test_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("ai-ssh-studio-host-keys-{}", Uuid::new_v4()))
            .join("known_hosts.json")
    }

    fn identity(key: &str, fingerprint: &str) -> HostKeyIdentity {
        HostKeyIdentity {
            key_type: "ssh-ed25519".to_owned(),
            fingerprint_sha256: fingerprint.to_owned(),
            public_key: key.to_owned(),
        }
    }

    const ORIGINAL_PUBLIC_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti user@example.com";
    const ROTATED_PUBLIC_KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= user@example.com";

    fn parsed_identity(text: &str) -> HostKeyIdentity {
        HostKeyIdentity::from_openssh(text).expect("测试公钥应有效")
    }

    #[test]
    fn trust_is_scoped_to_host_and_port_and_mismatches_are_not_overwritten() {
        let path = test_path();
        let store = HostKeyStore::load(&path).expect("新密钥存储应可创建");
        let original = identity("ssh-ed25519 AAAAoriginal", "SHA256:original");
        let rotated = identity("ssh-ed25519 AAAArotated", "SHA256:rotated");

        assert_eq!(
            store.check("localhost", 2222, &original),
            HostKeyCheck::Unknown
        );
        store
            .trust("localhost", 2222, &original)
            .expect("首次确认应保存完整公钥");
        assert_eq!(
            store.check("LOCALHOST", 2222, &original),
            HostKeyCheck::Trusted
        );
        assert_eq!(
            store.check("localhost", 2223, &original),
            HostKeyCheck::Unknown
        );
        assert_eq!(
            store.check("localhost", 2222, &rotated),
            HostKeyCheck::Mismatch {
                prior_fingerprint: "SHA256:original".to_owned(),
                current_fingerprint: "SHA256:rotated".to_owned(),
                key_type: "ssh-ed25519".to_owned(),
            }
        );
        assert!(store.trust("localhost", 2222, &rotated).is_err());

        let loaded = HostKeyStore::load(&path).expect("已保存记录应可读取");
        assert_eq!(
            loaded.check("localhost", 2222, &original),
            HostKeyCheck::Trusted
        );
        let directory = path.parent().expect("测试记录目录");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn same_host_key_with_different_openssh_comments_is_still_trusted() {
        let path = test_path();
        let store = HostKeyStore::load(&path).expect("新密钥存储应可创建");
        let with_comment = parsed_identity(ORIGINAL_PUBLIC_KEY);
        let without_comment = parsed_identity(
            ORIGINAL_PUBLIC_KEY
                .split_once(" user@example.com")
                .expect("测试公钥注释")
                .0,
        );
        assert_eq!(
            with_comment.fingerprint_sha256,
            without_comment.fingerprint_sha256
        );
        store.trust("localhost", 2222, &with_comment).unwrap();
        assert_eq!(
            store.check("localhost", 2222, &without_comment),
            HostKeyCheck::Trusted
        );
        assert!(store.trust("localhost", 2222, &without_comment).is_ok());
        let directory = path.parent().expect("测试记录目录");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn trusted_hosts_can_be_listed_and_revoked_by_exact_endpoint() {
        let path = test_path();
        let store = HostKeyStore::load(&path).expect("新密钥存储应可创建");
        let first = identity("ssh-ed25519 AAAA-first", "SHA256:first");
        let second = identity("ssh-ed25519 AAAA-second", "SHA256:second");
        store.trust("localhost", 2222, &first).unwrap();
        store.trust("localhost", 2223, &second).unwrap();

        let listed = store.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].source, "manual");
        assert!(listed[0].first_trusted_at > 0);
        assert!(store.forget("LOCALHOST", 2222).unwrap());
        assert!(!store.forget("localhost", 2222).unwrap());
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.check("localhost", 2223, &second),
            HostKeyCheck::Trusted
        );

        let directory = path.parent().expect("测试记录目录");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn verified_rotation_requires_the_observed_key_and_preserves_the_endpoint_record() {
        let path = test_path();
        let store = HostKeyStore::load(&path).expect("新密钥存储应可创建");
        let original = parsed_identity(ORIGINAL_PUBLIC_KEY);
        let rotated = parsed_identity(ROTATED_PUBLIC_KEY);
        store.trust("localhost", 2222, &original).unwrap();
        store
            .remember_mismatch("attempt-1", "localhost", 2222, &rotated)
            .unwrap();

        assert!(
            store
                .rotate_verified("attempt-1", ROTATED_PUBLIC_KEY, false)
                .is_err()
        );
        assert!(
            store
                .rotate_verified("attempt-1", ORIGINAL_PUBLIC_KEY, true)
                .is_err()
        );
        assert_eq!(
            store.check("localhost", 2222, &original),
            HostKeyCheck::Trusted
        );

        store
            .rotate_verified("attempt-1", ROTATED_PUBLIC_KEY, true)
            .expect("外部核验的公钥与观察指纹一致时应允许受控轮换");
        assert_eq!(
            store.check("localhost", 2222, &rotated),
            HostKeyCheck::Trusted
        );
        assert_eq!(store.list()[0].source, "verified-manual-rotation");

        let loaded = HostKeyStore::load(&path).expect("轮换记录应可持久化");
        assert_eq!(
            loaded.check("localhost", 2222, &rotated),
            HostKeyCheck::Trusted
        );
        assert_eq!(
            loaded.check("localhost", 2223, &rotated),
            HostKeyCheck::Unknown
        );
        let directory = path.parent().expect("测试记录目录");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn verified_rotation_rejects_a_stale_old_fingerprint() {
        let path = test_path();
        let store = HostKeyStore::load(&path).expect("新密钥存储应可创建");
        let original = parsed_identity(ORIGINAL_PUBLIC_KEY);
        let rotated = parsed_identity(ROTATED_PUBLIC_KEY);
        store.trust("localhost", 2222, &original).unwrap();
        store
            .remember_mismatch("attempt-stale", "localhost", 2222, &rotated)
            .unwrap();

        assert!(store.forget("localhost", 2222).unwrap());
        store.trust("localhost", 2222, &rotated).unwrap();
        assert!(
            store
                .rotate_verified("attempt-stale", ROTATED_PUBLIC_KEY, true)
                .is_err()
        );
        assert_eq!(store.list()[0].source, "manual");

        let directory = path.parent().expect("测试记录目录");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_host_key_records_migrate_without_losing_the_public_key() {
        let path = test_path();
        let directory = path.parent().expect("测试记录目录");
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            &path,
            r#"[{"host":"legacy.test","port":22,"keyType":"ssh-ed25519","fingerprintSha256":"SHA256:legacy","publicKey":"ssh-ed25519 AAAAlegacy"}]"#,
        )
        .unwrap();

        let store = HostKeyStore::load(&path).expect("旧版本可信记录应安全迁移");
        assert_eq!(
            store.check(
                "legacy.test",
                22,
                &identity("ssh-ed25519 AAAAlegacy", "SHA256:legacy")
            ),
            HostKeyCheck::Trusted
        );
        assert!(store.list()[0].first_trusted_at > 0);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(persisted[0]["lastVerifiedAt"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(directory);
    }
}
