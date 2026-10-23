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

type RuleDraft = { id: string | null; name: string; localPort: string; targetHost: string; targetPort: string };

const emptyDraft = (): RuleDraft => ({ id: null, name: "", localPort: "13306", targetHost: "127.0.0.1", targetPort: "3306" });
const stateLabel: Record<TunnelState, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "出错",
};

function readableError(error: unknown) {
  if (typeof error === "string") {
    try { return (JSON.parse(error) as { message?: string }).message ?? error; } catch { return error; }
  }
  return error instanceof Error ? error.message : "端口转发操作失败。";
}

function createRuleId() {
  return globalThis.crypto?.randomUUID?.() ?? `forward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function TunnelManagerDialog() {
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
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ForwardRule | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const sortedProfiles = useMemo(() => [...profiles].sort((a, b) =>
    a.group.localeCompare(b.group, "zh-CN") || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "zh-CN")), [profiles]);
  const profileGroups = useMemo(() => [...new Set(sortedProfiles.map((profile) => profile.group || "默认分组"))], [sortedProfiles]);
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
      } catch (error) {
        if (active) {
          setHasLoaded(true);
          toast.error(`无法加载端口转发：${readableError(error)}`);
        }
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyRuntime, open, replaceRuntimes]);

  const loading = open && isTauri() && !hasLoaded;

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProfileId || !draft) return;
    const localPort = Number(draft.localPort);
    const targetPort = Number(draft.targetPort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535
      || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
      toast.error("端口必须是 1 到 65535 之间的整数。");
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
      toast.success("端口转发规则已保存。");
    } catch (error) {
      toast.error(`保存失败：${readableError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const startRule = async (rule: ForwardRule) => {
    if (!activeSessionId) {
      toast.error("请先连接此服务器，再启动端口转发。");
      return;
    }
    try {
      applyRuntime(await startForward(rule.id, activeSessionId));
      toast.success(`已监听 ${rule.localHost}:${rule.localPort}。`);
    } catch (error) {
      toast.error(`启动失败：${readableError(error)}`);
      try {
        const current = await listForwardRuntimes();
        replaceRuntimes(current);
      } catch { /* 保留当前运行状态，错误已展示。 */ }
    }
  };

  const stopRule = async (rule: ForwardRule) => {
    try {
      applyRuntime(await stopForward(rule.id));
      toast.success("端口转发已停止，监听端口已释放。");
    } catch (error) {
      toast.error(`停止失败：${readableError(error)}`);
    }
  };

  const removeRule = async () => {
    if (!deleteTarget) return;
    try {
      await deleteForwardRule(deleteTarget.id);
      setRules((current) => current.filter((rule) => rule.id !== deleteTarget.id));
      clearRuntime(deleteTarget.id);
      toast.success("端口转发规则已删除。");
    } catch (error) {
      toast.error(`删除失败：${readableError(error)}`);
    } finally {
      setDeleteTarget(null);
    }
  };

  const copyLocalAddress = async (runtime?: ForwardRuntime) => {
    if (!runtime?.localAddress) return;
    try {
      await navigator.clipboard.writeText(runtime.localAddress);
      toast.success("本地监听地址已复制。");
    } catch {
      toast.error("复制失败，请手动选中地址复制。");
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
      <DialogContent className="flex h-[min(680px,calc(100vh-48px))] max-w-[980px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-panel-header px-3">
          <div className="flex min-w-0 items-center gap-2"><GitFork size={14} className="text-accent" /><DialogTitle className="text-sm">端口转发</DialogTitle></div>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label="关闭端口转发" onClick={close}><X size={14} /></Button>
        </header>
        <DialogDescription className="border-b border-border/50 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          仅监听本机 127.0.0.1；隧道使用对应 SSH 会话，不会在应用重启后自动恢复。请先建立并验证 SSH 连接，再手动启动。
        </DialogDescription>
        {!isTauri() && <div className="m-3 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-800 dark:text-amber-200">端口转发需要在 TermVista 桌面应用中运行。</div>}
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-border/50 bg-panel/55 p-2" aria-label="服务器分组">
            <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-semibold text-muted-foreground"><span>服务器</span><span>{profiles.length}</span></div>
            {profileGroups.map((group) => <section key={group} className="mb-2">
              <div className="truncate px-1 py-1 text-[9px] uppercase tracking-wide text-muted-foreground" title={group}>{group}</div>
              {sortedProfiles.filter((profile) => (profile.group || "默认分组") === group).map((profile) => <ProfileChoice key={profile.id} profile={profile} active={profile.id === activeProfileId} onClick={() => { setTunnelProfileId(profile.id); setDraft(null); }} />)}
            </section>)}
            {profiles.length === 0 && <div className="px-2 py-3 text-[10px] text-muted-foreground">先在连接管理器中添加服务器。</div>}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{activeProfile?.name ?? "选择服务器"}</div>
                {activeProfile && <div className="truncate font-mono text-[9px] text-muted-foreground">{activeProfile.username}@{activeProfile.host}:{activeProfile.port}</div>}
              </div>
              <div className="flex items-center gap-2">
                {connectedSessions.length > 1 ? <select className="h-7 max-w-52 rounded-sm border border-border bg-background px-2 text-[10px]" aria-label="选择已认证 SSH 会话" value={activeSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
                  <option value="">选择已连接会话</option>
                  {connectedSessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.username} · {session.attemptId.slice(0, 8)}</option>)}
                </select> : <span className={`text-[10px] ${connectedSessions.length ? "text-success" : "text-muted-foreground"}`}>{connectedSessions.length ? "SSH 已认证" : "SSH 未连接"}</span>}
                <Button type="button" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={!activeProfileId || !isTauri()} onClick={() => setDraft(emptyDraft())}><Plus size={12} />新增转发</Button>
              </div>
            </div>
            {draft && <form className="shrink-0 border-b border-border/50 bg-panel-header/35 p-3" onSubmit={(event) => void saveRule(event)}>
              <div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-medium">{draft.id ? "编辑转发规则" : "新建转发规则"}</span><Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label="关闭规则表单" onClick={() => setDraft(null)}><X size={12} /></Button></div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <Field label="规则名称"><Input className="h-7 rounded-sm text-[11px]" maxLength={64} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：开发数据库" /></Field>
                <Field label="远端服务预设"><select className="h-7 w-full rounded-sm border border-border bg-background px-2 text-[11px]" defaultValue="custom" onChange={(event) => {
                  const presets: Record<string, { name: string; port: string }> = { mysql: { name: "MySQL", port: "3306" }, postgres: { name: "PostgreSQL", port: "5432" }, redis: { name: "Redis", port: "6379" } };
                  const preset = presets[event.target.value];
                  if (preset) setDraft((current) => current ? { ...current, name: current.name || preset.name, targetPort: preset.port } : current);
                }}><option value="custom">自定义</option><option value="mysql">MySQL · 3306</option><option value="postgres">PostgreSQL · 5432</option><option value="redis">Redis · 6379</option></select></Field>
                <Field label="本机监听"><div className="flex h-7 items-center gap-2 rounded-sm border border-border bg-background px-2 font-mono text-[10px]"><span className="text-muted-foreground">127.0.0.1 :</span><input className="min-w-0 flex-1 bg-transparent outline-none" type="number" min={1} max={65535} required value={draft.localPort} onChange={(event) => setDraft({ ...draft, localPort: event.target.value })} aria-label="本地监听端口" /></div></Field>
                <Field label="远端主机"><Input className="h-7 rounded-sm font-mono text-[10px]" maxLength={255} required value={draft.targetHost} onChange={(event) => setDraft({ ...draft, targetHost: event.target.value })} placeholder="127.0.0.1 或 db.example.com" /></Field>
                <Field label="远端端口"><Input className="h-7 rounded-sm font-mono text-[10px]" type="number" min={1} max={65535} required value={draft.targetPort} onChange={(event) => setDraft({ ...draft, targetPort: event.target.value })} /></Field>
                <div className="col-span-2 flex justify-end gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" onClick={() => setDraft(null)}>取消</Button><Button type="submit" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={saving}>{saving && <LoaderCircle size={12} className="animate-spin" />}{saving ? "保存中…" : "保存规则"}</Button></div>
              </div>
            </form>}
            <div className="grid shrink-0 grid-cols-[minmax(100px,1fr)_150px_150px_78px_60px_136px] gap-2 border-b border-border/50 bg-panel-header/45 px-3 py-2 text-[9px] font-medium text-muted-foreground">
              <span>名称</span><span>本地监听</span><span>远端目标</span><span>状态</span><span>连接</span><span className="text-right">操作</span>
            </div>
            <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
              {loading && <div className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle size={13} className="animate-spin" />读取转发规则…</div>}
              {!loading && profileRules.map((rule) => <ForwardRuleRow
                key={rule.id}
                rule={rule}
                runtime={runtimes[rule.id]}
                canStart={Boolean(activeSessionId)}
                disabled={!isTauri()}
                onStart={() => void startRule(rule)}
                onStop={() => void stopRule(rule)}
                onCopy={() => void copyLocalAddress(runtimes[rule.id])}
                onEdit={() => beginEdit(rule)}
                onDelete={() => setDeleteTarget(rule)}
              />)}
              {!loading && activeProfileId && profileRules.length === 0 && <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-[11px] text-muted-foreground"><GitFork size={20} className="opacity-40" />此服务器还没有端口转发规则<Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setDraft(emptyDraft())}><Plus size={12} />新增规则</Button></div>}
              {!loading && !activeProfileId && profiles.length > 0 && <div className="px-3 py-6 text-center text-[10px] text-muted-foreground">选择左侧服务器以查看端口转发。</div>}
            </div>
            {activeProfile && <footer className="shrink-0 border-t border-border/50 px-3 py-2 text-[9px] leading-4 text-muted-foreground">
              目标由 SSH 服务端解析并连接。远端数据库若只允许服务器本机访问，目标主机可填 127.0.0.1。断线后监听会释放，重连后需手动启动。
            </footer>}
          </main>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>删除端口转发规则？</AlertDialogTitle>
        <AlertDialogDescription>删除“{deleteTarget?.name}”。运行中的规则必须先停止，删除后不会再自动恢复。</AlertDialogDescription>
        <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">取消</Button></AlertDialogCancel><Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void removeRule()}>删除规则</Button></div>
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
  const state = runtime?.state ?? "stopped";
  const running = state === "running" || state === "starting" || state === "stopping";
  return <div className="grid min-h-12 grid-cols-[minmax(100px,1fr)_150px_150px_78px_60px_136px] items-center gap-2 border-b border-border/35 px-3 py-1.5 text-[10px] even:bg-panel-header/20">
    <span className="min-w-0 truncate font-medium" title={rule.name}>{rule.name}</span>
    <span className="truncate font-mono text-muted-foreground" title={`${rule.localHost}:${rule.localPort}`}>{rule.localHost}:{rule.localPort}</span>
    <span className="truncate font-mono text-muted-foreground" title={`${rule.targetHost}:${rule.targetPort}`}>{rule.targetHost}:{rule.targetPort}</span>
    <span className={`truncate ${state === "running" ? "text-success" : state === "error" ? "text-destructive" : "text-muted-foreground"}`} title={runtime?.lastErrorMessage ?? stateLabel[state]}>
      {stateLabel[state]}
      {runtime?.localAddress && <button type="button" className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground" title="复制本地监听地址" aria-label={`复制 ${runtime.localAddress}`} onClick={onCopy}><Copy size={10} /></button>}
      {state === "error" && runtime?.lastErrorMessage && <span className="sr-only">：{runtime.lastErrorMessage}</span>}
    </span>
    <span className="tabular-nums text-muted-foreground">{runtime?.activeConnections ?? 0}</span>
    <span className="flex justify-end gap-0.5">
      {state === "running" || state === "starting" ? <Button type="button" variant="outline" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || state === "starting"} aria-label={`停止 ${rule.name}`} title="停止并释放端口" onClick={onStop}><Square size={11} /></Button> : <Button type="button" variant="outline" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || !canStart || state === "stopping"} aria-label={`启动 ${rule.name}`} title={canStart ? "启动端口转发" : "请先连接此服务器"} onClick={onStart}><Power size={11} /></Button>}
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" disabled={disabled || running} aria-label={`编辑 ${rule.name}`} title={running ? "请先停止规则再编辑" : "编辑"} onClick={onEdit}><Pencil size={11} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" disabled={disabled || running} aria-label={`删除 ${rule.name}`} title={running ? "请先停止规则再删除" : "删除"} onClick={onDelete}><Trash2 size={11} /></Button>
    </span>
  </div>;
}
