import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Activity, ArrowDown, ArrowUp, Check, Copy, FileInput, GitFork, LoaderCircle, Pencil, Plus, Power, Search, Sparkles, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { previewSshConfig, importSshConfigTunnelRules, type SshConfigPreview } from "@/features/connections/profileBridge";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore, type ConnectionProfile } from "@/stores/workspaceStore";
import { checkTunnelTarget, deleteForwardRule, deleteSocks5Rule, listForwardRules, listForwardRuntimes, listSocks5Rules, listSocks5Runtimes, listTunnelEvents, listenForwardRuntimes, listenSocks5Runtimes, saveForwardRule, saveSocks5Rule, startForward, startSocks5, stopForward, stopSocks5 } from "./tunnelBridge";
import { useTunnelStore } from "./tunnelStore";
import type { ForwardRule, ForwardRuntime, Socks5Rule, Socks5Runtime, TcpCheckResult, TunnelEvent, TunnelState } from "./tunnelTypes";
import { TunnelCopilotDialog } from "./TunnelCopilotDialog";
import { useTranslation } from "react-i18next";
import i18next from "@/i18n";

type TunnelKind = "forward" | "socks5";
type TunnelTarget = { kind: "forward"; rule: ForwardRule } | { kind: "socks5"; rule: Socks5Rule };
type TunnelItem = TunnelTarget & { runtime?: ForwardRuntime | Socks5Runtime };
type RuleDraft = { kind: TunnelKind; id: string | null; name: string; groupName: string; localPort: string; targetHost?: string; targetPort?: string };
type DeleteTarget = TunnelTarget;
type Translate = (key: string, options?: Record<string, unknown>) => string;

const emptyDraft = (kind: TunnelKind): RuleDraft => ({ kind, id: null, name: "", groupName: "", localPort: kind === "forward" ? "13306" : "1080", targetHost: "127.0.0.1", targetPort: "3306" });

function useTunnelTranslate(): Translate {
  const { t } = useTranslation("tunnels");
  return useCallback((key, options) => String(t(key as never, options as never)), [t]);
}

function tunnelErrorKey(code: string | null | undefined) {
  const normalized = code?.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const allowed = ["invalid_rule", "bind_in_use", "bind_failed", "session_missing", "session_profile_mismatch", "connection_lost", "remote_rejected", "target_unreachable", "rule_running", "internal"];
  return allowed.includes(normalized ?? "") ? normalized!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) : "generic";
}

function tunnelErrorText(t: Translate, code: string | null | undefined) {
  return t(`errors.${tunnelErrorKey(code)}`);
}

function tunnelExceptionText(t: Translate, error: unknown) {
  let code = "";
  if (error && typeof error === "object" && "code" in error) code = String(error.code);
  else if (typeof error === "string") {
    try { code = String((JSON.parse(error) as { code?: string }).code ?? ""); } catch { code = ""; }
  }
  return tunnelErrorText(t, code);
}

function stateKey(state: TunnelState) {
  return `state.${state}`;
}

function createRuleId() {
  return globalThis.crypto?.randomUUID?.() ?? `tunnel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function itemKey(item: TunnelTarget) {
  return `${item.kind}:${item.rule.id}`;
}

function itemState(item: TunnelItem): TunnelState {
  return item.runtime?.state ?? "stopped";
}

function isActive(state: TunnelState) {
  return state === "running" || state === "starting" || state === "stopping";
}

function formatRate(value: number, locale: string) {
  if (!Number.isFinite(value) || value <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let rate = value;
  let index = 0;
  while (rate >= 1024 && index < units.length - 1) { rate /= 1024; index += 1; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(rate)} ${units[index]}`;
}

