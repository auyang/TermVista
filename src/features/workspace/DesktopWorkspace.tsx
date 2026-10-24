import { useEffect, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { AiSidePanel } from "@/features/ai/AiSidePanel";
import { useAiStore } from "@/features/ai/aiStore";
import { MonitorSidebar } from "@/features/monitor/MonitorSidebar";
import { useMonitorLifecycle } from "@/features/monitor/useMonitorLifecycle";
import { SftpPane } from "@/features/sftp/SftpPane";
import { TerminalCommandBar } from "@/features/terminal/TerminalCommandBar";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { ConnectionTabBar } from "@/features/workspace/ConnectionTabBar";
import { HomeTab } from "@/features/home/HomeTab";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { toast } from "sonner";
import { RemoteEditorWorkspace } from "@/features/editor/RemoteEditorWorkspace";
import { resolveEditorLanguage } from "@/features/editor/languageRegistry";
import { closeRemoteDocument, openRemoteDocument } from "@/features/editor/remoteEditorBridge";
import { useEditorStore } from "@/features/editor/editorStore";
import { TunnelManagerDialog } from "@/features/tunnels/TunnelManagerDialog";
import { useTranslation } from "react-i18next";

export function DesktopWorkspace() {
  const { t } = useTranslation("workspace");
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const aiOpen = useWorkspaceStore((state) => state.aiOpen);
  const appTheme = useWorkspaceStore((state) => state.theme);
  const terminalColorScheme = useSettingsStore((state) => state.settings.terminal.colorScheme);
  const monitorCollapsed = useWorkspaceStore((state) => state.monitorCollapsed);
  const sftpCollapsed = useWorkspaceStore((state) => state.sftpCollapsed);
  const layouts = useWorkspaceStore((state) => state.layouts);
  const layoutResetCounter = useWorkspaceStore((state) => state.layoutResetCounter);
  const setLayout = useWorkspaceStore((state) => state.setLayout);
  const setMonitorCollapsed = useWorkspaceStore((state) => state.setMonitorCollapsed);
  const setSftpCollapsed = useWorkspaceStore((state) => state.setSftpCollapsed);
  const monitorRef = usePanelRef();
  const sftpRef = usePanelRef();
  const [narrow, setNarrow] = useState(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const isHome = !activeTab || activeTab.mode === "blank";
  const demo = import.meta.env.DEV && activeTab?.mode === "demo";
  const terminalTheme = terminalColorScheme === "dark" || appTheme === "dark" ? "dark" : "light";
  const activeSshSession = useSshSessionStore((state) =>
    activeTab?.mode === "ssh" ? state.sessions[activeTab.id] ?? null : null,
  );
  const editorConnectionId = activeSshSession?.profile.id ?? activeTab?.profileId ?? activeTab?.id ?? "workspace";
  const editorActiveId = useEditorStore((state) => state.activeByConnection[editorConnectionId] ?? "terminal");
  useMonitorLifecycle(
    activeSshSession?.state === "connected" ? activeSshSession.sessionId ?? null : null,
  );

  useEffect(() => {
    if (
      activeSshSession?.sessionId
      && ["disconnected", "error", "canceled"].includes(activeSshSession.state)
    ) {
      useAiStore.getState().clearSession(activeSshSession.sessionId);
    }
  }, [activeSshSession?.sessionId, activeSshSession?.state]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const panel = monitorRef.current;
    if (!panel) return;
    if (monitorCollapsed && !panel.isCollapsed()) panel.collapse();
    if (!monitorCollapsed && panel.isCollapsed()) panel.expand();
  }, [monitorCollapsed, layoutResetCounter, monitorRef]);

  useEffect(() => {
    const panel = sftpRef.current;
    if (!panel) return;
    if (sftpCollapsed && !panel.isCollapsed()) panel.collapse();
    if (!sftpCollapsed && panel.isCollapsed()) panel.expand();
  }, [sftpCollapsed, layoutResetCounter, sftpRef]);

  const openRemoteFile = async (requestedSessionId: string, remotePath: string) => {
    if (activeTab?.mode !== "ssh" || activeSshSession?.state !== "connected" || activeSshSession.sessionId !== requestedSessionId) {
      toast.error(t("sessionChanged"));
      return;
    }
    try {
      const current = useEditorStore.getState().documents.find((document) =>
        document.connectionId === activeSshSession.profile.id
        && document.sessionId === requestedSessionId
        && document.canonicalPath === remotePath,
      );
      if (current) {
        useEditorStore.getState().activate(current.connectionId, current.documentId);
        return;
      }
      const document = await openRemoteDocument(requestedSessionId, remotePath);
      const result = useEditorStore.getState().open(document, resolveEditorLanguage(document.canonicalPath));
      if (result.overLimit) {
        await closeRemoteDocument(document.documentId).catch(() => undefined);
        toast.warning(t("editorLimit"));
        return;
      }
      if (document.previewOnly) toast.message(t("readOnlyPreview"));
    } catch {
      toast.error(t("openRemoteFailed"));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup
        key={`desktop-${layoutResetCounter}`}
        orientation="horizontal"
        defaultLayout={layouts.desktop}
        resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
        onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) setLayout("desktop", layout); }}
      >
        <ResizablePanel id="monitor" panelRef={monitorRef} defaultSize="20%" minSize="176px" maxSize="360px" collapsible collapsedSize="40px" collapsedThreshold="96px" className="min-w-0 overflow-hidden">
          <MonitorSidebar collapsed={monitorCollapsed} onToggle={() => setMonitorCollapsed(!monitorCollapsed)} />
        </ResizablePanel>
        <ResizableHandle aria-label={t("resizeMonitor")} />
        <ResizablePanel id="workspace" defaultSize="85.75%" minSize="600px" className="min-w-0 overflow-hidden">
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layouts.center}
            resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
            onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction && aiOpen && !narrow) setLayout("center", layout); }}
            className="min-w-0"
          >
            <ResizablePanel id="main" defaultSize={aiOpen && !narrow ? "71%" : "100%"} minSize="600px" className="min-w-0 overflow-hidden">
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                <ConnectionTabBar />
                {isHome ? <HomeTab /> : <ResizablePanelGroup
                  orientation="vertical"
                  defaultLayout={layouts.workArea}
                  resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
                  onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) setLayout("workArea", layout); }}
                  className="min-h-0 flex-1"
                >
                  <ResizablePanel id="terminal" defaultSize="42%" minSize="252px" className="min-h-0">
                    <RemoteEditorWorkspace
                      connectionId={editorConnectionId}
                      connectionName={activeTab?.title ?? "SSH"}
                      sessionId={activeSshSession?.sessionId ?? null}
                      connected={activeSshSession?.state === "connected"}
                    >
                      <div className="terminal-workspace flex h-full min-h-0 flex-col" data-terminal-theme={terminalTheme}>
                        <TerminalPane demo={demo} visible={editorActiveId === "terminal"} />
                        <TerminalCommandBar />
                      </div>
                    </RemoteEditorWorkspace>
                  </ResizablePanel>
                  <ResizableHandle aria-label={t("resizeTerminalSftp")} />
                  <ResizablePanel id="sftp" panelRef={sftpRef} defaultSize="58%" minSize="160px" collapsible collapsedSize="32px" collapsedThreshold="80px" className="min-h-0 overflow-hidden">
                    <SftpPane key={activeTab?.id ?? "empty"} collapsed={sftpCollapsed} onToggleCollapse={() => setSftpCollapsed(!sftpCollapsed)} onOpenRemoteFile={(sessionId, path) => void openRemoteFile(sessionId, path)} />
                  </ResizablePanel>
                </ResizablePanelGroup>}
              </div>
            </ResizablePanel>
            {aiOpen && !narrow && <>
              <ResizableHandle aria-label={t("resizeAi")} />
              <ResizablePanel id="assistant" defaultSize="29%" minSize="300px" maxSize="480px" className="min-w-0 overflow-hidden">
                <AiSidePanel />
              </ResizablePanel>
            </>}
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      {aiOpen && narrow && <AiSidePanel sheet />}
      <TunnelManagerDialog />
    </div>
  );
}
