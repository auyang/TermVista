use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshState {
    Connecting,
    VerifyingHostKey,
    Authenticating,
    OpeningPty,
    Connected,
    Disconnecting,
    Disconnected,
    Error,
    Canceled,
}

impl SshState {
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Connecting, Self::VerifyingHostKey)
                | (Self::Connecting, Self::Authenticating)
                | (Self::Connecting, Self::Error)
                | (Self::Connecting, Self::Canceled)
                | (Self::VerifyingHostKey, Self::Authenticating)
                | (Self::VerifyingHostKey, Self::Error)
                | (Self::VerifyingHostKey, Self::Canceled)
                | (Self::Authenticating, Self::OpeningPty)
                | (Self::Authenticating, Self::Error)
                | (Self::Authenticating, Self::Canceled)
                | (Self::OpeningPty, Self::Connected)
                | (Self::OpeningPty, Self::Error)
                | (Self::OpeningPty, Self::Canceled)
                | (Self::Connected, Self::Disconnecting)
                | (Self::Connected, Self::Error)
                | (Self::Disconnecting, Self::Disconnected)
                | (Self::Disconnecting, Self::Error)
                | (Self::Error, Self::Disconnected)
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshErrorCode {
    HostKeyUnknown,
    HostKeyMismatch,
    HostKeyRejected,
    CredentialMissing,
    CredentialStoreUnavailable,
    AuthFailed,
    AuthPromptTimeout,
    PrivateKeyInvalid,
    DnsResolutionFailed,
    ConnectionTimeout,
    ConnectionRefused,
    ConnectionFailed,
    ServerClosed,
    ChannelOpenFailed,
    PtyRequestFailed,
    ShellRequestFailed,
    SessionNotFound,
    SessionClosed,
    Canceled,
    InputTooLarge,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshError {
    pub code: SshErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<SshErrorDetails>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshErrorDetails {
    HostKeyChanged {
        host: String,
        port: u16,
        key_type: String,
        prior_fingerprint: String,
        current_fingerprint: String,
    },
}

impl SshError {
    pub fn new(code: SshErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: SshErrorDetails) -> Self {
        self.details = Some(Box::new(details));
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

impl TerminalSize {
    pub fn normalized(self) -> Self {
        Self {
            cols: self.cols.clamp(1, 500),
            rows: self.rows.clamp(1, 300),
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshAuth {
    Password {
        password: String,
    },
    KeyboardInteractive,
    PrivateKey {
        private_key_path: String,
        #[serde(default)]
        key_ref: Option<String>,
        #[serde(skip)]
        private_key_data: Option<Zeroizing<String>>,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

impl Drop for SshAuth {
    fn drop(&mut self) {
        match self {
            Self::Password { password } => password.zeroize(),
            Self::KeyboardInteractive => {}
            Self::PrivateKey {
                private_key_data,
                passphrase,
                ..
            } => {
                drop(private_key_data.take());
                if let Some(secret) = passphrase {
                    secret.zeroize();
                }
            }
        }
    }
}

pub struct SshConnectRequest {
    pub attempt_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub initial_size: TerminalSize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub attempt_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint_sha256: String,
    pub prior_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptField {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptEvent {
    pub attempt_id: String,
    pub prompt_id: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<AuthPromptField>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyDecision {
    TrustOnce,
    TrustAndSave,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshStatusEvent {
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub state: SshState,
    pub error: Option<SshError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub state: SshState,
}

#[cfg(test)]
mod tests {
    use super::{AuthPromptEvent, HostKeyDecision, SshAuth, SshState, TerminalSize};

    #[test]
    fn host_key_decisions_use_the_frontend_camel_case_contract() {
        assert_eq!(
            serde_json::to_string(&HostKeyDecision::TrustOnce).unwrap(),
            "\"trustOnce\""
        );
        assert_eq!(
            serde_json::from_str::<HostKeyDecision>("\"trustAndSave\"").unwrap(),
            HostKeyDecision::TrustAndSave
        );
    }

    #[test]
    fn private_key_auth_accepts_the_camel_case_ipc_contract() {
        let auth: SshAuth = serde_json::from_str(
            r#"{"method":"privateKey","privateKeyPath":"/tmp/id_ed25519","passphrase":"test-only"}"#,
        )
        .unwrap();
        assert!(matches!(
            &auth,
            SshAuth::PrivateKey {
                private_key_path,
                passphrase: Some(passphrase),
                ..
            } if private_key_path == "/tmp/id_ed25519" && passphrase == "test-only"
        ));
    }

    #[test]
    fn keyboard_interactive_auth_and_prompt_use_the_frontend_contract() {
        let auth: SshAuth = serde_json::from_str(r#"{"method":"keyboardInteractive"}"#).unwrap();
        assert!(matches!(auth, SshAuth::KeyboardInteractive));
        let prompt: AuthPromptEvent = serde_json::from_str(
            r#"{"attemptId":"attempt-1","promptId":"prompt-1","name":"Verification","instructions":"Enter the code","prompts":[{"prompt":"One-time code:","echo":false}]}"#,
        )
        .unwrap();
        assert_eq!(prompt.prompts[0].prompt, "One-time code:");
        assert!(!prompt.prompts[0].echo);
    }

    #[test]
    fn connection_state_machine_accepts_only_real_lifecycle_edges() {
        assert!(SshState::Connecting.can_transition_to(SshState::VerifyingHostKey));
        assert!(SshState::VerifyingHostKey.can_transition_to(SshState::Authenticating));
        assert!(SshState::Authenticating.can_transition_to(SshState::OpeningPty));
        assert!(SshState::OpeningPty.can_transition_to(SshState::Connected));
        assert!(SshState::Connected.can_transition_to(SshState::Disconnecting));
        assert!(SshState::Disconnecting.can_transition_to(SshState::Disconnected));
        assert!(!SshState::Connecting.can_transition_to(SshState::Connected));
        assert!(!SshState::Connected.can_transition_to(SshState::Authenticating));
        assert!(!SshState::Canceled.can_transition_to(SshState::Connected));
    }

    #[test]
    fn terminal_size_is_clamped_before_pty_requests() {
        assert_eq!(
            TerminalSize { cols: 0, rows: 999 }.normalized(),
            TerminalSize { cols: 1, rows: 300 }
        );
        assert_eq!(
            TerminalSize {
                cols: 800,
                rows: 40
            }
            .normalized(),
            TerminalSize {
                cols: 500,
                rows: 40
            }
        );
    }
}
