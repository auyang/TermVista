import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Download,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  ListChecks,
  List,
  PanelBottomClose,
  PanelBottomOpen,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cancelSftpTransfer, clearCompletedSftpTransfers, closeSftp, createSftpDirectory, deleteSftpPath, grantLocalSftpFiles, grantLocalSftpRoot, listLocalSftpDirectory, listSftpDirectory, listSftpTransfers, openSftp, prepareSftpDelete, readSftpClipboardFiles, renameSftpPath, resolveSftpTransferConflict, retrySftpTransfer, startSftpTransfers, type ConflictPolicy, type DeleteConfirmation, type LocalEntry, type RemoteEntry, type SftpStatus, type TransferDirection, type TransferProgress } from "@/features/sftp/sftpBridge";
import { useAiStore } from "@/features/ai/aiStore";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useSftpSessionStore, type SftpViewState } from "@/stores/sftpSessionStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";
import i18next from "@/i18n";

const PAGE_SIZE = 100;
const uploadRefreshTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
const tSftp = (key: string, options?: Record<string, unknown>): string =>
  String(i18next.t(key as never, { ns: "sftp", ...options } as never));

function localParent(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function localDisplayPath(context: SftpViewState) {
  if (!context.localRootPath) return "";
  return context.localPath ? `${context.localRootPath}/${context.localPath}` : context.localRootPath;
}

type LocalFilePaneProps = {
  sessionId: string;
  context: SftpViewState;
  onChooseRoot: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onUpload: () => void;
  onCopySelected: () => void;
};

function LocalFilePane({ sessionId, context, onChooseRoot, onRefresh, onNavigate, onUpload, onCopySelected }: LocalFilePaneProps) {
  const { t } = useTranslation("sftp");
  const select = useSftpSessionStore((state) => state.selectLocalPath);
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("localFiles")} onKeyDown={(event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c" || isEditableTarget(event.target)) return;
    event.preventDefault();
    onCopySelected();
  }}>
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-panel-header px-1.5">
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("openLocalFolder")} title={t("chooseLocalFolder")} onClick={onChooseRoot}><FolderOpen size={13} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("localParent")} title={t("parentDirectory")} onClick={() => onNavigate(localParent(context.localPath))} disabled={!context.localGrantId || !context.localPath}><ArrowUp size={13} /></Button>
      <Input className="h-6 min-w-0 flex-1 rounded-sm border-border bg-background px-2 font-mono text-[10px]" aria-label={t("localAuthorizedPath")} value={localDisplayPath(context)} readOnly placeholder={t("selectLocalRootHint")} />
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("refreshLocalDirectory")} title={t("refreshLocalDirectory")} onClick={onRefresh} disabled={!context.localGrantId || context.localLoading}><RefreshCw size={12} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("uploadSelectedLocal")} title={t("uploadToCurrentRemote")} onClick={onUpload} disabled={!context.localGrantId || !context.localSelectedPaths.length}><Upload size={12} /></Button>
    </header>
    {!context.localGrantId ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-muted-foreground">
      <FolderOpen size={20} className="opacity-60" /><span>{t("localScopeNotice")}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={onChooseRoot}>{t("chooseLocalFolder")}</Button>
    </div> : context.localLoading ? <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">{t("readingLocalDirectory")}</div> : context.localError ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-destructive"><span>{t("errors.localRead")}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={onRefresh}>{t("retry")}</Button></div> : <>
      <div className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_72px] items-center border-b border-border bg-panel-header/50 px-2 text-[10px] font-medium text-muted-foreground"><span>{t("name")}</span><span className="text-right">{t("size")}</span></div>
      <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
        {context.localEntries.length === 0 ? <div className="p-4 text-center text-[11px] text-muted-foreground">{t("folderEmpty")}</div> : context.localEntries.map((entry: LocalEntry) => {
          const selected = context.localSelectedPaths.includes(entry.relativePath);
          return <button type="button" key={entry.relativePath} draggable={entry.kind === "file"} onDragStart={(event) => {
            if (entry.kind !== "file" || !context.localGrantId) return;
            const paths = selected
              ? context.localSelectedPaths.filter((path) => context.localEntries.some((candidate) => candidate.relativePath === path && candidate.kind === "file"))
              : [entry.relativePath];
            event.dataTransfer.setData("application/x-termvista-transfer", JSON.stringify({ kind: "local", sessionId, grantId: context.localGrantId, paths }));
            event.dataTransfer.effectAllowed = "copy";
          }} className={`grid w-full grid-cols-[minmax(0,1fr)_72px] items-center border-b border-border/50 px-2 py-1 text-left text-[11px] hover:bg-accent/10 ${selected ? "bg-accent/15" : ""}`} onClick={(event) => select(sessionId, entry.relativePath, event.metaKey || event.ctrlKey)} onDoubleClick={() => { if (entry.kind === "directory") onNavigate(entry.relativePath); }}>
            <span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-sky-600 dark:text-sky-400">{entry.kind === "directory" ? <Folder size={13} /> : <File size={12} />}</span><span className="truncate">{entry.name}</span>{entry.kind === "symlink" && <span className="text-[9px] text-muted-foreground">{t("link")}</span>}</span>
            <span className="text-right tabular-nums text-muted-foreground">{entry.sizeBytes == null ? "—" : formatSize(entry.sizeBytes)}</span>
          </button>;
        })}
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border px-2 text-[9px] text-muted-foreground"><span>{t("itemCount", { count: context.localEntries.length })}</span><span className="truncate" title={t("copyPasteUploadHint")}>{t("selectedCount", { count: context.localSelectedPaths.length })} · { /Mac/i.test(navigator.userAgent) ? t("copyShortcutMac") : t("copyShortcut")}</span></footer>
    </>}
  </section>;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}


function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function nativeDropPositionToClient(position: { x: number; y: number }) {
  // macOS 和 GTK 传入逻辑坐标；Windows WebView2 传入物理客户区坐标。
  const scale = /Windows/i.test(navigator.userAgent) ? window.devicePixelRatio || 1 : 1;
  return { x: position.x / scale, y: position.y / scale };
}

async function readRemoteDirectory(sessionId: string, path: string, notify = true): Promise<boolean> {
  const store = useSftpSessionStore.getState();
  const requestId = store.beginRead(sessionId);
  try {
    const entries = await listSftpDirectory(sessionId, path);
    store.applyRead(sessionId, path, requestId, entries);
    return true;
  } catch {
    const message = tSftp("errors.readDirectory");
    store.failRead(sessionId, path, requestId, message);
    if (notify) toast.error(message);
    return false;
  }
}

async function readTreeDirectory(sessionId: string, path: string, force = false) {
  const store = useSftpSessionStore.getState();
  const context = store.contexts[sessionId];
  if (!context || context.treeLoading.includes(path) || (!force && hasOwn(context.treeEntries, path))) return;
  store.setTreeLoading(sessionId, path, true);
  try {
    const entries = await listSftpDirectory(sessionId, path);
    store.setTreeEntries(sessionId, path, entries.filter((entry) => entry.kind === "directory"));
  } catch {
    toast.error(tSftp("errors.readTree"));
  } finally {
    store.setTreeLoading(sessionId, path, false);
  }
}

