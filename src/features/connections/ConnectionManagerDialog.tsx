import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Clock3, Folder, FolderOpen, FolderPlus, GitFork, KeyRound, Pencil, Plus, Search, Server, ShieldCheck, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DEFAULT_UNGROUPED_GROUP, profileDropInsertionIndex } from "@/features/connections/profileTree";
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
import { useTranslation } from "react-i18next";

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
  jumpProfileId: string;
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
  group: DEFAULT_UNGROUPED_GROUP,
  groupId: "",
  environment: "development",
  authMethod: "password",
  password: "",
  rememberPassword: false,
  privateKeyPath: "",
  keyRef: "",
  jumpProfileId: "",
  autoReconnect: false,
});

export function ConnectionManagerDialog() {
  const { t, i18n } = useTranslation("connections");
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
  const environmentLabel = useMemo<Record<ServerEnvironment, string>>(() => ({
    production: t("manager.environment.production"),
    test: t("manager.environment.test"),
    development: t("manager.environment.development"),
  }), [t]);

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
  }, [environmentLabel, profiles, search]);

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
    }).catch(() => {
      if (active) toast.error(t("manager.errors.loadGroups"));
    });
    return () => { active = false; };
  }, [open, view, refreshTree, t]);

  useEffect(() => {
    if (!open || view !== "trustedHosts") return;
    let active = true;
    void listTrustedHosts().then((items) => {
      if (active) setTrustedHosts(items);
    }).catch(() => {
      if (active) toast.error(t("manager.errors.loadTrustedHosts"));
    });
    return () => { active = false; };
  }, [open, view, t]);

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
      jumpProfileId: profile.jumpProfileId ?? "",
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
      toast.error(t("manager.errors.usernameRequired"));
      return;
    }
    const previous = profiles.find((profile) => profile.id === editingId);
    if (previous && clearPreviousCredentials) {
      try {
        await forgetSavedCredential(previous);
      } catch {
        toast.error(t("manager.errors.clearOldCredentials"));
        return;
      }
    }
    const group = values.groupId ? groupPathForId(values.groupId, groups) : values.group.trim() || DEFAULT_UNGROUPED_GROUP;
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
      jumpProfileId: values.jumpProfileId || undefined,
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
    } catch {
      toast.error(t("manager.errors.saveProfile"));
      return;
    }
    let credentialAccounts = savedProfile.credentialAccounts;
    if (values.authMethod === "password" && values.password && values.rememberPassword) {
      try {
        const credentialProfile = await saveSshPassword(savedProfile, values.password);
        credentialAccounts = credentialProfile.credentialAccounts;
        toast.success(t("manager.messages.passwordSaved"));
      } catch {
        toast.error(t("manager.errors.passwordNotSaved"));
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
      toast.success(t("manager.messages.credentialsForgotten", { name: profile.name }));
    } catch {
      toast.error(t("manager.errors.forgetCredentials"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteCredentials) {
      try {
        await forgetSavedCredential(deleteTarget);
      } catch {
        toast.error(t("manager.errors.deleteCredentialsFirst"));
        return;
      }
    }
    try {
      await deleteConnectionProfile(deleteTarget.id);
    } catch {
      toast.error(t("manager.errors.deleteProfile"));
      return;
    }
    removeProfile(deleteTarget.id);
    setDeleteTarget(null);
  };

  const toggleFavoritePersisted = async (profile: ConnectionProfile) => {
    try {
      await saveConnectionProfile({ ...profile, favorite: !profile.favorite });
      toggleFavorite(profile.id);
    } catch {
      toast.error(t("manager.errors.favorite"));
    }
  };

  const removeTrust = async (record: TrustedHostSummary) => {
    const id = `${record.host}:${record.port}`;
    try {
      await forgetTrustedHost(record.host, record.port);
      setTrustedHosts(await listTrustedHosts());
      setConfirmTrustedHost(null);
      toast.success(t("manager.messages.trustRevoked", { host: id }));
    } catch {
      toast.error(t("manager.errors.revokeTrust"));
    }
  };

  const chooseSshConfig = async () => {
    if (!isTauri()) {
      toast.error(t("manager.errors.desktopOnlyImport"));
      return;
    }
    const selectedPath = await openFileDialog({
      multiple: false,
      directory: false,
      title: t("manager.chooseConfigFile"),
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
    } catch {
      toast.error(t("manager.errors.previewConfig"));
    } finally {
      setSshConfigBusy(false);
    }
  };

  const importSelectedSshConfig = async () => {
    if (!sshConfigPreview || sshConfigSelection.size === 0) return;
    setSshConfigBusy(true);
    try {
      const aliases = new Set(sshConfigSelection);
      for (const entry of sshConfigPreview.entries) {
        if (!aliases.has(entry.alias) || !entry.proxyJump) continue;
        const existingJump = profiles.some((profile) => profile.name.toLocaleLowerCase() === entry.proxyJump?.toLocaleLowerCase());
        const configJump = sshConfigPreview.entries.find((candidate) => candidate.alias.toLocaleLowerCase() === entry.proxyJump?.toLocaleLowerCase());
        if (!existingJump && !configJump?.importable) {
          toast.error(t("manager.proxyJump.importDependencyMissing", { alias: entry.proxyJump }));
          return;
        }
        if (!existingJump && configJump) aliases.add(configJump.alias);
      }
      const result = await importSshConfig(sshConfigPreview.sourcePath, [...aliases]);
      await refreshTree();
      const skipped = result.skippedExistingNames.length;
      toast.success(t("manager.messages.imported", { count: result.imported.length, skipped }));
      setSshConfigPreview(null);
    } catch {
      toast.error(t("manager.errors.importConfig"));
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
        toast.success(t("manager.messages.groupCreated", { name }));
      } else {
        await renameConnectionGroup(groupDialog.groupId, name);
        toast.success(t("manager.messages.groupRenamed"));
      }
      await refreshTree();
      setGroupDialog(null);
    } catch {
      toast.error(t(groupDialog.kind === "create" ? "manager.errors.createGroup" : "manager.errors.renameGroup"));
    } finally {
      setGroupDialogBusy(false);
    }
  };

  const removeGroup = async (group: ConnectionGroup) => {
    if (!window.confirm(t("manager.confirmDeleteGroup", { name: group.name }))) return;
    try {
      const deleted = await deleteConnectionGroup(group.id);
      if (!deleted) {
        toast.error(t("manager.errors.groupNotEmpty"));
        return;
      }
      await refreshTree();
      toast.success(t("manager.messages.groupDeleted", { name: group.name }));
    } catch {
      toast.error(t("manager.errors.deleteGroup"));
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
    } catch {
      toast.error(t("manager.errors.moveProfile"));
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
    } catch {
      toast.error(t("manager.errors.moveGroup"));
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
      <div role="button" tabIndex={0} className="min-w-0 flex-1 cursor-default rounded-sm px-1 py-1 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-accent" onDoubleClick={() => connect(profile)} onKeyDown={(event) => rowKeyDown(event, profile)} title={t("manager.doubleClickConnect")}>
        <div className="flex items-center gap-1.5">
          {profile.favorite && <Star size={10} className="shrink-0 fill-amber-500 text-amber-500" aria-label={t("manager.favorite" )} />}
          <span className="truncate text-xs font-medium">{profile.name}</span>
          <span className={`rounded-sm border px-1 text-[9px] leading-[14px] ${profile.environment === "production" ? "border-amber-500/50 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}>{environmentLabel[profile.environment]}</span>
          {profile.autoReconnect && <span className="rounded-sm border border-accent/50 px-1 text-[9px] leading-[14px] text-accent">{t("manager.autoReconnect")}</span>}
          {profile.lastConnectedAt && <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 size={9} />{formatRecentTime(profile.lastConnectedAt, t)}</span>}
        </div>
        <div className="mt-0.5 truncate pl-0.5 font-mono text-[10px] text-muted-foreground">{profile.username}@{profile.host}:{profile.port || 22}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon" className={`h-6 w-6 rounded-sm ${profile.favorite ? "text-amber-500" : "text-muted-foreground"}`} aria-label={profile.favorite ? t("manager.removeFavoriteFor", { name: profile.name }) : t("manager.addFavoriteFor", { name: profile.name })} title={profile.favorite ? t("manager.removeFavorite") : t("manager.addFavorite")} onClick={() => void toggleFavoritePersisted(profile)}><Star size={13} fill={profile.favorite ? "currentColor" : "none"} /></Button>
        <Button type="button" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => connect(profile)}>{t("connect")}</Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("manager.editFor", { name: profile.name })} title={t("manager.edit")} onClick={() => editProfile(profile)}><Pencil size={12} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("manager.forgetCredentialsFor", { name: profile.name })} title={t("forgetCredentials")} onClick={() => setConfirmForgetId(confirmForgetId === profile.id ? null : profile.id)}><KeyRound size={12} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" aria-label={t("manager.deleteProfileFor", { name: profile.name })} title={t("manager.deleteProfile")} onClick={() => { setDeleteCredentials(true); setDeleteTarget(profile); }}><Trash2 size={12} /></Button>
      </div>
    </div>
    {confirmForgetId === profile.id && <div className="ml-1 mt-1 flex items-center justify-between gap-2 rounded-sm border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[10px]">
      <span className="text-muted-foreground">{t("manager.confirmForgetCredentials")}</span>
      <span className="flex shrink-0 gap-1"><Button type="button" size="sm" variant="ghost" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setConfirmForgetId(null)}>{t("cancel")}</Button><Button type="button" size="sm" variant="destructive" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void forgetCredentials(profile)}>{t("manager.forget")}</Button></span>
    </div>}
    </div></ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => connect(profile)}><Server size={12} />{t("connect")}</ContextMenuItem>
      <ContextMenuItem onSelect={() => openTunnelManager(profile.id)}><GitFork size={12} />{t("manager.portForward")}</ContextMenuItem>
      <ContextMenuItem onSelect={() => editProfile(profile)}><Pencil size={12} />{t("manager.edit")}</ContextMenuItem>
      <ContextMenuItem onSelect={() => void toggleFavoritePersisted(profile)}><Star size={12} />{profile.favorite ? t("manager.removeFavorite") : t("manager.addFavorite")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setConfirmForgetId(profile.id)}><KeyRound size={12} />{t("manager.forgetCredentialsMenu")}</ContextMenuItem>
      <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setDeleteCredentials(true); setDeleteTarget(profile); }}><Trash2 size={12} />{t("manager.deleteProfileMenu")}</ContextMenuItem>
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
          <div className="flex items-center gap-2"><FolderOpen size={14} className="text-accent" /><DialogTitle>{t("manager.dialogTitle")}</DialogTitle></div>
          <div className="flex items-center gap-1">
            <Button type="button" variant={view === "connections" ? "secondary" : "ghost"} size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setView("connections")}>{t("manager.servers")}</Button>
            <Button type="button" variant={view === "trustedHosts" ? "secondary" : "ghost"} size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => { setView("trustedHosts"); setFormOpen(false); }}><ShieldCheck size={12} />{t("manager.trustedHosts")}</Button>
          </div>
          <DialogDescription className="sr-only">{t("manager.dialogDescription")}</DialogDescription>
        </header>

        {view === "connections" ? <>
          {formOpen ? <div className="flex h-9 items-center gap-2 border-b border-border bg-panel-header/35 px-4">
            <Server size={13} className="text-accent" />
            <span className="text-xs font-semibold">{editingId ? t("manager.editProfile") : t("manager.newProfile")}</span>
          </div> : <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-7 rounded-sm pl-7 text-xs" placeholder={t("manager.searchProfiles")} value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" onClick={() => void createGroup(null)}><FolderPlus size={13} />{t("manager.newGroup")}</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" disabled={sshConfigBusy} onClick={() => void chooseSshConfig()}><FolderOpen size={13} />{t("manager.importConfigShort")}</Button>
            <Button type="button" size="sm" className="h-7 shrink-0 rounded-sm px-2 text-xs" onClick={showNewForm}><Plus size={13} />{t("manager.newProfileShort")}</Button>
          </div>}
          <div className={`compact-scrollbar overflow-y-auto ${formOpen ? "max-h-[calc(100vh-112px)] min-h-0 px-4 py-4" : "max-h-[min(500px,58vh)] min-h-36 px-3 py-2"}`}>
          {formOpen ? <ProfileForm draft={draft} setDraft={setDraft} groups={groups} profiles={profiles} editingProfileId={editingId} editing={Boolean(editingId)} onSubmit={submitProfile} onCancel={() => { setFormOpen(false); setEditingId(null); setDraft(emptyDraft()); }} /> : filtered.length === 0 && groups.length === 0 ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Server size={18} strokeWidth={1.5} />
                <span>{search ? t("manager.noProfilesMatch") : t("manager.noSavedProfiles")}</span>
                {!search && <span className="max-w-72 text-[10px]">{t("manager.emptyProfilesHint")}</span>}
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
            <p className="mb-2 text-[10px] leading-4 text-muted-foreground">{t("manager.permanentTrustDescription")}</p>
            {trustedHosts.length === 0 ? <div className="flex min-h-32 items-center justify-center text-xs text-muted-foreground">{t("manager.noTrustedHosts")}</div> : trustedHosts.map((record) => {
              const id = `${record.host}:${record.port}`;
              const confirming = confirmTrustedHost === id;
              return <div key={id} className="border-b border-border/60 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{id}<span className="ml-2 font-sans text-[10px] text-muted-foreground">{record.keyType}</span></div>
                    <div className="mt-1 break-all font-mono text-[10px] text-accent">{record.fingerprintSha256}</div>
                    <div className="mt-1 text-[9px] text-muted-foreground">{t("manager.trustDates", { first: new Date(record.firstTrustedAt * 1000).toLocaleString(i18n.resolvedLanguage), last: new Date(record.lastVerifiedAt * 1000).toLocaleString(i18n.resolvedLanguage) })}</div>
                  </div>
                  <Button type="button" variant={confirming ? "destructive" : "outline"} size="sm" className="h-6 shrink-0 rounded-sm px-2 text-[10px]" onClick={() => confirming ? void removeTrust(record) : setConfirmTrustedHost(id)}>{confirming ? t("manager.confirmRevoke") : t("manager.revokeTrust")}</Button>
                </div>
                {confirming && <div className="mt-1 flex justify-end"><Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => setConfirmTrustedHost(null)}>{t("cancel")}</Button></div>}
              </div>;
            })}
          </div>
          <footer className="flex min-h-8 items-center justify-between border-t border-border bg-panel-header px-3 text-[10px] text-muted-foreground"><span>{t("manager.trustStorageNotice")}</span><span>{t("manager.serverCount", { count: trustedHosts.length })}</span></footer>
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
                <DialogTitle className="text-sm">{groupDialog.kind === "create" ? groupDialog.parentId ? t("manager.newChildGroup") : t("manager.newGroup") : t("manager.renameGroup")}</DialogTitle>
                <DialogDescription className="mt-1 text-[11px] leading-4">
                  {groupDialog.kind === "rename"
                    ? t("manager.renameGroupDescription")
                    : groupDialog.parentId
                      ? t("manager.createChildGroupDescription", { parent: groups.find((group) => group.id === groupDialog.parentId)?.name ?? t("manager.parentGroup") })
                      : t("manager.createGroupDescription")}
                </DialogDescription>
              </div>
            </header>
            <div className="space-y-2 px-5 py-5">
              <label htmlFor="connection-group-name" className="block text-xs font-medium">{t("manager.groupName")}</label>
              <Input id="connection-group-name" autoFocus maxLength={80} placeholder={t("manager.groupNamePlaceholder")} className="h-9 rounded-sm text-xs" value={groupDialog.name} onChange={(event) => setGroupDialog((current) => current ? { ...current, name: event.target.value } : current)} />
              <p className="text-[10px] leading-4 text-muted-foreground">{t("manager.localGroupDescription")}</p>
            </div>
            <footer className="flex justify-end gap-2 border-t border-border bg-panel-header/30 px-5 py-3">
              <Button type="button" variant="ghost" size="sm" className="h-8 rounded-sm px-3 text-xs" disabled={groupDialogBusy} onClick={() => setGroupDialog(null)}>{t("cancel")}</Button>
              <Button type="submit" size="sm" className="h-8 rounded-sm px-3 text-xs" disabled={!groupDialog.name.trim() || groupDialogBusy}>{groupDialogBusy ? t("manager.saving") : groupDialog.kind === "create" ? t("manager.createGroup") : t("manager.saveName")}</Button>
            </footer>
          </form>}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingCredentialChange)} onOpenChange={(next) => { if (!next) setPendingCredentialChange(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("manager.credentialChangeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("manager.credentialChangeDescription")}</AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("manager.cancelChanges")}</Button></AlertDialogCancel>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-2" onClick={() => pendingCredentialChange && void persistDraft(pendingCredentialChange.draft)}>{t("manager.keepOldCredentials")}</Button>
            <Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => pendingCredentialChange && void persistDraft(pendingCredentialChange.draft, true)}>{t("manager.clearAndUpdate")}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("manager.deleteProfileTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("manager.deleteProfileDescription", { name: deleteTarget?.name ?? "" })}</AlertDialogDescription>
          <label className="flex items-start gap-2 text-[11px] leading-4 text-foreground"><input type="checkbox" checked={deleteCredentials} onChange={(event) => setDeleteCredentials(event.target.checked)} className="mt-0.5 accent-primary" /><span>{t("manager.clearSavedCredentials")}</span></label>
          {!deleteCredentials && <p className="text-[10px] text-amber-700 dark:text-amber-300">{t("manager.credentialsWillRemain")}</p>}
          <div className="flex justify-end gap-2"><AlertDialogCancel asChild><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2">{t("cancel")}</Button></AlertDialogCancel><Button type="button" variant="destructive" size="sm" className="h-7 rounded-sm px-2" onClick={() => void confirmDelete()}>{t("manager.deleteProfile")}</Button></div>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(sshConfigPreview)} onOpenChange={(next) => { if (!next && !sshConfigBusy) setSshConfigPreview(null); }}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center justify-between border-b border-border bg-panel-header px-3">
            <div className="flex items-center gap-2"><FolderOpen size={14} className="text-accent" /><DialogTitle>{t("manager.previewConfig")}</DialogTitle></div>
            <DialogDescription className="sr-only">{t("manager.previewConfigDescription")}</DialogDescription>
          </header>
          {sshConfigPreview && <>
            <div className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
              <p className="truncate font-mono" title={sshConfigPreview.sourcePath}>{sshConfigPreview.sourcePath}</p>
              <p className="mt-1">{t("manager.configSafetyNotice")}</p>
            </div>
            <div className="compact-scrollbar max-h-[min(420px,52vh)] min-h-20 overflow-y-auto px-3 py-2">
              {sshConfigPreview.warnings.length > 0 && <div className="mb-2 space-y-1 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] leading-4 text-amber-800 dark:text-amber-200">
                {sshConfigPreview.warnings.map((warning, index) => <p key={`${index}-${warning}`}>{warning}</p>)}
              </div>}
              {sshConfigPreview.entries.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">{t("manager.noStaticHosts")}</p> : <div className="space-y-1">
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
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium"><span>{entry.alias}</span><span className="font-mono text-muted-foreground">{entry.username}@{entry.hostname}:{entry.port}</span>{entry.identityFile && <span className="text-accent">{t("manager.privateKeyPath")}</span>}{entry.proxyJump && <span className="text-accent">ProxyJump: {entry.proxyJump}</span>}</span>
                        {entry.identityFile && <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground" title={entry.identityFile}>{entry.identityFile}</span>}
                        {nameExists && <span className="mt-0.5 block text-[9px] text-amber-800 dark:text-amber-200">{t("manager.duplicateProfileSkipped")}</span>}
                        {!entry.importable && <span className="mt-0.5 block text-[9px] text-amber-800 dark:text-amber-200">{t("manager.dynamicFieldsUnsupported")}</span>}
                        {entry.warnings.map((warning) => <span key={warning} className="mt-0.5 block text-[9px] leading-4 text-muted-foreground">{warning}</span>)}
                      </span>
                    </span>
                  </label>;
                })}
              </div>}
            </div>
            <footer className="flex items-center justify-between border-t border-border bg-panel-header px-3 py-2">
              <span className="text-[10px] text-muted-foreground">{t("manager.importReviewHint")}</span>
              <span className="flex gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-xs" disabled={sshConfigBusy} onClick={() => setSshConfigPreview(null)}>{t("cancel")}</Button><Button type="button" size="sm" className="h-7 rounded-sm px-2 text-xs" disabled={sshConfigBusy || sshConfigSelection.size === 0} onClick={() => void importSelectedSshConfig()}>{sshConfigBusy ? t("manager.processing") : t("manager.importCount", { count: sshConfigSelection.size })}</Button></span>
            </footer>
          </>}
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function ProfileForm({ draft, setDraft, groups, profiles, editingProfileId, editing, onSubmit, onCancel }: {
  draft: ProfileDraft;
  setDraft: (draft: ProfileDraft) => void;
  groups: ConnectionGroup[];
  profiles: ConnectionProfile[];
  editingProfileId: string | null;
  editing: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("connections");
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
  const jumpProfiles = profiles.filter((profile) => profile.id !== editingProfileId && !profile.jumpProfileId);
  return <form className="mb-3 grid grid-cols-2 gap-2 border border-border bg-background/40 p-2" onSubmit={onSubmit}>
    <label className="col-span-2 grid gap-1 text-[10px] text-muted-foreground">{t("manager.profileName")}<Input className="h-7 rounded-sm text-xs" placeholder={t("manager.profileNamePlaceholder")} value={draft.name} onChange={(event) => update("name", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.hostOrIp")}<Input className="h-7 rounded-sm text-xs" placeholder="host.example.com" value={draft.host} onChange={(event) => update("host", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.sshPort")}<Input className="h-7 rounded-sm text-xs" type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", event.target.value)} required /></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("username")}<Input className="h-7 rounded-sm text-xs" placeholder={t("manager.optional")} value={draft.username} onChange={(event) => update("username", event.target.value)} /></label>
    {draft.authMethod === "password" && <>
      <label className="grid gap-1 text-[10px] text-muted-foreground">{t("password")}<Input autoComplete="new-password" type="password" maxLength={1024} className="h-7 rounded-sm text-xs" placeholder={editing ? t("manager.keepSavedPassword") : t("manager.enterPasswordHint")} value={draft.password} onChange={(event) => {
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
        <label htmlFor="connection-profile-remember-password" className="cursor-pointer">{t("rememberPassword")}</label>
      </div>
    </>}
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.group")}<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.groupId} onChange={(event) => update("groupId", event.target.value)}>
      <option value="">{t("manager.defaultGroupLegacy")}</option>
      {groups.map((group) => <option key={group.id} value={group.id}>{`${"　".repeat(groupDepth(group, groups))}${group.name}`}</option>)}
    </select></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.environmentLabel")}<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.environment} onChange={(event) => update("environment", event.target.value as ServerEnvironment)}><option value="development">{t("manager.environment.development")}</option><option value="test">{t("manager.environment.test")}</option><option value="production">{t("manager.environment.production")}</option></select></label>
    <label className="col-span-2 grid gap-1 text-[10px] text-muted-foreground">{t("manager.proxyJump.label")}<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.jumpProfileId} onChange={(event) => update("jumpProfileId", event.target.value)}><option value="">{t("manager.proxyJump.direct")}</option>{jumpProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.host}:{profile.port}</option>)}</select></label>
    <label className="grid gap-1 text-[10px] text-muted-foreground">{t("authMethod")}<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.authMethod} onChange={(event) => {
      const authMethod = event.target.value as AuthMethod;
      setDraft({ ...draft, authMethod, ...(authMethod !== "password" ? { password: "", rememberPassword: false } : {}), ...(authMethod === "keyboardInteractive" ? { autoReconnect: false } : {}) });
    }}><option value="password">{t("password")}</option><option value="privateKey">{t("privateKeyFile")}</option><option value="keyboardInteractive">{t("keyboardInteractive")}</option></select></label>
    {draft.authMethod === "privateKey" && <div className="col-span-2 grid gap-2">
      <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.sshKey")}<select className="h-7 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={draft.keyRef} onChange={(event) => update("keyRef", event.target.value)}>
        <option value="">{t("manager.useKeyPath")}</option>
        {managedKeys.map((key) => <option key={key.id} value={key.id}>{key.alias} · {key.keyType}</option>)}
      </select></label>
      {keysLoaded && managedKeys.length === 0 && <p className="text-[9px] leading-4 text-muted-foreground">{t("manager.noManagedKeys")}</p>}
      {draft.keyRef
        ? <p className="rounded-sm border border-border bg-panel-header/50 px-2 py-1.5 text-[9px] leading-4 text-muted-foreground">{t("manager.vaultKeyNotice")}</p>
        : <label className="grid gap-1 text-[10px] text-muted-foreground">{t("manager.privateKeyPathOnly")}<Input className="h-7 rounded-sm font-mono text-xs" placeholder="~/.ssh/id_ed25519" value={draft.privateKeyPath} onChange={(event) => update("privateKeyPath", event.target.value)} /></label>}
    </div>}
    <label className={`col-span-2 flex items-start gap-2 rounded-sm border border-border/70 bg-panel-header/50 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground ${draft.authMethod === "keyboardInteractive" ? "opacity-60" : ""}`}><input type="checkbox" checked={draft.autoReconnect && draft.authMethod !== "keyboardInteractive"} disabled={draft.authMethod === "keyboardInteractive"} onChange={(event) => update("autoReconnect", event.target.checked)} className="mt-0.5 accent-primary" /><span>{draft.authMethod === "keyboardInteractive" ? t("manager.keyboardInteractiveReconnect") : t("manager.autoReconnectDescription")}</span></label>
    <div className="col-span-2 flex items-center justify-between gap-2">
      <div className="flex gap-1"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2" onClick={onCancel}>{t("cancel")}</Button><Button type="submit" size="sm" className="h-7 rounded-sm px-2">{editing ? t("manager.saveChanges") : t("manager.saveProfile")}</Button></div>
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
  const { t } = useTranslation("connections");
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

  return <div className="space-y-1" aria-label={t("manager.serverGroups")}>
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
      <div className="flex h-6 items-center gap-1.5 text-[10px] font-medium text-muted-foreground"><Folder size={12} />{t("manager.topLevel")}</div>
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
    {groups.length === 0 && <p className="px-2 py-4 text-center text-[10px] text-muted-foreground">{t("manager.noGroups")}</p>}
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
  const { t } = useTranslation("connections");
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
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" title={t("manager.newChildGroup")} aria-label={t("manager.createChildGroupFor", { name: group.name })} onClick={() => onCreateChild(group.id)}><FolderPlus size={11} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" title={t("manager.renameGroup")} aria-label={t("manager.renameGroupFor", { name: group.name })} onClick={() => onRename(group)}><Pencil size={10} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm text-muted-foreground hover:text-destructive" title={node.profiles.length || node.children.length ? t("manager.moveGroupContentsFirst") : t("manager.deleteEmptyGroup")} aria-label={t("manager.deleteGroupFor", { name: group.name })} disabled={node.profiles.length > 0 || node.children.length > 0} onClick={() => onDelete(group)}><Trash2 size={10} /></Button>
      </div>
      </div></ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onCreateChild(group.id)}><FolderPlus size={12} />{t("manager.newChildGroup")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(group)}><Pencil size={12} />{t("manager.renameGroup")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={node.profiles.length > 0 || node.children.length > 0} className="text-destructive focus:text-destructive" onSelect={() => onDelete(group)}><Trash2 size={12} />{t("manager.deleteEmptyGroupMenu")}</ContextMenuItem>
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
      {node.profiles.length === 0 && node.children.length === 0 && <p className="py-1 pl-2 text-[9px] text-muted-foreground">{t("manager.dropIntoGroupHint")}</p>}
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

function formatRecentTime(timestamp: number, translate: (key: string, options?: Record<string, unknown>) => string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return translate("manager.recent.now");
  if (elapsedMinutes < 60) return translate("manager.recent.minutes", { count: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return translate("manager.recent.hours", { count: elapsedHours });
  return translate("manager.recent.days", { count: Math.floor(elapsedHours / 24) });
}
