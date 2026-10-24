use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    OpenAiCompatible,
    Ollama,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiTaskMode {
    #[default]
    Ask,
    Diagnose,
    Plan,
    TunnelDiagnose,
    TunnelSuggest,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiTunnelProtocol {
    LocalTcp,
    Socks5,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelSuggestionAction {
    Create,
    UpdateSelected,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelSuggestionProtocol {
    LocalTcp,
    Socks5,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelSuggestionDraft {
    pub summary: String,
    pub action: TunnelSuggestionAction,
    pub protocol: TunnelSuggestionProtocol,
    pub name: String,
    pub group_name: String,
    pub local_host: String,
    pub local_port: u32,
    #[serde(default)]
    pub target_host: Option<String>,
    #[serde(default)]
    pub target_port: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: AiProviderKind,
    pub base_url: String,
    pub model: String,
    pub timeout_seconds: u64,
    pub allow_insecure_http: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub provider_id: Option<String>,
    pub name: String,
    pub kind: AiProviderKind,
    pub base_url: String,
    pub model: String,
    pub timeout_seconds: u64,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    #[serde(default)]
    pub allow_insecure_http: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub kind: AiProviderKind,
    pub base_url: String,
    pub model: String,
    pub timeout_seconds: u64,
    pub api_key_configured: bool,
    pub api_key_required: bool,
    pub allow_insecure_http: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelOption {
    pub id: String,
    pub streaming: Option<bool>,
    pub tool_calling: Option<bool>,
    pub structured_output: Option<bool>,
}

impl ProviderConfig {
    pub fn view(&self, api_key_configured: bool) -> ProviderView {
        ProviderView {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            timeout_seconds: self.timeout_seconds,
            api_key_configured,
            api_key_required: self.kind == AiProviderKind::OpenAiCompatible,
            allow_insecure_http: self.allow_insecure_http,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContextSourceRequest {
    TerminalSelection {
        text: String,
    },
    TerminalRecentOutput {
        text: String,
    },
    MonitorSnapshot,
    SftpSelectedText {
        remote_path: String,
    },
    EditorSelection {
        document_id: String,
        revision: u64,
        text: String,
    },
    EditorBuffer {
        document_id: String,
        revision: u64,
        dirty: bool,
        text: String,
    },
    DiagnosticEvidenceRefs {
        run_id: String,
        evidence_ids: Vec<String>,
    },
    TunnelRule {
        rule_id: String,
        protocol: AiTunnelProtocol,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreviewRequest {
    pub session_id: String,
    pub provider_id: String,
    pub prompt: String,
    pub sources: Vec<ContextSourceRequest>,
    #[serde(default)]
    pub include_history: bool,
    #[serde(default)]
    pub mode: AiTaskMode,
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
}

fn default_ui_language() -> String {
    "en-US".to_owned()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSourcePreview {
    pub kind: String,
    pub display_label: String,
    pub bytes: usize,
    pub truncated: bool,
    pub redacted: bool,
    pub editor_document_id: Option<String>,
    pub editor_revision: Option<u64>,
    pub editor_dirty: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreview {
    pub snapshot_id: String,
    pub session_id: String,
    pub host_label: String,
    pub host_fingerprint_sha256: String,
    pub provider_destination: String,
    pub provider_model: String,
    pub provider_kind: AiProviderKind,
    pub conversation_history_included: bool,
    pub task_mode: AiTaskMode,
    pub redacted_prompt: String,
    pub prompt_bytes: usize,
    pub prompt_truncated: bool,
    pub prompt_redacted: bool,
    pub sources: Vec<ContextSourcePreview>,
    pub redacted_preview: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiStreamEvent {
    Started {
        request_id: String,
        session_id: String,
    },
    Delta {
        request_id: String,
        session_id: String,
        text: String,
    },
    Usage {
        request_id: String,
        session_id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Completed {
        request_id: String,
        session_id: String,
        finish_reason: Option<String>,
        elapsed_ms: u64,
    },
    Cancelled {
        request_id: String,
        session_id: String,
    },
    Error {
        request_id: String,
        session_id: String,
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAccepted {
    pub request_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub error_code: Option<String>,
    pub model: Option<String>,
    pub elapsed_ms: Option<u128>,
    pub capabilities: Option<ProviderModelOption>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: String,
    pub message: String,
}

impl AiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AiError {}