export function TunnelManagerDialog() {
  const t = useTunnelTranslate();
  const open = useWorkspaceStore((state) => state.tunnelManagerOpen);
  const initialProfileId = useWorkspaceStore((state) => state.tunnelManagerProfileId);
  const setTunnelProfileId = useWorkspaceStore((state) => state.setTunnelManagerProfileId);
  const close = useWorkspaceStore((state) => state.closeTunnelManager);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const sessions = useSshSessionStore((state) => state.sessions);
  const activeWorkspaceTabId = useWorkspaceStore((state) => state.activeTabId);
  const activeWorkspaceSessionId = useSshSessionStore((state) => activeWorkspaceTabId ? state.sessions[activeWorkspaceTabId]?.sessionId : undefined);
  const runtimes = useTunnelStore((state) => state.runtimes);
  const socks5Runtimes = useTunnelStore((state) => state.socks5Runtimes);
  const applyRuntime = useTunnelStore((state) => state.applyRuntime);
  const applySocks5Runtime = useTunnelStore((state) => state.applySocks5Runtime);
  const replaceRuntimes = useTunnelStore((state) => state.replaceRuntimes);
  const replaceSocks5Runtimes = useTunnelStore((state) => state.replaceSocks5Runtimes);
  const clearRuntime = useTunnelStore((state) => state.clearRuntime);
  const clearSocks5Runtime = useTunnelStore((state) => state.clearSocks5Runtime);
  const locale = i18next.resolvedLanguage ?? "en-US";

  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [socks5Rules, setSocks5Rules] = useState<Socks5Rule[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [startTarget, setStartTarget] = useState<TunnelTarget | null>(null);
  const [batchStartOpen, setBatchStartOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRuleIds, setBusyRuleIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("name");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [targetChecks, setTargetChecks] = useState<Record<string, TcpCheckResult>>({});
  const [events, setEvents] = useState<TunnelEvent[]>([]);
  const [importPreview, setImportPreview] = useState<{ path: string; preview: SshConfigPreview } | null>(null);
  const [importAlias, setImportAlias] = useState("");
  const [importing, setImporting] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const sortedProfiles = useMemo(() => [...profiles].sort((a, b) =>
    a.group.localeCompare(b.group, locale) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, locale)), [locale, profiles]);
  const profileGroups = useMemo(() => [...new Set(sortedProfiles.map((profile) => profile.group || "__ungrouped__"))], [sortedProfiles]);
  const activeProfileId = sortedProfiles.some((profile) => profile.id === initialProfileId)
    ? initialProfileId ?? ""
    : sortedProfiles[0]?.id ?? "";
  const activeProfile = sortedProfiles.find((profile) => profile.id === activeProfileId) ?? null;
  const connectedSessions = useMemo(() => Object.values(sessions).filter((session) =>
    session.profile.id === activeProfileId && session.state === "connected" && Boolean(session.sessionId)), [activeProfileId, sessions]);
  const activeSessionId = connectedSessions.some((session) => session.sessionId === selectedSessionId)
    ? selectedSessionId
    : connectedSessions.length === 1 ? connectedSessions[0].sessionId ?? "" : "";

  const refreshRules = useCallback(async () => {
    const [nextRules, nextSocks5Rules, nextRuntimes, nextSocks5Runtimes] = await Promise.all([
      listForwardRules(), listSocks5Rules(), listForwardRuntimes(), listSocks5Runtimes(),
    ]);
    setRules(nextRules);
    setSocks5Rules(nextSocks5Rules);
    replaceRuntimes(nextRuntimes);
    replaceSocks5Runtimes(nextSocks5Runtimes);
  }, [replaceRuntimes, replaceSocks5Runtimes]);

  const refreshEvents = useCallback(async () => {
    try { setEvents(await listTunnelEvents()); } catch { /* 事件列表不可用时保留最近一次结果。 */ }
  }, []);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stopForward = await listenForwardRuntimes((runtime) => applyRuntime(runtime));
        if (!active) { stopForward(); return; }
        const stopSocks5 = await listenSocks5Runtimes((runtime) => applySocks5Runtime(runtime));
        if (!active) { stopForward(); stopSocks5(); return; }
        unlisten = () => { stopForward(); stopSocks5(); };
        await refreshRules();
        if (active) {
          setHasLoaded(true);
          await refreshEvents();
        }
      } catch {
        unlisten?.();
        if (active) {
          setHasLoaded(true);
          toast.error(t("messages.loadedFailed"));
        }
      }
    })();
    const interval = window.setInterval(() => { void refreshEvents(); }, 5000);
    return () => { active = false; unlisten?.(); window.clearInterval(interval); };
  }, [applyRuntime, applySocks5Runtime, open, refreshEvents, refreshRules, t]);

  const loading = open && isTauri() && !hasLoaded;
  const items = useMemo<TunnelItem[]>(() => [
    ...rules.filter((rule) => rule.profileId === activeProfileId).map((rule) => ({ kind: "forward" as const, rule, runtime: runtimes[rule.id] })),
    ...socks5Rules.filter((rule) => rule.profileId === activeProfileId).map((rule) => ({ kind: "socks5" as const, rule, runtime: socks5Runtimes[rule.id] })),
  ], [activeProfileId, rules, runtimes, socks5Rules, socks5Runtimes]);
  const groups = useMemo(() => [...new Set(items.map((item) => item.rule.groupName || ""))].sort((a, b) => a.localeCompare(b, locale)), [items, locale]);
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    const filtered = items.filter((item) => {
      const rule = item.rule;
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (stateFilter !== "all" && itemState(item) !== stateFilter) return false;
      if (groupFilter !== "all" && (rule.groupName || "") !== groupFilter) return false;
      if (!normalizedQuery) return true;
      const searchable = item.kind === "forward"
        ? `${rule.name} ${rule.groupName} ${rule.localPort} ${item.rule.targetHost} ${item.rule.targetPort}`
        : `${rule.name} ${rule.groupName} ${rule.localPort} SOCKS5`;
      return searchable.toLocaleLowerCase(locale).includes(normalizedQuery);
    });
    return filtered.sort((left, right) => {
      if (sortOrder === "port") return left.rule.localPort - right.rule.localPort || left.rule.name.localeCompare(right.rule.name, locale);
      if (sortOrder === "state") return itemState(left).localeCompare(itemState(right)) || left.rule.name.localeCompare(right.rule.name, locale);
      return (left.rule.groupName || "").localeCompare(right.rule.groupName || "", locale) || left.rule.name.localeCompare(right.rule.name, locale);
    });
  }, [groupFilter, items, kindFilter, locale, query, sortOrder, stateFilter]);
  const groupedItems = useMemo(() => {
    const groupsMap = new Map<string, TunnelItem[]>();
    for (const item of visibleItems) {
      const key = item.rule.groupName || "";
      groupsMap.set(key, [...(groupsMap.get(key) ?? []), item]);
    }
    return [...groupsMap.entries()];
  }, [visibleItems]);
  const selectedItems = items.filter((item) => selectedKeys.has(itemKey(item)));
  const copilotTarget = selectedItems.length === 1 ? selectedItems[0] : null;
  const copilotSessionMatchesWorkspace = Boolean(activeSessionId && activeWorkspaceSessionId === activeSessionId);
  const selectedActiveCount = selectedItems.filter((item) => isActive(itemState(item))).length;
  const filteredKeys = visibleItems.map(itemKey);
  const allVisibleSelected = filteredKeys.length > 0 && filteredKeys.every((key) => selectedKeys.has(key));

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProfileId || !draft) return;
    const localPort = Number(draft.localPort);
    const targetPort = draft.kind === "forward" ? Number(draft.targetPort) : undefined;
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535
      || (targetPort !== undefined && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535))) {
      toast.error(t("messages.invalidPort"));
      return;
    }
    const now = Date.now();
    const existing = draft.id
      ? draft.kind === "forward" ? rules.find((rule) => rule.id === draft.id) : socks5Rules.find((rule) => rule.id === draft.id)
      : undefined;
    setSaving(true);
    try {
      if (draft.kind === "socks5") {
        const rule: Socks5Rule = {
          id: draft.id ?? createRuleId(), profileId: activeProfileId, name: draft.name.trim(), groupName: draft.groupName.trim(),
          localHost: "127.0.0.1", localPort, createdAt: existing?.createdAt ?? now, updatedAt: now,
        };
        const saved = await saveSocks5Rule(rule);
        setSocks5Rules((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      } else {
        const rule: ForwardRule = {
          id: draft.id ?? createRuleId(), profileId: activeProfileId, name: draft.name.trim(), groupName: draft.groupName.trim(),
          localHost: "127.0.0.1", localPort, targetHost: draft.targetHost?.trim() ?? "127.0.0.1",
          targetPort: targetPort!, createdAt: existing?.createdAt ?? now, updatedAt: now,
        };
        const saved = await saveForwardRule(rule);
        setRules((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      }
      setDraft(null);
      toast.success(t("messages.saved"));
    } catch (error) {
      toast.error(tunnelExceptionText(t, error));
    } finally { setSaving(false); }
  };

  const startRule = async (target: TunnelTarget, quiet = false) => {
    if (!activeSessionId) {
      if (!quiet) toast.error(t("errors.sessionMissing"));
      return false;
    }
    const key = itemKey(target);
    setBusyRuleIds((current) => new Set(current).add(key));
    try {
      if (target.kind === "forward") {
        applyRuntime(await startForward(target.rule.id, activeSessionId));
      } else {
        applySocks5Runtime(await startSocks5(target.rule.id, activeSessionId));
      }
      if (!quiet) toast.success(t("messages.listening", { address: `${target.rule.localHost}:${target.rule.localPort}` }));
      return true;
    } catch (error) {
      if (!quiet) toast.error(tunnelExceptionText(t, error));
      try { await refreshRules(); } catch { /* 保留上次运行状态。 */ }
      return false;
    } finally {
      setBusyRuleIds((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const stopRule = async (target: TunnelTarget, quiet = false) => {
    const key = itemKey(target);
    setBusyRuleIds((current) => new Set(current).add(key));
    try {
      if (target.kind === "forward") applyRuntime(await stopForward(target.rule.id));
      else applySocks5Runtime(await stopSocks5(target.rule.id));
      if (!quiet) toast.success(t("messages.stopped"));
      return true;
    } catch (error) {
      if (!quiet) toast.error(tunnelExceptionText(t, error));
      return false;
    } finally {
      setBusyRuleIds((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const confirmStart = async () => {
    const target = startTarget;
    setStartTarget(null);
    if (target) { await startRule(target); return; }
    if (!batchStartOpen) return;
    setBatchStartOpen(false);
    const candidates = selectedItems.filter((item) => !isActive(itemState(item)));
    let started = 0;
    for (const item of candidates) if (await startRule(item, true)) started += 1;
    toast.success(t("messages.batchStarted", { started, total: candidates.length }));
  };

  const batchStop = async () => {
    const candidates = selectedItems.filter((item) => isActive(itemState(item)));
    let stopped = 0;
    for (const item of candidates) if (await stopRule(item, true)) stopped += 1;
    toast.success(t("messages.batchStopped", { stopped, total: candidates.length }));
  };

  const removeRule = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "forward") {
        await deleteForwardRule(deleteTarget.rule.id);
        setRules((current) => current.filter((rule) => rule.id !== deleteTarget.rule.id));
        clearRuntime(deleteTarget.rule.id);
      } else {
        await deleteSocks5Rule(deleteTarget.rule.id);
        setSocks5Rules((current) => current.filter((rule) => rule.id !== deleteTarget.rule.id));
        clearSocks5Runtime(deleteTarget.rule.id);
      }
      setSelectedKeys((current) => { const next = new Set(current); next.delete(itemKey(deleteTarget)); return next; });
      toast.success(t("messages.deleted"));
    } catch (error) { toast.error(tunnelExceptionText(t, error)); }
    finally { setDeleteTarget(null); }
  };

  const copyLocalAddress = async (runtime?: Pick<ForwardRuntime, "localAddress"> | Pick<Socks5Runtime, "localAddress">) => {
    if (!runtime?.localAddress) return;
    try { await navigator.clipboard.writeText(runtime.localAddress); toast.success(t("messages.copied")); }
    catch { toast.error(t("messages.copyFailed")); }
  };

  const checkTarget = async (rule: ForwardRule) => {
    if (!activeSessionId) { toast.error(t("errors.sessionMissing")); return; }
    const key = `check:${rule.id}`;
    setBusyRuleIds((current) => new Set(current).add(key));
    try {
      const result = await checkTunnelTarget(rule.id, activeSessionId);
      setTargetChecks((current) => ({ ...current, [rule.id]: result }));
      toast[result.reachable ? "success" : "error"](t(result.reachable ? "messages.targetReachable" : "messages.targetUnreachable", {
        target: `${result.targetHost}:${result.targetPort}`,
        elapsed: result.elapsedMs ?? 0,
      }));
    } catch (error) { toast.error(tunnelExceptionText(t, error)); }
    finally { setBusyRuleIds((current) => { const next = new Set(current); next.delete(key); return next; }); }
  };

  const selectSshConfig = async () => {
    if (!isTauri()) return;
    try {
      const path = await openFileDialog({ multiple: false, title: t("sshConfig.selectFile") });
      if (!path || Array.isArray(path)) return;
      const preview = await previewSshConfig(path);
      const candidates = preview.entries.filter((entry) => entry.localForwards.length + entry.dynamicForwards.length > 0);
      setImportPreview({ path, preview });
      setImportAlias(candidates[0]?.alias ?? "");
      if (!candidates.length) toast(t("sshConfig.noRules"));
    } catch { toast.error(t("sshConfig.readFailed")); }
  };

  const selectedImportEntry = importPreview?.preview.entries.find((entry) => entry.alias === importAlias) ?? null;
  const importTunnelRules = async () => {
    if (!importPreview || !selectedImportEntry || !activeProfileId) return;
    setImporting(true);
    try {
      const result = await importSshConfigTunnelRules(importPreview.path, selectedImportEntry.alias, activeProfileId);
      await refreshRules();
      setImportPreview(null);
      setImportAlias("");
      toast.success(t("sshConfig.imported", result));
    } catch { toast.error(t("sshConfig.importFailed")); }
    finally { setImporting(false); }
  };

  const beginEdit = (rule: ForwardRule) => setDraft({ kind: "forward", id: rule.id, name: rule.name, groupName: rule.groupName, localPort: String(rule.localPort), targetHost: rule.targetHost, targetPort: String(rule.targetPort) });
  const beginEditSocks5 = (rule: Socks5Rule) => setDraft({ kind: "socks5", id: rule.id, name: rule.name, groupName: rule.groupName, localPort: String(rule.localPort) });

  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex h-[min(720px,calc(100vh-48px))] w-[min(1040px,calc(100vw-32px))] max-w-[1040px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 bg-panel-header px-3">
          <div className="flex min-w-0 items-center gap-2"><GitFork size={14} className="text-accent" /><DialogTitle className="text-sm">{t("title")}</DialogTitle></div>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("close")} onClick={close}><X size={14} /></Button>
        </header>
        <DialogDescription className="border-b border-border/40 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">{t("description")}</DialogDescription>
        {!isTauri() && <div className="m-3 rounded-sm border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-800 dark:text-amber-200">{t("desktopOnly")}</div>}
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-border/40 bg-panel/40 p-2" aria-label={t("servers")}>
            <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-semibold text-muted-foreground"><span>{t("servers")}</span><span>{profiles.length}</span></div>
            {profileGroups.map((group) => <section key={group} className="mb-2">
              <div className="truncate px-1 py-1 text-[9px] uppercase tracking-wide text-muted-foreground" title={group}>{group === "__ungrouped__" ? t("defaultGroup") : group}</div>
              {sortedProfiles.filter((profile) => (profile.group || "__ungrouped__") === group).map((profile) => <ProfileChoice key={profile.id} profile={profile} active={profile.id === activeProfileId} onClick={() => { setTunnelProfileId(profile.id); setDraft(null); setSelectedKeys(new Set()); }} />)}
            </section>)}
            {profiles.length === 0 && <div className="px-2 py-3 text-[10px] text-muted-foreground">{t("addServer")}</div>}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
              <div className="min-w-0"><div className="truncate text-xs font-medium">{activeProfile?.name ?? t("selectServer")}</div>
                {activeProfile && <div className="truncate font-mono text-[9px] text-muted-foreground">{activeProfile.username}@{activeProfile.host}:{activeProfile.port}</div>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {connectedSessions.length > 1 ? <select className="h-7 max-w-44 rounded-sm border border-border/60 bg-background px-2 text-[10px]" aria-label={t("selectSessionAria")} value={activeSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
                  <option value="">{t("selectConnectedSession")}</option>{connectedSessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.username} · {session.attemptId.slice(0, 8)}</option>)}
                </select> : <span className={`px-1 text-[10px] ${connectedSessions.length ? "text-success" : "text-muted-foreground"}`}>{connectedSessions.length ? t("sshAuthenticated") : t("sshDisconnected")}</span>}
                <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!activeProfileId || !isTauri()} onClick={() => setDraft(emptyDraft("forward"))}><Plus size={11} />TCP</Button>
                <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!activeProfileId || !isTauri()} onClick={() => setDraft(emptyDraft("socks5"))}><Plus size={11} />SOCKS5</Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!activeProfileId || !isTauri()} onClick={() => void selectSshConfig()}><FileInput size={12} />{t("sshConfig.importButton")}</Button>
              </div>
            </div>

            {draft && <form className="shrink-0 border-b border-border/40 bg-panel-header/25 p-2.5" onSubmit={(event) => void saveRule(event)}>
              <div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-medium">{draft.kind === "socks5" ? (draft.id ? t("editSocks5") : t("newSocks5")) : (draft.id ? t("editRule") : t("newRule"))}</span><Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label={t("closeRuleForm")} onClick={() => setDraft(null)}><X size={12} /></Button></div>
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 md:grid-cols-4">
                <Field label={t("ruleName")}><Input className="h-7 rounded-sm text-[11px]" maxLength={64} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("namePlaceholder")} /></Field>
                <Field label={t("ruleGroup")}><Input className="h-7 rounded-sm text-[11px]" maxLength={64} value={draft.groupName} onChange={(event) => setDraft({ ...draft, groupName: event.target.value })} placeholder={t("defaultGroup")} /></Field>
                <Field label={t("localListen")}><div className="flex h-7 items-center gap-1 rounded-sm border border-border/60 bg-background px-2 font-mono text-[10px]"><span className="text-muted-foreground">127.0.0.1:</span><input className="min-w-0 flex-1 bg-transparent outline-none" type="number" min={1} max={65535} required value={draft.localPort} onChange={(event) => setDraft({ ...draft, localPort: event.target.value })} aria-label={t("localPort")} /></div></Field>
                {draft.kind === "forward" ? <>
                  <Field label={t("remoteHost")}><Input className="h-7 rounded-sm font-mono text-[10px]" maxLength={255} required value={draft.targetHost ?? ""} onChange={(event) => setDraft({ ...draft, targetHost: event.target.value })} placeholder={t("remoteHostPlaceholder")} /></Field>
                  <Field label={t("remotePort")}><Input className="h-7 rounded-sm font-mono text-[10px]" type="number" min={1} max={65535} required value={draft.targetPort ?? ""} onChange={(event) => setDraft({ ...draft, targetPort: event.target.value })} /></Field>
                </> : <div className="col-span-2 self-end pb-1 text-[9px] text-muted-foreground">{t("socks5FormHint")}</div>}
                <div className="col-span-full flex justify-end gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" onClick={() => setDraft(null)}>{t("cancel")}</Button><Button type="submit" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={saving}>{saving && <LoaderCircle size={12} className="animate-spin" />}{saving ? t("saving") : t("saveRule")}</Button></div>
              </div>
            </form>}

            {importPreview && <section className="shrink-0 border-b border-border/40 bg-accent/5 p-2.5" aria-label={t("sshConfig.previewTitle")}>
              <div className="mb-1.5 flex items-center justify-between"><div className="text-[10px] font-medium">{t("sshConfig.previewTitle")}</div><Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label={t("sshConfig.closePreview")} onClick={() => setImportPreview(null)}><X size={12} /></Button></div>
              <div className="grid grid-cols-[minmax(120px,1fr)_minmax(160px,2fr)_auto] items-center gap-2">
                <select className="h-7 min-w-0 rounded-sm border border-border/60 bg-background px-2 text-[10px]" value={importAlias} onChange={(event) => setImportAlias(event.target.value)} aria-label={t("sshConfig.selectAlias")}>
                  <option value="">{t("sshConfig.selectAlias")}</option>{importPreview.preview.entries.filter((entry) => entry.localForwards.length + entry.dynamicForwards.length > 0).map((entry) => <option key={entry.alias} value={entry.alias}>{entry.alias} · {entry.localForwards.length + entry.dynamicForwards.length}</option>)}
                </select>
                <div className="min-w-0 text-[9px] leading-4 text-muted-foreground">
                  {selectedImportEntry ? <>
                    <div className="truncate">{t("sshConfig.attachTo", { profile: activeProfile?.name ?? "" })}</div>
                    <div className="truncate font-mono">{selectedImportEntry.localForwards.map((item) => `127.0.0.1:${item.bindPort} → ${item.targetHost}:${item.targetPort}`).join(" · ")}{selectedImportEntry.dynamicForwards.map((item) => `SOCKS5 127.0.0.1:${item.bindPort}`).join(" · ")}</div>
                    {!!selectedImportEntry.warnings.length && <div className="truncate text-amber-700 dark:text-amber-300">{t("sshConfig.skippedWarnings", { count: selectedImportEntry.warnings.length })}</div>}
                  </> : <span>{t("sshConfig.noRules")}</span>}
                </div>
                <div className="flex justify-end gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" onClick={() => setImportPreview(null)}>{t("cancel")}</Button><Button type="button" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!selectedImportEntry || importing} onClick={() => void importTunnelRules()}>{importing && <LoaderCircle size={12} className="animate-spin" />}{t("sshConfig.importSelected")}</Button></div>
              </div>
              {!!importPreview.preview.warnings.length && <div className="mt-1 truncate text-[9px] text-muted-foreground" title={importPreview.preview.warnings.join("\n")}>{t("sshConfig.configWarnings", { count: importPreview.preview.warnings.length })}</div>}
            </section>}

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
              <label className="relative min-w-32 flex-1"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="h-7 rounded-sm pl-7 text-[10px]" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("filters.search")} aria-label={t("filters.search")} /></label>
              <select className="h-7 max-w-36 rounded-sm border border-border/60 bg-background px-2 text-[10px]" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label={t("filters.group")}>
                <option value="all">{t("filters.allGroups")}</option>{groups.map((group) => <option key={group || "__empty__"} value={group}>{group || t("defaultGroup")}</option>)}
              </select>
              <select className="h-7 rounded-sm border border-border/60 bg-background px-2 text-[10px]" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} aria-label={t("filters.kind")}><option value="all">{t("filters.allTypes")}</option><option value="forward">TCP</option><option value="socks5">SOCKS5</option></select>
              <select className="h-7 rounded-sm border border-border/60 bg-background px-2 text-[10px]" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label={t("filters.state")}><option value="all">{t("filters.allStates")}</option>{(["running", "stopped", "error"] as const).map((state) => <option key={state} value={state}>{t(stateKey(state))}</option>)}</select>
              <select className="h-7 rounded-sm border border-border/60 bg-background px-2 text-[10px]" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label={t("filters.sort")}><option value="name">{t("filters.sortName")}</option><option value="port">{t("filters.sortPort")}</option><option value="state">{t("filters.sortState")}</option></select>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-b border-border/35 bg-panel-header/25 px-3 py-1.5">
              <label className="flex items-center gap-1.5 text-[9px] text-muted-foreground"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelectedKeys((current) => {
                const next = new Set(current);
                for (const key of filteredKeys) {
                  if (event.target.checked) next.add(key);
                  else next.delete(key);
                }
                return next;
              })} aria-label={t("batch.selectVisible")} />{t("batch.selected", { count: selectedKeys.size })}</label>
              <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-2 text-[9px]" disabled={!selectedItems.some((item) => !isActive(itemState(item))) || !activeSessionId} onClick={() => setBatchStartOpen(true)}><Power size={10} />{t("batch.start")}</Button>
              <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-2 text-[9px]" disabled={selectedActiveCount === 0} onClick={() => void batchStop()}><Square size={10} />{t("batch.stop")}</Button>
              <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-2 text-[9px]" disabled={!copilotTarget || !copilotSessionMatchesWorkspace || !isTauri()} title={copilotSessionMatchesWorkspace ? t("copilot.selectOne") : t("copilot.activeTabRequired")} onClick={() => setCopilotOpen(true)}><Sparkles size={10} />{t("copilot.open")}</Button>
              <span className="ml-auto text-[9px] text-muted-foreground">{t("filters.resultCount", { count: visibleItems.length })}</span>
            </div>

            <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
              {loading && <div className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle size={13} className="animate-spin" />{t("loading")}</div>}
              {!loading && groupedItems.map(([group, groupItems]) => <section key={group || "__ungrouped__"}>
                <div className="sticky top-0 z-[1] flex h-6 items-center justify-between border-b border-border/30 bg-background/95 px-3 text-[9px] font-medium text-muted-foreground"><span>{group || t("defaultGroup")}</span><span>{groupItems.length}</span></div>
                {groupItems.map((item) => <TunnelRuleRow
                  key={itemKey(item)} item={item} checked={selectedKeys.has(itemKey(item))}
                  busy={busyRuleIds.has(itemKey(item))} checking={busyRuleIds.has(`check:${item.rule.id}`)}
                  canStart={Boolean(activeSessionId)} sshConnected={item.runtime?.sessionId ? connectedSessions.some((session) => session.sessionId === item.runtime?.sessionId) : Boolean(activeSessionId)}
                  targetCheck={item.kind === "forward" && targetChecks[item.rule.id]?.sessionId === activeSessionId ? targetChecks[item.rule.id] : undefined}
                  onSelect={(checked) => setSelectedKeys((current) => { const next = new Set(current); if (checked) next.add(itemKey(item)); else next.delete(itemKey(item)); return next; })}
                  onStart={() => setStartTarget(item)} onStop={() => void stopRule(item)}
                  onCopy={() => void copyLocalAddress(item.runtime)}
                  onCheck={() => { if (item.kind === "forward") void checkTarget(item.rule); }}
                  onEdit={() => item.kind === "forward" ? beginEdit(item.rule) : beginEditSocks5(item.rule)}
                  onDelete={() => setDeleteTarget(item)}
                  t={t} locale={locale}
                />)}
              </section>)}
              {!loading && activeProfileId && visibleItems.length === 0 && <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-[11px] text-muted-foreground"><GitFork size={20} className="opacity-40" />{items.length ? t("filters.noMatches") : t("empty")}<div className="flex gap-1"><Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setDraft(emptyDraft("forward"))}><Plus size={12} />TCP</Button><Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setDraft(emptyDraft("socks5"))}><Plus size={12} />SOCKS5</Button></div></div>}
              {!loading && !activeProfileId && profiles.length > 0 && <div className="px-3 py-6 text-center text-[10px] text-muted-foreground">{t("selectServerHint")}</div>}
            </div>
            {activeProfile && <footer className="shrink-0 border-t border-border/40 px-3 py-1.5 text-[9px] text-muted-foreground">
              <div className="flex items-center justify-between"><span>{t("footerUnified")}</span><span>{t("listenerSshTargetLegend")}</span></div>
              <details className="group mt-1">
                <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[10px] font-medium text-foreground/80"><Activity size={11} />{t("events.title")} <span className="font-normal text-muted-foreground">{events.filter((event) => event.profileId === activeProfileId).length}</span></summary>
                <div className="max-h-28 overflow-auto border-t border-border/25 pt-1">
                  {events.filter((event) => event.profileId === activeProfileId).slice(0, 20).map((event) => {
                    const rule = items.find((item) => item.rule.id === event.ruleId)?.rule;
                    return <div key={event.id} className="flex items-center gap-2 py-0.5"><time className="shrink-0 font-mono">{new Date(event.occurredAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span className="max-w-32 truncate">{rule?.name ?? event.protocol.toUpperCase()}</span><span className="truncate text-destructive">{tunnelErrorText(t, event.code)}</span></div>;
                  })}
                  {!events.some((event) => event.profileId === activeProfileId) && <div className="py-1">{t("events.empty")}</div>}
                </div>
              </details>
            </footer>}
          </main>
        </div>
      </DialogContent>
    </Dialog>

    <TunnelCopilotDialog
      key={`${activeSessionId}-${copilotTarget?.rule.id ?? "no-rule"}`}
      open={copilotOpen}
      onOpenChange={setCopilotOpen}
      sessionId={activeSessionId}
      rule={copilotTarget ? { id: copilotTarget.rule.id, name: copilotTarget.rule.name, protocol: copilotTarget.kind === "forward" ? "localTcp" : "socks5" } : null}
      onSaved={() => { void refreshRules(); }}
    />
    <AlertDialog open={Boolean(startTarget) || batchStartOpen} onOpenChange={(next) => { if (!next) { setStartTarget(null); setBatchStartOpen(false); } }}>
      <AlertDialogContent>
        <AlertDialogTitle>{batchStartOpen ? t("batch.startTitle") : t(startTarget?.kind === "socks5" ? "socks5StartTitle" : "startTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{batchStartOpen
          ? t("batch.startDescription", { count: selectedItems.filter((item) => !isActive(itemState(item))).length })
          : startTarget?.kind === "socks5"
            ? t("socks5StartDescription", { localPort: startTarget.rule.localPort })
            : t("startDescription", { localPort: startTarget?.kind === "forward" ? startTarget.rule.localPort : "", targetHost: startTarget?.kind === "forward" ? startTarget.rule.targetHost : "", targetPort: startTarget?.kind === "forward" ? startTarget.rule.targetPort : "" })}</AlertDialogDescription>
        <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("cancel")}</Button></AlertDialogCancel><Button type="button" size="sm" className="h-7 rounded-sm px-2" onClick={() => void confirmStart()}>{batchStartOpen ? t("batch.start") : t(startTarget?.kind === "socks5" ? "socks5StartButton" : "startButton")}</Button></div>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{t(deleteTarget?.kind === "socks5" ? "socks5DeleteTitle" : "deleteTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{t(deleteTarget?.kind === "socks5" ? "socks5DeleteDescription" : "deleteDescription", { name: deleteTarget?.rule.name ?? "" })}</AlertDialogDescription>
        <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("cancel")}</Button></AlertDialogCancel><Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void removeRule()}>{t(deleteTarget?.kind === "socks5" ? "socks5DeleteButton" : "deleteButton")}</Button></div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function ProfileChoice({ profile, active, onClick }: { profile: ConnectionProfile; active: boolean; onClick: () => void }) {
  return <button type="button" className={`mb-0.5 flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${active ? "bg-accent/10 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`} aria-current={active ? "true" : undefined} onClick={onClick}>
    <span className="w-full truncate text-[11px] font-medium">{profile.name}</span><span className="w-full truncate font-mono text-[9px] text-muted-foreground">{profile.username}@{profile.host}</span>
  </button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-[9px] text-muted-foreground">{label}{children}</label>;
}

function TunnelRuleRow({ item, checked, busy, checking, canStart, sshConnected, targetCheck, onSelect, onStart, onStop, onCopy, onCheck, onEdit, onDelete, t, locale }: {
  item: TunnelItem;
  checked: boolean;
  busy: boolean;
  checking: boolean;
  canStart: boolean;
  sshConnected: boolean;
  targetCheck?: TcpCheckResult;
  onSelect: (checked: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onCopy: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onDelete: () => void;
  t: Translate;
  locale: string;
}) {
  const rule = item.rule;
  const runtime = item.runtime;
  const state = itemState(item);
  const running = isActive(state);
  const localListening = state === "running" && Boolean(runtime?.localAddress);
  const target = item.kind === "forward" ? `${item.rule.targetHost}:${item.rule.targetPort}` : t("dynamicTarget");
  const status = state === "error" ? t("localListener.error") : localListening ? t("localListener.listening") : t(`localListener.${state}`);
  const health = item.kind === "socks5"
    ? t("targetHealth.dynamic")
    : targetCheck
      ? targetCheck.reachable ? t("targetHealth.reachable", { elapsed: targetCheck.elapsedMs ?? 0 }) : t("targetHealth.unreachable")
      : t("targetHealth.notChecked");
  return <div className="border-b border-border/25 px-3 py-1.5 text-[10px] hover:bg-panel-header/20">
    <div className="flex min-w-0 items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(event) => onSelect(event.target.checked)} aria-label={t("batch.selectRule", { name: rule.name })} />
      <span className={`shrink-0 rounded-sm px-1 py-0.5 text-[8px] ${item.kind === "forward" ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}`}>{item.kind === "forward" ? "TCP" : "SOCKS5"}</span>
      <span className="min-w-0 flex-1 truncate font-medium" title={rule.name}>{rule.name}</span>
      <span className="hidden max-w-28 truncate text-[9px] text-muted-foreground sm:block" title={rule.groupName}>{rule.groupName || t("defaultGroup")}</span>
      <span className="shrink-0 font-mono text-[9px] text-muted-foreground">127.0.0.1:{rule.localPort}</span>
      <span className={`hidden shrink-0 sm:inline ${state === "running" ? "text-success" : state === "error" ? "text-destructive" : "text-muted-foreground"}`} title={t("localListener.label")}>{status}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground" title={t("connections")}>{runtime?.activeConnections ?? 0}</span>
      {localListening && runtime?.localAddress && <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0" title={t("copyAddress")} aria-label={t("copyAria", { address: runtime.localAddress })} onClick={onCopy}><Copy size={10} /></Button>}
      {state === "running" || state === "starting" ? <Button type="button" variant="outline" size="icon" className="h-6 w-6 shrink-0 rounded-sm" disabled={busy || state === "starting"} aria-label={t("stopRuleAria", { name: rule.name })} title={t("stopAndRelease")} onClick={onStop}><Square size={11} /></Button> : <Button type="button" variant="outline" size="icon" className="h-6 w-6 shrink-0 rounded-sm" disabled={busy || !canStart || state === "stopping"} aria-label={t("startRuleAria", { name: rule.name })} title={canStart ? t("startForward") : t("connectFirst")} onClick={onStart}><Power size={11} /></Button>}
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm" disabled={busy || running} aria-label={t("editRuleAria", { name: rule.name })} title={running ? t("stopBeforeEdit") : t("edit")} onClick={onEdit}><Pencil size={11} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-destructive" disabled={busy || running} aria-label={t("deleteRuleAria", { name: rule.name })} title={running ? t("stopBeforeEdit") : t("delete")} onClick={onDelete}><Trash2 size={11} /></Button>
    </div>
    <div className="ml-6 mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
      <span className="min-w-0 max-w-52 truncate font-mono" title={target}>{target}</span>
      <span className={sshConnected ? "text-success" : "text-muted-foreground"}><span className="opacity-70">SSH</span> {sshConnected ? t("sshAuthenticated") : t("sshDisconnected")}</span>
      <span className={targetCheck?.reachable ? "text-success" : targetCheck ? "text-destructive" : ""}><span className="opacity-70">{t("targetHealth.label")}</span> {health}</span>
      {item.kind === "forward" && <Button type="button" variant="ghost" size="sm" className="h-5 rounded-sm px-1 text-[9px]" disabled={!canStart || checking} title={t("targetHealth.checkTooltip")} onClick={onCheck}>{checking ? <LoaderCircle size={10} className="animate-spin" /> : <Check size={10} />}{t("targetHealth.check")}</Button>}
      {runtime && running && <span className="ml-auto inline-flex items-center gap-2 font-mono" title={t("traffic.rateHint")}><span className="inline-flex items-center gap-0.5"><ArrowUp size={9} />{formatRate(runtime.bytesPerSecondFromLocal, locale)}</span><span className="inline-flex items-center gap-0.5"><ArrowDown size={9} />{formatRate(runtime.bytesPerSecondToLocal, locale)}</span></span>}
    </div>
  </div>;
}
