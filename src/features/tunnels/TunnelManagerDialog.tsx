import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Copy, GitFork, LoaderCircle, Pencil, Plus, Power, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore, type ConnectionProfile } from "@/stores/workspaceStore";
import { deleteForwardRule, listForwardRules, listForwardRuntimes, listenForwardRuntimes, saveForwardRule, startForward, stopForward } from "./tunnelBridge";
import { useTunnelStore } from "./tunnelStore";
import type { ForwardRule, ForwardRuntime, TunnelState } from "./tunnelTypes";
import { useTranslation } from "react-i18next";
import i18next from "@/i18n";

type RuleDraft = { id: string | null; name: string; localPort: string; targetHost: string; targetPort: string };

const emptyDraft = (): RuleDraft => ({ id: null, name: "", localPort: "13306", targetHost: "127.0.0.1", targetPort: "3306" });
type Translate = (key: string, options?: Record<string, unknown>) => string;

function useTunnelTranslate(): Translate {
  const { t } = useTranslation("tunnels");
  return (key, options) => String(t(key as never, options as never));
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
  return globalThis.crypto?.randomUUID?.() ?? `forward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function TunnelManagerDialog() {
  const t = useTunnelTranslate();
  const open = useWorkspaceStore((state) => state.tunnelManagerOpen);
  const initialProfileId = useWorkspaceStore((state) => state.tunnelManagerProfileId);
  const setTunnelProfileId = useWorkspaceStore((state) => state.setTunnelManagerProfileId);
  const close = useWorkspaceStore((state) => state.closeTunnelManager);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const sessions = useSshSessionStore((state) => state.sessions);
  const runtimes = useTunnelStore((state) => state.runtimes);
  const applyRuntime = useTunnelStore((state) => state.applyRuntime);
  const replaceRuntimes = useTunnelStore((state) => state.replaceRuntimes);
  const clearRuntime = useTunnelStore((state) => state.clearRuntime);
  const locale = i18next.resolvedLanguage ?? "en-US";
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ForwardRule | null>(null);
  const [startTarget, setStartTarget] = useState<ForwardRule | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRuleIds, setBusyRuleIds] = useState<Set<string>>(() => new Set());

  const sortedProfiles = useMemo(() => [...profiles].sort((a, b) =>
    a.group.localeCompare(b.group, locale) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, locale)), [locale, profiles]);
  const profileGroups = useMemo(() => [...new Set(sortedProfiles.map((profile) => profile.group || "__ungrouped__"))], [sortedProfiles]);
  const activeProfileId = sortedProfiles.some((profile) => profile.id === initialProfileId)
    ? initialProfileId ?? ""
    : sortedProfiles[0]?.id ?? "";
  const activeProfile = sortedProfiles.find((profile) => profile.id === activeProfileId) ?? null;
  const profileRules = useMemo(() => rules.filter((rule) => rule.profileId === activeProfileId), [activeProfileId, rules]);
  const connectedSessions = useMemo(() => Object.values(sessions).filter((session) =>
    session.profile.id === activeProfileId && session.state === "connected" && Boolean(session.sessionId)), [activeProfileId, sessions]);
  const activeSessionId = connectedSessions.some((session) => session.sessionId === selectedSessionId)
    ? selectedSessionId
    : connectedSessions.length === 1 ? connectedSessions[0].sessionId ?? "" : "";

  useEffect(() => {
    if (!open || !isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stopListening = await listenForwardRuntimes((runtime) => applyRuntime(runtime));
        if (!active) stopListening();
        else unlisten = stopListening;
        const [nextRules, nextRuntimes] = await Promise.all([listForwardRules(), listForwardRuntimes()]);
        if (active) {
          setRules(nextRules);
          replaceRuntimes(nextRuntimes);
          setHasLoaded(true);
        }
      } catch {
        if (active) {
          setHasLoaded(true);
          toast.error(t("messages.loadedFailed"));
        }
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyRuntime, open, replaceRuntimes, t]);

  const loading = open && isTauri() && !hasLoaded;

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProfileId || !draft) return;
    const localPort = Number(draft.localPort);
    const targetPort = Number(draft.targetPort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535
      || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
      toast.error(t("messages.invalidPort"));
      return;
    }
    const now = Date.now();
    const existing = draft.id ? rules.find((rule) => rule.id === draft.id) : undefined;
    const rule: ForwardRule = {
      id: draft.id ?? createRuleId(),
      profileId: activeProfileId,
      name: draft.name.trim(),
      localHost: "127.0.0.1",
      localPort,
      targetHost: draft.targetHost.trim(),
      targetPort,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    setSaving(true);
    try {
      const saved = await saveForwardRule(rule);
      setRules((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      setDraft(null);
      toast.success(t("messages.saved"));
    } catch (error) {
      toast.error(tunnelExceptionText(t, error));
    } finally {
      setSaving(false);
    }
  };

  const startRule = async (rule: ForwardRule) => {
    if (!activeSessionId) {
      toast.error(t("errors.sessionMissing"));
      return;
    }
    setBusyRuleIds((current) => new Set(current).add(rule.id));
    try {
      applyRuntime(await startForward(rule.id, activeSessionId));
      toast.success(t("messages.listening", { address: `${rule.localHost}:${rule.localPort}` }));
    } catch (error) {
      toast.error(tunnelExceptionText(t, error));
      try {
        const current = await listForwardRuntimes();
        replaceRuntimes(current);
      } catch { /* 保留当前运行状态，错误已展示。 */ }
    } finally {
      setBusyRuleIds((current) => {
        const next = new Set(current);
        next.delete(rule.id);
        return next;
      });
    }
  };

  const stopRule = async (rule: ForwardRule) => {
    setBusyRuleIds((current) => new Set(current).add(rule.id));
    try {
      applyRuntime(await stopForward(rule.id));
      toast.success(t("messages.stopped"));
    } catch (error) {
      toast.error(tunnelExceptionText(t, error));
    } finally {
      setBusyRuleIds((current) => {
        const next = new Set(current);
        next.delete(rule.id);
        return next;
      });
    }
  };

  const confirmStart = () => {
    const rule = startTarget;
    setStartTarget(null);
    if (rule) void startRule(rule);
  };

  const removeRule = async () => {
    if (!deleteTarget) return;
    try {
      await deleteForwardRule(deleteTarget.id);
      setRules((current) => current.filter((rule) => rule.id !== deleteTarget.id));
      clearRuntime(deleteTarget.id);
      toast.success(t("messages.deleted"));
    } catch (error) {
      toast.error(tunnelExceptionText(t, error));
    } finally {
      setDeleteTarget(null);
    }
  };

  const copyLocalAddress = async (runtime?: ForwardRuntime) => {
    if (!runtime?.localAddress) return;
    try {
      await navigator.clipboard.writeText(runtime.localAddress);
      toast.success(t("messages.copied"));
    } catch {
      toast.error(t("messages.copyFailed"));
    }
  };

  const beginEdit = (rule: ForwardRule) => setDraft({
    id: rule.id,
    name: rule.name,
    localPort: String(rule.localPort),
    targetHost: rule.targetHost,
    targetPort: String(rule.targetPort),
  });

  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex h-[min(680px,calc(100vh-48px))] w-[min(980px,calc(100vw-32px))] max-w-[980px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-panel-header px-3">
          <div className="flex min-w-0 items-center gap-2"><GitFork size={14} className="text-accent" /><DialogTitle className="text-sm">{t("title")}</DialogTitle></div>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("close")} onClick={close}><X size={14} /></Button>
        </header>
        <DialogDescription className="border-b border-border/50 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          {t("description")}
        </DialogDescription>
        {!isTauri() && <div className="m-3 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-800 dark:text-amber-200">{t("desktopOnly")}</div>}
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-border/50 bg-panel/55 p-2" aria-label={t("groups")}>
            <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-semibold text-muted-foreground"><span>{t("servers")}</span><span>{profiles.length}</span></div>
            {profileGroups.map((group) => <section key={group} className="mb-2">
              <div className="truncate px-1 py-1 text-[9px] uppercase tracking-wide text-muted-foreground" title={group}>{group === "__ungrouped__" ? t("defaultGroup") : group}</div>
              {sortedProfiles.filter((profile) => (profile.group || "__ungrouped__") === group).map((profile) => <ProfileChoice key={profile.id} profile={profile} active={profile.id === activeProfileId} onClick={() => { setTunnelProfileId(profile.id); setDraft(null); }} />)}
            </section>)}
            {profiles.length === 0 && <div className="px-2 py-3 text-[10px] text-muted-foreground">{t("addServer")}</div>}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{activeProfile?.name ?? t("selectServer")}</div>
                {activeProfile && <div className="truncate font-mono text-[9px] text-muted-foreground">{activeProfile.username}@{activeProfile.host}:{activeProfile.port}</div>}
              </div>
              <div className="flex items-center gap-2">
                {connectedSessions.length > 1 ? <select className="h-7 max-w-52 rounded-sm border border-border bg-background px-2 text-[10px]" aria-label={t("selectSessionAria")} value={activeSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
                  <option value="">{t("selectConnectedSession")}</option>
                  {connectedSessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.username} · {session.attemptId.slice(0, 8)}</option>)}
                </select> : <span className={`text-[10px] ${connectedSessions.length ? "text-success" : "text-muted-foreground"}`}>{connectedSessions.length ? t("sshAuthenticated") : t("sshDisconnected")}</span>}
                <Button type="button" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!activeProfileId || !isTauri()} onClick={() => setDraft(emptyDraft())}><Plus size={12} />{t("addRule")}</Button>
              </div>
            </div>
            {draft && <form className="shrink-0 border-b border-border/50 bg-panel-header/35 p-3" onSubmit={(event) => void saveRule(event)}>
              <div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-medium">{draft.id ? t("editRule") : t("newRule")}</span><Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label={t("closeRuleForm")} onClick={() => setDraft(null)}><X size={12} /></Button></div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <Field label={t("ruleName")}><Input className="h-7 rounded-sm text-[11px]" maxLength={64} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("namePlaceholder")} /></Field>
                <Field label={t("remotePreset")}><select className="h-7 w-full rounded-sm border border-border bg-background px-2 text-[11px]" defaultValue="custom" onChange={(event) => {
                  const presets: Record<string, { name: string; port: string }> = { mysql: { name: "MySQL", port: "3306" }, postgres: { name: "PostgreSQL", port: "5432" }, redis: { name: "Redis", port: "6379" } };
                  const preset = presets[event.target.value];
                  if (preset) setDraft((current) => current ? { ...current, name: current.name || preset.name, targetPort: preset.port } : current);
                }}><option value="custom">{t("custom")}</option><option value="mysql">MySQL · 3306</option><option value="postgres">PostgreSQL · 5432</option><option value="redis">Redis · 6379</option></select></Field>
                <Field label={t("localListen")}><div className="flex h-7 items-center gap-2 rounded-sm border border-border bg-background px-2 font-mono text-[10px]"><span className="text-muted-foreground">127.0.0.1 :</span><input className="min-w-0 flex-1 bg-transparent outline-none" type="number" min={1} max={65535} required value={draft.localPort} onChange={(event) => setDraft({ ...draft, localPort: event.target.value })} aria-label={t("localPort")} /></div></Field>
                <Field label={t("remoteHost")}><Input className="h-7 rounded-sm font-mono text-[10px]" maxLength={255} required value={draft.targetHost} onChange={(event) => setDraft({ ...draft, targetHost: event.target.value })} placeholder={t("remoteHostPlaceholder")} /></Field>
                <Field label={t("remotePort")}><Input className="h-7 rounded-sm font-mono text-[10px]" type="number" min={1} max={65535} required value={draft.targetPort} onChange={(event) => setDraft({ ...draft, targetPort: event.target.value })} /></Field>
                <div className="col-span-2 flex justify-end gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" onClick={() => setDraft(null)}>{t("cancel")}</Button><Button type="submit" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={saving}>{saving && <LoaderCircle size={12} className="animate-spin" />}{saving ? t("saving") : t("saveRule")}</Button></div>
              </div>
            </form>}
            <div className="grid shrink-0 grid-cols-[minmax(100px,1fr)_150px_150px_78px_60px_136px] gap-2 border-b border-border/50 bg-panel-header/45 px-3 py-2 text-[9px] font-medium text-muted-foreground">
              <span>{t("name")}</span><span>{t("localListen")}</span><span>{t("remoteTarget")}</span><span>{t("status")}</span><span>{t("connections")}</span><span className="text-right">{t("actions")}</span>
            </div>
            <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
              {loading && <div className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle size={13} className="animate-spin" />{t("loading")}</div>}
              {!loading && profileRules.map((rule) => <ForwardRuleRow
                key={rule.id}
                rule={rule}
                runtime={runtimes[rule.id]}
                canStart={Boolean(activeSessionId)}
                disabled={!isTauri() || busyRuleIds.has(rule.id)}
                onStart={() => setStartTarget(rule)}
                onStop={() => void stopRule(rule)}
                onCopy={() => void copyLocalAddress(runtimes[rule.id])}
                onEdit={() => beginEdit(rule)}
                onDelete={() => setDeleteTarget(rule)}
              />)}
              {!loading && activeProfileId && profileRules.length === 0 && <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-[11px] text-muted-foreground"><GitFork size={20} className="opacity-40" />{t("empty")}<Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setDraft(emptyDraft())}><Plus size={12} />{t("addRuleButton")}</Button></div>}
              {!loading && !activeProfileId && profiles.length > 0 && <div className="px-3 py-6 text-center text-[10px] text-muted-foreground">{t("selectServerHint")}</div>}
            </div>
            {activeProfile && <footer className="shrink-0 border-t border-border/50 px-3 py-2 text-[9px] leading-4 text-muted-foreground">
              {t("footer")}
            </footer>}
          </main>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(startTarget)} onOpenChange={(next) => { if (!next) setStartTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{t("startTitle")}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("startDescription", { localPort: startTarget?.localPort ?? "", targetHost: startTarget?.targetHost ?? "", targetPort: startTarget?.targetPort ?? "" })}
        </AlertDialogDescription>
        <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("cancel")}</Button></AlertDialogCancel><Button type="button" size="sm" className="h-7 rounded-sm px-2" onClick={confirmStart}>{t("startButton")}</Button></div>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{t("deleteDescription", { name: deleteTarget?.name ?? "" })}</AlertDialogDescription>
        <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("cancel")}</Button></AlertDialogCancel><Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void removeRule()}>{t("deleteButton")}</Button></div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function ProfileChoice({ profile, active, onClick }: { profile: ConnectionProfile; active: boolean; onClick: () => void }) {
  return <button type="button" className={`mb-0.5 flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${active ? "bg-accent/10 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`} aria-current={active ? "true" : undefined} onClick={onClick}>
    <span className="w-full truncate text-[11px] font-medium">{profile.name}</span>
    <span className="w-full truncate font-mono text-[9px] text-muted-foreground">{profile.username}@{profile.host}</span>
  </button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-[9px] text-muted-foreground">{label}{children}</label>;
}

function ForwardRuleRow({ rule, runtime, canStart, disabled, onStart, onStop, onCopy, onEdit, onDelete }: {
  rule: ForwardRule;
  runtime?: ForwardRuntime;
  canStart: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTunnelTranslate();
  const state = runtime?.state ?? "stopped";
  const running = state === "running" || state === "starting" || state === "stopping";
  return <div className="grid min-h-12 grid-cols-[minmax(100px,1fr)_150px_150px_78px_60px_136px] items-center gap-2 border-b border-border/35 px-3 py-1.5 text-[10px] even:bg-panel-header/20">
    <span className="min-w-0 truncate font-medium" title={rule.name}>{rule.name}</span>
    <span className="truncate font-mono text-muted-foreground" title={`${rule.localHost}:${rule.localPort}`}>{rule.localHost}:{rule.localPort}</span>
    <span className="truncate font-mono text-muted-foreground" title={`${rule.targetHost}:${rule.targetPort}`}>{rule.targetHost}:{rule.targetPort}</span>
    <span className={`truncate ${state === "running" ? "text-success" : state === "error" ? "text-destructive" : "text-muted-foreground"}`} title={state === "error" ? tunnelErrorText(t, runtime?.lastErrorCode) : t(stateKey(state))}>
      {t(stateKey(state))}
      {runtime?.localAddress && <button type="button" className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground" title={t("copyAddress")} aria-label={t("copyAria", { address: runtime.localAddress })} onClick={onCopy}><Copy size={10} /></button>}
      {state === "error" && runtime?.lastErrorCode && <span className="sr-only">{tunnelErrorText(t, runtime.lastErrorCode)}</span>}
    </span>
    <span className="tabular-nums text-muted-foreground">{runtime?.activeConnections ?? 0}</span>
    <span className="flex justify-end gap-0.5">
      {state === "running" || state === "starting" ? <Button type="button" variant="outline" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || state === "starting"} aria-label={t("stopRuleAria", { name: rule.name })} title={t("stopAndRelease")} onClick={onStop}><Square size={11} /></Button> : <Button type="button" variant="outline" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || !canStart || state === "stopping"} aria-label={t("startRuleAria", { name: rule.name })} title={canStart ? t("startForward") : t("connectFirst")} onClick={onStart}><Power size={11} /></Button>}
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || running} aria-label={t("editRuleAria", { name: rule.name })} title={running ? t("stopBeforeEdit") : t("edit")} onClick={onEdit}><Pencil size={11} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" disabled={disabled || running} aria-label={t("deleteRuleAria", { name: rule.name })} title={running ? t("stopBeforeEdit") : t("delete")} onClick={onDelete}><Trash2 size={11} /></Button>
    </span>
  </div>;
}
