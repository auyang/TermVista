import i18next from "@/i18n";

const sshErrorCodes = new Set([
  "HostKeyUnknown", "HostKeyMismatch", "HostKeyRejected", "CredentialMissing",
  "CredentialStoreUnavailable", "AuthFailed", "AuthPromptTimeout", "PrivateKeyInvalid",
  "DnsResolutionFailed", "ConnectionTimeout", "ConnectionRefused", "ConnectionFailed",
  "ServerClosed", "ChannelOpenFailed", "PtyRequestFailed", "ShellRequestFailed",
  "SessionNotFound", "SessionClosed", "Canceled", "InputTooLarge", "Internal",
]);

export function localizedSshError(code?: string) {
  const key = code && sshErrorCodes.has(code) ? `sshErrors.${code[0]?.toLowerCase()}${code.slice(1)}` : "sshErrors.unknown";
  return String(i18next.t(key as never, { ns: "connections" }));
}

export function sshErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "ConnectionFailed";
}
