export type AiProviderKind = "openAiCompatible" | "ollama";

export type AiProviderView = {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  apiKeyConfigured: boolean;
  allowInsecureHttp: boolean;
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
  | { kind: "monitorSnapshot" }
  | { kind: "sftpSelectedText"; remotePath: string };

export type AiPreviewRequest = {
  sessionId: string;
  providerId: string;
  prompt: string;
  sources: AiContextSource[];
};

export type AiContextSourcePreview = {
  kind: string;
  displayLabel: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
};

export type AiContextPreview = {
  snapshotId: string;
  sessionId: string;
  hostLabel: string;
  providerDestination: string;
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
  | { type: "completed"; requestId: string; sessionId: string; finishReason?: string }
  | { type: "cancelled"; requestId: string; sessionId: string }
  | { type: "error"; requestId: string; sessionId: string; code: string; message: string };

export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "cancelled" | "error";
  errorMessage?: string;
};

export type AiConnectionTestResult = {
  success: boolean;
  message: string;
  model?: string;
  elapsedMs?: number;
};
