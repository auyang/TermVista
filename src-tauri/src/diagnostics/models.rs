use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticTemplateId {
    Nginx502,
    ServiceFailed,
    DiskLow,
    HighCpu,
    PortUnbound,
    CurrentHost,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticMetricId {
    Cpu,
    Memory,
    Disk,
    Processes,
    Network,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiagnosticSelectedContext {
    TerminalSelection { text: String },
    SftpFile { remote_path: String },
    MonitorMetric { metric: DiagnosticMetricId },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPlanCreateRequest {
    pub session_id: String,
    pub template_id: DiagnosticTemplateId,
    pub service_name: Option<String>,
    pub port: Option<u16>,
    pub selected_context: Option<DiagnosticSelectedContext>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticTemplateDescriptor {
    pub id: DiagnosticTemplateId,
    pub title: String,
    pub description: String,
    pub requires_service: bool,
    pub requires_port: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPlanPreview {
    pub plan_id: String,
    pub revision: u32,
    pub plan_hash: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub fingerprint_sha256: String,
    pub template_id: DiagnosticTemplateId,
    pub why: String,
    pub created_at: String,
    pub expires_at: String,
    pub steps: Vec<DiagnosticStepPreview>,
    pub context_summary: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStepPreview {
    pub step_id: String,
    pub tool_id: String,
    pub title: String,
    pub why: String,
    pub read_scope: String,
    pub max_output_bytes: usize,
    pub sensitive_data: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPlanReviseRequest {
    pub plan_id: String,
    pub revision: u32,
    pub selected_step_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPlanApproveRequest {
    pub plan_id: String,
    pub revision: u32,
    pub displayed_hash: String,
    pub selected_step_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticGrantSummary {
    pub grant_id: String,
    pub plan_id: String,
    pub revision: u32,
    pub expires_at: String,
    pub allowed_steps: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticRunStatus {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStepStatus {
    Running,
    Success,
    Unsupported,
    PermissionDenied,
    Timeout,
    Cancelled,
    NotRun,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRunSummary {
    pub run_id: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub fingerprint_sha256: String,
    pub status: DiagnosticRunStatus,
    pub created_at: String,
    pub evidence: Vec<DiagnosticEvidencePreview>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvidencePreview {
    pub evidence_id: String,
    pub tool_id: String,
    pub status: DiagnosticStepStatus,
    pub source: String,
    pub collected_at: String,
    pub command_template: Option<String>,
    pub exit_status: Option<u32>,
    pub elapsed_ms: u128,
    pub original_bytes: usize,
    pub truncated: bool,
    pub safe_preview: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DiagnosticEvent {
    RunStatus {
        run_id: String,
        session_id: String,
        status: DiagnosticRunStatus,
        message: Option<String>,
    },
    StepStarted {
        run_id: String,
        session_id: String,
        step_id: String,
        tool_id: String,
    },
    StepFinished {
        run_id: String,
        session_id: String,
        step_id: String,
        tool_id: String,
        status: DiagnosticStepStatus,
        elapsed_ms: u128,
        evidence_id: Option<String>,
        message: Option<String>,
    },
    EvidenceReady {
        run_id: String,
        session_id: String,
        evidence_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticShareEvidence {
    pub evidence_id: String,
    pub tool_id: String,
    pub status: DiagnosticStepStatus,
    pub source: String,
    pub collected_at: String,
    pub command_template: Option<String>,
    pub exit_status: Option<u32>,
    pub elapsed_ms: u128,
    pub redacted: bool,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticShareData {
    pub run_id: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub fingerprint_sha256: String,
    pub evidence: Vec<DiagnosticShareEvidence>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticShareApproveRequest {
    pub preview_id: String,
    pub run_id: String,
    pub evidence_ids: Vec<String>,
    pub preview_hash: String,
    pub provider_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticShareGrantSummary {
    pub share_grant_id: String,
    pub run_id: String,
    pub expires_at: String,
    pub provider_id: String,
    pub evidence_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReportPreview {
    pub preview_id: String,
    pub run_id: String,
    pub session_id: String,
    pub host: String,
    pub fingerprint_sha256: String,
    pub provider_destination: String,
    pub provider_model: String,
    pub provider_id: String,
    pub evidence: Vec<DiagnosticEvidencePreview>,
    pub preview_hash: String,
    pub redacted_content: String,
    pub content_truncated: bool,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReportGrantSummary {
    pub share_grant_id: String,
    pub run_id: String,
    pub provider_id: String,
    pub evidence_count: usize,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticError {
    pub code: String,
    pub message: String,
}

impl DiagnosticError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}
