import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Clock3,
  Copy,
  FolderOpen,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { bootstrapWorkspaceProfiles, clearRecentConnections, deleteConnectionProfile, saveConnectionProfile } from "@/features/connections/profileBridge";
import { connectProfile } from "@/features/ssh/sshBridge";
import { findReusableProfileTab } from "@/features/home/profileTabReuse";
import { selectQuickConnectProfiles, type ProfileFilter } from "@/features/home/quickConnect";
import type { ConnectionProfile } from "@/stores/workspaceStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";

const inflightConnections = new Map<string, Promise<unknown>>();
const connectingStates = new Set(["connecting", "verifyingHostKey", "authenticating", "openingPty"]);

export function HomeTab() {
  const { t } = useTranslation("home");
  const profiles = useWorkspaceStore((state) => state.profiles);
  const profilesLoadStatus = useWorkspaceStore((state) => state.profilesLoadStatus);
  const lastSftpPaths = useWorkspaceStore((state) => state.lastSftpPaths);
  const setProfilesLoadStatus = useWorkspaceStore((state) => state.setProfilesLoadStatus);
  const replaceProfiles = useWorkspaceStore((state) => state.replaceProfiles);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const requestProfileEdit = useWorkspaceStore((state) => state.requestManagerProfileEdit);
  const setSftpCollapsed = useWorkspaceStore((state) => state.setSftpCollapsed);
  const setSftpMode = useWorkspaceStore((state) => state.setSftpMode);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const sessions = useSshSessionStore((state) => state.sessions);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProfileFilter>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const visibleProfiles = useMemo(() => {
    return selectQuickConnectProfiles(profiles, filter, search);
  }, [filter, profiles, search]);

  const selectedProfiles = visibleProfiles.filter((profile) => selectedIds.includes(profile.id));
  const openManager = () => setManagerOpen(true);

  const openProfile = useCallback(async (profile: ConnectionProfile, forceNew = false) => {
    if (!forceNew) {
      const sessions = useSshSessionStore.getState().sessions;
      const existing = findReusableProfileTab(useWorkspaceStore.getState().tabs, sessions, profile.id);
      if (existing) {
        useWorkspaceStore.getState().activateTab(existing.id);
        const session = sessions[existing.id];
        if (session?.state === "connected" && session.sessionId || session && connectingStates.has(session.state)) {
          return true;
        }
        return (await connectProfile(profile, existing.id)) !== null;
      }
    }
    const pending = inflightConnections.get(profile.id);
    if (pending) {
      return (await pending) != null;
    }
    const connection = connectProfile(profile);
    inflightConnections.set(profile.id, connection);
    try {
      return (await connection) !== null;
    } finally {
      if (inflightConnections.get(profile.id) === connection) inflightConnections.delete(profile.id);
    }
  }, []);

  const openSftp = async (profile: ConnectionProfile) => {
    setSftpMode("files");
    setSftpCollapsed(false);
    await openProfile(profile);
  };

  const persistFavorite = async (profile: ConnectionProfile) => {
    const updated = { ...profile, favorite: !profile.favorite };
    try {
      await saveConnectionProfile(updated);
      replaceProfiles(useWorkspaceStore.getState().profiles.map((item) => item.id === profile.id ? updated : item));
    } catch {
      toast.error(t("toast.favoriteSaveFailed"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteConnectionProfile(deleteTarget.id);
      useWorkspaceStore.getState().removeProfile(deleteTarget.id);
      setSelectedIds((items) => items.filter((id) => id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      toast.error(t("toast.deleteFailed"));
    }
  };

  const copyHost = async (profile: ConnectionProfile) => {
    try {
      await navigator.clipboard.writeText(profile.host);
      toast.success(t("toast.hostCopied", { host: profile.host }));
    } catch {
      toast.error(t("toast.clipboardUnavailable"));
    }
  };

  const clearRecent = async () => {
    try {
      await clearRecentConnections();
      useWorkspaceStore.getState().clearRecentConnections();
      toast.success(t("toast.recentCleared"));
    } catch {
      toast.error(t("toast.recentClearFailed"));
    }
  };

  const batchConnect = async () => {
    setBatchConfirmOpen(false);
    for (const profile of selectedProfiles) {
      const connected = await openProfile(profile);
      if (!connected) {
        toast.message(t("batch.paused", { name: profile.name }));
        return;
      }
    }
    toast.success(t("batch.completed", { count: selectedProfiles.length }));
    setSelectedIds([]);
  };

  const retryLoad = async () => {
    setProfilesLoadStatus("loading");
    try {
      await bootstrapWorkspaceProfiles();
    } catch {
      // 错误说明显示在当前首页，重试按钮保留在原位。
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const moveRowFocus = (event: KeyboardEvent<HTMLTableRowElement>, profile: ConnectionProfile, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(0, Math.min(visibleProfiles.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      const nextProfile = visibleProfiles[next];
      if (nextProfile) {
        setSelectedIds([nextProfile.id]);
        rowRefs.current.get(nextProfile.id)?.focus();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      void openProfile(profile);
    } else if (event.key === "Escape") {
      setSelectedIds([]);
    }
  };

  return (
    <main className="compact-scrollbar flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background px-5 py-4" aria-label={t("title")}>
      <section className="flex w-full max-w-[920px] flex-col overflow-hidden rounded-md border border-border bg-panel shadow-sm" aria-labelledby="quick-connect-title">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border bg-panel-header/55 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-accent/20 bg-accent/10 text-accent"><Monitor size={17} /></span>
            <div className="min-w-0">
              <h1 id="quick-connect-title" className="text-[17px] font-semibold leading-5">{t("title")}</h1>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("subtitle")}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs text-accent" onClick={openManager}>
            <FolderOpen size={13} />{t("manageConnections")}
          </Button>
        </header>

        {profilesLoadStatus === "loading" ? <LoadingRows /> : profilesLoadStatus === "error" ? (
          <div className="flex min-h-52 flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
            <Server size={20} className="text-muted-foreground" />
            <div className="text-sm font-medium">{t("loadError.title")}</div>
            <p className="max-w-md text-xs text-muted-foreground">{t("loadError.description")}</p>
            <Button type="button" variant="outline" size="sm" className="mt-1 h-7 rounded-sm text-xs" onClick={() => void retryLoad()}><RefreshCw size={12} />{t("loadError.retry")}</Button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-panel-header text-muted-foreground"><Server size={20} /></span>
            <h2 className="mt-1 text-sm font-semibold">{t("empty.title")}</h2>
            <p className="max-w-sm text-xs text-muted-foreground">{t("empty.description")}</p>
            <Button type="button" size="sm" className="mt-2 h-7 rounded-sm px-3 text-xs" onClick={openManager}><Plus size={13} />{t("empty.addSsh")}</Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex items-center gap-1" role="group" aria-label={t("filter.aria")}>
                <FilterButton label={t("filter.all")} active={filter === "all"} onClick={() => setFilter("all")} />
                <FilterButton label={t("filter.favorites")} active={filter === "favorite"} onClick={() => setFilter("favorite")} />
                <FilterButton label={t("filter.recent")} active={filter === "recent"} onClick={() => setFilter("recent")} />
              </div>
              <div className="flex min-w-[220px] flex-1 items-center justify-end gap-2">
                {selectedProfiles.length > 0 && <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-[11px]" onClick={() => setBatchConfirmOpen(true)}>{t("batch.connectCount", { count: selectedProfiles.length })}</Button>}
                <div className="relative w-full max-w-[250px]">
                  <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input ref={searchRef} className="h-7 rounded-sm pl-7 text-xs" placeholder={t("search.placeholder")} aria-label={t("search.aria")} value={search} onChange={(event) => setSearch(event.target.value)} />
                </div>
              </div>
            </div>
            <div className="compact-scrollbar max-h-[min(58vh,620px)] min-h-36 overflow-auto">
              {visibleProfiles.length === 0 ? <div className="flex min-h-36 items-center justify-center text-xs text-muted-foreground">{t("emptyFiltered")}</div> : (
                <table className="w-full min-w-[620px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-panel-header text-[10px] font-semibold text-muted-foreground shadow-[0_1px_0_var(--app-border)]">
                    <tr className="h-9">
                      <th className="h-9 w-10 px-3 py-0 text-center align-middle font-normal leading-none" scope="col"><span className="sr-only">{t("table.select")}</span></th>
                      <th className="h-9 min-w-[220px] px-2 py-0 align-middle leading-none" scope="col">{t("table.name")}</th>
                      <th className="h-9 w-[31%] px-2 py-0 align-middle leading-none" scope="col">{t("table.lastPath")}</th>
                      <th className="h-9 w-[17%] px-2 py-0 align-middle leading-none" scope="col">{t("table.user")}</th>
                      <th className="h-9 w-12 px-2 py-0 text-center align-middle leading-none" scope="col"><span className="sr-only">{t("table.actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProfiles.map((profile, index) => {
                      const status = profileActivity(profile, tabs, sessions);
                      const selected = selectedIds.includes(profile.id);
                      return (
                        <ContextMenu key={profile.id}>
                          <ContextMenuTrigger asChild>
                            <tr
                              ref={(element) => {
                                if (element) rowRefs.current.set(profile.id, element);
                                else rowRefs.current.delete(profile.id);
                              }}
                              tabIndex={0}
                              aria-selected={selected}
                              className={`h-12 border-b border-border/70 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${selected ? "bg-accent/10" : index % 2 ? "bg-panel-header/25" : "bg-panel"} hover:bg-accent/7`}
                              onClick={() => setSelectedIds([profile.id])}
                              onDoubleClick={() => void openProfile(profile)}
                              onKeyDown={(event) => moveRowFocus(event, profile, index)}
                            >
                              <td className="px-3" onClick={(event) => event.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 accent-[var(--app-accent)]"
                                  aria-label={t("actions.selected", { name: profile.name })}
                                  checked={selectedIds.includes(profile.id)}
                                  disabled={!selectedIds.includes(profile.id) && selectedIds.length >= 3}
                                  onChange={(event) => {
                                    if (event.target.checked) setSelectedIds((items) => [...items, profile.id]);
                                    else setSelectedIds((items) => items.filter((id) => id !== profile.id));
                                  }}
                                />
                              </td>
                              <td className="max-w-0 px-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-accent/15 bg-accent/5 text-accent"><Server size={13} /></span>
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                      <span className="truncate font-medium" title={profile.name}>{profile.name}</span>
                                      {profile.favorite && <Star size={11} className="shrink-0 fill-amber-500 text-amber-500" aria-label={t("actions.isFavorite")} />}
                                      {status && <span className={`shrink-0 rounded-sm border px-1 text-[9px] leading-[15px] ${status === "connected" ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-400" : "border-amber-500/25 text-amber-700 dark:text-amber-300"}`}>{status === "connected" ? t("status.connected") : t("status.connecting")}</span>}
                                    </span>
                                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={`${profile.host}:${profile.port}`}>{profile.host}:{profile.port || 22}</span>
                                  </span>
                                </div>
                              </td>
                              <td className="max-w-0 px-2 font-mono text-[11px] text-muted-foreground"><span className="block truncate" title={lastSftpPaths[profile.id] ?? t("actions.lastPathNotRecorded")}>{lastSftpPaths[profile.id] ?? "—"}</span></td>
                              <td className="max-w-0 px-2"><span className="block truncate" title={profile.username}>{profile.username || "—"}</span></td>
                              <td className="px-2 text-center" onClick={(event) => event.stopPropagation()}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-muted-foreground" aria-label={`${t("actions.more")}：${profile.name}`} title={t("actions.more")}><MoreHorizontal size={15} /></Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => void openProfile(profile)}><Server size={12} />{t("actions.connect")}</DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void openProfile(profile, true)}><Plus size={12} />{t("actions.connectNew")}</DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void openSftp(profile)}><FolderOpen size={12} />{t("actions.openSftp")}</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => requestProfileEdit(profile.id)}><Pencil size={12} />{t("actions.edit")}</DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void persistFavorite(profile)}><Star size={12} />{t(profile.favorite ? "actions.unfavorite" : "actions.favorite")}</DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void copyHost(profile)}><Copy size={12} />{t("actions.copyHost")}</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteTarget(profile)}><Trash2 size={12} />{t("actions.delete")}</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </td>
                            </tr>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onSelect={() => void openProfile(profile)}><Server size={12} />{t("actions.connect")}</ContextMenuItem>
                            <ContextMenuItem onSelect={() => void openProfile(profile, true)}><Plus size={12} />{t("actions.connectNew")}</ContextMenuItem>
                            <ContextMenuItem onSelect={() => void openSftp(profile)}><FolderOpen size={12} />{t("actions.openSftp")}</ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => requestProfileEdit(profile.id)}><Pencil size={12} />{t("actions.edit")}</ContextMenuItem>
                            <ContextMenuItem onSelect={() => void persistFavorite(profile)}><Star size={12} />{t(profile.favorite ? "actions.unfavorite" : "actions.favorite")}</ContextMenuItem>
                            <ContextMenuItem onSelect={() => void copyHost(profile)}><Copy size={12} />{t("actions.copyHost")}</ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => setDeleteTarget(profile)}><Trash2 size={12} />{t("actions.delete")}</ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <footer className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t border-border bg-panel-header/45 px-3 text-[10px] text-muted-foreground">
              <span>{t("footer.savedCount", { count: profiles.length })} · {t("footer.usage")}</span>
              <div className="flex items-center gap-3">
                {profiles.some((profile) => profile.lastConnectedAt) && <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void clearRecent()}><Clock3 size={11} />{t("footer.clearRecent")}</button>}
                <span>{t("batch.maxSelected")}</span>
              </div>
            </footer>
          </>
        )}
      </section>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.description", { name: deleteTarget?.name })}
            {deleteTarget && profileActivity(deleteTarget, tabs, sessions) && t("delete.activeSession")}
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("delete.cancel")}</Button></AlertDialogCancel>
            <Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void confirmDelete()}>{t("delete.confirm")}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("batch.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("batch.description", { count: selectedProfiles.length })}
          </AlertDialogDescription>
          <ul className="max-h-32 overflow-y-auto rounded-sm border border-border px-3 py-2 text-xs">
            {selectedProfiles.map((profile) => <li key={profile.id} className="truncate py-0.5">{profile.name} <span className="font-mono text-muted-foreground">{profile.username}@{profile.host}:{profile.port}</span></li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("delete.cancel")}</Button></AlertDialogCancel>
            <Button type="button" size="sm" className="h-7 rounded-sm px-2" onClick={() => void batchConnect()}>{t("batch.start")}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <Button type="button" variant={active ? "secondary" : "ghost"} size="sm" className={`h-6 rounded-sm px-2 text-[10px] ${active ? "text-foreground" : "text-muted-foreground"}`} aria-pressed={active} onClick={onClick}>{label}</Button>;
}

function LoadingRows() {
  const { t } = useTranslation("home");
  return <div className="space-y-0 px-3 py-3" role="status" aria-label={t("loading.aria")}>
    <div className="mb-2 flex h-7 items-center justify-between"><span className="h-3 w-24 animate-pulse rounded-sm bg-muted" /><span className="h-6 w-44 animate-pulse rounded-sm bg-muted" /></div>
    <div className="h-8 border-y border-border bg-panel-header/45" />
    {Array.from({ length: 5 }, (_, index) => <div key={index} className="flex h-12 items-center gap-3 border-b border-border/70 px-3">
      <span className="h-3.5 w-3.5 animate-pulse rounded-sm bg-muted" /><span className="h-6 w-6 animate-pulse rounded-sm bg-muted" /><span className="h-3 w-40 animate-pulse rounded-sm bg-muted" />
    </div>)}
    <span className="sr-only">{t("loading.screenReader")}</span>
  </div>;
}

function profileActivity(
  profile: ConnectionProfile,
  tabs: ReturnType<typeof useWorkspaceStore.getState>["tabs"],
  sessions: ReturnType<typeof useSshSessionStore.getState>["sessions"],
) {
  const profileSessions = tabs.filter((tab) => tab.mode === "ssh" && tab.profileId === profile.id)
    .map((tab) => sessions[tab.id])
    .filter(Boolean);
  if (profileSessions.some((session) => session.state === "connected" && session.sessionId)) return "connected";
  if (profileSessions.some((session) => connectingStates.has(session.state))) return "connecting";
  return null;
}
