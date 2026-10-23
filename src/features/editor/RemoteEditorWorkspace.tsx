import "./monacoWorkers";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  FileCode2,
  FoldVertical,
  GitCompareArrows,
  PanelTopClose,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  closeRemoteDocument,
  compareRemoteDocument,
  getEditorSaveCapabilities,
  rebindRemoteDocument,
  reloadRemoteDocument,
  saveRemoteDocument,
  saveRemoteDocumentAs,
  type EditorCompareResult,
} from "./remoteEditorBridge";
import { getRegisteredLanguageReport, languageMappings } from "./languageRegistry";
import { useEditorStore, type RemoteEditorTab } from "./editorStore";

type EditorViewProps = {
  connectionId: string;
  connectionName: string;
  sessionId: string | null;
  connected: boolean;
  children: ReactNode;
};

type ClosePrompt = { documentId: string; closeAfterSave: boolean } | null;
type ConflictPrompt = {
  documentId: string;
  remote: EditorCompareResult | null;
  loading: boolean;
  message: string;
} | null;

type SensitivePrompt = { documentId: string; closeAfterSave: boolean; asPath?: string } | null;

const modelByDocument = new Map<string, monaco.editor.ITextModel>();
const viewStateByDocument = new Map<string, monaco.editor.ICodeEditorViewState>();

function safeErrorMessage(error: unknown) {
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as { message?: string };
      return parsed.message ?? error;
    } catch {
      return error;
    }
  }
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "远程编辑操作失败；本地编辑缓冲仍保留。";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function isSensitivePath(path: string) {
  const normalized = path.toLowerCase();
  return normalized === "/etc"
    || normalized.startsWith("/etc/")
    || normalized.includes("/.ssh/")
    || normalized.endsWith("/.ssh")
    || /\.(env|pem|key|p12|pfx|crt|cer)$/.test(normalized);
}

function modelUri(tab: RemoteEditorTab) {
  const path = tab.canonicalPath.split("/").map(encodeURIComponent).join("/");
  return monaco.Uri.parse(`termvista://remote/${tab.documentId}${path}`);
}

function makeModel(tab: RemoteEditorTab) {
  const existing = modelByDocument.get(tab.documentId);
  if (existing && !existing.isDisposed()) return existing;
  const uri = modelUri(tab);
  const model = monaco.editor.getModel(uri)
    ?? monaco.editor.createModel(tab.text, tab.languageId, uri);
  monaco.editor.setModelLanguage(model, tab.languageId);
  modelByDocument.set(tab.documentId, model);
  return model;
}

function EditorButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon}</Button>;
}