function handleTransferProgress(progress: TransferProgress) {
  useSftpSessionStore.getState().updateTransfer(progress.sessionId, progress);
  if (progress.direction !== "upload" || progress.status !== "completed") return;

  const remoteDirectory = parentPath(progress.destinationPath);
  const key = `${progress.sessionId}\0${remoteDirectory}`;
  const existingTimer = uploadRefreshTimers.get(key);
  if (existingTimer !== undefined) window.clearTimeout(existingTimer);
  uploadRefreshTimers.set(key, window.setTimeout(() => {
    uploadRefreshTimers.delete(key);
    const context = useSftpSessionStore.getState().contexts[progress.sessionId];
    if (!context || context.status !== "ready") return;
    if (context.path === remoteDirectory) void readRemoteDirectory(progress.sessionId, remoteDirectory, false);
    if (context.expandedPaths.includes(remoteDirectory)) void readTreeDirectory(progress.sessionId, remoteDirectory, true);
  }, 150));
}

function parentPath(path: string): string {
  if (!path || path === "/") return "/";
  const clean = path.replace(/\/+$/, "");
  const separator = clean.lastIndexOf("/");
  return separator <= 0 ? "/" : clean.slice(0, separator);
}

function formatSize(size?: number | null): string {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatModified(value: number | null | undefined, locale?: string): string {
  if (value == null) return "—";
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function transferStatusLabel(status: TransferProgress["status"], translate: (key: string) => string): string {
  switch (status) {
    case "queued": return translate("status.queued");
    case "awaitingConflict": return translate("status.awaitingConflict");
    case "running": return translate("status.running");
    case "completed": return translate("status.completed");
    case "failed": return translate("status.failed");
    case "canceled": return translate("status.canceled");
    case "skipped": return translate("status.skipped");
  }
}

function displayType(entry: RemoteEntry, translate: (key: string, options?: Record<string, unknown>) => string): string {
  if (entry.kind === "directory") return translate("folder");
  if (entry.kind === "symlink") return translate("symlink");
  if (entry.kind === "other") return translate("specialFile");
  const pieces = entry.name.split(".");
  const extension = pieces[pieces.length - 1];
  return extension && extension !== entry.name ? translate("fileWithExtension", { extension: extension.toUpperCase() }) : translate("file");
}

function RemoteDirectoryTree({
  sessionId,
  context,
  onNavigate,
}: {
  sessionId: string;
  context: SftpViewState;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation("sftp");
  const toggleExpanded = useSftpSessionStore((state) => state.toggleExpanded);
  const expanded = (path: string) => context.expandedPaths.includes(path);
  const loading = (path: string) => context.treeLoading.includes(path);
  const expand = (path: string) => {
    const wasExpanded = expanded(path);
    toggleExpanded(sessionId, path);
    if (!wasExpanded) void readTreeDirectory(sessionId, path);
  };
  const children = (path: string) => context.treeEntries[path] ?? [];

  const renderNode = (entry: RemoteEntry, depth: number) => (
    <div key={entry.path}>
      <div className={`flex h-6 items-center pr-2 text-[11px] hover:bg-accent/5 ${context.path === entry.path ? "bg-accent/10 text-accent" : "text-foreground"}`} style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <button type="button" className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground" aria-label={t(expanded(entry.path) ? "collapseName" : "expandName", { name: entry.name })} aria-expanded={expanded(entry.path)} onClick={() => expand(entry.path)}>
          {loading(entry.path) ? <span className="h-2.5 w-2.5 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" /> : expanded(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onNavigate(entry.path)}>
          <Folder size={13} className="shrink-0 text-[#5597ed]" />
          <span className="truncate">{entry.name}</span>
        </button>
      </div>
      {expanded(entry.path) && children(entry.path).map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <nav className="compact-scrollbar h-full overflow-auto py-1" aria-label={t("remoteDirectoryTree")}>
      <div className={`flex h-6 items-center pr-2 text-[11px] hover:bg-accent/5 ${context.path === "/" ? "bg-accent/10 text-accent" : "text-foreground"}`}>
        <button type="button" className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground" aria-label={t(expanded("/") ? "collapseRoot" : "expandRoot")} aria-expanded={expanded("/")} onClick={() => expand("/")}>
          {loading("/") ? <span className="h-2.5 w-2.5 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" /> : expanded("/") ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onNavigate("/")}>
          <Folder size={13} className="shrink-0 text-[#5597ed]" /><span>/</span>
        </button>
      </div>
      {expanded("/") && children("/").map((entry) => renderNode(entry, 1))}
    </nav>
  );
}

function RemoteFileTable({
  sessionId,
  context,
  onOpenDirectory,
  onOpenRemoteFile,
  onDownload,
  onRename,
  onDelete,
  onAnalyzeText,
}: {
  sessionId: string;
  context: SftpViewState;
  onOpenDirectory: (entry: RemoteEntry) => void;
  onOpenRemoteFile: (sessionId: string, path: string) => void;
  onDownload: (paths: string[]) => void;
  onRename: (entry: RemoteEntry) => void;
  onDelete: (entry: RemoteEntry) => void;
  onAnalyzeText: (entry: RemoteEntry) => void;
}) {
  const { t, i18n } = useTranslation("sftp");
  const selectPath = useSftpSessionStore((state) => state.selectPath);
  const setSort = useSftpSessionStore((state) => state.setSort);
  const setPage = useSftpSessionStore((state) => state.setPage);
  const columns: { key: SftpViewState["sortKey"]; label: string; className: string }[] = [
    { key: "name", label: t("fileName"), className: "min-w-36 flex-1" },
    { key: "sizeBytes", label: t("size"), className: "w-[76px]" },
    { key: "kind", label: t("type"), className: "w-[100px]" },
    { key: "modifiedAtEpochMs", label: t("modifiedAt"), className: "w-[136px]" },
    { key: "permissions", label: t("permissions"), className: "w-[108px]" },
    { key: "ownerLabel", label: t("ownerGroup"), className: "w-[120px]" },
  ];
  const entries = useMemo(() => {
    const filtered = context.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(context.query.toLocaleLowerCase()));
    const value = (entry: RemoteEntry): string | number => {
      switch (context.sortKey) {
        case "sizeBytes": return entry.sizeBytes ?? -1;
        case "kind": return displayType(entry, t);
        case "modifiedAtEpochMs": return entry.modifiedAtEpochMs ?? -1;
        case "permissions": return entry.permissions ?? "";
        case "ownerLabel": return entry.ownerLabel ?? "";
        default: return entry.name;
      }
    };
    return filtered.sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      const a = value(left);
      const b = value(right);
      const compare = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return context.sortDirection === "asc" ? compare : -compare;
    });
  }, [context.entries, context.query, context.sortKey, context.sortDirection, t]);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(context.page, pageCount - 1);
  const visible = entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="flex h-full min-w-0 flex-col" aria-label={t("remoteDirectoryLabel", { path: context.path })}>
      <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[680px] border-collapse text-[11px]" aria-label={t("remoteFileDetails")}>
          <thead className="sticky top-0 z-10 bg-panel-header text-foreground">
            <tr className="h-7 border-b border-border text-left">
              {columns.map((column) => <th key={column.key} className={`px-2 font-medium ${column.className}`}>
                <button type="button" className="inline-flex items-center gap-1 hover:text-accent" onClick={() => setSort(sessionId, column.key)} aria-label={t("sortBy", { name: column.label })}>
                  {column.label}{context.sortKey === column.key ? <ChevronsUpDown size={10} className="text-accent" /> : null}
                </button>
              </th>)}
              <th className="w-1" />
            </tr>
          </thead>
          <tbody>
            {visible.map((entry, index) => (
              <ContextMenu key={entry.path}>
                <ContextMenuTrigger asChild>
                  <tr
                    className={`${context.compact ? "h-5" : "h-[22px]"} border-b border-border/60 ${context.selectedPaths.includes(entry.path) ? "bg-accent/15" : index % 2 ? "bg-panel-header/35" : "bg-panel hover:bg-accent/5"}`}
                    draggable={entry.kind === "file"}
                    onDragStart={(event) => {
                      if (entry.kind !== "file") return;
                      const paths = context.selectedPaths.includes(entry.path)
                        ? context.selectedPaths.filter((path) => context.entries.some((candidate) => candidate.path === path && candidate.kind === "file"))
                        : [entry.path];
                      event.dataTransfer.setData("application/x-termvista-transfer", JSON.stringify({ kind: "remote", sessionId, paths }));
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={(event) => selectPath(sessionId, entry.path, event.metaKey || event.ctrlKey)}
                    onDoubleClick={() => {
                      if (entry.kind === "directory") onOpenDirectory(entry);
                      else if (entry.kind === "file") onOpenRemoteFile(sessionId, entry.path);
                    }}
                  >
                    <td className="max-w-0 px-2"><span className="flex items-center gap-1.5 truncate">{entry.kind === "directory" ? <Folder size={13} className="shrink-0 text-[#5597ed]" /> : <File size={13} className="shrink-0 text-[#5992bd]" />}<span className="truncate">{entry.name}</span></span></td>
                    <td className="px-2 tabular-nums">{entry.kind === "directory" ? "—" : formatSize(entry.sizeBytes)}</td>
                    <td className="px-2 text-muted-foreground">{displayType(entry, t)}</td>
                    <td className="px-2 tabular-nums">{formatModified(entry.modifiedAtEpochMs, i18n.resolvedLanguage)}</td>
                    <td className="px-2 font-mono text-[9px] text-muted-foreground">{entry.permissions ?? "—"}</td>
                    <td className="px-2 text-muted-foreground">{entry.ownerLabel || entry.groupLabel ? `${entry.ownerLabel ?? (entry.uid == null ? "—" : entry.uid)}/${entry.groupLabel ?? (entry.gid == null ? "—" : entry.gid)}` : entry.uid != null || entry.gid != null ? `${entry.uid ?? "—"}/${entry.gid ?? "—"}` : "—"}</td>
                    <td />
                  </tr>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={entry.kind !== "directory"} onSelect={() => onOpenDirectory(entry)}>{t("openDirectory")}</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => onOpenRemoteFile(sessionId, entry.path)}>{t("openInEditor")}</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind === "directory"} onSelect={() => onDownload([entry.path])}>{t("download")}</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => onAnalyzeText(entry)}><Sparkles size={12} />{t("analyzeWithAi")}</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => {
                    useDiagnosticStore.getState().setPendingContext({ sessionId, context: { kind: "sftpFile", remotePath: entry.path } });
                    useWorkspaceStore.getState().setAiOpen(true);
                  }}><Activity size={12} />{t("createDiagnosticPlan")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onRename(entry)}>{t("rename")}</ContextMenuItem>
                  <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(entry)}>{t("delete")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
            {!context.loading && visible.length === 0 && <tr><td colSpan={7} className="h-16 text-center text-muted-foreground">{context.query ? t("noMatchingFiles") : t("directoryEmpty")}</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border px-2 text-[10px] text-muted-foreground">
        <span>{t("itemCount", { count: entries.length })}{context.query ? ` (${t("filtered")})` : ""}</span>
        {pageCount > 1 && <span className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label={t("previousPage")} disabled={currentPage === 0} onClick={() => setPage(sessionId, currentPage - 1)}><ArrowLeft size={11} /></Button>
          <span>{currentPage + 1}/{pageCount}</span>
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label={t("nextPage")} disabled={currentPage >= pageCount - 1} onClick={() => setPage(sessionId, currentPage + 1)}><ArrowRight size={11} /></Button>
        </span>}
      </footer>
    </div>
  );
}

type SftpPaneProps = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenRemoteFile: (sessionId: string, path: string) => void;
};
type SftpDropTarget = "local" | "remote";
type InternalTransferPayload = { kind: "local" | "remote"; sessionId: string; grantId?: string; paths: string[] };
type DropActions = {
  sessionId?: string;
  acceptNativeDrop: (paths: string[], target: SftpDropTarget | null) => Promise<void>;
};

export function SftpPane({ collapsed, onToggleCollapse, onOpenRemoteFile }: SftpPaneProps) {
  const { t } = useTranslation("sftp");
  const pathInputRef = useRef<HTMLInputElement>(null);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const sshSession = useSshSessionStore((state) => activeTabId ? state.sessions[activeTabId] : undefined);
  const sessionId = sshSession?.sessionId;
  const profileId = sshSession?.profile.id;
  const initialSftpPathRef = useRef<string | null>(null);
  const lastShellPathRef = useRef<{ sessionId: string | undefined; path?: string }>({ sessionId: undefined });
  const savedSftpPath = useWorkspaceStore((state) => profileId ? state.lastSftpPaths[profileId] : undefined);
  const setLastSftpPath = useWorkspaceStore((state) => state.setLastSftpPath);
  const context = useSftpSessionStore((state) => sessionId ? state.contexts[sessionId] : undefined);
  const initialize = useSftpSessionStore((state) => state.initialize);
  const setStatus = useSftpSessionStore((state) => state.setStatus);
  const setPathDraft = useSftpSessionStore((state) => state.setPathDraft);
  const setLocation = useSftpSessionStore((state) => state.setLocation);
  const setQuery = useSftpSessionStore((state) => state.setQuery);
  const setCompact = useSftpSessionStore((state) => state.setCompact);
  const setTransfers = useSftpSessionStore((state) => state.setTransfers);
  const sftpMode = useWorkspaceStore((state) => state.sftpMode);
  const sftpBrowserMode = useWorkspaceStore((state) => state.sftpBrowserMode);
  const sftpLayout = useWorkspaceStore((state) => state.layouts.sftp);
  const dualSftpLayout = useWorkspaceStore((state) => state.layouts.dualSftp);
  const setSftpMode = useWorkspaceStore((state) => state.setSftpMode);
  const setSftpBrowserMode = useWorkspaceStore((state) => state.setSftpBrowserMode);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameEntry, setRenameEntry] = useState<RemoteEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [applyPolicyTransferId, setApplyPolicyTransferId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [dropTarget, setDropTarget] = useState<SftpDropTarget | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const localFileClipboardRef = useRef<{ grantId: string; paths: string[] } | null>(null);
  const dropActionsRef = useRef<DropActions | null>(null);

  useEffect(() => {
    localFileClipboardRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "leave") {
        setDropTarget(null);
        setDropCount(0);
        return;
      }
      const { x, y } = nativeDropPositionToClient(event.payload.position);
      const element = document.elementFromPoint(x, y);
      const targetName = element?.closest<HTMLElement>("[data-sftp-drop-target]")?.dataset.sftpDropTarget;
      const target: SftpDropTarget | null = targetName === "local" || targetName === "remote" ? targetName : null;
      setDropTarget(target);
      if (event.payload.type === "enter") setDropCount(event.payload.paths.length);
      if (event.payload.type === "drop") {
        const actions = dropActionsRef.current;
        if (actions?.sessionId) void actions.acceptNativeDrop(event.payload.paths, target);
        setDropCount(0);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error: unknown) => {
      console.error("Unable to register native file drag-and-drop handler.", error);
      toast.error(tSftp("errors.nativeDropUnavailable"));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const focusPath = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!sessionId || detail?.sessionId !== sessionId) return;
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    };
    window.addEventListener("aissh:focus-sftp-path", focusPath);
    return () => window.removeEventListener("aissh:focus-sftp-path", focusPath);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !sshSession || sshSession.state !== "connected") return;
    initialize(sessionId);
    const current = useSftpSessionStore.getState().contexts[sessionId];
    if (current.status === "ready" || current.status === "opening") return;
    setStatus(sessionId, "opening");
    const onStatus = new Channel<SftpStatus>();
    onStatus.onmessage = (event) => {
      if (event.state === "disconnected") setStatus(sessionId, "disconnected", tSftp("errors.disconnected"));
    };
    let currentView = true;
    void openSftp(sessionId, onStatus).then(async (result) => {
      if (!currentView) return;
      initialSftpPathRef.current = result.currentPath;
      const restorePath = savedSftpPath?.trim() || result.currentPath;
      setLocation(sessionId, restorePath, "replace");
      setStatus(sessionId, "ready");
      void listSftpTransfers(sessionId).then((transfers) => setTransfers(sessionId, transfers)).catch(() => undefined);
      const restored = await readRemoteDirectory(sessionId, restorePath, !savedSftpPath);
      if (!restored && restorePath !== result.currentPath) {
        setLocation(sessionId, result.currentPath, "replace");
        if (profileId) setLastSftpPath(profileId, result.currentPath);
        await readRemoteDirectory(sessionId, result.currentPath, false);
      } else if (restored && profileId) {
        setLastSftpPath(profileId, restorePath);
      }
      await readTreeDirectory(sessionId, "/");
      useSftpSessionStore.getState().toggleExpanded(sessionId, "/");
    }).catch(() => {
      if (!currentView) return;
      const message = tSftp("errors.openSftp");
      setStatus(sessionId, "error", message);
      toast.error(message);
    });
    return () => {
      currentView = false;
    };
  }, [initialize, profileId, retryCount, savedSftpPath, sessionId, setLastSftpPath, setLocation, setStatus, setTransfers, sshSession]);

  useEffect(() => {
    if (!sessionId || !sshSession || !["disconnected", "error", "canceled"].includes(sshSession.state)) return;
    void closeSftp(sessionId).catch(() => undefined);
    useSftpSessionStore.getState().remove(sessionId);
  }, [sessionId, sshSession]);

  useEffect(() => {
    if (!sessionId || context?.status !== "ready" || hasOwn(context.treeEntries, "/")) return;
    void readTreeDirectory(sessionId, "/");
  }, [context?.status, context?.treeEntries, sessionId]);

  const ready = Boolean(sessionId && sshSession?.state === "connected" && context?.status === "ready");
  const navigate = (path: string, historyMode: "push" | "back" | "forward" | "replace" = "push") => {
    if (!sessionId || !ready || path === context?.path) return;
    setLocation(sessionId, path, historyMode);
    if (profileId) setLastSftpPath(profileId, path);
    void readRemoteDirectory(sessionId, path);
  };

  useEffect(() => {
    const shellPath = context?.shellPath;
    if (!sessionId || !ready || !shellPath) return;
    if (lastShellPathRef.current.sessionId !== sessionId) {
      lastShellPathRef.current = { sessionId };
    }
    if (lastShellPathRef.current.path === shellPath) return;
    // 记录已处理的 shell 路径；同一路径下用户手动浏览时，不再把文件栏拉回去。
    lastShellPathRef.current.path = shellPath;
    if (shellPath === context.path) return;
    if (savedSftpPath && context.path === savedSftpPath && shellPath === initialSftpPathRef.current) return;
    setLocation(sessionId, shellPath, "replace");
    if (profileId) setLastSftpPath(profileId, shellPath);
    void readRemoteDirectory(sessionId, shellPath);
  }, [context?.path, context?.shellPath, profileId, ready, savedSftpPath, sessionId, setLastSftpPath, setLocation]);

  const refresh = () => {
    if (!sessionId || !context || !ready) return;
    void readRemoteDirectory(sessionId, context.path);
    if (context.expandedPaths.includes(context.path)) void readTreeDirectory(sessionId, context.path, true);
  };
  const goBack = () => {
    const previous = context ? last(context.backHistory) : undefined;
    if (previous) navigate(previous, "back");
  };
  const goForward = () => {
    const next = context ? last(context.forwardHistory) : undefined;
    if (next) navigate(next, "forward");
  };
  const goUp = () => {
    if (context?.path) navigate(parentPath(context.path));
  };

  const loadLocalDirectory = async (targetSessionId: string, grantId: string, path: string) => {
    useSftpSessionStore.getState().setLocalLoading(targetSessionId, true);
    try {
      const entries = await listLocalSftpDirectory(targetSessionId, grantId, path);
      const current = useSftpSessionStore.getState().contexts[targetSessionId];
      if (current?.localGrantId === grantId && current.localPath === path) {
        useSftpSessionStore.getState().setLocalEntries(targetSessionId, entries);
      }
    } catch {
      useSftpSessionStore.getState().setLocalLoading(targetSessionId, false, t("errors.localRead"));
    }
  };

  const selectLocalRoot = async () => {
    if (!sessionId || !ready) return null;
    try {
      const selected = await openNativeDialog({ title: t("chooseLocalScope"), directory: true, multiple: false });
      if (typeof selected !== "string") return null;
      const grant = await grantLocalSftpRoot(sessionId, selected);
      useSftpSessionStore.getState().setLocalGrant(sessionId, grant.grantId, grant.currentPath);
      useSftpSessionStore.getState().setLocalPath(sessionId, "");
      await loadLocalDirectory(sessionId, grant.grantId, "");
      return grant.grantId;
    } catch {
      toast.error(t("errors.grantLocalFolder"));
      return null;
    }
  };

  const navigateLocal = (path: string) => {
    if (!sessionId || !context?.localGrantId || !ready) return;
    useSftpSessionStore.getState().setLocalPath(sessionId, path);
    void loadLocalDirectory(sessionId, context.localGrantId, path);
  };

  const startTransfer = useCallback(async (direction: TransferDirection, sourcePaths: string[], destinationDirectory: string, localGrantId = context?.localGrantId) => {
    if (!sessionId || !sourcePaths.length) return;
    if (!localGrantId) {
      toast.message(t("selectLocalFolderFirst"));
      return;
    }
    const onProgress = new Channel<TransferProgress>();
    onProgress.onmessage = (progress) => {
      if (progress.sessionId === sessionId) handleTransferProgress(progress);
    };
    try {
      await startSftpTransfers(sessionId, direction, localGrantId, sourcePaths, destinationDirectory, onProgress);
      setQueueOpen(true);
      toast.success(t("queuedTransfers", { count: sourcePaths.length }));
    } catch {
      toast.error(t("errors.startTransfer"));
    }
  }, [context?.localGrantId, sessionId, t]);

  const acceptNativeDrop = useCallback(async (paths: string[], target: SftpDropTarget | null) => {
    setDropTarget(null);
    const remotePath = context?.path;
    if (!sessionId || sshSession?.state !== "connected") {
      toast.message(t("sshNotConnectedUpload"));
      return;
    }
    if (!ready) {
      toast.message(t("sftpNotReadyUpload"));
      return;
    }
    if (!remotePath) {
      toast.message(t("remoteDirectoryNotReady"));
      return;
    }
    if (target !== "remote") {
      toast.message(t("dropOntoCurrentRemoteList"));
      return;
    }
    try {
      const grantedFiles = await grantLocalSftpFiles(sessionId, paths);
      const groups = new Map<string, string[]>();
      for (const item of grantedFiles) groups.set(item.grantId, [...(groups.get(item.grantId) ?? []), item.relativePath]);
      for (const [grantId, relativePaths] of groups) {
        await startTransfer("upload", relativePaths, remotePath, grantId);
      }
    } catch {
      toast.error(t("errors.systemUpload"));
    }
  }, [context?.path, ready, sessionId, sshSession?.state, startTransfer, t]);

  const copyLocalSelection = () => {
    if (!sessionId || !context?.localGrantId) return;
    const paths = context.localEntries
      .filter((entry) => entry.kind === "file" && context.localSelectedPaths.includes(entry.relativePath))
      .map((entry) => entry.relativePath);
    if (!paths.length) {
      toast.message(t("selectLocalFilesFirst"));
      return;
    }
    localFileClipboardRef.current = { grantId: context.localGrantId, paths };
    toast.success(t("copiedFilesPasteHint", { count: paths.length, shortcut: /Mac/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V" }));
  };

  const pasteFilesToRemote = async () => {
    if (!sessionId || !ready || !context) return;
    const localFileClipboard = localFileClipboardRef.current;
    if (localFileClipboard) {
      await startTransfer("upload", localFileClipboard.paths, context.path, localFileClipboard.grantId);
      return;
    }
    try {
      const paths = await readSftpClipboardFiles();
      if (!paths.length) {
        toast.message(t("clipboardNoFiles"));
        return;
      }
      await acceptNativeDrop(paths, "remote");
    } catch {
      toast.error(t("errors.readClipboard"));
    }
  };

  const handleRemotePasteKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "v" || isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteFilesToRemote();
  };

  useEffect(() => {
    dropActionsRef.current = { sessionId, acceptNativeDrop };
    return () => {
      if (dropActionsRef.current?.sessionId === sessionId) dropActionsRef.current = null;
    };
  }, [acceptNativeDrop, sessionId]);

  const handleInternalDragOver = (event: ReactDragEvent<HTMLDivElement>, target: SftpDropTarget) => {
    if (!Array.from(event.dataTransfer.types).includes("application/x-termvista-transfer")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(target);
  };

  const handleInternalDrop = (event: ReactDragEvent<HTMLDivElement>, target: SftpDropTarget) => {
    const value = event.dataTransfer.getData("application/x-termvista-transfer");
    if (!value) return;
    event.preventDefault();
    setDropTarget(null);
    try {
      const payload = JSON.parse(value) as InternalTransferPayload;
      if (!sessionId || payload.sessionId !== sessionId) {
        toast.error(t("crossSessionDropBlocked"));
        return;
      }
      if (!payload.paths.length || payload.paths.length > 100) {
        toast.error(t("invalidDropCount"));
        return;
      }
      if (payload.kind === "local" && target === "remote" && payload.grantId) {
        void startTransfer("upload", payload.paths, context?.path ?? "", payload.grantId);
      } else if (payload.kind === "remote" && target === "local" && context?.localGrantId) {
        void startTransfer("download", payload.paths, context.localPath, context.localGrantId);
      } else if (payload.kind === "remote" && target === "local") {
        toast.message(t("chooseLocalFolderBeforeDownload"));
      }
    } catch {
      toast.error(t("errors.invalidDrop"));
    }
  };

  const chooseUpload = async () => {
    if (!sessionId || !ready || !context) return;
    try {
      const selected = await openNativeDialog({ title: t("selectFilesToUpload"), multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const grantedFiles = await grantLocalSftpFiles(sessionId, paths);
      const groups = new Map<string, string[]>();
      for (const item of grantedFiles) groups.set(item.grantId, [...(groups.get(item.grantId) ?? []), item.relativePath]);
      for (const [grantId, relativePaths] of groups) {
        await startTransfer("upload", relativePaths, context.path, grantId);
      }
    } catch {
      toast.error(t("errors.authorizeUpload"));
    }
  };

  const chooseDownload = async (paths = context?.selectedPaths ?? []) => {
    if (!sessionId || !context || !ready || !paths.length) {
      if (!paths.length) toast.message(t("selectRemoteFilesFirst"));
      return;
    }
    const entries = paths.map((path) => context.entries.find((entry) => entry.path === path));
    if (entries.some((entry) => entry?.kind === "directory")) {
      toast.error(t("singleFileTransferOnly"));
      return;
    }
    let grantId = context.localGrantId;
    if (!grantId) {
      grantId = await selectLocalRoot() ?? undefined;
      if (!grantId) return;
      setSftpBrowserMode("dual");
    }
    await startTransfer("download", paths, context.localPath, grantId);
  };

  const pendingConflict = context?.transfers.find((transfer) => transfer.status === "awaitingConflict");
  const applyConflictPolicyToQueue = pendingConflict?.transferId === applyPolicyTransferId;
  const resolveConflict = async (policy: ConflictPolicy) => {
    if (!pendingConflict || conflictBusy) return;
    setConflictBusy(true);
    try {
      await resolveSftpTransferConflict(pendingConflict.transferId, policy, applyConflictPolicyToQueue);
    } catch {
      toast.error(t("errors.resolveConflict"));
    } finally {
      setConflictBusy(false);
    }
  };

  const cancelTransfer = async (transferId: string) => {
    try {
      await cancelSftpTransfer(transferId);
    } catch {
      toast.error(t("errors.cancelTransfer"));
    }
  };

  const retryTransfer = async (transferId: string) => {
    if (!sessionId) return;
    const onProgress = new Channel<TransferProgress>();
    onProgress.onmessage = (progress) => {
      if (progress.sessionId === sessionId) handleTransferProgress(progress);
    };
    try {
      await retrySftpTransfer(transferId, onProgress);
      toast.message(t("transferRetried"));
    } catch {
      toast.error(t("errors.retryTransfer"));
    }
  };

  const clearTransfers = async () => {
    if (!sessionId || !context) return;
    try {
      await clearCompletedSftpTransfers(sessionId);
      setTransfers(sessionId, context.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)));
    } catch {
      toast.error(t("errors.clearTransferHistory"));
    }
  };

  const submitNewFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || !context || !newFolderName.trim() || busy) return;
    setBusy(true);
    try {
      await createSftpDirectory(sessionId, context.path, newFolderName);
      toast.success(t("messages.folderCreated"));
      setNewFolderName("");
      setNewFolderOpen(false);
      refresh();
      if (context.expandedPaths.includes(context.path)) void readTreeDirectory(sessionId, context.path, true);
    } catch {
      toast.error(t("errors.createFolder"));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || !renameEntry || !renameValue || busy) return;
    setBusy(true);
    try {
      await renameSftpPath(sessionId, renameEntry.path, renameValue);
      toast.success(t("messages.renamed"));
      setRenameEntry(null);
      refresh();
      void readTreeDirectory(sessionId, parentPath(renameEntry.path), true);
    } catch {
      toast.error(t("errors.rename"));
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = async (entry: RemoteEntry) => {
    if (!sessionId) return;
    try {
      setDeleteConfirmation(await prepareSftpDelete(sessionId, entry.path));
      setDeleteOpen(true);
    } catch {
      toast.error(t("errors.prepareDelete"));
    }
  };

  const confirmDelete = async () => {
    if (!sessionId || !deleteConfirmation || busy) return;
    setBusy(true);
    try {
      await deleteSftpPath(sessionId, deleteConfirmation.operationId);
      toast.success(t("messages.deleted"));
      setDeleteOpen(false);
      setDeleteConfirmation(null);
      refresh();
      void readTreeDirectory(sessionId, parentPath(deleteConfirmation.path), true);
    } catch {
      toast.error(t("errors.delete"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`flex min-h-0 min-w-0 flex-col border-t border-border bg-panel ${collapsed ? "h-8" : "h-full"}`} aria-label={t("panelLabel")}>
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        <div className="flex h-full items-stretch gap-3" role="tablist" aria-label={t("tabsLabel")}>
          <button type="button" role="tab" aria-selected={sftpMode === "files"} className={`border-b-2 px-2 text-xs ${sftpMode === "files" ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setSftpMode("files")}>{t("files")}</button>
          <button type="button" role="tab" aria-selected={sftpMode === "commands"} className={`border-b-2 px-2 text-xs ${sftpMode === "commands" ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setSftpMode("commands")}>{t("commands")}</button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`mr-1 rounded-sm border px-1.5 py-0.5 text-[9px] ${ready ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : "border-border text-muted-foreground"}`} aria-live="polite">
            {ready ? t("status.connected") : context?.status === "opening" ? t("status.opening") : context?.status === "error" ? t("status.unavailable") : sshSession?.state === "connected" ? t("status.waiting") : t("status.disconnected")}
          </span>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={collapsed ? t("expandPanel") : t("collapsePanel")} title={collapsed ? t("expandPanel") : t("collapsePanel")} onClick={onToggleCollapse}>{collapsed ? <PanelBottomOpen size={13} /> : <PanelBottomClose size={13} />}</Button>
        </div>
      </header>
      {!collapsed && <>
        <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel-header/35 px-1.5">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("backPath")} title={t("backPath")} onClick={goBack} disabled={!ready || !context?.backHistory.length}><ArrowLeft size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("forwardPath")} title={t("forwardPath")} onClick={goForward} disabled={!ready || !context?.forwardHistory.length}><ArrowRight size={13} /></Button>
          <Input ref={pathInputRef} className="h-7 min-w-0 flex-1 rounded-sm border-border bg-background px-2 font-mono text-[11px]" value={context?.pathDraft ?? ""} disabled={!ready || sftpMode !== "files"} placeholder={t("remotePathPlaceholder")} aria-label={t("remotePath")} onChange={(event) => sessionId && setPathDraft(sessionId, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && context?.pathDraft) navigate(context.pathDraft); }} />
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("refreshFileList")} title={t("refreshRemoteDirectory")} onClick={refresh} disabled={!ready || context?.loading}><RefreshCw size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("parentDirectory")} title={t("parentDirectory")} onClick={goUp} disabled={!ready || context?.path === "/"}><ArrowUp size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("newFolder")} title={t("newRemoteFolder")} onClick={() => setNewFolderOpen(true)} disabled={!ready || sftpMode !== "files"}><FolderPlus size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("uploadFile")} title={t("uploadHelp", { shortcut: /Mac/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V" })} onClick={() => void chooseUpload()} disabled={!ready || sftpMode !== "files"}><Upload size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label={t("downloadSelected")} title={t("downloadSelectedRemote")} onClick={() => void chooseDownload()} disabled={!ready || !context?.selectedPaths.length}><Download size={13} /></Button>
          <Button type="button" variant={sftpBrowserMode === "dual" ? "secondary" : "ghost"} size="xs" className="h-6 shrink-0 rounded-sm px-2 text-[10px]" aria-pressed={sftpBrowserMode === "dual"} onClick={() => setSftpBrowserMode(sftpBrowserMode === "dual" ? "remote" : "dual")} disabled={!ready}>{t("localRemote")}</Button>
          <div className="relative shrink-0">
            <Button type="button" variant="ghost" size="icon" className="relative h-6 w-6 rounded-sm text-muted-foreground" aria-label={t("openTransferQueue")} aria-expanded={queueOpen} title={t("transferQueue")} onClick={() => setQueueOpen((open) => !open)} disabled={!sessionId}>
              <ListChecks size={13} />
              {(context?.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)).length ?? 0) > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-accent px-0.5 text-[8px] leading-3 text-white">{context?.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)).length}</span>}
            </Button>
            {queueOpen && context && <div className="absolute right-0 top-7 z-40 w-[min(420px,calc(100vw-36px))] rounded border border-border bg-panel shadow-xl">
              <header className="flex h-8 items-center justify-between border-b border-border bg-panel-header px-2 text-[11px] font-medium">
                <span>{t("transferQueueCount", { count: context.transfers.length })}</span>
                <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="xs" className="h-5 rounded-sm px-1.5 text-[10px]" onClick={() => void clearTransfers()} disabled={!context.transfers.some((item) => ["completed", "failed", "canceled", "skipped"].includes(item.status))}>{t("clearCompleted")}</Button><Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label={t("closeTransferQueue")} onClick={() => setQueueOpen(false)}>×</Button></div>
              </header>
              <div className="compact-scrollbar max-h-64 overflow-auto">
                {context.transfers.length === 0 ? <div className="p-4 text-center text-[11px] text-muted-foreground">{t("noTransfers")}</div> : context.transfers.map((transfer) => {
                  const active = ["queued", "running", "awaitingConflict"].includes(transfer.status);
                  const percent = transfer.bytesTotal && transfer.bytesTotal > 0 ? Math.min(100, transfer.bytesDone / transfer.bytesTotal * 100) : transfer.status === "completed" ? 100 : 0;
                  return <div key={transfer.transferId} className="grid gap-1 border-b border-border/70 px-2 py-1.5 last:border-b-0">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="min-w-0 truncate font-mono">{transfer.direction === "upload" ? t("upload") : t("download")} · {basename(transfer.sourcePath)}</span>
                      <span className={`shrink-0 ${transfer.status === "failed" ? "text-destructive" : transfer.status === "completed" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>{transferStatusLabel(transfer.status, t)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-muted"><div className={`h-full ${transfer.status === "failed" ? "bg-destructive" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>
                      <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{formatSize(transfer.bytesDone)}{transfer.bytesTotal == null ? "" : ` / ${formatSize(transfer.bytesTotal)}`}{transfer.speedBytesPerSec ? ` · ${formatSize(transfer.speedBytesPerSec)}/s` : ""}</span>
                      {active && <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground" aria-label={t("cancelNamed", { name: basename(transfer.sourcePath) })} title={t("cancelTransfer")} onClick={() => void cancelTransfer(transfer.transferId)}>×</Button>}
                      {["failed", "canceled"].includes(transfer.status) && <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground" aria-label={t("retryNamed", { name: basename(transfer.sourcePath) })} title={t("retryTransfer")} onClick={() => void retryTransfer(transfer.transferId)}><RefreshCw size={11} /></Button>}
                    </div>
                    {transfer.error && <p className="break-all text-[10px] text-destructive">{transfer.error}</p>}
                    {transfer.warning && <p className="break-all text-[10px] text-amber-700 dark:text-amber-300">{transfer.warning}</p>}
                  </div>;
                })}
              </div>
            </div>}
          </div>
          <div className="relative ml-1 hidden min-w-[120px] max-w-[220px] flex-1 md:block">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-7 rounded-sm border-border bg-background pl-7 pr-2 text-[11px]" placeholder={t("searchCurrentDirectory")} value={context?.query ?? ""} onChange={(event) => sessionId && setQuery(sessionId, event.target.value)} disabled={!ready || sftpMode !== "files"} aria-label={t("filterCurrentDirectory")} />
          </div>
          <Button type="button" variant={context?.compact ? "secondary" : "outline"} size="icon" className="h-6 w-6 shrink-0 rounded-sm" aria-label={t("compactListView")} aria-pressed={Boolean(context?.compact)} title={t("compactList")} onClick={() => sessionId && setCompact(sessionId, true)} disabled={!ready}><List size={13} /></Button>
          <Button type="button" variant={!context?.compact ? "secondary" : "outline"} size="icon" className="h-6 w-6 shrink-0 rounded-sm" aria-label={t("detailedListView")} aria-pressed={!context?.compact} title={t("detailedList")} onClick={() => sessionId && setCompact(sessionId, false)} disabled={!ready}><Grid2X2 size={13} /></Button>
        </div>
        {sftpMode === "commands" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-xs text-muted-foreground">{t("commandViewNotice")}</div>
        ) : ready && sessionId && context ? (
          <div className="flex min-h-0 flex-1">
            {sftpBrowserMode === "dual" ? <ResizablePanelGroup orientation="horizontal" defaultLayout={dualSftpLayout} onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) useWorkspaceStore.getState().setLayout("dualSftp", layout); }}>
              <ResizablePanel id="local" defaultSize="42%" minSize="220px" className="min-w-0 border-r border-border">
                <div data-sftp-drop-target="local" className="relative h-full min-w-0" onDragOver={(event) => handleInternalDragOver(event, "local")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "local")}>
                  <LocalFilePane sessionId={sessionId} context={context} onChooseRoot={() => void selectLocalRoot()} onRefresh={() => { if (context.localGrantId) void loadLocalDirectory(sessionId, context.localGrantId, context.localPath); }} onNavigate={navigateLocal} onUpload={() => void startTransfer("upload", context.localSelectedPaths, context.path)} onCopySelected={copyLocalSelection} />
                  {dropTarget === "local" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">{t("dropToDownload", { path: localDisplayPath(context) || t("authorizedLocalFolder") })}</div>}
                </div>
              </ResizablePanel>
              <ResizableHandle aria-label={t("resizeLocalRemotePanes")} />
              <ResizablePanel id="remote" defaultSize="58%" minSize="320px" className="min-w-0">
                <div data-sftp-drop-target="remote" className="relative h-full min-w-0 focus-visible:outline-none" tabIndex={0} aria-label={t("remoteDropTargetLabel")} onKeyDown={handleRemotePasteKeyDown} onDragOver={(event) => handleInternalDragOver(event, "remote")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "remote")}>
                  {context.loading ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><span className="mr-2 h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" />{t("readingRemoteDirectory")}</div> : context.error ? <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"><span>{t("errors.remoteRead")}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={refresh}>{t("retry")}</Button></div> : <RemoteFileTable sessionId={sessionId} context={context} onOpenDirectory={(entry) => navigate(entry.path)} onOpenRemoteFile={onOpenRemoteFile} onDownload={(paths) => void chooseDownload(paths)} onRename={(entry) => { setRenameEntry(entry); setRenameValue(entry.name); }} onDelete={(entry) => void requestDelete(entry)} onAnalyzeText={(entry) => { useAiStore.getState().setIntent({ sessionId, prompt: t("aiAnalyzeSelectedFilePrompt"), sources: [{ kind: "sftpSelectedText", remotePath: entry.path }] }); useWorkspaceStore.getState().setAiOpen(true); }} />}
                  {dropTarget === "remote" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">{t("dropToUpload", { itemLabel: dropCount ? t("itemCount", { count: dropCount }) : t("file"), server: sshSession?.profile.name ?? sshSession?.profile.host ?? t("currentSshTab"), path: context.path })}</div>}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup> : <ResizablePanelGroup orientation="horizontal" defaultLayout={sftpLayout} onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) useWorkspaceStore.getState().setLayout("sftp", layout); }}>
              <ResizablePanel id="tree" defaultSize="19%" minSize="140px" className="min-w-0 border-r border-border">
                <RemoteDirectoryTree sessionId={sessionId} context={context} onNavigate={(path) => navigate(path)} />
              </ResizablePanel>
              <ResizableHandle aria-label={t("resizeRemoteTree")} />
              <ResizablePanel id="files" defaultSize="81%" minSize="320px" className="min-w-0">
                <div data-sftp-drop-target="remote" className="relative h-full min-w-0 focus-visible:outline-none" tabIndex={0} aria-label={t("remoteDropTargetLabel")} onKeyDown={handleRemotePasteKeyDown} onDragOver={(event) => handleInternalDragOver(event, "remote")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "remote")}>
                  {context.loading ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><span className="mr-2 h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" />{t("readingRemoteDirectory")}</div> : context.error ? <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"><span>{t("errors.remoteRead")}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={refresh}>{t("retry")}</Button></div> : <RemoteFileTable sessionId={sessionId} context={context} onOpenDirectory={(entry) => navigate(entry.path)} onOpenRemoteFile={onOpenRemoteFile} onDownload={(paths) => void chooseDownload(paths)} onRename={(entry) => { setRenameEntry(entry); setRenameValue(entry.name); }} onDelete={(entry) => void requestDelete(entry)} onAnalyzeText={(entry) => { useAiStore.getState().setIntent({ sessionId, prompt: t("aiAnalyzeSelectedFilePrompt"), sources: [{ kind: "sftpSelectedText", remotePath: entry.path }] }); useWorkspaceStore.getState().setAiOpen(true); }} />}
                  {dropTarget === "remote" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">{t("dropToUpload", { itemLabel: dropCount ? t("itemCount", { count: dropCount }) : t("file"), server: sshSession?.profile.name ?? sshSession?.profile.host ?? t("currentSshTab"), path: context.path })}</div>}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <span>{context?.status === "error" ? t("errors.openSftp") : sshSession?.state === "connected" ? t("openingChannel") : t("noRemoteSession")}</span>
            {context?.status === "error" && sessionId && sshSession?.state === "connected" && <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { useSftpSessionStore.getState().setStatus(sessionId, "idle"); setRetryCount((value) => value + 1); }}>{t("reconnectSftp")}</Button>}
          </div>
        )}
      </>}

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center border-b border-border bg-panel-header px-3"><DialogTitle>{t("newRemoteFolder")}</DialogTitle><DialogDescription className="sr-only">{t("newRemoteFolderDescription")}</DialogDescription></header>
          <form className="grid gap-3 p-3" onSubmit={(event) => void submitNewFolder(event)}>
            <div className="truncate rounded-sm border border-border bg-background/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{context?.path ?? ""}</div>
            <label className="grid gap-1 text-[11px] text-muted-foreground">{t("folderName")}<Input autoFocus className="h-8 rounded-sm text-xs" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} required /></label>
            <footer className="flex justify-end gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setNewFolderOpen(false)}>{t("cancel")}</Button><Button type="submit" size="xs" className="rounded-sm" disabled={busy || !newFolderName.trim()}>{t("create")}</Button></footer>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameEntry !== null} onOpenChange={(open) => { if (!open) setRenameEntry(null); }}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center border-b border-border bg-panel-header px-3"><DialogTitle>{t("renameRemoteItem")}</DialogTitle><DialogDescription className="sr-only">{t("renameDescription")}</DialogDescription></header>
          <form className="grid gap-3 p-3" onSubmit={(event) => void submitRename(event)}>
            <div className="truncate rounded-sm border border-border bg-background/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{renameEntry?.path ?? ""}</div>
            <label className="grid gap-1 text-[11px] text-muted-foreground">{t("newName")}<Input autoFocus className="h-8 rounded-sm text-xs" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required /></label>
            <footer className="flex justify-end gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setRenameEntry(null)}>{t("cancel")}</Button><Button type="submit" size="xs" className="rounded-sm" disabled={busy || !renameValue}>{t("rename")}</Button></footer>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!open && !busy) { setDeleteOpen(false); setDeleteConfirmation(null); } }}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("confirmDeleteRemoteItem")}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteSafetyDescription")}</AlertDialogDescription>
          {deleteConfirmation && <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-background/50 p-2 text-[11px]">
            <dt className="text-muted-foreground">{t("server")}</dt><dd className="break-all font-mono">{deleteConfirmation.serverName}</dd>
            <dt className="text-muted-foreground">{t("path")}</dt><dd className="break-all font-mono">{deleteConfirmation.path}</dd>
            <dt className="text-muted-foreground">{t("type")}</dt><dd>{deleteConfirmation.kind === "directory" ? t("emptyDirectory") : deleteConfirmation.kind === "symlink" ? t("symlink") : t("file")}</dd>
            <dt className="text-muted-foreground">{t("affectedCount")}</dt><dd>{t("itemCount", { count: deleteConfirmation.affectedCount })}</dd>
          </dl>}
          <footer className="flex justify-end gap-2 border-t border-border pt-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="xs" className="rounded-sm" disabled={busy}>{t("cancel")}</Button></AlertDialogCancel>
            <AlertDialogAction asChild><Button type="button" variant="destructive" size="xs" className="rounded-sm" disabled={busy} onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>{busy ? t("deleting") : t("confirmDelete")}</Button></AlertDialogAction>
          </footer>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingConflict !== undefined} onOpenChange={() => undefined}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("destinationExists")}</AlertDialogTitle>
          <AlertDialogDescription>{t("conflictDescription")}</AlertDialogDescription>
          {pendingConflict && <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-background/50 p-2 text-[11px]">
            <dt className="text-muted-foreground">{t("source")}</dt><dd className="break-all font-mono">{pendingConflict.sourcePath}</dd>
            <dt className="text-muted-foreground">{t("destination")}</dt><dd className="break-all font-mono">{pendingConflict.conflictPath ?? pendingConflict.destinationPath}</dd>
            <dt className="text-muted-foreground">{t("fileSize")}</dt><dd>{pendingConflict.bytesTotal == null ? t("unknown") : formatSize(pendingConflict.bytesTotal)}</dd>
          </dl>}
          <label className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
            <input type="checkbox" className="mt-0.5 accent-primary" checked={applyConflictPolicyToQueue} disabled={conflictBusy} onChange={(event) => setApplyPolicyTransferId(event.target.checked ? pendingConflict?.transferId ?? null : null)} />
            {t("applyConflictPolicyDescription")}
          </label>
          <footer className="flex flex-wrap justify-end gap-2 border-t border-border pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("skip")}>{t("skipFile")}</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("rename")}>{t("keepBoth")}</Button>
            <Button type="button" variant="destructive" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("overwrite")}>{t("overwriteDestination")}</Button>
          </footer>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
