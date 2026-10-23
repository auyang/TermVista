import { invoke } from "@tauri-apps/api/core";

export type SshKeyMetadata = {
  id: string;
  alias: string;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  storageKind: string;
  createdAt: number;
  references: number;
};

export function listSshKeys() {
  return invoke<SshKeyMetadata[]>("ssh_keys_list");
}

export function generateSshKey(input: {
  alias: string;
  keyType: "ed25519" | "rsa" | "ecdsaP256";
  rsaBits?: 3072 | 4096;
  passphrase: string;
}) {
  return invoke<SshKeyMetadata>("ssh_key_generate", input);
}

export function importSshKey(input: { path: string; alias: string; passphrase?: string }) {
  return invoke<SshKeyMetadata>("ssh_key_import", input);
}

export function exportSshKey(input: {
  keyId: string;
  path: string;
  currentPassphrase?: string;
  exportPassphrase: string;
}) {
  return invoke<void>("ssh_key_export", input);
}

export function deleteSshKey(keyId: string) {
  return invoke<boolean>("ssh_key_delete", { keyId });
}
