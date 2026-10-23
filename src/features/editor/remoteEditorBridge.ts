import { invoke } from "@tauri-apps/api/core";

export type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "unknown";
export type LineEnding = "lf" | "crlf" | "cr" | "mixed";

export type RemoteDocument = {
  documentId: string;
  connectionId: string;
  sessionId: string;
  canonicalPath: string;
  displayName: string;
  text: string | null;
  sha256: string | null;
  sizeBytes: number;
  modifiedAtSec: number | null;
  permissions: number | null;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  readOnly: boolean;
  readOnlyReason: string | null;
  sensitive: boolean;
  previewOnly: boolean;
};

export type SaveStatus = "saved" | "conflict" | "unsupported";
export type RemoteSaveResult = {
  status: SaveStatus;
  documentId: string;
  requestId: string;
  canonicalPath: string;
  newSha256: string | null;
  currentSha256: string | null;
  sizeBytes: number | null;
  verified: boolean;
  durableWrite: boolean;
  message: string | null;
};

export type EditorError = {
  code: string;
  message: string;
  draftRetained: boolean;
};

export type EditorCompareResult = {
  canonicalPath: string;
  sha256: string;
  sizeBytes: number;
  modifiedAtSec: number | null;
  text: string | null;
  encoding: TextEncoding;
  lineEnding: LineEnding;
};

export type SaveCapabilities = {
  safeReplaceExisting: boolean;
  safeCreateNew: boolean;
  fsync: boolean;
  note: string;
};

export function openRemoteDocument(sessionId: string, remotePath: string, allowLarge = false) {
  return invoke<RemoteDocument>("editor_open", { sessionId, remotePath, allowLarge });
}

export function getEditorSaveCapabilities(sessionId: string) {
  return invoke<SaveCapabilities>("editor_save_capabilities", { sessionId });
}

export function saveRemoteDocument(
  documentId: string,
  expectedSha256: string,
  newText: string,
  confirmSensitive: boolean,
) {
  return invoke<RemoteSaveResult>("editor_save", {
    documentId,
    expectedSha256,
    newText,
    requestId: crypto.randomUUID(),
    confirmSensitive,
  });
}

export function saveRemoteDocumentAs(
  documentId: string,
  expectedSha256: string,
  newPath: string,
  newText: string,
  confirmSensitive: boolean,
) {
  return invoke<RemoteSaveResult>("editor_save_as", {
    documentId,
    expectedSha256,
    newPath,
    newText,
    requestId: crypto.randomUUID(),
    confirmSensitive,
  });
}

export function compareRemoteDocument(documentId: string) {
  return invoke<EditorCompareResult>("editor_compare", { documentId });
}

export function reloadRemoteDocument(documentId: string) {
  return invoke<RemoteDocument>("editor_reload", { documentId });
}

export function rebindRemoteDocument(documentId: string, newSessionId: string) {
  return invoke<RemoteDocument>("editor_rebind", { documentId, newSessionId });
}

export function closeRemoteDocument(documentId: string) {
  return invoke<void>("editor_close", { documentId });
}
