import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionManagerDialog } from "@/features/connections/ConnectionManagerDialog";
import { CommandPalette } from "@/features/workspace/CommandPalette";
import { DesktopWorkspace } from "@/features/workspace/DesktopWorkspace";
import { StatusBar } from "@/features/workspace/StatusBar";
import { HostKeyDialog, HostKeyMismatchDialog, SshAuthPromptDialog, SshCredentialsDialog } from "@/features/ssh/SshDialogs";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { bootstrapWorkspaceProfiles } from "@/features/connections/profileBridge";
import { toast, Toaster } from "sonner";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { connectProfile } from "@/features/ssh/sshBridge";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useEditorStore } from "@/features/editor/editorStore";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getAppMetadata } from "@/features/settings/settingsBridge";
import { checkForUpdate } from "@/features/updater/updaterBridge";
import { updaterErrorCode } from "@/features/updater/updaterErrors";
import { useUpdaterStore } from "@/features/updater/updaterStore";
import { applyLanguagePreference } from "@/i18n";
import { useTranslation } from "react-i18next";

function legacyWorkspaceTheme(): "light" | "dark" | null {
  try {
    const raw = localStorage.getItem("ai-ssh-studio.ui.v1");
    if (!raw) return null;
    const theme = JSON.parse(raw)?.state?.theme;
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

function closeApplicationWindow() {
  return navigator.platform.toLowerCase().startsWith("mac")
    ? invoke<void>("application_exit")
    : getCurrentWindow().close();
}

export function AppShell() {
  const { t: tw } = useTranslation("workspace");
  const { t: tu } = useTranslation("updater");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingEditorClose, setPendingEditorClose] = useState(false);
  const [startupReady, setStartupReady] = useState(false);
  const [localeReady, setLocaleReady] = useState(false);
  const allowEditorWindowClose = useRef(false);
  const startupUpdateCheckStarted = useRef(false);
  const dirtyEditorIds = useEditorStore(useShallow((state) =>
    state.documents.filter((document) => document.dirty).map((document) => document.documentId),
  ));
  const dirtyEditorDocuments = useMemo(() => {
    const byId = new Map(useEditorStore.getState().documents.map((document) => [document.documentId, document]));
    return dirtyEditorIds.map((id) => byId.get(id)).filter((document) => document != null);
  }, [dirtyEditorIds]);
  const theme = useWorkspaceStore((state) => state.theme);
  const addBlankTab = useWorkspaceStore((state) => state.addBlankTab);
  const resetTabsForStartup = useWorkspaceStore((state) => state.resetTabsForStartup);
  const removeDemoTabs = useWorkspaceStore((state) => state.removeDemoTabs);
  const setMonitorCollapsed = useWorkspaceStore((state) => state.setMonitorCollapsed);
  const setAiOpen = useWorkspaceStore((state) => state.setAiOpen);
  const toggleAi = useWorkspaceStore((state) => state.toggleAi);
  const themeMode = useSettingsStore((state) => state.settings.appearance.themeMode);
  const languagePreference = useSettingsStore((state) => state.settings.appearance.languagePreference);
  const showMonitorSidebar = useSettingsStore((state) => state.settings.appearance.showMonitorSidebar);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      let startupSettings = null;
      try {
        startupSettings = await useSettingsStore.getState().load();
      } catch {
        // Settings errors remain visible in the settings dialog; use safe defaults for this launch.
      }
      if (canceled) return;
      try {
        await applyLanguagePreference(startupSettings?.appearance.languagePreference ?? "system");
      } catch {
        await applyLanguagePreference("system");
      }
      if (canceled) return;
      setLocaleReady(true);
      if (startupSettings) {
        const oldTheme = legacyWorkspaceTheme();
        if (startupSettings.revision === 0 && oldTheme) {
          try {
            startupSettings = await useSettingsStore.getState().update("appearance", { themeMode: oldTheme });
          } catch {
            // 保留旧主题迁移失败前已读取的偏好。
          }
        }
      }
      if (!import.meta.env.DEV && useWorkspaceStore.getState().tabs.some((tab) => tab.mode === "demo")) {
        removeDemoTabs();
      }
      if (startupSettings && !startupSettings.general.restoreLastTabs) resetTabsForStartup();
      setAiOpen(startupSettings?.appearance.aiPanelOpenByDefault ?? false);
      setMonitorCollapsed(!(startupSettings?.appearance.showMonitorSidebar ?? true));
      addBlankTab();
      try {
        const profiles = await bootstrapWorkspaceProfiles();
        if (canceled) return;
        setStartupReady(true);
        if (!startupSettings?.general.autoConnectSavedHosts) return;
        const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
        const restoredTabs = useWorkspaceStore.getState().tabs.filter((tab) => tab.mode === "ssh" && tab.profileId);
        for (const tab of restoredTabs) {
          if (canceled) return;
          const profile = tab.profileId ? profileById.get(tab.profileId) : undefined;
          if (!profile) continue;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          const result = await connectProfile(profile, tab.id);
          const authenticationPrompt = useSshSessionStore.getState();
          if (!result && (authenticationPrompt.connectingProfile || authenticationPrompt.hostKeyChallenges.length > 0)) break;
        }
      } catch {
        // Connection profiles report their own visible loading and error states.
      } finally {
        if (!canceled) setStartupReady(true);
      }
    })();
    return () => { canceled = true; };
  }, [addBlankTab, resetTabsForStartup, removeDemoTabs, setAiOpen, setMonitorCollapsed]);

  useEffect(() => {
    if (!localeReady || languagePreference !== "system") return;
    const syncSystemLanguage = () => { void applyLanguagePreference("system"); };
    window.addEventListener("focus", syncSystemLanguage);
    window.addEventListener("languagechange", syncSystemLanguage);
    return () => {
      window.removeEventListener("focus", syncSystemLanguage);
      window.removeEventListener("languagechange", syncSystemLanguage);
    };
  }, [languagePreference, localeReady]);

  useEffect(() => {
    if (!startupReady || !useSettingsStore.getState().loaded || startupUpdateCheckStarted.current) return;
    startupUpdateCheckStarted.current = true;
    if (!isTauri() || !useSettingsStore.getState().settings.general.autoCheckUpdates) return;
    let canceled = false;
    void (async () => {
      try {
        const metadata = await getAppMetadata();
        if (canceled || !metadata.updaterConfigured) return;
        useUpdaterStore.getState().setState({ phase: "checking", error: null, message: null });
        const update = await checkForUpdate(metadata.platform, metadata.arch);
        if (canceled) return;
        if (update) {
          useUpdaterStore.getState().setState({ phase: "available", update, error: null });
          toast.info(tu("noticeTitle"), {
            description: tu("noticeDescription", { version: update.version }),
            duration: 7000,
          });
        } else {
          useUpdaterStore.getState().setState({ phase: "upToDate", update: null, error: null });
        }
      } catch (error) {
        // 启动检查保持非阻断；用户可在“关于 TermVista”手动重试。
        useUpdaterStore.getState().setState({ phase: "error", error: updaterErrorCode(error) });
      }
    })();
    return () => { canceled = true; };
  }, [startupReady, tu]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => useWorkspaceStore.getState().setTheme(themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode);
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (allowEditorWindowClose.current) return;
      if (useEditorStore.getState().documents.some((document) => document.dirty)) {
        event.preventDefault();
        setPendingEditorClose(true);
        return;
      }
      if (navigator.platform.toLowerCase().startsWith("mac")) {
        event.preventDefault();
        void closeApplicationWindow().catch(() => undefined);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Radix 弹窗通过 Portal 挂到 document.body，主题必须应用到全局根节点。
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    setMonitorCollapsed(!showMonitorSidebar);
  }, [showMonitorSidebar, setMonitorCollapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(event.metaKey || event.ctrlKey)) return;
      const element = target instanceof HTMLElement ? target : null;
      const typing = element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
      const inTerminal = Boolean(element?.closest(".xterm"));
      const key = event.key.toLowerCase();
      if (key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
        return;
      }
      if (key === "k") {
        const terminalShortcut = inTerminal && (event.ctrlKey ? event.shiftKey : event.metaKey);
        if (typing && !inTerminal) return;
        if (inTerminal && !terminalShortcut) return;
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (typing) return;
      if (key === "t") {
        event.preventDefault();
        addBlankTab();
      } else if (key === "j") {
        event.preventDefault();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addBlankTab, toggleAi]);

  if (!localeReady) {
    return <div className="flex h-full items-center justify-center gap-2 bg-background text-foreground" aria-busy="true">
      <img src="/termvista-icon-v2.png" alt="" className="h-6 w-6 rounded-sm" />
      <span className="text-sm font-medium">TermVista</span>
    </div>;
  }

  return (
    <div className="app-shell flex h-full min-h-0 flex-col overflow-hidden" data-theme={theme}>
      <DesktopWorkspace />
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <ConnectionManagerDialog />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Dialog open={pendingEditorClose} onOpenChange={setPendingEditorClose}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>{tw("exitDirtyTitle")}</DialogTitle>
          <DialogDescription>{tw("exitDirtyDescription")}</DialogDescription>
          <ul className="compact-scrollbar max-h-40 space-y-1 overflow-auto rounded-sm border border-border p-2 text-[10px]">
            {dirtyEditorDocuments.slice(0, 8).map((document) => <li key={document.documentId} className="truncate font-mono" title={document.canonicalPath}>{document.displayName} · {document.canonicalPath}</li>)}
            {dirtyEditorDocuments.length > 8 && <li className="text-muted-foreground">{tw("moreUnsaved", { count: dirtyEditorDocuments.length - 8 })}</li>}
          </ul>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => setPendingEditorClose(false)}>{tw("returnToEditor")}</Button>
            <Button type="button" variant="destructive" size="xs" className="rounded-sm" onClick={() => {
              if (navigator.platform.toLowerCase().startsWith("mac")) {
                setPendingEditorClose(false);
                void closeApplicationWindow().catch(() => setPendingEditorClose(true));
                return;
              }
              allowEditorWindowClose.current = true;
              setPendingEditorClose(false);
              void getCurrentWindow().close().catch(() => {
                allowEditorWindowClose.current = false;
                setPendingEditorClose(true);
              });
            }}>{tw("discardAndExit")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <SshCredentialsDialog />
      <SshAuthPromptDialog />
      <HostKeyDialog />
      <HostKeyMismatchDialog />
      <Toaster theme={theme} position="bottom-right" closeButton duration={3500} />
      <div className="sr-only" aria-live="polite">{tw("aiSafetyAnnouncement")}</div>
    </div>
  );
}
