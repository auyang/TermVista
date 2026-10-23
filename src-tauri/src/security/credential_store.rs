use serde::Deserialize;
use zeroize::Zeroizing;

const SERVICE: &str = "ai-ssh-studio.ssh";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    Password,
    PrivateKeyPassphrase,
}

impl CredentialKind {
    fn key_name(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKeyPassphrase => "private-key-passphrase",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialKey {
    pub profile_id: String,
    pub username: String,
    pub kind: CredentialKind,
}

impl CredentialKey {
    pub(crate) fn account_name(&self) -> String {
        format!(
            "{}:{}{}:{}:{}",
            self.profile_id.len(),
            self.profile_id,
            self.username.len(),
            self.username,
            self.kind.key_name()
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStatus {
    Saved,
    Missing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CredentialStoreError;

pub trait CredentialStore: Send + Sync {
    fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError>;
    fn load(&self, key: &CredentialKey) -> Result<Option<Zeroizing<String>>, CredentialStoreError>;
    fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError>;
}

#[derive(Default)]
pub struct KeyringCredentialStore;

impl CredentialStore for KeyringCredentialStore {
    fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError> {
        keyring::Entry::new(SERVICE, &key.account_name())
            .map_err(|_| CredentialStoreError)?
            .set_password(secret)
            .map_err(|_| CredentialStoreError)
    }

    fn load(&self, key: &CredentialKey) -> Result<Option<Zeroizing<String>>, CredentialStoreError> {
        let entry =
            keyring::Entry::new(SERVICE, &key.account_name()).map_err(|_| CredentialStoreError)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialStoreError),
        }
    }

    fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError> {
        let entry =
            keyring::Entry::new(SERVICE, &key.account_name()).map_err(|_| CredentialStoreError)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialStoreError),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialKey, CredentialKind, CredentialStore, CredentialStoreError};
    use std::{collections::HashMap, sync::Mutex};
    use zeroize::Zeroizing;

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<HashMap<String, Zeroizing<String>>>);

    impl CredentialStore for MemoryCredentialStore {
        fn save(&self, key: &CredentialKey, secret: &str) -> Result<(), CredentialStoreError> {
            self.0
                .lock()
                .unwrap()
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
                .unwrap()
                .get(&key.account_name())
                .map(|secret| Zeroizing::new(secret.to_string())))
        }

        fn forget(&self, key: &CredentialKey) -> Result<(), CredentialStoreError> {
            self.0.lock().unwrap().remove(&key.account_name());
            Ok(())
        }
    }

    #[test]
    fn credential_references_are_scoped_by_profile_account_and_kind() {
        let password = CredentialKey {
            profile_id: "profile-a".to_owned(),
            username: "root".to_owned(),
            kind: CredentialKind::Password,
        };
        let other_account = CredentialKey {
            username: "admin".to_owned(),
            ..password.clone()
        };
        let passphrase = CredentialKey {
            kind: CredentialKind::PrivateKeyPassphrase,
            ..password.clone()
        };
        let other_profile = CredentialKey {
            profile_id: "profile-b".to_owned(),
            ..password.clone()
        };

        let reference = password.account_name();
        assert_ne!(reference, other_account.account_name());
        assert_ne!(reference, passphrase.account_name());
        assert_ne!(reference, other_profile.account_name());
    }

    #[test]
    fn credential_store_round_trips_and_forgets_without_persisting_test_data() {
        let store = MemoryCredentialStore::default();
        let key = CredentialKey {
            profile_id: "profile-test".to_owned(),
            username: "test-user".to_owned(),
            kind: CredentialKind::Password,
        };

        assert!(store.load(&key).unwrap().is_none());
        store.save(&key, "temporary-test-only").unwrap();
        assert_eq!(
            store.load(&key).unwrap().as_deref().map(String::as_str),
            Some("temporary-test-only")
        );
        store.forget(&key).unwrap();
        assert!(store.load(&key).unwrap().is_none());
    }
}
