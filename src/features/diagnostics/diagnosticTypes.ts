export type DiagnosticTemplateId =
  | "nginx502"
  | "serviceFailed"
  | "diskLow"
  | "highCpu"
  | "portUnbound"
  | "currentHost";

export type DiagnosticMetricId = "cpu" | "memory" | "disk" | "processes" | "network";

export type DiagnosticSelectedContext =
  | { kind: "terminalSelection"; text: string }
  | { kind: "sftpFile"; remotePath: string }
  | { kind: "monitorMetric"; metric: DiagnosticMetricId };

export type DiagnosticPlanCreateRequest = {
  sessionId: string;
  templateId: DiagnosticTemplateId;
  serviceName?: string;
  port?: number;
  selectedContext?: DiagnosticSelectedContext;
};

export type DiagnosticTemplateDescriptor = {
  id: DiagnosticTemplateId;
  title: string;
  description: string;
  requiresService: boolean;
  requiresPort: boolean;
};

export type DiagnosticStepPreview = {
  stepId: string;
  toolId: string;
  title: string;
  why: string;
  readScope: string;
  maxOutputBytes: number;
  sensitiveData: string;
  enabled: boolean;
};

export type DiagnosticPlanPreview = {
  planId: string;
  revision: number;
  planHash: string;
  sessionId: string;
  host: string;
  port: number;
  username: string;
  fingerprintSha256: string;
  templateId: DiagnosticTemplateId;
  why: string;
  createdAt: string;
  expiresAt: string;
  steps: DiagnosticStepPreview[];
  contextSummary?: string;
};

export type DiagnosticPlanReviseRequest = {
  planId: string;
  revision: number;
  selectedStepIds: string[];
};

export type DiagnosticGrantSummary = {
  grantId: string;
  planId: string;
  revision: number;
  expiresAt: string;
  allowedSteps: number;
};

export type DiagnosticRunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type DiagnosticStepStatus = "running" | "success" | "unsupported" | "permissionDenied" | "timeout" | "cancelled" | "notRun" | "error";

export type DiagnosticEvidencePreview = {
  evidenceId: string;
  toolId: string;
  status: DiagnosticStepStatus;
  source: string;
  collectedAt: string;
  commandTemplate?: string;
  exitStatus?: number;
  elapsedMs: number;
  originalBytes: number;
  truncated: boolean;
  safePreview: string;
};

export type DiagnosticRunSummary = {
  runId: string;
  sessionId: string;
  host: string;
  port: number;
  username: string;
  fingerprintSha256: string;
  status: DiagnosticRunStatus;
  createdAt: string;
  evidence: DiagnosticEvidencePreview[];
};

export type DiagnosticReportPreview = {
  previewId: string;
  runId: string;
  sessionId: string;
  host: string;
  fingerprintSha256: string;
  providerDestination: string;
  providerModel: string;
  providerId: string;
  evidence: DiagnosticEvidencePreview[];
  previewHash: string;
  redactedContent: string;
  contentTruncated: boolean;
  expiresAt: string;
};

export type DiagnosticShareGrantSummary = {
  shareGrantId: string;
  runId: string;
  expiresAt: string;
  providerId: string;
  evidenceCount: number;
};

export type DiagnosticEvent =
  | { type: "run_status"; runId: string; sessionId: string; status: DiagnosticRunStatus; message?: string }
  | { type: "step_started"; runId: string; sessionId: string; stepId: string; toolId: string }
  | { type: "step_finished"; runId: string; sessionId: string; stepId: string; toolId: string; status: DiagnosticStepStatus; elapsedMs: number; evidenceId?: string; message?: string }
  | { type: "evidence_ready"; runId: string; sessionId: string; evidenceIds: string[] };

export type DiagnosticError = { code: string; message: string };
