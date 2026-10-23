import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Clock3, Folder, FolderOpen, FolderPlus, GitFork, KeyRound, Pencil, Plus, Search, Server, ShieldCheck, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { profileDropInsertionIndex } from "@/features/connections/profileTree";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useWorkspaceStore, type AuthMethod, type ConnectionGroup, type ConnectionProfile, type ServerEnvironment } from "@/stores/workspaceStore";
import { forgetSavedCredential, forgetTrustedHost, listTrustedHosts, connectProfile, saveSshPassword, type TrustedHostSummary } from "@/features/ssh/sshBridge";
import { takeManagerOpener } from "@/features/connections/managerFocus";
import { createConnectionGroup, createProfileId, deleteConnectionGroup, deleteConnectionProfile, importSshConfig, loadConnectionGroups, moveConnectionGroup, moveConnectionProfile, previewSshConfig, refreshConnectionProfiles, renameConnectionGroup, saveConnectionProfile, type SshConfigPreview } from "@/features/connections/profileBridge";
import { listSshKeys, type SshKeyMetadata } from "@/features/settings/sshKeyBridge";

type ProfileDraft = {
  name: string;
  host: string;
  port: string;
  username: string;
  group: string;
  groupId: string;
  environment: ServerEnvironment;
  authMethod: AuthMethod;
  password: string;
  rememberPassword: boolean;
  privateKeyPath: string;
  keyRef: string;
  autoReconnect: boolean;
};

type GroupDialogState =
  | { kind: "create"; parentId: string | null; name: string }
  | { kind: "rename"; groupId: string; name: string }
  | null;

const emptyDraft = (): ProfileDraft => ({
  name: "",
  host: "",
  port: "22",
  username: "",
  group: "默认分组",
  groupId: "",
  environment: "development",
  authMethod: "password",
  password: "",
  rememberPassword: false,
  privateKeyPath: "",
  keyRef: "",
  autoReconnect: false,
});

const environmentLabel: Record<ServerEnvironment, string> = {
  production: "生产",
  test: "测试",
  development: "开发",
};