export function RemoteEditorWorkspace({
  connectionId,
  connectionName,
  sessionId,
  connected,
  children,
}: EditorViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelSubscriptionRef = useRef<monaco.IDisposable | null>(null);
  const currentModelDocumentRef = useRef<string | null>(null);
  const docs = useEditorStore(useShallow((state) => state.documents.filter((document) => document.connectionId === connectionId)));
  const activeId = useEditorStore((state) => state.activeByConnection[connectionId] ?? "terminal");
  const activate = useEditorStore((state) => state.activate);
  const activateTerminal = useEditorStore((state) => state.activateTerminal);
  const setLanguage = useEditorStore((state) => state.setLanguage);
  const setSaveState = useEditorStore((state) => state.setSaveState);
  const markSaved = useEditorStore((state) => state.markSaved);
  const removeDocument = useEditorStore((state) => state.remove);
  const removeCleanDocuments = useEditorStore((state) => state.removeCleanDocuments);
  const theme = useWorkspaceStore((state) => state.theme);
  const activeDocument = docs.find((document) => document.documentId === activeId) ?? null;
  const editorDocumentOpen = Boolean(activeDocument);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [closePrompt, setClosePrompt] = useState<ClosePrompt>(null);
  const [sensitivePrompt, setSensitivePrompt] = useState<SensitivePrompt>(null);
  const [conflictPrompt, setConflictPrompt] = useState<ConflictPrompt>(null);
  const [saveAsPath, setSaveAsPath] = useState("");
  const [saveAsPrompt, setSaveAsPrompt] = useState<string | null>(null);
  const [capabilityNote, setCapabilityNote] = useState("");
  const [busy, setBusy] = useState(false);

  const languageReport = useMemo(
    () => getRegisteredLanguageReport(monaco.languages.getLanguages()),
    [],
  );
  const registeredLanguageCount = languageReport.registeredCount;
  const registeredIds = useMemo(
    () => new Set(monaco.languages.getLanguages().map((language) => language.id)),
    [],
  );
  const languageOptions = useMemo(() => {
    const used = new Set<string>();
    return languageMappings.filter((item) => registeredIds.has(item.id) && !used.has(item.id) && Boolean(used.add(item.id)));
  }, [registeredIds]);

  useEffect(() => {
    if (import.meta.env.DEV) console.info("Monaco 已注册语法模式", languageReport.registeredCount, languageReport.missingIds);
  }, [languageReport]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: "",
      language: "plaintext",
      theme: "vs",
      automaticLayout: false,
      minimap: { enabled: false },
      lineNumbers: "on",
      glyphMargin: false,
      folding: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      wordWrap: "off",
      smoothScrolling: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      padding: { top: 8, bottom: 8 },
      stickyScroll: { enabled: false },
      largeFileOptimizations: true,
      maxTokenizationLineLength: 20_000,
      formatOnPaste: false,
      formatOnType: false,
      trimAutoWhitespace: false,
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      readOnly: true,
      contextmenu: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true },
    });
    editorRef.current = editor;
    const cursorListener = editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
      cursorListener.dispose();
      modelSubscriptionRef.current?.dispose();
      modelSubscriptionRef.current = null;
      editor.dispose();
      editorRef.current = null;
      currentModelDocumentRef.current = null;
    };
  }, [editorDocumentOpen]);

  useEffect(() => {
    const editor = editorRef.current;
    const documentId = activeId === "terminal" ? null : activeId;
    const document = documentId
      ? useEditorStore.getState().documents.find((item) => item.documentId === documentId) ?? null
      : null;
    if (!editor || !document) return;
    const model = makeModel(document);
    if (model.getValue() !== document.text && !document.dirty) {
      model.setValue(document.text);
    }
    const currentViewState = editor.saveViewState();
    if (currentModelDocumentRef.current && currentViewState) {
      viewStateByDocument.set(currentModelDocumentRef.current, currentViewState);
    }
    modelSubscriptionRef.current?.dispose();
    editor.setModel(model);
    editor.updateOptions({ readOnly: document.readOnly || !connected || document.sessionId !== sessionId });
    const previousState = viewStateByDocument.get(document.documentId);
    if (previousState) editor.restoreViewState(previousState);
    modelSubscriptionRef.current = model.onDidChangeContent(() => {
      useEditorStore.getState().updateText(document.documentId, model.getValue());
    });
    currentModelDocumentRef.current = document.documentId;
    if (activeId !== "terminal") editor.focus();
  }, [activeId, connected, sessionId]);

  useEffect(() => {
    const documentId = activeDocument?.documentId;
    if (!documentId) return;
    const document = useEditorStore.getState().documents.find((item) => item.documentId === documentId);
    if (!document || document.dirty) return;
    const model = modelByDocument.get(documentId);
    if (model && model.getValue() !== document.text) model.setValue(document.text);
  }, [activeDocument?.documentId, activeDocument?.sha256]);

  const activeLanguageId = activeDocument?.languageId;
  const activeReadOnly = activeDocument?.readOnly;
  const activeDocumentSessionId = activeDocument?.sessionId;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
    if (activeLanguageId) {
      const model = editor.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, activeLanguageId);
        editor.updateOptions({ readOnly: Boolean(activeReadOnly) || !connected || activeDocumentSessionId !== sessionId });
      }
    }
    editor.layout();
  }, [theme, activeLanguageId, activeReadOnly, activeDocumentSessionId, connected, sessionId]);

  const closeNow = useCallback(async (tab: RemoteEditorTab) => {
    try {
      await closeRemoteDocument(tab.documentId);
    } catch {
      // 本地关闭仍然有效；后端会话断开时文档快照随进程结束清理。
    }
    if (currentModelDocumentRef.current === tab.documentId) {
      modelSubscriptionRef.current?.dispose();
      modelSubscriptionRef.current = null;
      currentModelDocumentRef.current = null;
    }
    const model = modelByDocument.get(tab.documentId);
    model?.dispose();
    modelByDocument.delete(tab.documentId);
    viewStateByDocument.delete(tab.documentId);
    removeDocument(tab.documentId);
    setClosePrompt(null);
    setSensitivePrompt(null);
  }, [removeDocument]);

  const showConflict = useCallback(async (tab: RemoteEditorTab, message: string) => {
    setSaveState(tab.documentId, "conflict", message);
    setConflictPrompt({ documentId: tab.documentId, remote: null, loading: true, message });
    try {
      const remote = await compareRemoteDocument(tab.documentId);
      setConflictPrompt({ documentId: tab.documentId, remote, loading: false, message });
    } catch (error) {
      setConflictPrompt({ documentId: tab.documentId, remote: null, loading: false, message: `${message} ${safeErrorMessage(error)}` });
    }
  }, [setSaveState]);

  const saveDocument = useCallback(async (
    documentId: string,
    confirmSensitive = false,
    closeAfterSave = false,
    asPath?: string,
  ) => {
    const tab = useEditorStore.getState().documents.find((item) => item.documentId === documentId);
    if (!tab || !tab.dirty || !tab.sha256) return false;
    if (!connected || tab.sessionId !== sessionId) {
      setSaveState(documentId, "offline", "SSH 会话未连接或已变化。编辑草稿保留；重连后必须重新校验指纹和远程版本。");
      return false;
    }
    if ((tab.sensitive || (asPath && isSensitivePath(asPath))) && !confirmSensitive) {
      if (closeAfterSave) setClosePrompt(null);
      if (asPath) setSaveAsPrompt(null);
      setSensitivePrompt({ documentId, closeAfterSave, asPath });
      return false;
    }
    setBusy(true);
    setSaveState(documentId, "saving", null);
    try {
      const expectedSha256 = tab.sha256;
      const result = asPath
        ? await saveRemoteDocumentAs(documentId, expectedSha256, asPath, tab.text, confirmSensitive)
        : await saveRemoteDocument(documentId, expectedSha256, tab.text, confirmSensitive);
      if (result.status === "conflict") {
        setBusy(false);
        setSaveAsPrompt(null);
        await showConflict(tab, result.message ?? "远程文件发生变化，保存已阻止。");
        return false;
      }
      if (result.status === "unsupported") {
        setBusy(false);
        setSaveState(documentId, "conflict", result.message ?? "服务器不支持安全替换。原文件未修改。");
        setConflictPrompt({ documentId, remote: null, loading: false, message: result.message ?? "服务器不支持安全替换。原文件未修改。" });
        return false;
      }
      if (!result.verified || !result.newSha256) throw new Error("服务端未完成写后校验，编辑缓冲保持未保存。");
      markSaved(documentId, {
        sha256: result.newSha256,
        text: tab.text,
        canonicalPath: result.canonicalPath,
        displayName: result.canonicalPath.split("/").pop() ?? tab.displayName,
        sizeBytes: result.sizeBytes ?? new TextEncoder().encode(tab.text).length,
      });
      if (result.message) toast.message(result.message, { duration: 5500 });
      else toast.success("远程文件已保存并回读校验。", { duration: 2500 });
      setSensitivePrompt(null);
      setConflictPrompt(null);
      setSaveAsPrompt(null);
      setSaveAsPath("");
      if (closeAfterSave) {
        const updated = useEditorStore.getState().documents.find((item) => item.documentId === documentId);
        if (updated) await closeNow(updated);
      }
      return true;
    } catch (error) {
      const message = safeErrorMessage(error);
      setSaveState(documentId, /断开|连接|会话/i.test(message) ? "offline" : "error", message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [connected, sessionId, setSaveState, showConflict, markSaved, closeNow]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const inEditor = Boolean(target?.closest(".monaco-editor"));
      const inTerminal = Boolean(target?.closest(".xterm"));
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (inEditor) {
        event.preventDefault();
        event.stopPropagation();
        const activeDocumentId = useEditorStore.getState().activeByConnection[connectionId];
        if (activeDocumentId && activeDocumentId !== "terminal") {
          void saveDocument(activeDocumentId);
        }
      } else if (inTerminal) {
        // 防止浏览器保存页面；终端聚焦时绝不调用编辑器保存。
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [connectionId, saveDocument]);

  const openClosePrompt = (tab: RemoteEditorTab) => {
    if (tab.dirty) {
      setClosePrompt({ documentId: tab.documentId, closeAfterSave: true });
      return;
    }
    void closeNow(tab);
  };

  const chooseCloseSave = async () => {
    const targetId = closePrompt?.documentId;
    if (!targetId) return;
    const tab = useEditorStore.getState().documents.find((item) => item.documentId === targetId);
    if (!tab) return;
    const saved = await saveDocument(targetId, false, true);
    if (saved) setClosePrompt(null);
  };

  const startSave = (tab: RemoteEditorTab) => void saveDocument(tab.documentId);

  const openOrClose = (tab: RemoteEditorTab) => openClosePrompt(tab);

  const restoreLargeFile = async (tab: RemoteEditorTab) => {
    if (!sessionId || !connected) return;
    try {
      const fullDocument = await reloadRemoteDocument(tab.documentId);
      const editorStoreDoc = useEditorStore.getState().documents.find((item) => item.documentId === tab.documentId);
      if (!editorStoreDoc || editorStoreDoc.dirty) {
        toast.warning("文件已修改，请先保存或关闭后重新打开再继续编辑。");
        return;
      }
      useEditorStore.getState().mergeRemote(fullDocument, false);
      if (fullDocument.readOnly) toast.message(fullDocument.readOnlyReason ?? "此文件仍以只读方式打开。");
    } catch (error) {
      toast.error(safeErrorMessage(error));
    }
  };

  const onRebind = async (tab: RemoteEditorTab) => {
    if (!sessionId || !connected) return;
    try {
      const document = await rebindRemoteDocument(tab.documentId, sessionId);
      useEditorStore.getState().mergeRemote(document, true);
      toast.success("已核对连接身份与远程文件版本，编辑缓冲已重新绑定。");
    } catch (error) {
      await showConflict(tab, safeErrorMessage(error));
    }
  };

  const onReload = async () => {
    if (!conflictPrompt) return;
    const tab = useEditorStore.getState().documents.find((item) => item.documentId === conflictPrompt.documentId);
    if (!tab) return;
    try {
      const document = await reloadRemoteDocument(tab.documentId);
      useEditorStore.getState().mergeRemote(document, false);
      const model = modelByDocument.get(tab.documentId);
      if (model && document.text != null) model.setValue(document.text);
      setConflictPrompt(null);
      toast.message("已重新加载远程版本；本地未保存修改已放弃。", { duration: 3500 });
    } catch (error) {
      toast.error(safeErrorMessage(error));
    }
  };

  const onCompare = async (tab: RemoteEditorTab) => {
    setConflictPrompt({ documentId: tab.documentId, remote: null, loading: true, message: "正在读取远程版本…" });
    try {
      const remote = await compareRemoteDocument(tab.documentId);
      setConflictPrompt({ documentId: tab.documentId, remote, loading: false, message: "保存前版本与远程当前版本如下。" });
    } catch (error) {
      setConflictPrompt({ documentId: tab.documentId, remote: null, loading: false, message: safeErrorMessage(error) });
    }
  };

  useEffect(() => {
    if (!sessionId || !connected) return;
    let disposed = false;
    void getEditorSaveCapabilities(sessionId).then((capabilities) => {
      if (!disposed) setCapabilityNote(capabilities.note);
    }).catch(() => {
      if (!disposed) setCapabilityNote("无法读取当前 SFTP 保存能力；保存操作将继续由 Rust 端逐项校验。");
    });
    return () => { disposed = true; };
  }, [sessionId, connected]);

  const activeView = activeId === "terminal" ? "terminal" : "editor";
  const languageOptionsForDoc = activeDocument
    ? languageOptions.filter((item) => item.id === activeDocument.languageId || item.id !== "plaintext")
    : languageOptions;
  const canSave = Boolean(activeDocument?.dirty && connected && activeDocument.sessionId === sessionId && !activeDocument.readOnly && activeDocument.sha256);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="终端与远程编辑工作区" data-monaco-language-count={registeredLanguageCount}>
      <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-panel-header px-1" role="tablist" aria-label="终端和编辑文件">
        <button type="button" role="tab" aria-selected={activeView === "terminal"} className={`flex h-full items-center gap-1.5 border-b-2 px-2 text-[10px] ${activeView === "terminal" ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => activateTerminal(connectionId)}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground/40"}`} />终端
        </button>
        <div className="compact-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="远程编辑文件">
          {docs.map((tab) => <div key={tab.documentId} role="presentation" className={`group flex h-full max-w-56 shrink-0 items-center border-b-2 ${activeId === tab.documentId ? "border-accent bg-panel text-foreground" : "border-transparent text-muted-foreground hover:bg-panel/70"}`}>
            <button type="button" role="tab" aria-selected={activeId === tab.documentId} title={`${connectionName} / ${tab.canonicalPath}`} className="flex h-full min-w-0 items-center gap-1 px-2 text-[10px]" onClick={() => activate(connectionId, tab.documentId)}>
              <FileCode2 size={11} className="shrink-0 text-accent" />
              <span className="truncate">{tab.displayName}</span>
              {tab.dirty && <span className="ml-0.5 text-[11px] font-bold text-accent" aria-label="未保存">●</span>}
              {!tab.dirty && tab.saveState === "saved" && <Check size={10} className="text-success" />}
            </button>
            <button type="button" aria-label={`关闭 ${tab.displayName}`} title="关闭编辑标签" className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => openOrClose(tab)}><X size={10} /></button>
          </div>)}
        </div>
        {docs.length > 0 && <Button type="button" variant="ghost" size="icon" className="h-6 w-6 self-center rounded-sm text-muted-foreground" aria-label="关闭未修改的编辑标签" title="关闭未修改的编辑标签" onClick={removeCleanDocuments}><PanelTopClose size={12} /></Button>}
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={activeView === "terminal" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} aria-hidden={activeView !== "terminal"}>
          {children}
        </div>
        {activeView === "editor" && activeDocument && <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected && activeDocument.sessionId === sessionId ? "bg-success" : "bg-warning"}`} />
              <span className="truncate text-[10px] font-medium" title={`${connectionName} / ${activeDocument.canonicalPath}`}>{activeDocument.canonicalPath}</span>
              {activeDocument.sensitive && <span className="shrink-0 rounded-sm border border-warning/40 px-1 py-0.5 text-[9px] text-warning">敏感路径</span>}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <EditorButton label="保存（⌘S / Ctrl+S）" icon={busy ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />} disabled={!canSave || busy} onClick={() => startSave(activeDocument)} />
              <EditorButton label="查找" icon={<Search size={12} />} onClick={() => { void editorRef.current?.getAction("actions.find")?.run(); }} />
              <EditorButton label="查找和替换" icon={<Code2 size={12} />} onClick={() => { void editorRef.current?.getAction("editor.action.startFindReplaceAction")?.run(); }} />
              <EditorButton label="跳转到行" icon={<ChevronDown size={12} />} onClick={() => { void editorRef.current?.getAction("editor.action.gotoLine")?.run(); }} />
              <EditorButton label="折叠全部代码" icon={<FoldVertical size={12} />} onClick={() => { void editorRef.current?.getAction("editor.foldAll")?.run(); }} />
              <EditorButton label="撤销" icon={<span className="text-[12px]">↶</span>} onClick={() => { void editorRef.current?.getAction("undo")?.run(); }} />
              <EditorButton label="重做" icon={<span className="text-[12px]">↷</span>} onClick={() => { void editorRef.current?.getAction("redo")?.run(); }} />
              <span className="mx-1 h-4 w-px bg-border" />
              <EditorButton label="与远程版本比较" icon={<GitCompareArrows size={12} />} onClick={() => void onCompare(activeDocument)} />
              {activeDocument.sessionId !== sessionId && connected && <Button type="button" variant="outline" size="xs" className="h-5 rounded-sm px-1.5 text-[9px]" onClick={() => void onRebind(activeDocument)}>重新校验并绑定</Button>}
              <EditorButton label="刷新远程文件" icon={<RefreshCw size={12} />} disabled={busy} onClick={() => {
                if (activeDocument.dirty) setConflictPrompt({ documentId: activeDocument.documentId, remote: null, loading: false, message: "重新加载会丢弃当前本地修改。请确认后再操作。" });
                else void onReload();
              }} />
            </div>
          </div>

          {activeDocument.readOnlyReason && <div className="flex min-h-7 items-center gap-1.5 border-b border-warning/20 bg-warning/5 px-3 py-1 text-[10px] text-warning" role="status">
            <AlertCircle size={11} className="shrink-0" />
            <span className="min-w-0 flex-1">{activeDocument.readOnlyReason}</span>
            {activeDocument.readOnlyReason.includes("2 MiB") && <Button type="button" variant="outline" size="xs" className="h-5 shrink-0 rounded-sm px-1.5 text-[9px]" onClick={() => void restoreLargeFile(activeDocument)}>继续编辑</Button>}
          </div>}

          <div className="relative min-h-0 flex-1" ref={hostRef} aria-label={`Monaco 编辑器 ${activeDocument.displayName}`}>
            {activeDocument.encoding === "unknown" && <div className="absolute inset-0 z-10 flex items-center justify-center bg-panel/95 p-6 text-center text-[11px] text-muted-foreground" role="status">
              无法安全识别此文件编码，原始文件保持只读且未做字符转换。请下载后用已知编码查看。
            </div>}
          </div>

          <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-panel-header px-2 text-[9px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <select aria-label="编辑器语言模式" className="h-4 max-w-40 border-0 bg-transparent text-[9px] text-muted-foreground outline-none" value={activeDocument.languageId} onChange={(event) => {
                const languageId = event.target.value;
                setLanguage(activeDocument.documentId, languageId);
                const model = modelByDocument.get(activeDocument.documentId);
                if (model) monaco.editor.setModelLanguage(model, languageId);
              }}>
                {languageOptionsForDoc.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
              </select>
              <span>{activeDocument.encoding}</span><span>{activeDocument.lineEnding.toUpperCase()}</span>
              <span>{formatBytes(activeDocument.sizeBytes)}</span>
              <span>{activeDocument.readOnly || activeDocument.sessionId !== sessionId || !connected ? "只读" : activeDocument.dirty ? "未保存" : "已同步"}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span>行 {cursor.line}，列 {cursor.column}</span>
              <span>{activeDocument.saveState === "saving" ? "正在保存…" : activeDocument.saveState === "conflict" ? "存在冲突" : activeDocument.saveState === "offline" ? "SSH 已断开，草稿保留" : activeDocument.saveState === "error" ? "保存失败，草稿保留" : connected ? "SSH 在线" : "SSH 离线"}</span>
            </div>
          </footer>
          {activeDocument.error && activeDocument.saveState === "error" && <div className="border-t border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive" role="alert">{activeDocument.error}</div>}
          {capabilityNote && <span className="sr-only" title={capabilityNote}>保存能力已探测</span>}
        </div>}
        {activeView === "editor" && !activeDocument && <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-muted-foreground">选择下方 SFTP 文件列表中的文本文件以打开编辑。</div>}
      </div>

      <Dialog open={closePrompt !== null} onOpenChange={(open) => { if (!open) setClosePrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>关闭未保存文件？</DialogTitle>
          <DialogDescription>保存会先检查远程版本与服务器替换能力。保存失败时编辑器会保留草稿。</DialogDescription>
          {closePrompt && docs.find((item) => item.documentId === closePrompt.documentId)?.sensitive && <p className="rounded-sm border border-warning/40 bg-warning/5 p-2 text-[10px] leading-4 text-warning">此路径可能包含敏感配置。确认保存会将当前内容写回原服务器文件。</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setClosePrompt(null)}>取消</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => {
              const tab = closePrompt && useEditorStore.getState().documents.find((item) => item.documentId === closePrompt.documentId);
              if (tab) void closeNow(tab);
            }}>放弃修改</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy} onClick={() => void chooseCloseSave()}>保存并关闭</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sensitivePrompt !== null} onOpenChange={(open) => { if (!open) setSensitivePrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>确认写回敏感路径？</DialogTitle>
          <DialogDescription>{sensitivePrompt?.asPath ?? (sensitivePrompt && docs.find((item) => item.documentId === sensitivePrompt.documentId)?.canonicalPath)}</DialogDescription>
          <p className="text-[10px] leading-4 text-warning">此文件可能包含密钥或系统配置。TermVista 会先检查远程哈希，再通过临时文件写入并回读校验；服务器不支持安全替换时会停止保存。</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setSensitivePrompt(null)}>取消</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy || !sensitivePrompt} onClick={() => {
              if (sensitivePrompt) void saveDocument(sensitivePrompt.documentId, true, sensitivePrompt.closeAfterSave, sensitivePrompt.asPath);
            }}>确认并保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={conflictPrompt !== null} onOpenChange={(open) => { if (!open) setConflictPrompt(null); }}>
        <DialogContent className="w-[min(920px,calc(100vw-32px))] gap-0 p-3">
          <DialogTitle>远程文件冲突</DialogTitle>
          <DialogDescription>{conflictPrompt?.message}</DialogDescription>
          {conflictPrompt?.remote ? <div className="grid min-h-0 grid-cols-2 gap-2">
            <div className="min-h-0 rounded-sm border border-border">
              <div className="border-b border-border px-2 py-1 text-[10px] font-medium">本地编辑缓冲</div>
              <pre className="compact-scrollbar max-h-[48vh] overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-4">{docs.find((item) => item.documentId === conflictPrompt.documentId)?.text}</pre>
            </div>
            <div className="min-h-0 rounded-sm border border-border">
              <div className="border-b border-border px-2 py-1 text-[10px] font-medium">远程当前版本</div>
              <pre className="compact-scrollbar max-h-[48vh] overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-4">{conflictPrompt.remote.text ?? "远程编码无法无损显示。"}</pre>
            </div>
          </div> : conflictPrompt?.loading ? <div className="flex h-24 items-center justify-center text-[11px] text-muted-foreground">正在读取远程版本…</div> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-3">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setConflictPrompt(null)}>取消</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => {
              const tab = conflictPrompt && useEditorStore.getState().documents.find((item) => item.documentId === conflictPrompt.documentId);
              if (tab) {
                setSaveAsPath(`${parentPath(tab.canonicalPath)}/${tab.displayName}.copy`);
                setSaveAsPrompt(tab.documentId);
                setConflictPrompt(null);
              }
            }}>另存为新文件</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" disabled={busy || !connected || conflictPrompt?.loading} onClick={() => void onReload()}>重新加载远程版本</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={saveAsPrompt !== null} onOpenChange={(open) => { if (!open) setSaveAsPrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>另存为远程新文件</DialogTitle>
          <DialogDescription>此操作只允许创建不存在的新路径，不覆盖现有文件；原文件保持不变。</DialogDescription>
          <Input aria-label="另存为远程路径" value={saveAsPath} onChange={(event) => setSaveAsPath(event.target.value)} className="h-7 rounded-sm text-[11px]" autoFocus />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setSaveAsPrompt(null)}>取消</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy || !saveAsPath.trim() || !saveAsPrompt} onClick={() => {
              const documentId = saveAsPrompt;
              if (documentId) void saveDocument(documentId, false, false, saveAsPath.trim());
            }}>保存新文件</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
