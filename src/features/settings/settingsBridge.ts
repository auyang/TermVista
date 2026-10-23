import { invoke } from "@tauri-apps/api/core";

export type SettingsSection = "general" | "terminal" | "connections" | "sftp" | "monitoring" | "aiPrivacy" | "appearance";
export type WritableSettingsSection = "general" | "terminal" | "connections" | "monitoring" | "appearance";

export type PublicSettings = {
  schemaVersion: number;
  revision: number;
  general: {
    restoreLastTabs: boolean;
    autoConnectSavedHosts: boolean;
    rememberRecentConnections: boolean;
    autoCheckUpdates: boolean;
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    cursorStyle: "block" | "underline" | "bar";
    cursorBlink: boolean;
    colorScheme: "follow" | "dark";
    scrollback: number;
    pastePreview: boolean;
  };
  connections: {
    autoReconnectEnabled: boolean;
  };
  monitoring: {
    enabled: boolean;
  };
  appearance: {
    themeMode: "system" | "light" | "dark";
    showMonitorSidebar: boolean;
    aiPanelOpenByDefault: boolean;
  };
};

export type AppMetadata = {
  name: string;
  nameZh: string;
  version: string;
  platform: string;
  arch: string;
  channel: string | null;
  buildHash: string | null;
  updaterConfigured: boolean;
  updaterConfigReason: string;
};

export type SanitizedDiagnosticInfo = {
  name: string;
  version: string;
  platform: string;
  arch: string;
  updaterConfigured: boolean;
};

export const defaultSettings: PublicSettings = {
  schemaVersion: 1,
  revision: 0,
  general: {
    restoreLastTabs: true,
    autoConnectSavedHosts: false,
    rememberRecentConnections: true,
    autoCheckUpdates: true,
  },
  terminal: {
    fontFamily: "Menlo, Monaco, 'SFMono-Regular', monospace",
    fontSize: 14,
    lineHeight: 1.25,
    cursorStyle: "block",
    cursorBlink: true,
    colorScheme: "follow",
    scrollback: 5000,
    pastePreview: true,
  },
  connections: { autoReconnectEnabled: false },
  monitoring: { enabled: true },
  appearance: {
    themeMode: "system",
    showMonitorSidebar: true,
    aiPanelOpenByDefault: false,
  },
};

export function getSettings() {
  return invoke<PublicSettings>("settings_get");
}

export function patchSettings<T extends WritableSettingsSection>(
  section: T,
  patch: Partial<PublicSettings[T]>,
  expectedRevision: number,
) {
  return invoke<PublicSettings>("settings_patch", { section, patch, expectedRevision });
}

export function getAppMetadata() {
  return invoke<AppMetadata>("app_metadata_get");
}

export function getSanitizedDiagnostics() {
  return invoke<SanitizedDiagnosticInfo>("app_diagnostics_copyable");
}
