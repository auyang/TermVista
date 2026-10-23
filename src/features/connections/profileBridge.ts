import { invoke, isTauri } from "@tauri-apps/api/core";
import { useWorkspaceStore, type ConnectionGroup, type ConnectionProfile } from "@/stores/workspaceStore";

export type SshConfigPreviewEntry = {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile: string | null;
  identitiesOnly: boolean | null;
  proxyJump: string | null;
  importable: boolean;
  warnings: string[];
};

export type SshConfigPreview = {
  sourcePath: string;
  entries: SshConfigPreviewEntry[];
  warnings: string[];
};

export type SshConfigImportResult = {
  imported: string[];
  skippedExistingNames: string[];
};

export function createProfileId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadConnectionProfiles(legacyProfiles: ConnectionProfile[]) {
  if (!isTauri()) return legacyProfiles;
  return invoke<ConnectionProfile[]>("connection_profiles_bootstrap", { legacyProfiles });
}

export async function bootstrapWorkspaceProfiles() {
  const store = useWorkspaceStore.getState();
  store.setProfilesLoadStatus("loading");
  try {
    const profiles = await loadConnectionProfiles(store.profiles);
    useWorkspaceStore.getState().replaceProfiles(profiles);
    useWorkspaceStore.getState().setProfilesLoadStatus("ready");
    return profiles;
  } catch (error) {
    useWorkspaceStore.getState().setProfilesLoadStatus("error");
    throw error;
  }
}

export async function refreshConnectionProfiles() {
  if (!isTauri()) return null;
  return invoke<ConnectionProfile[]>("connection_profiles_list");
}

export async function saveConnectionProfile(profile: ConnectionProfile) {
  if (!isTauri()) return;
  await invoke("connection_profile_save", { profile });
}

export async function deleteConnectionProfile(profileId: string) {
  if (!isTauri()) return true;
  return invoke<boolean>("connection_profile_delete", { profileId });
}

export async function clearRecentConnections() {
  if (!isTauri()) return 0;
  return invoke<number>("connection_profiles_clear_recent");
}

export async function loadConnectionGroups() {
  if (!isTauri()) return [] as ConnectionGroup[];
  return invoke<ConnectionGroup[]>("connection_groups_list");
}

export async function createConnectionGroup(name: string, parentId: string | null) {
  return invoke<ConnectionGroup>("connection_group_create", { name, parentId });
}

export async function renameConnectionGroup(groupId: string, name: string) {
  return invoke<void>("connection_group_rename", { groupId, name });
}

export async function moveConnectionGroup(groupId: string, parentId: string | null, sortOrder: number) {
  return invoke<void>("connection_group_move", { groupId, parentId, sortOrder });
}

export async function deleteConnectionGroup(groupId: string) {
  return invoke<boolean>("connection_group_delete", { groupId });
}

export async function moveConnectionProfile(profileId: string, groupId: string | null, sortOrder: number) {
  return invoke<void>("connection_profile_move", { profileId, groupId, sortOrder });
}

export async function previewSshConfig(path: string) {
  return invoke<SshConfigPreview>("ssh_config_preview", { path });
}

export async function importSshConfig(path: string, aliases: string[]) {
  return invoke<SshConfigImportResult>("ssh_config_import", { path, aliases });
}

export function isNativeProfileStore() {
  return isTauri();
}
