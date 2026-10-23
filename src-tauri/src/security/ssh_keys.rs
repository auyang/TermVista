use std::{fs::OpenOptions, io::Write, path::Path, time::SystemTime};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use russh::keys::ssh_key::{
    Algorithm, EcdsaCurve, HashAlg, LineEnding, PrivateKey, private::RsaKeypair,
    rand_core::UnwrapErr,
};
use zeroize::Zeroizing;

use crate::{
    connections::{ConnectionProfilesStore, SshKeyMetadata},
    security::vault::CredentialVault,
};

const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;

pub fn generate(
    profiles: &ConnectionProfilesStore,
    vault: &CredentialVault,
    alias: &str,
    key_type: &str,
    rsa_bits: Option<u16>,
    passphrase: &str,
) -> Result<SshKeyMetadata, String> {
    let alias = validate_alias(alias)?;
    validate_passphrase(passphrase)?;
    let mut rng = UnwrapErr(getrandom::SysRng);
    let key_result = match key_type {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .map_err(|_| "无法生成 SSH 密钥，请检查系统安全随机数服务。".to_owned()),
        "ecdsaP256" => PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .map_err(|_| "无法生成 SSH 密钥，请检查系统安全随机数服务。".to_owned()),
        "rsa" => {
            let bits = match rsa_bits {
                Some(3072) => 3072,
                Some(4096) => 4096,
                _ => return Err("RSA 密钥长度只能选择 3072 或 4096 位。".to_owned()),
            };
            RsaKeypair::random(&mut rng, bits)
                .map(PrivateKey::from)
                .map_err(|_| "无法生成 RSA 密钥，请检查系统安全随机数服务。".to_owned())
        }
        _ => return Err("不支持的 SSH 密钥类型。".to_owned()),
    };
    let mut private_key = key_result?;
    private_key.set_comment(alias.clone());
    let encrypted = private_key
        .encrypt(&mut getrandom::SysRng, passphrase)
        .map_err(|_| "无法使用所选口令加密 SSH 私钥。".to_owned())?;
    let private_openssh = encrypted
        .to_openssh(LineEnding::LF)
        .map_err(|_| "无法编码生成的 SSH 私钥。".to_owned())?;
    save_vault_key(profiles, vault, alias, private_openssh, &encrypted)
}

pub fn import_openssh_file(
    profiles: &ConnectionProfilesStore,
    vault: &CredentialVault,
    path: &Path,
    alias: &str,
    passphrase: Option<&str>,
) -> Result<SshKeyMetadata, String> {
    let alias = validate_alias(alias)?;
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("无法读取 SSH 私钥文件：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err("SSH 私钥必须是非空普通文件，且大小不能超过 1 MiB。".to_owned());
    }
    let private_openssh = Zeroizing::new(
        std::fs::read_to_string(path).map_err(|error| format!("无法读取 SSH 私钥文件：{error}"))?,
    );
    let parsed = PrivateKey::from_openssh(&*private_openssh)
        .map_err(|_| "无法识别 OpenSSH 私钥格式。请确认选择的是私钥文件。".to_owned())?;
    let validated = if parsed.is_encrypted() {
        let passphrase = passphrase
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "该私钥已加密，请输入当前私钥口令以验证后导入。".to_owned())?;
        parsed
            .decrypt(passphrase)
            .map_err(|_| "私钥口令不正确或私钥数据已损坏。".to_owned())?
    } else {
        parsed
    };
    save_vault_key(profiles, vault, alias, private_openssh, &validated)
}

pub fn list(profiles: &ConnectionProfilesStore) -> Result<Vec<SshKeyMetadata>, String> {
    profiles.ssh_key_list()
}

pub fn delete(profiles: &ConnectionProfilesStore, key_id: &str) -> Result<bool, String> {
    profiles.ssh_key_delete_if_unreferenced(key_id)
}

