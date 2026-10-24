import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceTab = {
  id: string;
  title: string;
  mode: "blank" | "demo" | "ssh";
  host?: string;
  profileId?: string;
};

export type AuthMethod = "password" | "privateKey" | "keyboardInteractive";
export type ServerEnvironment = "production" | "test" | "development";

export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  groupId?: string;
  sortOrder?: number;
  authMethod: AuthMethod;
  privateKeyPath: string;
  keyRef?: string;
  jumpProfileId?: string;
  environment: ServerEnvironment;
  favorite: boolean;
  lastConnectedAt?: number;
  autoReconnect: boolean;
  credentialAccounts: string[];
};

export type ConnectionGroup = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
};

export type Layouts = {
  desktop: Record<string, number>;
  center: Record<string, number>;
  workArea: Record<string, number>;
  sftp: Record<string, number>;
  dualSftp: Record<string, number>;
};

const defaultLayouts: Layouts = {
  desktop: { monitor: 20, workspace: 80 },
  center: { main: 71, assistant: 29 },
  workArea: { terminal: 42, sftp: 58 },
  sftp: { tree: 19, files: 81 },
  dualSftp: { local: 42, remote: 58 },
};

type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  profiles: ConnectionProfile[];
  profilesLoadStatus: "loading" | "ready" | "error";
  lastSftpPaths: Record<string, string>;
  managerOpen: boolean;
  managerView: "connections" | "trustedHosts";
  managerEditProfileId: string | null;
  tunnelManagerOpen: boolean;
  tunnelManagerProfileId: string | null;
  aiOpen: boolean;
  monitorCollapsed: boolean;
  sftpCollapsed: boolean;
  sftpMode: "files" | "commands";
  sftpBrowserMode: "remote" | "dual";
  theme: "dark" | "light";
  layouts: Layouts;
  layoutResetCounter: number;
  addBlankTab: () => void;
  addDemoTab: (title?: string, host?: string) => void;
  addSshTab: (id: string, title: string, host: string, profileId: string) => void;
  replaceSshTab: (oldId: string, newId: string, title: string, host: string, profileId: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  addProfile: (profile: Omit<ConnectionProfile, "id">, id?: string) => void;
  updateProfile: (id: string, profile: Omit<ConnectionProfile, "id" | "lastConnectedAt">) => void;
  setProfile: (profile: ConnectionProfile) => void;
  replaceProfiles: (profiles: ConnectionProfile[]) => void;
  setProfilesLoadStatus: (status: WorkspaceState["profilesLoadStatus"]) => void;
  clearRecentConnections: () => void;
  removeProfile: (id: string) => void;
  toggleFavorite: (id: string) => void;
  setAutoReconnect: (id: string, enabled: boolean) => void;
  markProfileConnected: (id: string, timestamp?: number) => void;
  markCredentialSaved: (id: string, username: string) => void;
  clearCredentialAccounts: (id: string) => void;
  setLastSftpPath: (id: string, path: string) => void;
  setManagerOpen: (open: boolean) => void;
  setManagerView: (view: "connections" | "trustedHosts") => void;
  openTunnelManager: (profileId?: string | null) => void;
  setTunnelManagerProfileId: (profileId: string) => void;
  closeTunnelManager: () => void;
  requestManagerProfileEdit: (id: string) => void;
  clearManagerProfileEditRequest: () => void;
  setAiOpen: (open: boolean) => void;
  toggleAi: () => void;
  setMonitorCollapsed: (collapsed: boolean) => void;
  setSftpCollapsed: (collapsed: boolean) => void;
  setSftpMode: (mode: "files" | "commands") => void;
  setSftpBrowserMode: (mode: "remote" | "dual") => void;
  setTheme: (theme: "dark" | "light") => void;
  setLayout: (group: keyof Layouts, layout: Record<string, number>) => void;
  resetLayout: () => void;
  resetTabsForStartup: () => void;
  removeDemoTabs: () => void;
};