export function ConnectionManagerDialog() {
  const open = useWorkspaceStore((state) => state.managerOpen);
  const setOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const view = useWorkspaceStore((state) => state.managerView);
  const setView = useWorkspaceStore((state) => state.setManagerView);
  const openTunnelManager = useWorkspaceStore((state) => state.openTunnelManager);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const addProfile = useWorkspaceStore((state) => state.addProfile);
  const updateProfile = useWorkspaceStore((state) => state.updateProfile);
  const removeProfile = useWorkspaceStore((state) => state.removeProfile);
  const toggleFavorite = useWorkspaceStore((state) => state.toggleFavorite);
  const clearManagerEditRequest = useWorkspaceStore((state) => state.clearManagerProfileEditRequest);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState>(null);
  const [groupDialogBusy, setGroupDialogBusy] = useState(false);
  const [pendingCredentialChange, setPendingCredentialChange] = useState<{ profile: ConnectionProfile; draft: ProfileDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null);
  const [deleteCredentials, setDeleteCredentials] = useState(true);
  const [confirmForgetId, setConfirmForgetId] = useState<string | null>(null);
  const [trustedHosts, setTrustedHosts] = useState<TrustedHostSummary[]>([]);
  const [confirmTrustedHost, setConfirmTrustedHost] = useState<string | null>(null);
  const [sshConfigPreview, setSshConfigPreview] = useState<SshConfigPreview | null>(null);
  const [sshConfigSelection, setSshConfigSelection] = useState<Set<string>>(new Set());
  const [sshConfigBusy, setSshConfigBusy] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return profiles;
    return profiles.filter((profile) => [
      profile.name,
      profile.host,
      profile.username,
      profile.group,
      String(profile.port),
      environmentLabel[profile.environment],
    ].some((value) => value.toLocaleLowerCase().includes(term)));
  }, [profiles, search]);

  const refreshTree = useCallback(async () => {
    const [nextGroups, nextProfiles] = await Promise.all([
      loadConnectionGroups(),
      refreshConnectionProfiles(),
    ]);
    setGroups(nextGroups);
    if (nextProfiles) useWorkspaceStore.getState().replaceProfiles(nextProfiles);
  }, []);

  useEffect(() => {
    if (!open || view !== "connections") return;
    let active = true;
    void Promise.all([loadConnectionGroups(), refreshConnectionProfiles()]).then(([nextGroups, nextProfiles]) => {
      if (!active) return;
      setGroups(nextGroups);
      if (nextProfiles) useWorkspaceStore.getState().replaceProfiles(nextProfiles);
    }).catch((error: unknown) => {
      if (active) toast.error(`读取连接分组失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, [open, view, refreshTree]);

  useEffect(() => {
    if (!open || view !== "trustedHosts") return;
    let active = true;
    void listTrustedHosts().then((items) => {
      if (active) setTrustedHosts(items);
    }).catch((error: unknown) => {
      if (active) toast.error(`读取可信主机记录失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, [open, view]);

  const showNewForm = () => {
    setEditingId(null);
    setDraft({ ...emptyDraft(), groupId: groups.find((group) => !group.parentId)?.id ?? "" });
    setFormOpen(true);
  };

  const editProfile = useCallback((profile: ConnectionProfile) => {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      host: profile.host,
      port: String(profile.port || 22),
      username: profile.username === "未设置" ? "" : profile.username,
      group: profile.group,
      groupId: profile.groupId ?? groups.find((group) => groupPathForId(group.id, groups) === profile.group)?.id ?? "",
      environment: profile.environment,
      authMethod: profile.authMethod,
      password: "",
      rememberPassword: false,
      privateKeyPath: profile.privateKeyPath,
      keyRef: profile.keyRef ?? "",
      autoReconnect: profile.autoReconnect,
    });
    setFormOpen(true);
  }, [groups]);

  useEffect(() => useWorkspaceStore.subscribe((state, previous) => {
    if (!state.managerEditProfileId || state.managerEditProfileId === previous.managerEditProfileId) return;
    const profile = state.profiles.find((item) => item.id === state.managerEditProfileId);
    window.requestAnimationFrame(() => {
      if (profile) editProfile(profile);
      clearManagerEditRequest();
    });
  }), [clearManagerEditRequest, editProfile]);

  const persistDraft = async (values: ProfileDraft, clearPreviousCredentials = false) => {
    const port = Number(values.port);
    if (!values.name.trim() || !values.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) return;
    if (values.password && values.rememberPassword && !values.username.trim()) {
      toast.error("要安全保存 SSH 密码，请先填写服务器用户名。");
      return;
    }
    const previous = profiles.find((profile) => profile.id === editingId);
    if (previous && clearPreviousCredentials) {
      try {
        await forgetSavedCredential(previous);
      } catch (error) {
        toast.error(`旧凭据未能清除，配置没有修改：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const group = values.groupId ? groupPathForId(values.groupId, groups) : values.group.trim() || "默认分组";
    const groupId = values.groupId || groups.find((item) => groupPathForId(item.id, groups) === group)?.id;
    const sortOrder = previous && (previous.groupId ?? null) === (groupId ?? null)
      ? previous.sortOrder ?? 0
      : Math.max(-1, ...profiles
          .filter((profile) => (profile.groupId ?? null) === (groupId ?? null) && profile.id !== previous?.id)
          .map((profile) => profile.sortOrder ?? 0)) + 1;
    const next = {
      name: values.name.trim(),
      host: values.host.trim(),
      port,
      username: values.username.trim() || "未设置",
      group,
      groupId,
      sortOrder,
      environment: values.environment,
      authMethod: values.authMethod,
      privateKeyPath: values.authMethod === "privateKey" && !values.keyRef ? values.privateKeyPath.trim() : "",
      keyRef: values.authMethod === "privateKey" ? values.keyRef || undefined : undefined,
      favorite: previous?.favorite ?? false,
      autoReconnect: values.autoReconnect,
      credentialAccounts: clearPreviousCredentials ? [] : previous?.credentialAccounts ?? [],
    };
    const savedProfile: ConnectionProfile = {
      ...next,
      id: previous?.id ?? createProfileId(),
      ...(previous?.lastConnectedAt ? { lastConnectedAt: previous.lastConnectedAt } : {}),
    };
    try {
      await saveConnectionProfile(savedProfile);
    } catch (error) {
      toast.error(`无法保存服务器配置：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let credentialAccounts = savedProfile.credentialAccounts;
    if (values.authMethod === "password" && values.password && values.rememberPassword) {
      try {
        const credentialProfile = await saveSshPassword(savedProfile, values.password);
        credentialAccounts = credentialProfile.credentialAccounts;
        toast.success("SSH 密码已安全保存到本机保险库。");
      } catch (error) {
        toast.error(`服务器配置已保存，但密码未能安全保存：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const profileValues = { ...next, credentialAccounts };
    if (previous) updateProfile(previous.id, profileValues);
    else addProfile(profileValues, savedProfile.id);
    setFormOpen(false);
    setEditingId(null);
    setDraft(emptyDraft());
    setPendingCredentialChange(null);
  };

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const previous = profiles.find((profile) => profile.id === editingId);
    if (previous && (previous.username !== (draft.username.trim() || "未设置") || previous.authMethod !== draft.authMethod || previous.keyRef !== (draft.keyRef || undefined))) {
      setPendingCredentialChange({ profile: previous, draft });
      return;
    }
    void persistDraft(draft);
  };

  const connect = (profile: ConnectionProfile) => {
    void connectProfile(profile);
    setOpen(false);
  };

  const forgetCredentials = async (profile: ConnectionProfile) => {
    try {
      await forgetSavedCredential(profile);
      setConfirmForgetId(null);
      toast.success(`已忘记 ${profile.name} 的 SSH 凭据。`);
    } catch (error) {
      toast.error(`无法清除系统凭据：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteCredentials) {
      try {
        await forgetSavedCredential(deleteTarget);
      } catch (error) {
        toast.error(`系统凭据未能清除，配置没有删除：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try {
      await deleteConnectionProfile(deleteTarget.id);
    } catch (error) {
      toast.error(`无法删除服务器配置：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    removeProfile(deleteTarget.id);
    setDeleteTarget(null);
  };

  const toggleFavoritePersisted = async (profile: ConnectionProfile) => {
    try {
      await saveConnectionProfile({ ...profile, favorite: !profile.favorite });
      toggleFavorite(profile.id);
    } catch (error) {
      toast.error(`无法保存收藏状态：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeTrust = async (record: TrustedHostSummary) => {
    const id = `${record.host}:${record.port}`;
    try {
      await forgetTrustedHost(record.host, record.port);
      setTrustedHosts(await listTrustedHosts());
      setConfirmTrustedHost(null);
      toast.success(`已撤销 ${id} 的永久信任；下次连接会重新要求核对指纹。`);
    } catch (error) {
      toast.error(`无法撤销主机信任：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const chooseSshConfig = async () => {
    if (!isTauri()) {
      toast.error("SSH Config 导入需要在桌面应用中使用。");
      return;
    }
    const selectedPath = await openFileDialog({
      multiple: false,
      directory: false,
      title: "选择 SSH Config 文件",
      filters: [{ name: "SSH Config", extensions: ["config", "conf", "txt"] }],
    });
    if (typeof selectedPath !== "string") return;
    setSshConfigBusy(true);
    try {
      const preview = await previewSshConfig(selectedPath);
      setSshConfigPreview(preview);
      setSshConfigSelection(new Set(preview.entries.filter((entry) => {
        const nameExists = profiles.some((profile) => profile.name.toLocaleLowerCase() === entry.alias.toLocaleLowerCase());
        return entry.importable && !nameExists;
      }).map((entry) => entry.alias)));
    } catch (error) {
      toast.error(`无法预览 SSH Config：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSshConfigBusy(false);
    }
  };

  const importSelectedSshConfig = async () => {
    if (!sshConfigPreview || sshConfigSelection.size === 0) return;
    setSshConfigBusy(true);
    try {
      const result = await importSshConfig(sshConfigPreview.sourcePath, [...sshConfigSelection]);
      await refreshTree();
      const skipped = result.skippedExistingNames.length;
      toast.success(`已导入 ${result.imported.length} 个连接${skipped ? `，跳过 ${skipped} 个同名配置` : ""}。`);
      setSshConfigPreview(null);
    } catch (error) {
      toast.error(`无法导入 SSH Config：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSshConfigBusy(false);
    }
  };

  const createGroup = (parentId: string | null) => {
    setGroupDialog({ kind: "create", parentId, name: "" });
  };

  const renameGroup = (group: ConnectionGroup) => {
    setGroupDialog({ kind: "rename", groupId: group.id, name: group.name });
  };

  const submitGroupDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!groupDialog || groupDialogBusy) return;
    const name = groupDialog.name.trim();
    if (!name) return;
    if (groupDialog.kind === "rename" && groups.find((group) => group.id === groupDialog.groupId)?.name === name) {
      setGroupDialog(null);
      return;
    }
    setGroupDialogBusy(true);
    try {
      if (groupDialog.kind === "create") {
        await createConnectionGroup(name, groupDialog.parentId);
        toast.success(`已创建分组“${name}”。`);
      } else {
        await renameConnectionGroup(groupDialog.groupId, name);
        toast.success("已修改分组名称。");
      }
      await refreshTree();
      setGroupDialog(null);
    } catch (error) {
      toast.error(`无法${groupDialog.kind === "create" ? "创建" : "修改"}分组：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setGroupDialogBusy(false);
    }
  };

  const removeGroup = async (group: ConnectionGroup) => {
    if (!window.confirm(`删除空分组“${group.name}”？`)) return;
    try {
      const deleted = await deleteConnectionGroup(group.id);
      if (!deleted) {
        toast.error("该分组中仍有服务器或子分组，请先移动它们。");
        return;
      }
      await refreshTree();
      toast.success(`已删除分组“${group.name}”。`);
    } catch (error) {
      toast.error(`无法删除分组：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const moveProfileToGroup = async (profileId: string, groupId: string | null, requestedOrder?: number) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    try {
      const siblings = profiles
        .filter((item) => (item.groupId ?? null) === groupId && item.id !== profileId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
      const sortOrder = requestedOrder ?? siblings.length;
      if ((profile.groupId ?? null) === groupId && profile.sortOrder === sortOrder) return;
      await moveConnectionProfile(profileId, groupId, sortOrder);
      await refreshTree();
    } catch (error) {
      toast.error(`无法移动服务器：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const moveGroupInto = async (groupId: string, parentId: string | null, requestedOrder?: number) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group || group.id === parentId) return;
    try {
      const siblings = groups
        .filter((item) => item.parentId === parentId && item.id !== groupId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      const sortOrder = requestedOrder ?? siblings.length;
      if (group.parentId === parentId && group.sortOrder === sortOrder) return;
      await moveConnectionGroup(groupId, parentId, sortOrder);
      await refreshTree();
    } catch (error) {
      toast.error(`无法移动分组：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const rowKeyDown = (event: KeyboardEvent<HTMLDivElement>, profile: ConnectionProfile) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      connect(profile);
    }
  };

  const renderProfile = (profile: ConnectionProfile) => <ContextMenu key={profile.id}>
    <ContextMenuTrigger asChild><div className="border-b border-border/60 py-1.5">
    <div className="flex items-center justify-between gap-2">
      <div role="button" tabIndex={0} className="min-w-0 flex-1 cursor-default rounded-sm px-1 py-1 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-accent" onDoubleClick={() => connect(profile)} onKeyDown={(event) => rowKeyDown(event, profile)} title="双击或按 Enter 连接">
        <div className="flex items-center gap-1.5">
          {profile.favorite && <Star size={10} className="shrink-0 fill-amber-500 text-amber-500" aria-label="已收藏" />}
          <span className="truncate text-xs font-medium">{profile.name}</span>
          <span className={`rounded-sm border px-1 text-[9px] leading-[14px] ${profile.environment === "production" ? "border-amber-500/50 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}>{environmentLabel[profile.environment]}</span>
          {profile.autoReconnect && <span className="rounded-sm border border-accent/50 px-1 text-[9px] leading-[14px] text-accent">自动重连</span>}
          {profile.lastConnectedAt && <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 size={9} />{formatRecentTime(profile.lastConnectedAt)}</span>}
        </div>
        <div className="mt-0.5 truncate pl-0.5 font-mono text-[10px] text-muted-foreground">{profile.username}@{profile.host}:{profile.port || 22}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon" className={`h-6 w-6 rounded-sm ${profile.favorite ? "text-amber-500" : "text-muted-foreground"}`} aria-label={profile.favorite ? `取消收藏 ${profile.name}` : `收藏 ${profile.name}`} title={profile.favorite ? "取消收藏" : "收藏"} onClick={() => void toggleFavoritePersisted(profile)}><Star size={13} fill={profile.favorite ? "currentColor" : "none"} /></Button>
        <Button type="button" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => connect(profile)}>连接</Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={`编辑 ${profile.name}`} title="编辑" onClick={() => editProfile(profile)}><Pencil size={12} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={`忘记 ${profile.name} 的凭据`} title="忘记已存凭据" onClick={() => setConfirmForgetId(confirmForgetId === profile.id ? null : profile.id)}><KeyRound size={12} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" aria-label={`删除配置 ${profile.name}`} title="删除配置" onClick={() => { setDeleteCredentials(true); setDeleteTarget(profile); }}><Trash2 size={12} /></Button>
      </div>
    </div>
    {confirmForgetId === profile.id && <div className="ml-1 mt-1 flex items-center justify-between gap-2 rounded-sm border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[10px]">
      <span className="text-muted-foreground">清除该配置关联的已保存密码和私钥口令？</span>
      <span className="flex shrink-0 gap-1"><Button type="button" size="sm" variant="ghost" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setConfirmForgetId(null)}>取消</Button><Button type="button" size="sm" variant="destructive" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void forgetCredentials(profile)}>忘记</Button></span>
    </div>}
    </div></ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => connect(profile)}><Server size={12} />连接</ContextMenuItem>
      <ContextMenuItem onSelect={() => openTunnelManager(profile.id)}><GitFork size={12} />端口转发…</ContextMenuItem>
      <ContextMenuItem onSelect={() => editProfile(profile)}><Pencil size={12} />编辑</ContextMenuItem>
      <ContextMenuItem onSelect={() => void toggleFavoritePersisted(profile)}><Star size={12} />{profile.favorite ? "取消收藏" : "收藏"}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setConfirmForgetId(profile.id)}><KeyRound size={12} />忘记已保存凭据…</ContextMenuItem>
      <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setDeleteCredentials(true); setDeleteTarget(profile); }}><Trash2 size={12} />删除配置…</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;

  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setView("connections");
    }}>
      <DialogContent
        className="gap-0 p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = takeManagerOpener();
          window.requestAnimationFrame(() => {
            if (target?.isConnected) target.focus({ preventScroll: true });
          });
        }}
      >
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel-header px-3">
          <div className="flex items-center gap-2"><FolderOpen size={14} className="text-accent" /><DialogTitle>连接管理器</DialogTitle></div>
          <div className="flex items-center gap-1">
            <Button type="button" variant={view === "connections" ? "secondary" : "ghost"} size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setView("connections")}>服务器</Button>
            <Button type="button" variant={view === "trustedHosts" ? "secondary" : "ghost"} size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => { setView("trustedHosts"); setFormOpen(false); }}><ShieldCheck size={12} />可信主机</Button>
          </div>
          <DialogDescription className="sr-only">管理本机连接配置和 SSH 主机信任记录。</DialogDescription>
        </header>

        {view === "connections" ? <>
          {formOpen ? <div className="flex h-9 items-center gap-2 border-b border-border bg-panel-header/35 px-4">
            <Server size={13} className="text-accent" />
            <span className="text-xs font-semibold">{editingId ? "编辑服务器配置" : "新增服务器配置"}</span>
          </div> : <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-7 rounded-sm pl-7 text-xs" placeholder="搜索名称、主机、用户、端口或环境" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" onClick={() => void createGroup(null)}><FolderPlus size={13} />新建分组</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" disabled={sshConfigBusy} onClick={() => void chooseSshConfig()}><FolderOpen size={13} />导入 Config</Button>
            <Button type="button" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" onClick={showNewForm}><Plus size={13} />新增配置</Button>
          </div>}
          <div className={`compact-scrollbar overflow-y-auto ${formOpen ? "max-h-[calc(100vh-112px)] min-h-0 px-4 py-4" : "max-h-[min(500px,58vh)] min-h-36 px-3 py-2"}`}>
            {formOpen ? <ProfileForm draft={draft} setDraft={setDraft} groups={groups} editing={Boolean(editingId)} onSubmit={submitProfile} onCancel={() => { setFormOpen(false); setEditingId(null); setDraft(emptyDraft()); }} /> : filtered.length === 0 && groups.length === 0 ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Server size={18} strokeWidth={1.5} />
                <span>{search ? "没有匹配的服务器" : "暂无已保存配置"}</span>
                {!search && <span className="max-w-72 text-[10px]">添加服务器配置后可双击或按 Enter 连接；密码可选择安全保存到本机保险库。</span>}
              </div>
            ) : <ConnectionGroupTree
              groups={groups}
              profiles={filtered}
              dragEnabled={!search.trim()}
              renderProfile={renderProfile}
              onCreateChild={(parentId) => void createGroup(parentId)}
              onRename={(group) => void renameGroup(group)}
              onDelete={(group) => void removeGroup(group)}
              onMoveProfile={(profileId, groupId) => void moveProfileToGroup(profileId, groupId)}
              onMoveGroup={(groupId, parentId) => void moveGroupInto(groupId, parentId)}
            />}
          </div>
        </> : <>
          <div className="compact-scrollbar max-h-[min(500px,58vh)] min-h-36 overflow-y-auto px-3 py-2">
            <p className="mb-2 text-[10px] leading-4 text-muted-foreground">永久信任仅在服务器公钥与记录完全一致时自动通过。撤销记录后，下次连接会重新显示指纹确认。</p>
            {trustedHosts.length === 0 ? <div className="flex min-h-32 items-center justify-center text-xs text-muted-foreground">暂无永久保存的主机指纹</div> : trustedHosts.map((record) => {
              const id = `${record.host}:${record.port}`;
              const confirming = confirmTrustedHost === id;
              return <div key={id} className="border-b border-border/60 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{id}<span className="ml-2 font-sans text-[10px] text-muted-foreground">{record.keyType}</span></div>
                    <div className="mt-1 break-all font-mono text-[10px] text-accent">{record.fingerprintSha256}</div>
                    <div className="mt-1 text-[9px] text-muted-foreground">首次确认 {new Date(record.firstTrustedAt * 1000).toLocaleString()} · 最近验证 {new Date(record.lastVerifiedAt * 1000).toLocaleString()}</div>
                  </div>
                  <Button type="button" variant={confirming ? "destructive" : "outline"} size="sm" className="h-6 shrink-0 rounded-sm px-2 text-[10px]" onClick={() => confirming ? void removeTrust(record) : setConfirmTrustedHost(id)}>{confirming ? "确认撤销" : "撤销信任"}</Button>
                </div>
                {confirming && <div className="mt-1 flex justify-end"><Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setConfirmTrustedHost(null)}>取消</Button></div>}
              </div>;
            })}
          </div>
          <footer className="flex min-h-8 items-center justify-between border-t border-border bg-panel-header px-3 text-[10px] text-muted-foreground"><span>指纹记录只存主机公钥，不包含登录凭据</span><span>{trustedHosts.length} 台服务器</span></footer>
        </>}
      </DialogContent>

      <Dialog open={Boolean(groupDialog)} onOpenChange={(next) => { if (!next && !groupDialogBusy) setGroupDialog(null); }}>
        <DialogContent className="w-[min(420px,calc(100vw-40px))] max-w-none gap-0 overflow-hidden p-0">
          {groupDialog && <form onSubmit={(event) => void submitGroupDialog(event)}>
            <header className="flex items-start gap-3 border-b border-border bg-panel-header/45 px-5 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent/15 bg-accent/8 text-accent">
                {groupDialog.kind === "create" ? <FolderPlus size={16} /> : <Pencil size={15} />}
              </span>
              <div className="min-w-0 pt-0.5">
                <DialogTitle className="text-sm">{groupDialog.kind === "create" ? groupDialog.parentId ? "新建子分组" : "新建分组" : "修改分组名称"}</DialogTitle>
                <DialogDescription className="mt-1 text-[11px] leading-4">
                  {groupDialog.kind === "rename"
                    ? "修改名称不会影响分组中的服务器配置。"
                    : groupDialog.parentId
                      ? `将在「${groups.find((group) => group.id === groupDialog.parentId)?.name ?? "上级分组"}」下创建。`
                      : "按环境或用途整理本机保存的服务器连接。"}
                </DialogDescription>
              </div>
            </header>
            <div className="space-y-2 px-5 py-5">
              <label htmlFor="connection-group-name" className="block text-xs font-medium">分组名称</label>
              <Input id="connection-group-name" autoFocus maxLength={80} placeholder="例如：生产环境" className="h-9 rounded-sm text-xs" value={groupDialog.name} onChange={(event) => setGroupDialog((current) => current ? { ...current, name: event.target.value } : current)} />
              <p className="text-[10px] leading-4 text-muted-foreground">名称仅用于连接管理器中的本机整理。</p>
            </div>
            <footer className="flex justify-end gap-2 border-t border-border bg-panel-header/30 px-5 py-3">
              <Button type="button" variant="ghost" size="sm" className="h-8 rounded-sm px-3 text-xs" disabled={groupDialogBusy} onClick={() => setGroupDialog(null)}>取消</Button>
              <Button type="submit" size="sm" className="h-8 rounded-sm px-3 text-xs" disabled={!groupDialog.name.trim() || groupDialogBusy}>{groupDialogBusy ? "正在保存…" : groupDialog.kind === "create" ? "创建分组" : "保存名称"}</Button>
            </footer>
          </form>}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingCredentialChange)} onOpenChange={(next) => { if (!next) setPendingCredentialChange(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>连接账户或认证方式已更改</AlertDialogTitle>
          <AlertDialogDescription>旧凭据仍绑定在原账户和认证方式下，不会转移。你可以同时清除旧凭据，或保留以便以后手动清理。</AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">取消修改</Button></AlertDialogCancel>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-2" onClick={() => pendingCredentialChange && void persistDraft(pendingCredentialChange.draft)}>保留旧凭据</Button>
            <Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => pendingCredentialChange && void persistDraft(pendingCredentialChange.draft, true)}>清除并更新</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>删除服务器配置？</AlertDialogTitle>
          <AlertDialogDescription>删除 {deleteTarget?.name} 的本机连接配置和该服务器下保存的端口转发规则。运行中的转发会停止；共享主机指纹信任记录不会受影响。</AlertDialogDescription>
          <label className="flex items-start gap-2 text-[11px] leading-4 text-foreground"><input type="checkbox" checked={deleteCredentials} onChange={(event) => setDeleteCredentials(event.target.checked)} className="mt-0.5 accent-primary" /><span>同时清除关联的已保存密码和私钥口令</span></label>
          {!deleteCredentials && <p className="text-[10px] text-amber-700 dark:text-amber-300">已保存凭据会保留在本机加密保险库中，以后仍可手动清除。</p>}
          <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">取消</Button></AlertDialogCancel><Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void confirmDelete()}>删除配置</Button></div>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(sshConfigPreview)} onOpenChange={(next) => { if (!next && !sshConfigBusy) setSshConfigPreview(null); }}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center justify-between border-b border-border bg-panel-header px-3">
            <div className="flex items-center gap-2"><FolderOpen size={14} className="text-accent" /><DialogTitle>预览 SSH Config</DialogTitle></div>
            <DialogDescription className="sr-only">选择静态主机项并导入为本机连接配置。</DialogDescription>
          </header>
          {sshConfigPreview && <>
            <div className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
              <p className="truncate font-mono" title={sshConfigPreview.sourcePath}>{sshConfigPreview.sourcePath}</p>
              <p className="mt-1">只读解析，不修改源文件。ProxyCommand 和 Match exec 不会执行；ProxyJump 当前不会配置跳板。IdentityFile 只保存路径，不读取或复制密钥内容。</p>
            </div>
            <div className="compact-scrollbar max-h-[min(420px,52vh)] min-h-20 overflow-y-auto px-3 py-2">
              {sshConfigPreview.warnings.length > 0 && <div className="mb-2 space-y-1 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] leading-4 text-amber-800 dark:text-amber-200">
                {sshConfigPreview.warnings.map((warning, index) => <p key={`${index}-${warning}`}>{warning}</p>)}
              </div>}
              {sshConfigPreview.entries.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">没有可静态导入的具体主机。通配 Host 和动态 Match 仅显示为提示。</p> : <div className="space-y-1">
                {sshConfigPreview.entries.map((entry) => {
                  const nameExists = profiles.some((profile) => profile.name.toLocaleLowerCase() === entry.alias.toLocaleLowerCase());
                  const checked = sshConfigSelection.has(entry.alias);
                  return <label key={entry.alias} className={`block rounded-sm border border-border px-2 py-1.5 ${entry.importable && !nameExists ? "cursor-pointer hover:bg-muted/50" : "opacity-70"}`}>
                    <span className="flex items-start gap-2">
                      <input type="checkbox" className="mt-0.5 accent-primary" checked={checked} disabled={!entry.importable || nameExists} onChange={(event) => setSshConfigSelection((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(entry.alias);
                        else next.delete(entry.alias);
                        return next;
                      })} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium"><span>{entry.alias}</span><span className="font-mono text-muted-foreground">{entry.username}@{entry.hostname}:{entry.port}</span>{entry.identityFile && <span className="text-accent">私钥路径</span>}</span>
                        {entry.identityFile && <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground" title={entry.identityFile}>{entry.identityFile}</span>}
                        {nameExists && <span className="mt-0.5 block text-[9px] text-amber-800 dark:text-amber-200">已存在同名配置，导入时会跳过</span>}
                        {!entry.importable && <span className="mt-0.5 block text-[9px] text-amber-800 dark:text-amber-200">包含当前无法静态处理的动态字段</span>}
                        {entry.warnings.map((warning) => <span key={warning} className="mt-0.5 block text-[9px] leading-4 text-muted-foreground">{warning}</span>)}
                      </span>
                    </span>
                  </label>;
                })}
              </div>}
            </div>
            <footer className="flex items-center justify-between border-t border-border bg-panel-header px-3 py-2">
              <span className="text-[10px] text-muted-foreground">导入后可在连接管理器中检查并修改</span>
              <span className="flex gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-xs" disabled={sshConfigBusy} onClick={() => setSshConfigPreview(null)}>取消</Button><Button type="button" size="sm" className="h-7 rounded-sm px-2 text-xs" disabled={sshConfigBusy || sshConfigSelection.size === 0} onClick={() => void importSelectedSshConfig()}>{sshConfigBusy ? "处理中…" : `导入 ${sshConfigSelection.size} 项`}</Button></span>
            </footer>
          </>}
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function ProfileForm({ draft, setDraft, groups, editing, onSubmit, onCancel }: {
  draft: ProfileDraft;
  setDraft: (draft: ProfileDraft) => void;
  groups: ConnectionGroup[];
  editing: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [managedKeys, setManagedKeys] = useState<SshKeyMetadata[]>([]);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    if (draft.authMethod !== "privateKey") return;
    let active = true;
    void listSshKeys().then((items) => {
      if (active) {
        setManagedKeys(items);
        setKeysLoaded(true);
      }
    }).catch(() => {
      if (active) {
        setManagedKeys([]);
        setKeysLoaded(true);
      }
    });
    return () => { active = false; };
  }, [draft.authMethod]);

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft({ ...draft, [key]: value });
  return <form className="mb-3 grid grid-cols-2 gap-2 border border-border bg-background/40 p-2" onSubmit={onSubmit}>
    <label className="col-span-2 grid gap-1 text-[10px] text-muted-foreground">配置名称<Input className="h-7 rounded-sm text-xs" placeholder="例如：测试环境" value={draft.name} onChange={(event) => update("name", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">主机名 / IP<Input className="h-7 rounded-sm text-xs" placeholder="host.example.com" value={draft.host} onChange={(event) => update("host", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">SSH 端口<Input className="h-7 rounded-sm text-xs" type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">用户名<Input className="h-7 rounded-sm text-xs" placeholder="可选" value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
    {draft.authMethod === "password" && <>
      <label className="grid gap-1 text-[10px] text-muted-foreground">SSH 密码<Input autoComplete="new-password" type="password" maxLength={1024} className="h-7 rounded-sm text-xs" placeholder={editing ? "留空以保留已保存密码" : "录入密码，避免每次连接重复输入"} value={draft.password} onChange={(event) => {
        const password = event.target.value;
        setDraft({
          ...draft,
          password,
          rememberPassword: password ? draft.rememberPassword : false,
        });
      }} /></label>
      <div className="col-span-2 flex items-start gap-2 rounded-sm border border-border/70 bg-panel-header/50 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
        <input id="connection-profile-remember-password" type="checkbox" checked={draft.rememberPassword} disabled={!draft.password} onChange={(event) => {
          const rememberPassword = event.target.checked;
          setDraft({ ...draft, rememberPassword, password: rememberPassword ? draft.password : "" });
        }} className="mt-0.5 accent-primary" />
        <label htmlFor="connection-profile-remember-password" className="cursor-pointer">记住密码</label>
      </div>
    </>}
    <label className="grid gap-1 text-[10px] text-muted-foreground">分组<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.groupId} onChange={(event) => update("groupId", event.target.value)}>
      <option value="">默认分组（兼容旧配置）</option>
      {groups.map((group) => <option key={group.id} value={group.id}>{`${"　".repeat(groupDepth(group, groups))}${group.name}`}</option>)}
    </select></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">环境<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.environment} onChange={(event) => update("environment", event.target.value as ServerEnvironment)}><option value="development">开发</option><option value="test">测试</option><option value="production">生产</option></select></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">认证方式<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.authMethod} onChange={(event) => {
      const authMethod = event.target.value as AuthMethod;
      setDraft({ ...draft, authMethod, ...(authMethod !== "password" ? { password: "", rememberPassword: false } : {}), ...(authMethod === "keyboardInteractive" ? { autoReconnect: false } : {}) });
    }}><option value="password">密码</option><option value="privateKey">私钥文件</option><option value="keyboardInteractive">多重提示（密码/验证码）</option></select></label>
    {draft.authMethod === "privateKey" && <div className="col-span-2 grid gap-2">
      <label className="grid gap-1 text-[10px] text-muted-foreground">SSH 密钥<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.keyRef} onChange={(event) => update("keyRef", event.target.value)}>
        <option value="">使用私钥文件路径</option>
        {managedKeys.map((key) => <option key={key.id} value={key.id}>{key.alias} · {key.keyType}</option>)}
      </select></label>
      {keysLoaded && managedKeys.length === 0 && <p className="text-[9px] leading-4 text-muted-foreground">暂无可选的本机密钥。可在“设置 → 连接与安全”中解锁保险库并生成或导入。</p>}
      {draft.keyRef
        ? <p className="rounded-sm border border-border bg-panel-header/50 px-2 py-1.5 text-[9px] leading-4 text-muted-foreground">私钥由本机保险库加密保护。连接时可单次输入口令，或选择安全记住口令。</p>
        : <label className="grid gap-1 text-[10px] text-muted-foreground">私钥文件路径（仅保存路径）<Input className="h-7 rounded-sm font-mono text-xs" placeholder="~/.ssh/id_ed25519" value={draft.privateKeyPath} onChange={(event) => update("privateKeyPath", event.target.value)} /></label>}
    </div>}
    <label className={`col-span-2 flex items-start gap-2 rounded-sm border border-border/70 bg-panel-header/50 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground ${draft.authMethod === "keyboardInteractive" ? "opacity-60" : ""}`}><input type="checkbox" checked={draft.autoReconnect && draft.authMethod !== "keyboardInteractive"} disabled={draft.authMethod === "keyboardInteractive"} onChange={(event) => update("autoReconnect", event.target.checked)} className="mt-0.5 accent-primary" /><span>{draft.authMethod === "keyboardInteractive" ? "多重提示认证需要用户逐项输入，不参与自动重连。" : "断线后自动重连，最多 5 次。默认关闭；生产服务器也需要单独开启。没有可用凭据时不会自动重试认证。"}</span></label>
    <div className="col-span-2 flex items-center justify-between gap-2">
      <div className="flex gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2" onClick={onCancel}>取消</Button><Button type="submit" size="sm" className="h-7 rounded-sm px-2">{editing ? "保存修改" : "保存配置"}</Button></div>
    </div>
  </form>;
}

const PROFILE_DRAG_TYPE = "application/x-termvista-profile";
const GROUP_DRAG_TYPE = "application/x-termvista-group";

type GroupTreeNodeData = {
  group: ConnectionGroup;
  profiles: ConnectionProfile[];
  children: GroupTreeNodeData[];
};

function ConnectionGroupTree({
  groups,
  profiles,
  dragEnabled,
  renderProfile,
  onCreateChild,
  onRename,
  onDelete,
  onMoveProfile,
  onMoveGroup,
}: {
  groups: ConnectionGroup[];
  profiles: ConnectionProfile[];
  dragEnabled: boolean;
  renderProfile: (profile: ConnectionProfile) => ReactNode;
  onCreateChild: (parentId: string) => void;
  onRename: (group: ConnectionGroup) => void;
  onDelete: (group: ConnectionGroup) => void;
  onMoveProfile: (profileId: string, groupId: string | null, sortOrder?: number) => void;
  onMoveGroup: (groupId: string, parentId: string | null, sortOrder?: number) => void;
}) {
  const sortedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const compareProfiles = (a: ConnectionProfile, b: ConnectionProfile) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
  const byId = new Map<string, GroupTreeNodeData>();
  for (const group of sortedGroups) byId.set(group.id, { group, profiles: [], children: [] });
  const roots: GroupTreeNodeData[] = [];
  for (const group of sortedGroups) {
    const node = byId.get(group.id);
    if (!node) continue;
    const parent = group.parentId ? byId.get(group.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const groupByPath = new Map(sortedGroups.map((group) => [groupPathForId(group.id, sortedGroups), group.id]));
  const unassigned: ConnectionProfile[] = [];
  for (const profile of profiles) {
    const groupId = profile.groupId ?? groupByPath.get(profile.group);
    const node = groupId ? byId.get(groupId) : undefined;
    if (node) node.profiles.push(profile);
    else unassigned.push(profile);
  }
  for (const node of byId.values()) node.profiles.sort(compareProfiles);
  unassigned.sort(compareProfiles);

  const handleDrop = (event: DragEvent<HTMLDivElement>, group: ConnectionGroup) => {
    event.preventDefault();
    event.stopPropagation();
    const profileId = event.dataTransfer.getData(PROFILE_DRAG_TYPE);
    const groupId = event.dataTransfer.getData(GROUP_DRAG_TYPE);
    if (profileId) {
      onMoveProfile(profileId, group.id);
    } else if (groupId) {
      const draggedGroup = groups.find((item) => item.id === groupId);
      if (!draggedGroup) return;
      if (draggedGroup.parentId === group.parentId) {
        const siblings = groups
          .filter((item) => item.parentId === group.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        const draggedIndex = siblings.findIndex((item) => item.id === groupId);
        const targetIndex = siblings.findIndex((item) => item.id === group.id);
        const insertionIndex = targetIndex - (draggedIndex >= 0 && draggedIndex < targetIndex ? 1 : 0);
        onMoveGroup(groupId, group.parentId, insertionIndex);
      } else {
        onMoveGroup(groupId, group.id);
      }
    }
  };

  const handleProfileDrop = (event: DragEvent<HTMLDivElement>, target: ConnectionProfile) => {
    event.preventDefault();
    event.stopPropagation();
    const profileId = event.dataTransfer.getData(PROFILE_DRAG_TYPE);
    if (!profileId) return;
    const targetGroupId = target.groupId ?? null;
    const insertionIndex = profileDropInsertionIndex(profiles, profileId, target.id);
    if (insertionIndex === null) return;
    onMoveProfile(profileId, targetGroupId, insertionIndex);
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const profileId = event.dataTransfer.getData(PROFILE_DRAG_TYPE);
    const groupId = event.dataTransfer.getData(GROUP_DRAG_TYPE);
    if (profileId) {
      onMoveProfile(profileId, null);
    } else if (groupId) {
      onMoveGroup(groupId, null);
    }
  };

  return <div className="space-y-1" aria-label="服务器分组">
    {roots.map((node) => <GroupTreeNode
      key={node.group.id}
      node={node}
      groups={groups}
      dragEnabled={dragEnabled}
      renderProfile={renderProfile}
      onProfileDrop={handleProfileDrop}
      onCreateChild={onCreateChild}
      onRename={onRename}
      onDelete={onDelete}
      onDrop={handleDrop}
    />)}
    <div
      className="mt-2 min-h-8 rounded-sm border border-dashed border-border px-2 py-1"
      onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
      onDrop={handleRootDrop}
    >
      <div className="flex h-6 items-center gap-1.5 text-[10px] font-medium text-muted-foreground"><Folder size={12} />顶层</div>
      {unassigned.length > 0
        ? unassigned.map((profile) => <div
            key={profile.id}
            draggable={dragEnabled}
            onDragStart={(event) => event.dataTransfer.setData(PROFILE_DRAG_TYPE, profile.id)}
            onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
            onDrop={(event) => handleProfileDrop(event, profile)}
            className="cursor-grab active:cursor-grabbing"
          >{renderProfile(profile)}</div>)
        : null}
    </div>
    {groups.length === 0 && <p className="px-2 py-4 text-center text-[10px] text-muted-foreground">暂无分组，请新建一个分组。</p>}
  </div>;
}

function GroupTreeNode({
  node,
  groups,
  dragEnabled,
  renderProfile,
  onProfileDrop,
  onCreateChild,
  onRename,
  onDelete,
  onDrop,
}: {
  node: GroupTreeNodeData;
  groups: ConnectionGroup[];
  dragEnabled: boolean;
  renderProfile: (profile: ConnectionProfile) => ReactNode;
  onProfileDrop: (event: DragEvent<HTMLDivElement>, profile: ConnectionProfile) => void;
  onCreateChild: (parentId: string) => void;
  onRename: (group: ConnectionGroup) => void;
  onDelete: (group: ConnectionGroup) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, group: ConnectionGroup) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { group } = node;
  return <section className="min-w-0">
    <ContextMenu>
      <ContextMenuTrigger asChild><div
        className="group flex min-h-8 items-center gap-1 rounded-sm border border-transparent px-1 hover:bg-muted/50"
        onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
        onDrop={(event) => onDrop(event, group)}
        onDragStart={(event) => {
          event.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        draggable={dragEnabled}
      >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={13} className="shrink-0 text-accent" />
        <span className="truncate text-[10px] font-semibold">{group.name}</span>
        <span className="text-[9px] text-muted-foreground">{node.profiles.length + node.children.length}</span>
      </button>
      <div className="flex shrink-0 items-center opacity-70 group-hover:opacity-100">
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" title="新建子分组" aria-label={`在 ${group.name} 中新建子分组`} onClick={() => onCreateChild(group.id)}><FolderPlus size={11} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" title="重命名分组" aria-label={`重命名 ${group.name}`} onClick={() => onRename(group)}><Pencil size={10} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm text-muted-foreground hover:text-destructive" title={node.profiles.length || node.children.length ? "先移动分组内的服务器和子分组" : "删除空分组"} aria-label={`删除 ${group.name}`} disabled={node.profiles.length > 0 || node.children.length > 0} onClick={() => onDelete(group)}><Trash2 size={10} /></Button>
      </div>
      </div></ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onCreateChild(group.id)}><FolderPlus size={12} />新建子分组</ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(group)}><Pencil size={12} />重命名</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={node.profiles.length > 0 || node.children.length > 0} className="text-destructive focus:text-destructive" onSelect={() => onDelete(group)}><Trash2 size={12} />删除空分组…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    {expanded && <div
      className="ml-3 min-h-7 border-l border-border/70 pl-2"
      onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }}
      onDrop={(event) => { if (dragEnabled) onDrop(event, group); }}
    >
      {node.profiles.map((profile) => <div key={profile.id} draggable={dragEnabled} onDragStart={(event) => {
        event.dataTransfer.setData(PROFILE_DRAG_TYPE, profile.id);
        event.dataTransfer.effectAllowed = "move";
      }} onDragOver={(event) => { if (dragEnabled) event.preventDefault(); }} onDrop={(event) => {
        if (dragEnabled) onProfileDrop(event, profile);
      }} className="cursor-grab active:cursor-grabbing">{renderProfile(profile)}</div>)}
      {node.children.map((child) => <GroupTreeNode key={child.group.id} node={child} groups={groups} dragEnabled={dragEnabled} renderProfile={renderProfile} onProfileDrop={onProfileDrop} onCreateChild={onCreateChild} onRename={onRename} onDelete={onDelete} onDrop={onDrop} />)}
      {node.profiles.length === 0 && node.children.length === 0 && <p className="py-1 pl-2 text-[9px] text-muted-foreground">拖动服务器或子分组到此处</p>}
    </div>}
  </section>;
}

function groupPathForId(groupId: string, groups: ConnectionGroup[]) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const path: string[] = [];
  let current = byId.get(groupId);
  while (current && path.length < 64) {
    path.push(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse().join("/");
}

function groupDepth(group: ConnectionGroup, groups: ConnectionGroup[]) {
  const byId = new Map(groups.map((item) => [item.id, item]));
  let depth = 0;
  let parentId = group.parentId;
  while (parentId && depth < 64) {
    depth += 1;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return depth;
}

function formatRecentTime(timestamp: number) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}