pub fn export_encrypted(
    vault: &CredentialVault,
    key_id: &str,
    destination: &Path,
    current_passphrase: Option<&str>,
    export_passphrase: &str,
) -> Result<(), String> {
    validate_passphrase(export_passphrase)?;
    let stored = vault.load_managed_key(key_id)?;
    let parsed = PrivateKey::from_openssh(stored.as_str())
        .map_err(|_| "保险库中的 SSH 私钥格式无效，无法导出。".to_owned())?;
    let private_key = if parsed.is_encrypted() {
        let passphrase = current_passphrase
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "该私钥已有口令保护，请输入当前口令后导出。".to_owned())?;
        parsed
            .decrypt(passphrase)
            .map_err(|_| "当前私钥口令不正确，未导出文件。".to_owned())?
    } else {
        parsed
    };
    let encrypted = private_key
        .encrypt(&mut getrandom::SysRng, export_passphrase)
        .map_err(|_| "无法使用新口令加密 SSH 私钥。".to_owned())?;
    let contents = Zeroizing::new(
        encrypted
            .to_openssh(LineEnding::LF)
            .map_err(|_| "无法编码加密后的 SSH 私钥。".to_owned())?,
    );

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(destination)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                "目标文件已存在。请选择其他文件名，原文件未更改。".to_owned()
            }
            _ => "无法创建导出文件，请检查目标位置的权限和可用空间。".to_owned(),
        })?;

    let write_result = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all());
    if write_result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(destination);
        return Err("SSH 私钥写入失败，未保留不完整的导出文件。".to_owned());
    }
    Ok(())
}

fn save_vault_key(
    profiles: &ConnectionProfilesStore,
    vault: &CredentialVault,
    alias: String,
    private_openssh: Zeroizing<String>,
    parsed_key: &PrivateKey,
) -> Result<SshKeyMetadata, String> {
    let fingerprint = parsed_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    if profiles
        .ssh_key_list()?
        .iter()
        .any(|existing| existing.fingerprint == fingerprint)
    {
        return Err("此 SSH 公钥已存在于密钥管理器中。".to_owned());
    }
    let key_id = uuid::Uuid::new_v4().to_string();
    let secret_ref = vault.save_managed_key(&key_id, &private_openssh)?;
    let metadata = SshKeyMetadata {
        id: key_id.clone(),
        alias,
        key_type: parsed_key.algorithm().to_string(),
        fingerprint,
        public_key: parsed_key
            .public_key()
            .to_openssh()
            .map_err(|_| "无法编码 SSH 公钥。".to_owned())?,
        storage_kind: "vault".to_owned(),
        secret_ref: Some(secret_ref),
        path_ref: None,
        created_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or_default(),
        references: 0,
    };
    if let Err(error) = profiles.ssh_key_save(&metadata) {
        let _ = profiles.vault_record_delete("ssh_private_key", &key_id, "", "private_key");
        return Err(format!("无法保存 SSH 密钥信息：{error}"));
    }
    Ok(metadata)
}