const nextId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      profiles: [],
      profilesLoadStatus: "loading",
      lastSftpPaths: {},
      managerOpen: false,
      managerView: "connections",
      managerEditProfileId: null,
      tunnelManagerOpen: false,
      tunnelManagerProfileId: null,
      aiOpen: false,
      monitorCollapsed: false,
      sftpCollapsed: false,
      sftpMode: "files",
      sftpBrowserMode: "remote",
      theme: "light",
      layouts: defaultLayouts,
      layoutResetCounter: 0,
      addBlankTab: () => {
        set((state) => {
          const existing = state.tabs.find((tab) => tab.mode === "blank");
          if (existing) return { activeTabId: existing.id };
          const id = nextId();
          return {
            tabs: [...state.tabs, { id, title: "", mode: "blank" }],
            activeTabId: id,
          };
        });
      },
      addDemoTab: (title = "Web-01", host = "demo-web-01.local") => {
        if (!import.meta.env.DEV) return;
        const id = nextId();
        set((state) => ({
          tabs: [...state.tabs, { id, title, host, mode: "demo" }],
          activeTabId: id,
        }));
      },
      addSshTab: (id, title, host, profileId) =>
        set((state) => ({
          tabs: [...state.tabs, { id, title, host, profileId, mode: "ssh" }],
          activeTabId: id,
        })),
      replaceSshTab: (oldId, newId, title, host, profileId) => set((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === oldId);
        if (index < 0) {
          return {
            tabs: [...state.tabs, { id: newId, title, host, profileId, mode: "ssh" }],
            activeTabId: newId,
          };
        }
        const tabs = state.tabs.slice();
        tabs[index] = { id: newId, title, host, profileId, mode: "ssh" };
        return { tabs, activeTabId: state.activeTabId === oldId ? newId : state.activeTabId };
      }),
      activateTab: (id) => set({ activeTabId: id }),
      closeTab: (id) =>
        set((state) => {
          const closingIndex = state.tabs.findIndex((tab) => tab.id === id);
          const tabs = state.tabs.filter((tab) => tab.id !== id);
          const activeTabId =
            state.activeTabId === id
              ? (tabs[Math.max(0, closingIndex - 1)]?.id ?? tabs[0]?.id ?? null)
              : state.activeTabId;
          return { tabs, activeTabId };
        }),
      closeOtherTabs: (id) =>
        set((state) => ({ tabs: state.tabs.filter((tab) => tab.id === id), activeTabId: id })),
      addProfile: (profile, id = nextId()) =>
        set((state) => ({ profiles: [...state.profiles, { ...profile, id }] })),
      updateProfile: (id, profile) => set((state) => ({
        profiles: state.profiles.map((item) => item.id === id
          ? { ...profile, id, lastConnectedAt: item.lastConnectedAt }
          : item),
      })),
      setProfile: (profile) => set((state) => ({
        profiles: state.profiles.map((item) => item.id === profile.id
          ? { ...profile, lastConnectedAt: profile.lastConnectedAt ?? item.lastConnectedAt }
          : item),
      })),
      replaceProfiles: (profiles) => set({ profiles }),
      setProfilesLoadStatus: (profilesLoadStatus) => set({ profilesLoadStatus }),
      clearRecentConnections: () => set((state) => ({
        profiles: state.profiles.map((profile) => ({ ...profile, lastConnectedAt: undefined })),
      })),
      removeProfile: (id) => set((state) => {
        const lastSftpPaths = { ...state.lastSftpPaths };
        delete lastSftpPaths[id];
        return {
          profiles: state.profiles.filter((profile) => profile.id !== id),
          lastSftpPaths,
        };
      }),
      toggleFavorite: (id) => set((state) => ({
        profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, favorite: !profile.favorite } : profile),
      })),
      setAutoReconnect: (id, enabled) => set((state) => ({
        profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, autoReconnect: enabled } : profile),
      })),
      markProfileConnected: (id, timestamp = Date.now()) => set((state) => ({
        profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, lastConnectedAt: timestamp } : profile),
      })),
      markCredentialSaved: (id, username) => set((state) => ({
        profiles: state.profiles.map((profile) => profile.id === id
          ? { ...profile, credentialAccounts: [...new Set([...profile.credentialAccounts, username])] }
          : profile),
      })),
      clearCredentialAccounts: (id) => set((state) => ({
        profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, credentialAccounts: [] } : profile),
      })),
      setLastSftpPath: (id, path) => set((state) => ({ lastSftpPaths: { ...state.lastSftpPaths, [id]: path } })),
      setManagerOpen: (managerOpen) => set({ managerOpen }),
      setManagerView: (managerView) => set({ managerView }),
      openTunnelManager: (tunnelManagerProfileId = null) => set({
        managerOpen: false,
        tunnelManagerOpen: true,
        tunnelManagerProfileId,
      }),
      setTunnelManagerProfileId: (tunnelManagerProfileId) => set({ tunnelManagerProfileId }),
      closeTunnelManager: () => set({ tunnelManagerOpen: false, tunnelManagerProfileId: null }),
      requestManagerProfileEdit: (id) => set({ managerEditProfileId: id, managerOpen: true, managerView: "connections" }),
      clearManagerProfileEditRequest: () => set({ managerEditProfileId: null }),
      setAiOpen: (aiOpen) => set({ aiOpen }),
      toggleAi: () => set((state) => ({ aiOpen: !state.aiOpen })),
      setMonitorCollapsed: (monitorCollapsed) => set({ monitorCollapsed }),
      setSftpCollapsed: (sftpCollapsed) => set({ sftpCollapsed }),
      setSftpMode: (sftpMode) => set({ sftpMode }),
      setSftpBrowserMode: (sftpBrowserMode) => set({ sftpBrowserMode }),
      setTheme: (theme) => set({ theme }),
      setLayout: (group, layout) =>
        set((state) => ({ layouts: { ...state.layouts, [group]: layout } })),
      resetLayout: () =>
        set((state) => ({
          layouts: defaultLayouts,
          aiOpen: false,
          monitorCollapsed: false,
          sftpCollapsed: false,
          layoutResetCounter: state.layoutResetCounter + 1,
        })),
      resetTabsForStartup: () => set({ tabs: [], activeTabId: null }),
      removeDemoTabs: () => set((state) => {
        const tabs = state.tabs.filter((tab) => tab.mode !== "demo");
        return {
          tabs,
          activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0]?.id ?? null,
        };
      }),
    }),
    {
      name: "ai-ssh-studio.ui.v1",
      version: 5,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<WorkspaceState>;
        const profiles = (state.profiles ?? []).map((profile) => {
          const legacyProfile = profile as Partial<ConnectionProfile>;
          return {
            ...legacyProfile,
            authMethod: legacyProfile.authMethod ?? "password",
            privateKeyPath: legacyProfile.privateKeyPath ?? "",
            environment: legacyProfile.environment ?? "development",
            favorite: legacyProfile.favorite ?? false,
            autoReconnect: legacyProfile.autoReconnect ?? false,
            credentialAccounts: legacyProfile.credentialAccounts ?? [],
          } as ConnectionProfile;
        });
        const tabs = (state.tabs ?? []).filter((tab) => tab.mode !== "demo");
        const defaultState = version < 2
          ? { theme: "light" as const, layouts: defaultLayouts }
          : {};
        const layouts = state.layouts as Partial<Layouts> | undefined;
        return {
          ...state,
          ...defaultState,
          layouts: { ...defaultLayouts, ...layouts, dualSftp: layouts?.dualSftp ?? defaultLayouts.dualSftp },
          tabs,
          activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0]?.id ?? null,
          profiles,
          lastSftpPaths: state.lastSftpPaths ?? {},
          sftpBrowserMode: state.sftpBrowserMode ?? "remote",
          managerOpen: false,
          managerView: "connections" as const,
          aiOpen: false,
        } as WorkspaceState;
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs.filter((tab) => tab.mode !== "demo" && (tab.mode !== "ssh" || state.profiles.some((profile) => profile.id === tab.profileId))),
        activeTabId: state.tabs.some((tab) => tab.id === state.activeTabId && tab.mode !== "demo" && (tab.mode !== "ssh" || state.profiles.some((profile) => profile.id === tab.profileId)))
          ? state.activeTabId
          : state.tabs.find((tab) => tab.mode !== "demo" && (tab.mode !== "ssh" || state.profiles.some((profile) => profile.id === tab.profileId)))?.id ?? null,
        profiles: state.profiles,
        lastSftpPaths: state.lastSftpPaths,
        monitorCollapsed: state.monitorCollapsed,
        sftpCollapsed: state.sftpCollapsed,
        sftpMode: state.sftpMode,
        sftpBrowserMode: state.sftpBrowserMode,
        theme: state.theme,
        layouts: state.layouts,
      }),
    },
  ),
);
