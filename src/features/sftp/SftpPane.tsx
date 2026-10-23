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

const PAGE_SIZE = 100;
const uploadRefreshTimers = new Map<string, ReturnType<typeof window.setTimeout>>();

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
  const select = useSftpSessionStore((state) => state.selectLocalPath);
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="本地文件" onKeyDown={(event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c" || isEditableTarget(event.target)) return;
    event.preventDefault();
    onCopySelected();
  }}>
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-panel-header px-1.5">
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label="打开本地文件夹" title="选择本地授权文件夹" onClick={onChooseRoot}><FolderOpen size={13} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label="转到本地上级目录" title="上级目录" onClick={() => onNavigate(localParent(context.localPath))} disabled={!context.localGrantId || !context.localPath}><ArrowUp size={13} /></Button>
      <Input className="h-6 min-w-0 flex-1 rounded-sm border-border bg-background px-2 font-mono text-[10px]" aria-label="本地授权目录路径" value={localDisplayPath(context)} readOnly placeholder="选择本地文件夹以授权访问范围" />
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label="刷新本地目录" title="刷新本地目录" onClick={onRefresh} disabled={!context.localGrantId || context.localLoading}><RefreshCw size={12} /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label="上传选中的本地文件" title="上传所选文件到当前远程目录" onClick={onUpload} disabled={!context.localGrantId || !context.localSelectedPaths.length}><Upload size={12} /></Button>
    </header>
    {!context.localGrantId ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-muted-foreground">
      <FolderOpen size={20} className="opacity-60" /><span>选择文件夹后，TermVista 只浏览该授权范围。</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={onChooseRoot}>选择本地文件夹</Button>
    </div> : context.localLoading ? <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">正在读取本地目录…</div> : context.localError ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-destructive"><span>{context.localError}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={onRefresh}>重试</Button></div> : <>
      <div className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_72px] items-center border-b border-border bg-panel-header/50 px-2 text-[10px] font-medium text-muted-foreground"><span>名称</span><span className="text-right">大小</span></div>
      <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
        {context.localEntries.length === 0 ? <div className="p-4 text-center text-[11px] text-muted-foreground">此文件夹为空。</div> : context.localEntries.map((entry: LocalEntry) => {
          const selected = context.localSelectedPaths.includes(entry.relativePath);
          return <button type="button" key={entry.relativePath} draggable={entry.kind === "file"} onDragStart={(event) => {
            if (entry.kind !== "file" || !context.localGrantId) return;
            const paths = selected
              ? context.localSelectedPaths.filter((path) => context.localEntries.some((candidate) => candidate.relativePath === path && candidate.kind === "file"))
              : [entry.relativePath];
            event.dataTransfer.setData("application/x-termvista-transfer", JSON.stringify({ kind: "local", sessionId, grantId: context.localGrantId, paths }));
            event.dataTransfer.effectAllowed = "copy";
          }} className={`grid w-full grid-cols-[minmax(0,1fr)_72px] items-center border-b border-border/50 px-2 py-1 text-left text-[11px] hover:bg-accent/10 ${selected ? "bg-accent/15" : ""}`} onClick={(event) => select(sessionId, entry.relativePath, event.metaKey || event.ctrlKey)} onDoubleClick={() => { if (entry.kind === "directory") onNavigate(entry.relativePath); }}>
            <span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-sky-600 dark:text-sky-400">{entry.kind === "directory" ? <Folder size={13} /> : <File size={12} />}</span><span className="truncate">{entry.name}</span>{entry.kind === "symlink" && <span className="text-[9px] text-muted-foreground">链接</span>}</span>
            <span className="text-right tabular-nums text-muted-foreground">{entry.sizeBytes == null ? "—" : formatSize(entry.sizeBytes)}</span>
          </button>;
        })}
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border px-2 text-[9px] text-muted-foreground"><span>{context.localEntries.length} 项</span><span className="truncate" title="选择本地文件后复制，再到远程文件列表粘贴上传">已选 {context.localSelectedPaths.length} 项 · { /Mac/i.test(navigator.userAgent) ? "⌘C 复制" : "Ctrl+C 复制"}</span></footer>
    </>}
  </section>;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
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
  } catch (error) {
    const message = errorMessage(error);
    store.failRead(sessionId, path, requestId, message);
    if (notify) toast.error(`读取目录失败：${message}`);
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
  } catch (error) {
    toast.error(`读取目录树失败：${errorMessage(error)}`);
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

function formatModified(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function transferStatusLabel(status: TransferProgress["status"]): string {
  switch (status) {
    case "queued": return "排队中";
    case "awaitingConflict": return "等待冲突处理";
    case "running": return "传输中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "canceled": return "已取消";
    case "skipped": return "已跳过";
  }
}

function displayType(entry: RemoteEntry): string {
  if (entry.kind === "directory") return "文件夹";
  if (entry.kind === "symlink") return "符号链接";
  if (entry.kind === "other") return "特殊文件";
  const pieces = entry.name.split(".");
  const extension = pieces[pieces.length - 1];
  return extension && extension !== entry.name ? `${extension.toUpperCase()} 文件` : "文件";
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
        <button type="button" className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground" aria-label={`${expanded(entry.path) ? "收起" : "展开"} ${entry.name}`} aria-expanded={expanded(entry.path)} onClick={() => expand(entry.path)}>
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
    <nav className="compact-scrollbar h-full overflow-auto py-1" aria-label="远程目录树">
      <div className={`flex h-6 items-center pr-2 text-[11px] hover:bg-accent/5 ${context.path === "/" ? "bg-accent/10 text-accent" : "text-foreground"}`}>
        <button type="button" className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground" aria-label={`${expanded("/") ? "收起" : "展开"} 根目录`} aria-expanded={expanded("/")} onClick={() => expand("/")}>
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
  const selectPath = useSftpSessionStore((state) => state.selectPath);
  const setSort = useSftpSessionStore((state) => state.setSort);
  const setPage = useSftpSessionStore((state) => state.setPage);
  const columns: { key: SftpViewState["sortKey"]; label: string; className: string }[] = [
    { key: "name", label: "文件名", className: "min-w-36 flex-1" },
    { key: "sizeBytes", label: "大小", className: "w-[76px]" },
    { key: "kind", label: "类型", className: "w-[100px]" },
    { key: "modifiedAtEpochMs", label: "修改时间", className: "w-[136px]" },
    { key: "permissions", label: "权限", className: "w-[108px]" },
    { key: "ownerLabel", label: "用户/用户组", className: "w-[120px]" },
  ];
  const entries = useMemo(() => {
    const filtered = context.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(context.query.toLocaleLowerCase()));
    const value = (entry: RemoteEntry): string | number => {
      switch (context.sortKey) {
        case "sizeBytes": return entry.sizeBytes ?? -1;
        case "kind": return displayType(entry);
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
  }, [context.entries, context.query, context.sortKey, context.sortDirection]);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(context.page, pageCount - 1);
  const visible = entries.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="flex h-full min-w-0 flex-col" aria-label={`远程目录 ${context.path}`}>
      <div className="compact-scrollbar min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[680px] border-collapse text-[11px]" aria-label="远程文件详情">
          <thead className="sticky top-0 z-10 bg-panel-header text-foreground">
            <tr className="h-7 border-b border-border text-left">
              {columns.map((column) => <th key={column.key} className={`px-2 font-medium ${column.className}`}>
                <button type="button" className="inline-flex items-center gap-1 hover:text-accent" onClick={() => setSort(sessionId, column.key)} aria-label={`按${column.label}排序`}>
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
                    <td className="px-2 text-muted-foreground">{displayType(entry)}</td>
                    <td className="px-2 tabular-nums">{formatModified(entry.modifiedAtEpochMs)}</td>
                    <td className="px-2 font-mono text-[9px] text-muted-foreground">{entry.permissions ?? "—"}</td>
                    <td className="px-2 text-muted-foreground">{entry.ownerLabel || entry.groupLabel ? `${entry.ownerLabel ?? (entry.uid == null ? "—" : entry.uid)}/${entry.groupLabel ?? (entry.gid == null ? "—" : entry.gid)}` : entry.uid != null || entry.gid != null ? `${entry.uid ?? "—"}/${entry.gid ?? "—"}` : "—"}</td>
                    <td />
                  </tr>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={entry.kind !== "directory"} onSelect={() => onOpenDirectory(entry)}>打开目录</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => onOpenRemoteFile(sessionId, entry.path)}>用编辑器打开</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind === "directory"} onSelect={() => onDownload([entry.path])}>下载</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => onAnalyzeText(entry)}><Sparkles size={12} />用 AI 分析文本…</ContextMenuItem>
                  <ContextMenuItem disabled={entry.kind !== "file"} onSelect={() => {
                    useDiagnosticStore.getState().setPendingContext({ sessionId, context: { kind: "sftpFile", remotePath: entry.path } });
                    useWorkspaceStore.getState().setAiOpen(true);
                  }}><Activity size={12} />制定只读诊断计划…</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onRename(entry)}>重命名</ContextMenuItem>
                  <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(entry)}>删除</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
            {!context.loading && visible.length === 0 && <tr><td colSpan={7} className="h-16 text-center text-muted-foreground">{context.query ? "当前目录没有匹配文件。" : "此目录为空。"}</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border px-2 text-[10px] text-muted-foreground">
        <span>{entries.length} 项{context.query ? "（当前目录筛选）" : ""}</span>
        {pageCount > 1 && <span className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(sessionId, currentPage - 1)}><ArrowLeft size={11} /></Button>
          <span>{currentPage + 1}/{pageCount}</span>
          <Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label="下一页" disabled={currentPage >= pageCount - 1} onClick={() => setPage(sessionId, currentPage + 1)}><ArrowRight size={11} /></Button>
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
      console.error("无法注册系统文件拖放处理器。", error);
      toast.error("系统文件拖放不可用；仍可使用上传按钮或本地文件栏传输。");
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
      if (event.state === "disconnected") setStatus(sessionId, "disconnected", event.message ?? undefined);
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
    }).catch((error: unknown) => {
      if (!currentView) return;
      const message = errorMessage(error);
      setStatus(sessionId, "error", message);
      toast.error(`SFTP 未能打开：${message}`);
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
    } catch (error) {
      useSftpSessionStore.getState().setLocalLoading(targetSessionId, false, errorMessage(error));
    }
  };

  const selectLocalRoot = async () => {
    if (!sessionId || !ready) return null;
    try {
      const selected = await openNativeDialog({ title: "选择本地文件夹授权范围", directory: true, multiple: false });
      if (typeof selected !== "string") return null;
      const grant = await grantLocalSftpRoot(sessionId, selected);
      useSftpSessionStore.getState().setLocalGrant(sessionId, grant.grantId, grant.currentPath);
      useSftpSessionStore.getState().setLocalPath(sessionId, "");
      await loadLocalDirectory(sessionId, grant.grantId, "");
      return grant.grantId;
    } catch (error) {
      toast.error(`无法授权本地文件夹：${errorMessage(error)}`);
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
      toast.message("请先选择本地授权文件夹。");
      return;
    }
    const onProgress = new Channel<TransferProgress>();
    onProgress.onmessage = (progress) => {
      if (progress.sessionId === sessionId) handleTransferProgress(progress);
    };
    try {
      await startSftpTransfers(sessionId, direction, localGrantId, sourcePaths, destinationDirectory, onProgress);
      setQueueOpen(true);
      toast.success(`${sourcePaths.length} 个文件已加入 SFTP 传输队列。`);
    } catch (error) {
      toast.error(`无法开始传输：${errorMessage(error)}`);
    }
  }, [context?.localGrantId, sessionId]);

  const acceptNativeDrop = useCallback(async (paths: string[], target: SftpDropTarget | null) => {
    setDropTarget(null);
    const remotePath = context?.path;
    if (!sessionId || sshSession?.state !== "connected") {
      toast.message("当前 SSH 标签尚未连接，请先连接后再上传。");
      return;
    }
    if (!ready) {
      toast.message("SFTP 尚未就绪，请等远程目录加载完成后再上传。");
      return;
    }
    if (!remotePath) {
      toast.message("当前远程目录尚未就绪，请刷新 SFTP 后重试。");
      return;
    }
    if (target !== "remote") {
      toast.message("请将文件放到当前 SSH 标签的远程文件列表中。");
      return;
    }
    try {
      const grantedFiles = await grantLocalSftpFiles(sessionId, paths);
      const groups = new Map<string, string[]>();
      for (const item of grantedFiles) groups.set(item.grantId, [...(groups.get(item.grantId) ?? []), item.relativePath]);
      for (const [grantId, relativePaths] of groups) {
        await startTransfer("upload", relativePaths, remotePath, grantId);
      }
    } catch (error) {
      toast.error(`无法从系统文件管理器上传：${errorMessage(error)}`);
    }
  }, [context?.path, ready, sessionId, sshSession?.state, startTransfer]);

  const copyLocalSelection = () => {
    if (!sessionId || !context?.localGrantId) return;
    const paths = context.localEntries
      .filter((entry) => entry.kind === "file" && context.localSelectedPaths.includes(entry.relativePath))
      .map((entry) => entry.relativePath);
    if (!paths.length) {
      toast.message("请先在本地文件栏选择要上传的文件。");
      return;
    }
    localFileClipboardRef.current = { grantId: context.localGrantId, paths };
    toast.success(`已复制 ${paths.length} 个本地文件；切到远程文件列表按 ${/Mac/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V"} 上传。`);
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
        toast.message("剪贴板里没有本地文件；可在本地文件栏选择文件后复制，或使用上传按钮。");
        return;
      }
      await acceptNativeDrop(paths, "remote");
    } catch (error) {
      toast.error(`无法读取剪贴板文件：${errorMessage(error)}`);
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
        toast.error("拖拽来源与当前 SSH 标签不同，已阻止跨连接传输。");
        return;
      }
      if (!payload.paths.length || payload.paths.length > 100) {
        toast.error("拖拽文件数量无效或超过 100 项限制。");
        return;
      }
      if (payload.kind === "local" && target === "remote" && payload.grantId) {
        void startTransfer("upload", payload.paths, context?.path ?? "", payload.grantId);
      } else if (payload.kind === "remote" && target === "local" && context?.localGrantId) {
        void startTransfer("download", payload.paths, context.localPath, context.localGrantId);
      } else if (payload.kind === "remote" && target === "local") {
        toast.message("请先在本地面板选择授权文件夹，再放入远程文件。");
      }
    } catch {
      toast.error("无法识别这次拖拽操作，未创建传输任务。");
    }
  };

  const chooseUpload = async () => {
    if (!sessionId || !ready || !context) return;
    try {
      const selected = await openNativeDialog({ title: "选择要上传的文件", multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const grantedFiles = await grantLocalSftpFiles(sessionId, paths);
      const groups = new Map<string, string[]>();
      for (const item of grantedFiles) groups.set(item.grantId, [...(groups.get(item.grantId) ?? []), item.relativePath]);
      for (const [grantId, relativePaths] of groups) {
        await startTransfer("upload", relativePaths, context.path, grantId);
      }
    } catch (error) {
      toast.error(`上传文件授权失败：${errorMessage(error)}`);
    }
  };

  const chooseDownload = async (paths = context?.selectedPaths ?? []) => {
    if (!sessionId || !context || !ready || !paths.length) {
      if (!paths.length) toast.message("请先选择要下载的远程文件。");
      return;
    }
    const entries = paths.map((path) => context.entries.find((entry) => entry.path === path));
    if (entries.some((entry) => entry?.kind === "directory")) {
      toast.error("目前只支持单个文件传输，请取消文件夹选择后重试。");
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
    } catch (error) {
      toast.error(`处理文件冲突失败：${errorMessage(error)}`);
    } finally {
      setConflictBusy(false);
    }
  };

  const cancelTransfer = async (transferId: string) => {
    try {
      await cancelSftpTransfer(transferId);
    } catch (error) {
      toast.error(`取消传输失败：${errorMessage(error)}`);
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
      toast.message("已重新加入传输队列，目标冲突会重新确认。");
    } catch (error) {
      toast.error(`重试失败：${errorMessage(error)}`);
    }
  };

  const clearTransfers = async () => {
    if (!sessionId || !context) return;
    try {
      await clearCompletedSftpTransfers(sessionId);
      setTransfers(sessionId, context.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)));
    } catch (error) {
      toast.error(`清理传输历史失败：${errorMessage(error)}`);
    }
  };

  const submitNewFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || !context || !newFolderName.trim() || busy) return;
    setBusy(true);
    try {
      await createSftpDirectory(sessionId, context.path, newFolderName);
      toast.success("已在远程服务器创建文件夹。");
      setNewFolderName("");
      setNewFolderOpen(false);
      refresh();
      if (context.expandedPaths.includes(context.path)) void readTreeDirectory(sessionId, context.path, true);
    } catch (error) {
      toast.error(`新建文件夹失败：${errorMessage(error)}`);
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
      toast.success("远程路径已重命名。");
      setRenameEntry(null);
      refresh();
      void readTreeDirectory(sessionId, parentPath(renameEntry.path), true);
    } catch (error) {
      toast.error(`重命名失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = async (entry: RemoteEntry) => {
    if (!sessionId) return;
    try {
      setDeleteConfirmation(await prepareSftpDelete(sessionId, entry.path));
      setDeleteOpen(true);
    } catch (error) {
      toast.error(`无法删除：${errorMessage(error)}`);
    }
  };

  const confirmDelete = async () => {
    if (!sessionId || !deleteConfirmation || busy) return;
    setBusy(true);
    try {
      await deleteSftpPath(sessionId, deleteConfirmation.operationId);
      toast.success("远程项目已删除。");
      setDeleteOpen(false);
      setDeleteConfirmation(null);
      refresh();
      void readTreeDirectory(sessionId, parentPath(deleteConfirmation.path), true);
    } catch (error) {
      toast.error(`删除失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`flex min-h-0 min-w-0 flex-col border-t border-border bg-panel ${collapsed ? "h-8" : "h-full"}`} aria-label="SFTP 远程文件面板">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        <div className="flex h-full items-stretch gap-3" role="tablist" aria-label="SFTP 功能">
          <button type="button" role="tab" aria-selected={sftpMode === "files"} className={`border-b-2 px-2 text-xs ${sftpMode === "files" ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setSftpMode("files")}>文件</button>
          <button type="button" role="tab" aria-selected={sftpMode === "commands"} className={`border-b-2 px-2 text-xs ${sftpMode === "commands" ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setSftpMode("commands")}>命令</button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`mr-1 rounded-sm border px-1.5 py-0.5 text-[9px] ${ready ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : "border-border text-muted-foreground"}`} aria-live="polite">
            {ready ? "SFTP 已连接" : context?.status === "opening" ? "正在打开 SFTP" : context?.status === "error" ? "SFTP 不可用" : sshSession?.state === "connected" ? "SFTP 等待中" : "SFTP 未连接"}
          </span>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={collapsed ? "展开 SFTP 面板" : "折叠 SFTP 面板"} title={collapsed ? "展开 SFTP 面板" : "折叠 SFTP 面板"} onClick={onToggleCollapse}>{collapsed ? <PanelBottomOpen size={13} /> : <PanelBottomClose size={13} />}</Button>
        </div>
      </header>
      {!collapsed && <>
        <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel-header/35 px-1.5">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="返回上一路径" title="返回上一路径" onClick={goBack} disabled={!ready || !context?.backHistory.length}><ArrowLeft size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="前进到下一路径" title="前进到下一路径" onClick={goForward} disabled={!ready || !context?.forwardHistory.length}><ArrowRight size={13} /></Button>
          <Input ref={pathInputRef} className="h-7 min-w-0 flex-1 rounded-sm border-border bg-background px-2 font-mono text-[11px]" value={context?.pathDraft ?? ""} disabled={!ready || sftpMode !== "files"} placeholder="连接后显示远程路径" aria-label="远程路径" onChange={(event) => sessionId && setPathDraft(sessionId, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && context?.pathDraft) navigate(context.pathDraft); }} />
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="刷新文件列表" title="刷新远程目录" onClick={refresh} disabled={!ready || context?.loading}><RefreshCw size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="转到父目录" title="上级目录" onClick={goUp} disabled={!ready || context?.path === "/"}><ArrowUp size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="新建文件夹" title="新建远程文件夹" onClick={() => setNewFolderOpen(true)} disabled={!ready || sftpMode !== "files"}><FolderPlus size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="上传文件" title={`上传文件；也可拖入，或在远程列表按 ${/Mac/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V"} 粘贴`} onClick={() => void chooseUpload()} disabled={!ready || sftpMode !== "files"}><Upload size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground" aria-label="下载选中文件" title="下载选中的远程文件" onClick={() => void chooseDownload()} disabled={!ready || !context?.selectedPaths.length}><Download size={13} /></Button>
          <Button type="button" variant={sftpBrowserMode === "dual" ? "secondary" : "ghost"} size="xs" className="h-6 shrink-0 rounded-sm px-2 text-[10px]" aria-pressed={sftpBrowserMode === "dual"} onClick={() => setSftpBrowserMode(sftpBrowserMode === "dual" ? "remote" : "dual")} disabled={!ready}>本地 / 远程</Button>
          <div className="relative shrink-0">
            <Button type="button" variant="ghost" size="icon" className="relative h-6 w-6 rounded-sm text-muted-foreground" aria-label="打开传输队列" aria-expanded={queueOpen} title="传输队列" onClick={() => setQueueOpen((open) => !open)} disabled={!sessionId}>
              <ListChecks size={13} />
              {(context?.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)).length ?? 0) > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-accent px-0.5 text-[8px] leading-3 text-white">{context?.transfers.filter((item) => ["queued", "running", "awaitingConflict"].includes(item.status)).length}</span>}
            </Button>
            {queueOpen && context && <div className="absolute right-0 top-7 z-40 w-[min(420px,calc(100vw-36px))] rounded border border-border bg-panel shadow-xl">
              <header className="flex h-8 items-center justify-between border-b border-border bg-panel-header px-2 text-[11px] font-medium">
                <span>传输队列 · {context.transfers.length} 项</span>
                <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="xs" className="h-5 rounded-sm px-1.5 text-[10px]" onClick={() => void clearTransfers()} disabled={!context.transfers.some((item) => ["completed", "failed", "canceled", "skipped"].includes(item.status))}>清理已结束</Button><Button type="button" variant="ghost" size="icon" className="h-5 w-5 rounded-sm" aria-label="关闭传输队列" onClick={() => setQueueOpen(false)}>×</Button></div>
              </header>
              <div className="compact-scrollbar max-h-64 overflow-auto">
                {context.transfers.length === 0 ? <div className="p-4 text-center text-[11px] text-muted-foreground">暂无传输任务。</div> : context.transfers.map((transfer) => {
                  const active = ["queued", "running", "awaitingConflict"].includes(transfer.status);
                  const percent = transfer.bytesTotal && transfer.bytesTotal > 0 ? Math.min(100, transfer.bytesDone / transfer.bytesTotal * 100) : transfer.status === "completed" ? 100 : 0;
                  return <div key={transfer.transferId} className="grid gap-1 border-b border-border/70 px-2 py-1.5 last:border-b-0">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="min-w-0 truncate font-mono">{transfer.direction === "upload" ? "上传" : "下载"} · {basename(transfer.sourcePath)}</span>
                      <span className={`shrink-0 ${transfer.status === "failed" ? "text-destructive" : transfer.status === "completed" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>{transferStatusLabel(transfer.status)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-muted"><div className={`h-full ${transfer.status === "failed" ? "bg-destructive" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>
                      <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{formatSize(transfer.bytesDone)}{transfer.bytesTotal == null ? "" : ` / ${formatSize(transfer.bytesTotal)}`}{transfer.speedBytesPerSec ? ` · ${formatSize(transfer.speedBytesPerSec)}/s` : ""}</span>
                      {active && <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground" aria-label={`取消 ${basename(transfer.sourcePath)}`} title="取消传输" onClick={() => void cancelTransfer(transfer.transferId)}>×</Button>}
                      {["failed", "canceled"].includes(transfer.status) && <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground" aria-label={`重试 ${basename(transfer.sourcePath)}`} title="重新传输" onClick={() => void retryTransfer(transfer.transferId)}><RefreshCw size={11} /></Button>}
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
            <Input className="h-7 rounded-sm border-border bg-background pl-7 pr-2 text-[11px]" placeholder="搜索当前目录..." value={context?.query ?? ""} onChange={(event) => sessionId && setQuery(sessionId, event.target.value)} disabled={!ready || sftpMode !== "files"} aria-label="筛选当前目录文件" />
          </div>
          <Button type="button" variant={context?.compact ? "secondary" : "outline"} size="icon" className="h-6 w-6 shrink-0 rounded-sm" aria-label="紧凑列表视图" aria-pressed={Boolean(context?.compact)} title="紧凑列表" onClick={() => sessionId && setCompact(sessionId, true)} disabled={!ready}><List size={13} /></Button>
          <Button type="button" variant={!context?.compact ? "secondary" : "outline"} size="icon" className="h-6 w-6 shrink-0 rounded-sm" aria-label="详细列表视图" aria-pressed={!context?.compact} title="详细列表" onClick={() => sessionId && setCompact(sessionId, false)} disabled={!ready}><Grid2X2 size={13} /></Button>
        </div>
        {sftpMode === "commands" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-xs text-muted-foreground">SFTP 命令视图暂不执行远程 Shell 命令。</div>
        ) : ready && sessionId && context ? (
          <div className="flex min-h-0 flex-1">
            {sftpBrowserMode === "dual" ? <ResizablePanelGroup orientation="horizontal" defaultLayout={dualSftpLayout} onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) useWorkspaceStore.getState().setLayout("dualSftp", layout); }}>
              <ResizablePanel id="local" defaultSize="42%" minSize="220px" className="min-w-0 border-r border-border">
                <div data-sftp-drop-target="local" className="relative h-full min-w-0" onDragOver={(event) => handleInternalDragOver(event, "local")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "local")}>
                  <LocalFilePane sessionId={sessionId} context={context} onChooseRoot={() => void selectLocalRoot()} onRefresh={() => { if (context.localGrantId) void loadLocalDirectory(sessionId, context.localGrantId, context.localPath); }} onNavigate={navigateLocal} onUpload={() => void startTransfer("upload", context.localSelectedPaths, context.path)} onCopySelected={copyLocalSelection} />
                  {dropTarget === "local" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">放开后下载到 {localDisplayPath(context) || "本地授权目录"}</div>}
                </div>
              </ResizablePanel>
              <ResizableHandle aria-label="调整本地与远程文件栏宽度" />
              <ResizablePanel id="remote" defaultSize="58%" minSize="320px" className="min-w-0">
                <div data-sftp-drop-target="remote" className="relative h-full min-w-0 focus-visible:outline-none" tabIndex={0} aria-label="远程文件列表，可粘贴本地文件上传" onKeyDown={handleRemotePasteKeyDown} onDragOver={(event) => handleInternalDragOver(event, "remote")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "remote")}>
                  {context.loading ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><span className="mr-2 h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" />正在读取远程目录…</div> : context.error ? <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"><span>{context.error}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={refresh}>重试</Button></div> : <RemoteFileTable sessionId={sessionId} context={context} onOpenDirectory={(entry) => navigate(entry.path)} onOpenRemoteFile={onOpenRemoteFile} onDownload={(paths) => void chooseDownload(paths)} onRename={(entry) => { setRenameEntry(entry); setRenameValue(entry.name); }} onDelete={(entry) => void requestDelete(entry)} onAnalyzeText={(entry) => { useAiStore.getState().setIntent({ sessionId, prompt: "请解释这个文件的主要内容，指出可能的运行风险或错误，并给出只读排查建议。", sources: [{ kind: "sftpSelectedText", remotePath: entry.path }] }); useWorkspaceStore.getState().setAiOpen(true); }} />}
                  {dropTarget === "remote" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">放开后上传{dropCount ? ` ${dropCount} 项` : "文件"}到 {sshSession?.profile.name ?? sshSession?.profile.host ?? "当前 SSH 标签"} · {context.path}</div>}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup> : <ResizablePanelGroup orientation="horizontal" defaultLayout={sftpLayout} onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) useWorkspaceStore.getState().setLayout("sftp", layout); }}>
              <ResizablePanel id="tree" defaultSize="19%" minSize="140px" className="min-w-0 border-r border-border">
                <RemoteDirectoryTree sessionId={sessionId} context={context} onNavigate={(path) => navigate(path)} />
              </ResizablePanel>
              <ResizableHandle aria-label="调整远程目录树宽度" />
              <ResizablePanel id="files" defaultSize="81%" minSize="320px" className="min-w-0">
                <div data-sftp-drop-target="remote" className="relative h-full min-w-0 focus-visible:outline-none" tabIndex={0} aria-label="远程文件列表，可粘贴本地文件上传" onKeyDown={handleRemotePasteKeyDown} onDragOver={(event) => handleInternalDragOver(event, "remote")} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => handleInternalDrop(event, "remote")}>
                  {context.loading ? <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><span className="mr-2 h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-accent" />正在读取远程目录…</div> : context.error ? <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"><span>{context.error}</span><Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={refresh}>重试</Button></div> : <RemoteFileTable sessionId={sessionId} context={context} onOpenDirectory={(entry) => navigate(entry.path)} onOpenRemoteFile={onOpenRemoteFile} onDownload={(paths) => void chooseDownload(paths)} onRename={(entry) => { setRenameEntry(entry); setRenameValue(entry.name); }} onDelete={(entry) => void requestDelete(entry)} onAnalyzeText={(entry) => { useAiStore.getState().setIntent({ sessionId, prompt: "请解释这个文件的主要内容，指出可能的运行风险或错误，并给出只读排查建议。", sources: [{ kind: "sftpSelectedText", remotePath: entry.path }] }); useWorkspaceStore.getState().setAiOpen(true); }} />}
                  {dropTarget === "remote" && <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded border-2 border-dashed border-accent bg-panel/90 px-4 text-center text-xs font-medium text-foreground shadow-lg">放开后上传{dropCount ? ` ${dropCount} 项` : "文件"}到 {sshSession?.profile.name ?? sshSession?.profile.host ?? "当前 SSH 标签"} · {context.path}</div>}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <span>{context?.status === "error" ? context.error : sshSession?.state === "connected" ? "正在建立与当前 SSH 标签关联的 SFTP 通道…" : "尚无远程会话。连接 SSH 后将加载真实远程目录。"}</span>
            {context?.status === "error" && sessionId && sshSession?.state === "connected" && <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { useSftpSessionStore.getState().setStatus(sessionId, "idle"); setRetryCount((value) => value + 1); }}>重新连接 SFTP</Button>}
          </div>
        )}
      </>}

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center border-b border-border bg-panel-header px-3"><DialogTitle>新建远程文件夹</DialogTitle><DialogDescription className="sr-only">当前 SFTP 目录下新建一个空文件夹。</DialogDescription></header>
          <form className="grid gap-3 p-3" onSubmit={(event) => void submitNewFolder(event)}>
            <div className="truncate rounded-sm border border-border bg-background/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{context?.path ?? ""}</div>
            <label className="grid gap-1 text-[11px] text-muted-foreground">文件夹名称<Input autoFocus className="h-8 rounded-sm text-xs" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} required /></label>
            <footer className="flex justify-end gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setNewFolderOpen(false)}>取消</Button><Button type="submit" size="xs" className="rounded-sm" disabled={busy || !newFolderName.trim()}>创建</Button></footer>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameEntry !== null} onOpenChange={(open) => { if (!open) setRenameEntry(null); }}>
        <DialogContent className="gap-0 p-0">
          <header className="flex h-10 items-center border-b border-border bg-panel-header px-3"><DialogTitle>重命名远程项目</DialogTitle><DialogDescription className="sr-only">输入新的远程文件或文件夹名称。</DialogDescription></header>
          <form className="grid gap-3 p-3" onSubmit={(event) => void submitRename(event)}>
            <div className="truncate rounded-sm border border-border bg-background/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{renameEntry?.path ?? ""}</div>
            <label className="grid gap-1 text-[11px] text-muted-foreground">新名称<Input autoFocus className="h-8 rounded-sm text-xs" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required /></label>
            <footer className="flex justify-end gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setRenameEntry(null)}>取消</Button><Button type="submit" size="xs" className="rounded-sm" disabled={busy || !renameValue}>重命名</Button></footer>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!open && !busy) { setDeleteOpen(false); setDeleteConfirmation(null); } }}>
        <AlertDialogContent>
          <AlertDialogTitle>确认删除远程项目</AlertDialogTitle>
          <AlertDialogDescription>此操作将通过 SFTP 删除已确认的路径；目录只允许删除空目录。</AlertDialogDescription>
          {deleteConfirmation && <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-background/50 p-2 text-[11px]">
            <dt className="text-muted-foreground">服务器</dt><dd className="break-all font-mono">{deleteConfirmation.serverName}</dd>
            <dt className="text-muted-foreground">路径</dt><dd className="break-all font-mono">{deleteConfirmation.path}</dd>
            <dt className="text-muted-foreground">类型</dt><dd>{deleteConfirmation.kind === "directory" ? "空目录" : deleteConfirmation.kind === "symlink" ? "符号链接" : "文件"}</dd>
            <dt className="text-muted-foreground">影响数量</dt><dd>{deleteConfirmation.affectedCount} 项</dd>
          </dl>}
          <footer className="flex justify-end gap-2 border-t border-border pt-2">
            <AlertDialogCancel asChild><Button type="button" variant="ghost" size="xs" className="rounded-sm" disabled={busy}>取消</Button></AlertDialogCancel>
            <AlertDialogAction asChild><Button type="button" variant="destructive" size="xs" className="rounded-sm" disabled={busy} onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>{busy ? "正在删除…" : "确认删除"}</Button></AlertDialogAction>
          </footer>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingConflict !== undefined} onOpenChange={() => undefined}>
        <AlertDialogContent>
          <AlertDialogTitle>目标文件已存在</AlertDialogTitle>
          <AlertDialogDescription>传输任务暂停等待选择。默认不会覆盖远程或本地已有文件。</AlertDialogDescription>
          {pendingConflict && <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-background/50 p-2 text-[11px]">
            <dt className="text-muted-foreground">来源</dt><dd className="break-all font-mono">{pendingConflict.sourcePath}</dd>
            <dt className="text-muted-foreground">目标</dt><dd className="break-all font-mono">{pendingConflict.conflictPath ?? pendingConflict.destinationPath}</dd>
            <dt className="text-muted-foreground">文件大小</dt><dd>{pendingConflict.bytesTotal == null ? "未知" : formatSize(pendingConflict.bytesTotal)}</dd>
          </dl>}
          <label className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
            <input type="checkbox" className="mt-0.5 accent-primary" checked={applyConflictPolicyToQueue} disabled={conflictBusy} onChange={(event) => setApplyPolicyTransferId(event.target.checked ? pendingConflict?.transferId ?? null : null)} />
            对当前 SSH 会话的本次传输队列应用所选策略；后续冲突将自动处理。
          </label>
          <footer className="flex flex-wrap justify-end gap-2 border-t border-border pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("skip")}>跳过此文件</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("rename")}>保留两者（自动改名）</Button>
            <Button type="button" variant="destructive" size="xs" className="rounded-sm" disabled={conflictBusy} onClick={() => void resolveConflict("overwrite")}>覆盖目标</Button>
          </footer>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
