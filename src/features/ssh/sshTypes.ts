export type SshState =
  | "connecting"
  | "verifyingHostKey"
  | "authenticating"
  | "openingPty"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "canceled"
  | "error";

export type SshErrorDetails =
  | {
      kind: "hostKeyChanged";
      host: string;
      port: number;
      keyType: string;
      priorFingerprint: string;
      currentFingerprint: string;
    };

export type SshError = { code: string; message: string; details?: SshErrorDetails };

export type SshStatusEvent = {
  attemptId: string;
  sessionId?: string;
  state: SshState;
  error?: SshError;
};

export type HostKeyChallenge = {
  attemptId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  priorFingerprint?: string | null;
};

export type AuthPromptEvent = {
  attemptId: string;
  promptId: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};

export type SshAuth =
  | { method: "password"; password: string }
  | { method: "keyboardInteractive" }
  | { method: "privateKey"; privateKeyPath: string; keyRef?: string; passphrase?: string };

export type SshConnectArgs = {
  attemptId: string;
  profileId: string;
  host: string;
  port: number;
  username: string;
  jumpSessionId?: string;
  auth: SshAuth;
  rememberCredential: boolean;
  initialSize: { cols: number; rows: number };
  onData: Channel<ArrayBuffer>;
  onStatus: Channel<SshStatusEvent>;
  onHostKey: Channel<HostKeyChallenge>;
  onAuthPrompt: Channel<AuthPromptEvent>;
};

export type SavedAuthMethod = "password" | "privateKey" | "keyboardInteractive";
export type SavedCredentialKind = "password" | "privateKeyPassphrase";
export type SavedCredentialStatus = "saved" | "missing" | "unavailable";
export type SshConnectResult = {
  sessionId: string;
  credentialSaved: boolean;
  credentialWarning?: string | null;
  profileWarning?: string | null;
};

import type { Channel } from "@tauri-apps/api/core";
