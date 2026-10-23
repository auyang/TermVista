import { Channel, invoke } from "@tauri-apps/api/core";

export type RemoteEntryKind = "file" | "directory" | "symlink" | "other";
export type LocalEntry = {
  relativePath: string;
  name: string;
  kind: RemoteEntryKind;
  sizeBytes: number | null;
  modifiedAtEpochMs: number | null;
};
export type LocalRootGrant = { grantId: string; currentPath: string };
export type GrantedLocalFile = { grantId: string; relativePath: string; name: string };

export type RemoteEntry = {
  path: string;
  name: string;
  kind: RemoteEntryKind;
  sizeBytes: number | null;
  modifiedAtEpochMs: number | null;
  permissions: string | null;
  uid: number | null;
  gid: number | null;
  ownerLabel: string | null;
  groupLabel: string | null;
};

export type SftpStatus = {
  sessionId: string;
  state: string;
  message: string | null;
};

export type DeleteConfirmation = {
  operationId: string;
  serverName: string;
  path: string;
  kind: RemoteEntryKind;
  affectedCount: number;
};

export type SftpOpenResult = { currentPath: string };

export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "awaitingConflict" | "running" | "completed" | "failed" | "canceled" | "skipped";
export type ConflictPolicy = "overwrite" | "skip" | "rename";

export type TransferProgress = {
  transferId: string;
  sessionId: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  bytesDone: number;
  bytesTotal: number | null;
  speedBytesPerSec: number | null;
  status: TransferStatus;
  error: string | null;
  conflictPath: string | null;
  warning: string | null;
};

export function openSftp(sessionId: string, onStatus: Channel<SftpStatus>) {
  return invoke<SftpOpenResult>("sftp_open", { sessionId, onStatus });
}

export function closeSftp(sessionId: string) {
  return invoke<void>("sftp_close", { sessionId });
}

export function listSftpDirectory(sessionId: string, path: string) {
  return invoke<RemoteEntry[]>("sftp_list_dir", { sessionId, path });
}

export function statSftpPath(sessionId: string, path: string) {
  return invoke<RemoteEntry>("sftp_stat", { sessionId, path });
}

export function grantLocalSftpRoot(sessionId: string, path: string) {
  return invoke<LocalRootGrant>("sftp_local_grant_root", { sessionId, path });
}

export function listLocalSftpDirectory(sessionId: string, grantId: string, relativePath: string) {
  return invoke<LocalEntry[]>("sftp_local_list_dir", { sessionId, grantId, relativePath });
}

export function grantLocalSftpFiles(sessionId: string, paths: string[]) {
  return invoke<GrantedLocalFile[]>("sftp_local_grant_files", { sessionId, paths });
}

export function readSftpClipboardFiles() {
  return invoke<string[]>("sftp_clipboard_file_paths");
}

export function createSftpDirectory(sessionId: string, parent: string, name: string) {
  return invoke<void>("sftp_mkdir", { sessionId, parent, name });
}

export function renameSftpPath(sessionId: string, path: string, newName: string) {
  return invoke<string>("sftp_rename", { sessionId, path, newName });
}

export function prepareSftpDelete(sessionId: string, path: string) {
  return invoke<DeleteConfirmation>("sftp_prepare_delete", { sessionId, path });
}

export function deleteSftpPath(sessionId: string, operationId: string) {
  return invoke<void>("sftp_delete", { sessionId, operationId });
}

export function startSftpTransfers(
  sessionId: string,
  direction: TransferDirection,
  localGrantId: string,
  sourcePaths: string[],
  destinationDirectory: string,
  onProgress: Channel<TransferProgress>,
) {
  return invoke<string[]>("sftp_transfer_start", { sessionId, direction, localGrantId, sourcePaths, destinationDirectory, onProgress });
}

export function resolveSftpTransferConflict(transferId: string, policy: ConflictPolicy, applyToQueue = false) {
  return invoke<void>("sftp_transfer_resolve", { transferId, policy, applyToQueue });
}

export function cancelSftpTransfer(transferId: string) {
  return invoke<void>("sftp_transfer_cancel", { transferId });
}

export function retrySftpTransfer(transferId: string, onProgress: Channel<TransferProgress>) {
  return invoke<string[]>("sftp_transfer_retry", { transferId, onProgress });
}

export function listSftpTransfers(sessionId: string) {
  return invoke<TransferProgress[]>("sftp_transfer_list", { sessionId });
}

export function clearCompletedSftpTransfers(sessionId: string) {
  return invoke<void>("sftp_transfer_clear_completed", { sessionId });
}
