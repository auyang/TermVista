import { useRef, useState } from "react";
import { FolderOpen, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { rememberManagerOpener } from "@/features/connections/managerFocus";
import { closeSshTab, connectProfile } from "@/features/ssh/sshBridge";
import { statusLabel, useSshSessionStore } from "@/stores/sshSessionStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { getWorkspaceTabDisplayTitle } from "@/features/workspace/tabTitle";

type PendingClose = {
  kind: "one" | "others";
  id: string;
  dirtyNames: string[];
} | null;

export function ConnectionTabBar() {
  const { t } = useTranslation("workspace");
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const activateTab = useWorkspaceStore((state) => state.activateTab);
  const addBlankTab = useWorkspaceStore((state) => state.addBlankTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs);
  const sshSessions = useSshSessionStore((state) => state.sessions);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const aiOpen = useWorkspaceStore((state) => state.aiOpen);
  const toggleAi = useWorkspaceStore((state) => state.toggleAi);
  const [pendingClose, setPendingClose] = useState<PendingClose>(null);
  const dirtyEditorNames = useEditorStore(useShallow((state) => state.documents
    .filter((document) => document.dirty)
    .map((document) => `${document.connectionId}\u0000${document.displayName}\u0000${document.canonicalPath}`)));

  const closeOneNow = (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab?.mode === "ssh") void closeSshTab(id);
    closeTab(id);
  };
  const closeOthersNow = (id: string) => {
    tabs.filter((tab) => tab.id !== id && tab.mode === "ssh").forEach((tab) => void closeSshTab(tab.id));
    closeOtherTabs(id);
  };
  const requestClose = (kind: "one" | "others", id: string) => {
    const closingTabs = tabs.filter((tab) => kind === "one" ? tab.id === id : tab.id !== id);
    const profileIds = new Set(closingTabs.map((tab) => sshSessions[tab.id]?.profile.id ?? tab.profileId).filter((value): value is string => Boolean(value)));
    const dirtyNames = dirtyEditorNames.filter((value) => profileIds.has(value.split("\u0000", 1)[0] ?? ""));
    if (dirtyNames.length) {
      setPendingClose({ kind, id, dirtyNames });
      return;
    }
    if (kind === "one") closeOneNow(id);
    else closeOthersNow(id);
  };

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border bg-panel-header px-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
        aria-label={t("openConnectionManager")}
        title={t("connectionManager")}
        onClick={(event) => {
          rememberManagerOpener(event.currentTarget);
          setManagerOpen(true);
        }}
      >
        <FolderOpen size={15} />
      </Button>
      <div
        ref={scrollRef}
        className="compact-scrollbar flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
        role="tablist"
        aria-label={t("sessions")}
      >
        {tabs.length === 0 ? (
          <div className="flex h-full items-center border-x border-border/70 bg-panel px-3 text-xs text-muted-foreground" role="tab" aria-selected="true">
            {t("newTab")}
          </div>
        ) : (
          tabs.map((tab) => {
            const tabTitle = getWorkspaceTabDisplayTitle(tab, t("newTab"));
            return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div className={`group flex h-full min-w-28 max-w-56 shrink-0 items-center border-r border-border/70 ${activeTabId === tab.id ? "bg-panel text-foreground" : "bg-panel-header text-muted-foreground hover:bg-panel/70"}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTabId === tab.id}
                    aria-label={`${import.meta.env.DEV && tab.mode === "demo" ? t("demoSession") : tab.mode === "ssh" ? sshSessions[tab.id] ? statusLabel(sshSessions[tab.id].state) : t("awaitingReconnect") : t("disconnectedSession")}: ${tabTitle}`}
                    title={tab.host ? `${tabTitle} · ${tab.host}` : tabTitle}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                    onClick={() => activateTab(tab.id)}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${import.meta.env.DEV && tab.mode === "demo" ? "bg-accent" : tab.mode === "ssh" ? sshSessions[tab.id]?.state === "connected" ? "bg-emerald-500" : sshSessions[tab.id]?.state === "error" ? "bg-destructive" : "bg-amber-500" : "bg-muted-foreground/55"}`} aria-hidden="true" />
                    <span className="truncate text-xs">{tabTitle}</span>
                    {import.meta.env.DEV && tab.mode === "demo" && <span className="shrink-0 rounded-[2px] border border-accent/60 px-1 text-[9px] font-semibold leading-[14px] text-accent">DEMO</span>}
                    {tab.mode === "ssh" && <span className="shrink-0 rounded-[2px] border border-border px-1 text-[9px] leading-[14px] text-muted-foreground">{sshSessions[tab.id] ? statusLabel(sshSessions[tab.id].state) : t("reconnectPending")}</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={t("closeTabNamed", { name: tabTitle })}
                    title={t("closeTabNamed", { name: tabTitle })}
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestClose("one", tab.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => requestClose("one", tab.id)}>{t("closeTab")}</ContextMenuItem>
                <ContextMenuItem onSelect={() => requestClose("others", tab.id)}>{t("closeOthers")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={tab.mode !== "ssh"} onSelect={() => {
                  const profile = sshSessions[tab.id]?.profile ?? profiles.find((item) => item.id === tab.profileId);
                  if (profile) void connectProfile(profile, tab.id);
                }}>{t("reconnect")}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            );
          })
        )}
      </div>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground" aria-label={t("newTab")} title={t("newTab")} onClick={addBlankTab}>
        <Plus size={15} />
      </Button>
      <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={`h-8 w-7 shrink-0 rounded-sm ${aiOpen ? "bg-accent/15 text-accent" : "text-muted-foreground hover:text-foreground"}`}
        aria-label={aiOpen ? t("aiClose") : t("aiOpen")}
        aria-pressed={aiOpen}
        title={t("aiPanel")}
        onClick={toggleAi}
      >
        <Sparkles size={15} />
      </Button>
      <Dialog open={pendingClose !== null} onOpenChange={(open) => { if (!open) setPendingClose(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>{t("dirtyTitle")}</DialogTitle>
          <DialogDescription>{t("dirtyDescription")}</DialogDescription>
          <ul className="compact-scrollbar max-h-36 space-y-1 overflow-auto rounded-sm border border-border p-2 text-[10px]">
            {pendingClose?.dirtyNames.slice(0, 6).map((item) => {
              const [, name, path] = item.split("\u0000");
              return <li key={item} className="truncate font-mono" title={path}>{name} · {path}</li>;
            })}
            {pendingClose && pendingClose.dirtyNames.length > 6 && <li className="text-muted-foreground">{t("moreUnsaved", { count: pendingClose.dirtyNames.length - 6 })}</li>}
          </ul>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => setPendingClose(null)}>{t("keepEditing")}</Button>
            <Button type="button" size="xs" className="rounded-sm" onClick={() => {
              if (pendingClose?.kind === "one") closeOneNow(pendingClose.id);
              else if (pendingClose) closeOthersNow(pendingClose.id);
              setPendingClose(null);
            }}>{t("closeKeepDraft")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
