export type AiProviderKind = "openAiCompatible" | "ollama";
export type AiTaskMode = "ask" | "diagnose" | "plan" | "tunnelDiagnose" | "tunnelSuggest";
export type AiTunnelProtocol = "localTcp" | "socks5";

export type AiProviderView = {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  apiKeyConfigured: boolean;
  apiKeyRequired: boolean;
  allowInsecureHttp: boolean;
};

export type AiProviderModelOption = {
  id: string;
  streaming?: boolean;
  toolCalling?: boolean;
  structuredOutput?: boolean;
};

export type AiProviderInput = {
  providerId?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  apiKey?: string;
  clearApiKey?: boolean;
  allowInsecureHttp: boolean;
};

export type AiContextSource =
  | { kind: "terminalSelection"; text: string }
  | { kind: "terminalRecentOutput"; text: string }
  | { kind: "monitorSnapshot" }
  | { kind: "sftpSelectedText"; remotePath: string }
  | { kind: "editorSelection"; documentId: string; revision: number; text: string }
  | { kind: "editorBuffer"; documentId: string; revision: number; dirty: boolean; text: string }
  | { kind: "diagnosticEvidenceRefs"; runId: string; evidenceIds: string[] }
  | { kind: "tunnelRule"; ruleId: string; protocol: AiTunnelProtocol };

export type AiPreviewRequest = {
  sessionId: string;
  providerId: string;
  prompt: string;
  sources: AiContextSource[];
  includeHistory: boolean;
  mode: AiTaskMode;
  uiLanguage: string;
};

export type AiContextSourcePreview = {
  kind: string;
  displayLabel: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
  editorDocumentId?: string;
  editorRevision?: number;
  editorDirty?: boolean;
};

export type AiContextPreview = {
  snapshotId: string;
  sessionId: string;
  hostLabel: string;
  hostFingerprintSha256: string;
  providerDestination: string;
  providerModel: string;
  providerKind: AiProviderKind;
  conversationHistoryIncluded: boolean;
  taskMode: AiTaskMode;
  redactedPrompt: string;
  promptBytes: number;
  promptTruncated: boolean;
  promptRedacted: boolean;
  sources: AiContextSourcePreview[];
  redactedPreview: string;
  expiresAt: string;
};

export type AiStreamEvent =
  | { type: "started"; requestId: string; sessionId: string }
  | { type: "delta"; requestId: string; sessionId: string; text: string }
  | { type: "usage"; requestId: string; sessionId: string; inputTokens?: number; outputTokens?: number }
  | { type: "completed"; requestId: string; sessionId: string; finishReason?: string; elapsedMs: number }
  | { type: "cancelled"; requestId: string; sessionId: string }
  | { type: "error"; requestId: string; sessionId: string; code: string; message: string };

export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "cancelled" | "error";
  errorMessage?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  elapsedMs?: number;
  mode?: AiTaskMode;
  editorBinding?: {
    documentId: string;
    revision: number;
    originalText: string;
    languageId: string;
  };
};

export type AiConnectionTestResult = {
  success: boolean;
  message: string;
  errorCode?: string;
  model?: string;
  elapsedMs?: number;
  capabilities?: AiProviderModelOption;
};