fn validate_alias(alias: &str) -> Result<String, String> {
    let alias = alias.trim();
    if alias.is_empty() || alias.chars().count() > 80 || alias.chars().any(char::is_control) {
        return Err("密钥名称须为 1–80 个可显示字符。".to_owned());
    }
    Ok(alias.to_owned())
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < 8 || passphrase.len() > 1024 {
        return Err("生成 SSH 密钥的口令至少需要 8 个字符，且不能超过 1024 字节。".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::PathBuf, sync::Mutex};

    use zeroize::Zeroizing;

    use crate::{
        connections::{ConnectionProfile, ConnectionProfilesStore},
        security::{
            credential_store::{CredentialKey, CredentialStore, CredentialStoreError},
            vault::{CredentialVault, VaultKeyStore},
        },
    };

    use super::{delete, export_encrypted, generate, import_openssh_file, list};

    #[derive(Default)]
    struct TestKeyStore;

    impl VaultKeyStore for TestKeyStore {
        fn save(&self, _key_id: &str, _key: &[u8; 32]) -> Result<(), String> {
            Ok(())
        }

        fn load(&self, _key_id: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
            Ok(None)
        }

        fn forget(&self, _key_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct TestCredentialStore(Mutex<HashMap<String, Zeroizing<String>>>);

    impl CredentialStore for TestCredentialStore {
        fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError> {
            self.0
                .lock()
                .map_err(|_| CredentialStoreError)?
                .insert(key.profile_id.clone(), Zeroizing::new(secret.to_owned()));
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
                .get(&key.profile_id)
                .map(|secret| Zeroizing::new(secret.to_string())))
        }

        fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError> {
            self.0
                .lock()
                .map_err(|_| CredentialStoreError)?
                .remove(&key.profile_id);
            Ok(())
        }
    }

    struct TestEnvironment {
        directory: PathBuf,
        profiles: std::sync::Arc<ConnectionProfilesStore>,
        vault: CredentialVault,
    }

    impl TestEnvironment {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("termvista-ssh-keys-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let profiles = std::sync::Arc::new(
                ConnectionProfilesStore::open(directory.join("connections.sqlite3")).unwrap(),
            );
            let vault = CredentialVault::with_backends(
                profiles.clone(),
                std::sync::Arc::new(TestKeyStore),
                std::sync::Arc::new(TestCredentialStore::default()),
            );
            vault
                .initialize_master_password("unit-test-master-password")
                .unwrap();
            Self {
                directory,
                profiles,
                vault,
            }
        }
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn generated_keys_are_encrypted_and_deletion_removes_the_vault_record() {
        let environment = TestEnvironment::new();
        let key = generate(
            &environment.profiles,
            &environment.vault,
            "unit-test-key",
            "ed25519",
            None,
            "private-key-passphrase",
        )
        .unwrap();
        let secret = environment.vault.load_managed_key(&key.id).unwrap();
        let parsed = russh::keys::ssh_key::PrivateKey::from_openssh(secret.as_str()).unwrap();

        assert!(parsed.is_encrypted());
        assert!(key.public_key.starts_with("ssh-ed25519 "));
        assert_eq!(list(&environment.profiles).unwrap().len(), 1);
        let profile = ConnectionProfile {
            id: "key-reference-profile".to_owned(),
            name: "key reference test".to_owned(),
            host: "localhost".to_owned(),
            port: 22,
            username: "tester".to_owned(),
            group_name: "默认分组".to_owned(),
            group_id: None,
            sort_order: 0,
            auth_method: "privateKey".to_owned(),
            private_key_path: String::new(),
            key_ref: Some(key.id.clone()),
            environment: "test".to_owned(),
            favorite: false,
            last_connected_at: None,
            auto_reconnect: false,
            credential_accounts: Vec::new(),
        };
        environment.profiles.save(&profile).unwrap();
        assert!(
            delete(&environment.profiles, &key.id)
                .unwrap_err()
                .contains("1 个连接")
        );
        assert!(environment.vault.load_managed_key(&key.id).is_ok());
        assert!(environment.profiles.delete(&profile.id).unwrap());
        let record = environment
            .profiles
            .vault_record_get("ssh_private_key", &key.id, "", "private_key")
            .unwrap()
            .unwrap();
        assert!(!String::from_utf8_lossy(&record.ciphertext).contains("OPENSSH"));

        assert!(delete(&environment.profiles, &key.id).unwrap());
        assert!(environment.vault.load_managed_key(&key.id).is_err());
        assert!(list(&environment.profiles).unwrap().is_empty());
    }

    #[test]
    fn import_validates_private_key_passphrase_before_persisting_it() {
        let environment = TestEnvironment::new();
        let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
        let private_key = russh::keys::ssh_key::PrivateKey::random(
            &mut rng,
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let encoded = private_key
            .encrypt(&mut getrandom::SysRng, "source-key-passphrase")
            .unwrap()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let path = environment.directory.join("source-key");
        std::fs::write(&path, encoded.as_bytes()).unwrap();

        assert!(
            import_openssh_file(
                &environment.profiles,
                &environment.vault,
                &path,
                "bad-import",
                Some("wrong-passphrase"),
            )
            .is_err()
        );
        assert!(list(&environment.profiles).unwrap().is_empty());

        let imported = import_openssh_file(
            &environment.profiles,
            &environment.vault,
            &path,
            "imported-key",
            Some("source-key-passphrase"),
        )
        .unwrap();
        assert_eq!(
            imported.fingerprint,
            private_key
                .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                .to_string()
        );
        assert_eq!(list(&environment.profiles).unwrap().len(), 1);
        assert!(
            import_openssh_file(
                &environment.profiles,
                &environment.vault,
                &path,
                "duplicate-key",
                Some("source-key-passphrase"),
            )
            .unwrap_err()
            .contains("已存在")
        );
        assert_eq!(list(&environment.profiles).unwrap().len(), 1);
    }

    #[test]
    fn private_key_export_is_encrypted_restricts_permissions_and_never_overwrites() {
        let environment = TestEnvironment::new();
        let key = generate(
            &environment.profiles,
            &environment.vault,
            "export-test-key",
            "ed25519",
            None,
            "source-passphrase",
        )
        .unwrap();
        let destination = environment.directory.join("exported.openssh");

        assert!(
            export_encrypted(
                &environment.vault,
                &key.id,
                &destination,
                Some("incorrect-passphrase"),
                "export-passphrase",
            )
            .is_err()
        );
        assert!(!destination.exists());

        export_encrypted(
            &environment.vault,
            &key.id,
            &destination,
            Some("source-passphrase"),
            "export-passphrase",
        )
        .unwrap();
        let exported = std::fs::read_to_string(&destination).unwrap();
        let exported = russh::keys::ssh_key::PrivateKey::from_openssh(&exported).unwrap();
        assert!(exported.is_encrypted());
        let decrypted = exported.decrypt("export-passphrase").unwrap();
        assert_eq!(
            decrypted
                .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                .to_string(),
            key.fingerprint
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&destination)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let existing = environment.directory.join("existing.openssh");
        std::fs::write(&existing, b"preserve this file").unwrap();
        let error = export_encrypted(
            &environment.vault,
            &key.id,
            &existing,
            Some("source-passphrase"),
            "export-passphrase",
        )
        .unwrap_err();
        assert!(error.contains("已存在"));
        assert_eq!(std::fs::read(&existing).unwrap(), b"preserve this file");
    }

    #[test]
    fn exporting_an_imported_unencrypted_key_always_adds_a_passphrase() {
        let environment = TestEnvironment::new();
        let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
        let source_key = russh::keys::ssh_key::PrivateKey::random(
            &mut rng,
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let source_path = environment.directory.join("unencrypted-source");
        std::fs::write(
            &source_path,
            source_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap(),
        )
        .unwrap();
        let imported = import_openssh_file(
            &environment.profiles,
            &environment.vault,
            &source_path,
            "unencrypted-source-key",
            None,
        )
        .unwrap();
        let destination = environment.directory.join("encrypted-export.openssh");

        export_encrypted(
            &environment.vault,
            &imported.id,
            &destination,
            None,
            "new-export-passphrase",
        )
        .unwrap();
        let encoded = std::fs::read_to_string(destination).unwrap();
        let encrypted = russh::keys::ssh_key::PrivateKey::from_openssh(&encoded).unwrap();
        assert!(encrypted.is_encrypted());
        assert_eq!(
            encrypted
                .decrypt("new-export-passphrase")
                .unwrap()
                .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                .to_string(),
            imported.fingerprint
        );
    }

    #[test]
    fn generates_and_imports_ed25519_rsa_and_ecdsa_keys() {
        let environment = TestEnvironment::new();
        let passphrase = "test-key-passphrase";
        let mut rng = russh::keys::ssh_key::rand_core::UnwrapErr(getrandom::SysRng);
        let algorithms = [
            ("ed25519", None, "ssh-ed25519"),
            ("rsa", Some(3072), "ssh-rsa"),
            ("ecdsaP256", None, "ecdsa-sha2-nistp256"),
        ];

        for (index, (key_type, rsa_bits, expected_algorithm)) in algorithms.into_iter().enumerate()
        {
            let generated = generate(
                &environment.profiles,
                &environment.vault,
                &format!("generated-{key_type}"),
                key_type,
                rsa_bits,
                passphrase,
            )
            .unwrap();
            let encrypted_key = environment.vault.load_managed_key(&generated.id).unwrap();
            let encrypted_key =
                russh::keys::ssh_key::PrivateKey::from_openssh(encrypted_key.as_str()).unwrap();
            assert!(encrypted_key.is_encrypted());
            let decrypted_key = encrypted_key.decrypt(passphrase).unwrap();
            assert_eq!(decrypted_key.algorithm().to_string(), expected_algorithm);
            assert_eq!(generated.key_type, expected_algorithm);

            let source_key = match key_type {
                "ed25519" => russh::keys::ssh_key::PrivateKey::random(
                    &mut rng,
                    russh::keys::ssh_key::Algorithm::Ed25519,
                )
                .unwrap(),
                "rsa" => russh::keys::ssh_key::PrivateKey::from(
                    russh::keys::ssh_key::private::RsaKeypair::random(&mut rng, 3072).unwrap(),
                ),
                "ecdsaP256" => russh::keys::ssh_key::PrivateKey::random(
                    &mut rng,
                    russh::keys::ssh_key::Algorithm::Ecdsa {
                        curve: russh::keys::ssh_key::EcdsaCurve::NistP256,
                    },
                )
                .unwrap(),
                _ => unreachable!(),
            };
            let encoded = source_key
                .encrypt(&mut getrandom::SysRng, passphrase)
                .unwrap()
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap();
            let source_path = environment.directory.join(format!("source-{index}"));
            std::fs::write(&source_path, encoded.as_bytes()).unwrap();
            let imported = import_openssh_file(
                &environment.profiles,
                &environment.vault,
                &source_path,
                &format!("imported-{key_type}"),
                Some(passphrase),
            )
            .unwrap();
            assert_eq!(imported.key_type, expected_algorithm);
        }

        assert_eq!(list(&environment.profiles).unwrap().len(), 6);
    }
}
