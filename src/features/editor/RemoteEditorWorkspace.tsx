import "./monacoWorkers";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
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
import { getUiFontScale } from "@/lib/uiFontScale";
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
import { useTranslation } from "react-i18next";

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

type Translate = (key: string, options?: Record<string, unknown>) => string;

function useEditorTranslate(): Translate {
  const { t } = useTranslation("editor");
  return (key, options) => String(t(key as never, options as never));
}

function editorErrorCode(error: unknown): string {
  const names = ["Disconnected", "Conflict", "NotSupported", "PermissionDenied", "NotFound", "InvalidPath", "Binary", "UnknownEncoding", "TooLarge", "InvalidContent", "InvalidRequest", "Other"];
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : typeof error === "string" ? error : "";
  try {
    const parsed = JSON.parse(value) as { code?: string };
    const code = parsed.code ?? value;
    return names.find((name) => name.toLowerCase() === code.toLowerCase()) ?? "Other";
  } catch {
    return names.find((name) => name.toLowerCase() === value.toLowerCase()) ?? "Other";
  }
}

function localizedEditorError(t: Translate, error: unknown) {
  const code = editorErrorCode(error);
  const key = code === "Disconnected" ? "disconnected" : code === "Conflict" ? "conflict" : code === "NotSupported" ? "notSupported" : code === "PermissionDenied" ? "permissionDenied" : code === "NotFound" ? "notFound" : code === "InvalidPath" ? "invalidPath" : code === "Binary" ? "binary" : code === "UnknownEncoding" ? "unknownEncoding" : code === "TooLarge" ? "tooLarge" : code === "InvalidContent" ? "invalidContent" : code === "InvalidRequest" ? "invalidRequest" : "other";
  return t(`errors.${key}`);
}

function readOnlyReason(t: Translate, document: { encoding: string; previewOnly: boolean; sizeBytes: number }) {
  if (document.encoding === "unknown") return t("labels.encoding");
  if (document.previewOnly) return t("largePreview");
  if (document.sizeBytes > 2 * 1024 * 1024) return t("sizeWarning");
  return t("readOnlyFallback");
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

function EditorMenuItem({ label, onClick, disabled = false }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return <button type="button" role="menuitem" disabled={disabled} className="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-40" onClick={onClick}>{label}</button>;
}

export function RemoteEditorWorkspace({
  connectionId,
  connectionName,
  sessionId,
  connected,
  children,
}: EditorViewProps) {
  const t = useEditorTranslate();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorContextMenuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelSubscriptionRef = useRef<monaco.IDisposable | null>(null);
  const currentModelDocumentRef = useRef<string | null>(null);
  const docs = useEditorStore(useShallow((state) => state.documents.filter((document) => document.connectionId === connectionId)));
  const activeId = useEditorStore((state) => state.activeByConnection[connectionId] ?? "terminal");
  const activate = useEditorStore((state) => state.activate);
  const activateTerminal = useEditorStore((state) => state.activateTerminal);
  const setLanguage = useEditorStore((state) => state.setLanguage);
  const updateSelection = useEditorStore((state) => state.updateSelection);
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
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (editorContextMenu) editorContextMenuRef.current?.focus();
  }, [editorContextMenu]);

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
    if (import.meta.env.DEV) console.info("Monaco language registration", languageReport.registeredCount, languageReport.missingIds);
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
      fontSize: 12 * getUiFontScale(),
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
      contextmenu: false,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true },
    });
    editorRef.current = editor;
    const cursorListener = editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    const selectionListener = editor.onDidChangeCursorSelection((event) => {
      const documentId = currentModelDocumentRef.current;
      const model = editor.getModel();
      if (documentId && model) updateSelection(documentId, model.getValueInRange(event.selection));
    });
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
      cursorListener.dispose();
      selectionListener.dispose();
      modelSubscriptionRef.current?.dispose();
      modelSubscriptionRef.current = null;
      editor.dispose();
      editorRef.current = null;
      currentModelDocumentRef.current = null;
    };
  }, [editorDocumentOpen, updateSelection]);

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
    currentModelDocumentRef.current = document.documentId;
    editor.setModel(model);
    editor.updateOptions({ readOnly: document.readOnly || !connected || document.sessionId !== sessionId });
    const previousState = viewStateByDocument.get(document.documentId);
    if (previousState) editor.restoreViewState(previousState);
    modelSubscriptionRef.current = model.onDidChangeContent(() => {
      useEditorStore.getState().updateText(document.documentId, model.getValue());
    });
    updateSelection(document.documentId, "");
    if (activeId !== "terminal") editor.focus();
  }, [activeId, connected, sessionId, updateSelection]);

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
    } catch {
      setConflictPrompt({ documentId: tab.documentId, remote: null, loading: false, message: `${message} ${t("messages.compareFailed")}` });
    }
  }, [setSaveState, t]);

  const saveDocument = useCallback(async (
    documentId: string,
    confirmSensitive = false,
    closeAfterSave = false,
    asPath?: string,
  ) => {
    const tab = useEditorStore.getState().documents.find((item) => item.documentId === documentId);
    if (!tab || !tab.dirty || !tab.sha256) return false;
    if (!connected || tab.sessionId !== sessionId) {
      setSaveState(documentId, "offline", t("messages.offline"));
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
        await showConflict(tab, t("messages.remoteChanged"));
        return false;
      }
      if (result.status === "unsupported") {
        setBusy(false);
        setSaveState(documentId, "conflict", t("messages.unsupportedReplace"));
        setConflictPrompt({ documentId, remote: null, loading: false, message: t("messages.unsupportedReplace") });
        return false;
      }
      if (!result.verified || !result.newSha256) throw new Error("write-not-verified");
      markSaved(documentId, {
        sha256: result.newSha256,
        text: tab.text,
        canonicalPath: result.canonicalPath,
        displayName: result.canonicalPath.split("/").pop() ?? tab.displayName,
        sizeBytes: result.sizeBytes ?? new TextEncoder().encode(tab.text).length,
      });
      if (!result.durableWrite) toast.warning(t("messages.savedDurabilityWarning"), { duration: 5500 });
      else toast.success(t("messages.saved"), { duration: 2500 });
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
      const message = error instanceof Error && error.message === "write-not-verified" ? t("messages.writeNotVerified") : localizedEditorError(t, error);
      setSaveState(documentId, editorErrorCode(error) === "Disconnected" ? "offline" : "error", message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [connected, sessionId, setSaveState, showConflict, markSaved, closeNow, t]);

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

  const showEditorContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!activeDocument || !(event.target as HTMLElement).closest(".monaco-editor")) return;
    event.preventDefault();
    const width = 184;
    const height = 244;
    setEditorContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  };

  const runEditorContextAction = (actionId: string) => {
    setEditorContextMenu(null);
    const action = editorRef.current?.getAction(actionId);
    if (!action?.isSupported()) return;
    void action.run().catch(() => toast.error(t("contextMenu.actionFailed")));
  };

  const restoreLargeFile = async (tab: RemoteEditorTab) => {
    if (!sessionId || !connected) return;
    try {
      const fullDocument = await reloadRemoteDocument(tab.documentId);
      const editorStoreDoc = useEditorStore.getState().documents.find((item) => item.documentId === tab.documentId);
      if (!editorStoreDoc || editorStoreDoc.dirty) {
        toast.warning(t("refreshDirtyWarning"));
        return;
      }
      useEditorStore.getState().mergeRemote(fullDocument, false);
      if (fullDocument.readOnly) toast.message(readOnlyReason(t, fullDocument));
    } catch (error) {
      toast.error(localizedEditorError(t, error));
    }
  };

  const onRebind = async (tab: RemoteEditorTab) => {
    if (!sessionId || !connected) return;
    try {
      const document = await rebindRemoteDocument(tab.documentId, sessionId);
      useEditorStore.getState().mergeRemote(document, true);
      toast.success(t("messages.rebound"));
    } catch (error) {
      await showConflict(tab, localizedEditorError(t, error));
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
      toast.message(t("messages.reloaded"), { duration: 3500 });
    } catch (error) {
      toast.error(localizedEditorError(t, error));
    }
  };

  const onCompare = async (tab: RemoteEditorTab) => {
    setConflictPrompt({ documentId: tab.documentId, remote: null, loading: true, message: t("dialog.readingRemote") });
    try {
      const remote = await compareRemoteDocument(tab.documentId);
      setConflictPrompt({ documentId: tab.documentId, remote, loading: false, message: t("dialog.compareDescription") });
    } catch (error) {
      setConflictPrompt({ documentId: tab.documentId, remote: null, loading: false, message: localizedEditorError(t, error) });
    }
  };

  useEffect(() => {
    if (!sessionId || !connected) return;
    let disposed = false;
    void getEditorSaveCapabilities(sessionId).then(() => {
      if (!disposed) setCapabilityNote(t("messages.readCapability"));
    }).catch(() => {
      if (!disposed) setCapabilityNote(t("messages.readCapability"));
    });
    return () => { disposed = true; };
  }, [sessionId, connected, t]);

  const activeView = activeId === "terminal" ? "terminal" : "editor";
  const languageOptionsForDoc = activeDocument
    ? languageOptions.filter((item) => item.id === activeDocument.languageId || item.id !== "plaintext")
    : languageOptions;
  const canSave = Boolean(activeDocument?.dirty && connected && activeDocument.sessionId === sessionId && !activeDocument.readOnly && activeDocument.sha256);
  const sameSessionOnline = Boolean(activeDocument && connected && activeDocument.sessionId === sessionId);
  const saveStatus = !activeDocument
    ? ""
    : activeDocument.saveState === "saving"
      ? t("status.saving")
      : activeDocument.saveState === "conflict"
        ? t("status.conflict")
        : activeDocument.saveState === "offline" || (activeDocument.dirty && !sameSessionOnline)
          ? t("status.offline")
          : activeDocument.saveState === "error"
            ? t("status.error")
            : activeDocument.dirty
              ? t("status.dirty")
              : activeDocument.saveState === "saved"
                ? t("status.saved")
                : sameSessionOnline ? t("status.verified") : t("status.disconnected");
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t("labels.workspace")} data-monaco-language-count={registeredLanguageCount}>
      <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-panel-header px-1" role="tablist" aria-label={t("labels.mainTabs")}>
        <button type="button" role="tab" aria-selected={activeView === "terminal"} className={`flex h-full items-center gap-1.5 border-b-2 px-2 text-[10px] ${activeView === "terminal" ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => activateTerminal(connectionId)}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground/40"}`} />{t("actions.terminal")}
        </button>
        <div className="compact-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label={t("labels.remoteFiles")}>
          {docs.map((tab) => <div key={tab.documentId} role="presentation" className={`group flex h-full max-w-56 shrink-0 items-center border-b-2 ${activeId === tab.documentId ? "border-accent bg-panel text-foreground" : "border-transparent text-muted-foreground hover:bg-panel/70"}`}>
            <button type="button" role="tab" aria-selected={activeId === tab.documentId} title={`${connectionName} / ${tab.canonicalPath}`} className="flex h-full min-w-0 items-center gap-1 px-2 text-[10px]" onClick={() => activate(connectionId, tab.documentId)}>
              <FileCode2 size={11} className="shrink-0 text-accent" />
              <span className="truncate">{tab.displayName}</span>
              {tab.dirty && <span className="ml-0.5 text-[11px] font-bold text-accent" aria-label={t("labels.unsaved")} title={t("labels.unsaved")}>●</span>}
              {!tab.dirty && tab.saveState === "saved" && <Check size={10} className="text-success" />}
            </button>
            <button type="button" aria-label={`${t("actions.closeEditorTab")} ${tab.displayName}`} title={t("actions.closeEditorTab")} className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => openOrClose(tab)}><X size={10} /></button>
          </div>)}
        </div>
        {docs.length > 0 && <Button type="button" variant="ghost" size="icon" className="h-6 w-6 self-center rounded-sm text-muted-foreground" aria-label={t("actions.closeCleanTabs")} title={t("actions.closeCleanTabs")} onClick={removeCleanDocuments}><PanelTopClose size={12} /></Button>}
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={activeView === "terminal" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} aria-hidden={activeView !== "terminal"}>
          {children}
        </div>
        {activeView === "editor" && activeDocument && <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
          <div className="flex h-8 shrink-0 items-center justify-between bg-panel-header px-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected && activeDocument.sessionId === sessionId ? "bg-success" : "bg-warning"}`} />
              <span className="max-w-36 shrink-0 truncate rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium" title={connectionName}>{connectionName}</span>
              <span className="truncate font-mono text-[11px]" title={`${connectionName} / ${activeDocument.canonicalPath}`}>{activeDocument.canonicalPath}</span>
              {activeDocument.sensitive && <span className="shrink-0 rounded-sm border border-warning/40 px-1 py-0.5 text-[10px] text-warning">{t("actions.sensitivePath")}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <EditorButton label={t("actions.save")} icon={busy ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />} disabled={!canSave || busy} onClick={() => startSave(activeDocument)} />
              <EditorButton label={t("actions.find")} icon={<Search size={12} />} onClick={() => { void editorRef.current?.getAction("actions.find")?.run(); }} />
              <EditorButton label={t("actions.replace")} icon={<Code2 size={12} />} onClick={() => { void editorRef.current?.getAction("editor.action.startFindReplaceAction")?.run(); }} />
              <EditorButton label={t("actions.goToLine")} icon={<ChevronDown size={12} />} onClick={() => { void editorRef.current?.getAction("editor.action.gotoLine")?.run(); }} />
              <EditorButton label={t("actions.foldAll")} icon={<FoldVertical size={12} />} onClick={() => { void editorRef.current?.getAction("editor.foldAll")?.run(); }} />
              <EditorButton label={t("actions.undo")} icon={<span className="text-[12px]">↶</span>} onClick={() => { void editorRef.current?.getAction("undo")?.run(); }} />
              <EditorButton label={t("actions.redo")} icon={<span className="text-[12px]">↷</span>} onClick={() => { void editorRef.current?.getAction("redo")?.run(); }} />
              <span className="mx-1 h-4 w-px bg-border" />
              <EditorButton label={t("actions.compare")} icon={<GitCompareArrows size={12} />} onClick={() => void onCompare(activeDocument)} />
              {activeDocument.sessionId !== sessionId && connected && <Button type="button" variant="outline" size="xs" className="h-5 rounded-sm px-1.5 text-[9px]" onClick={() => void onRebind(activeDocument)}>{t("actions.rebind")}</Button>}
              <EditorButton label={t("actions.refresh")} icon={<RefreshCw size={12} />} disabled={busy} onClick={() => {
                if (activeDocument.dirty) setConflictPrompt({ documentId: activeDocument.documentId, remote: null, loading: false, message: t("dialog.discardReload") });
                else void onReload();
              }} />
            </div>
          </div>

          {activeDocument.readOnlyReason && <div className="flex min-h-7 items-center gap-1.5 bg-warning/5 px-3 py-1 text-[11px] text-warning" role="status">
            <AlertCircle size={11} className="shrink-0" />
            <span className="min-w-0 flex-1">{readOnlyReason(t, activeDocument)}</span>
            {activeDocument.sizeBytes > 2 * 1024 * 1024 && <Button type="button" variant="outline" size="xs" className="h-5 shrink-0 rounded-sm px-1.5 text-[9px]" onClick={() => void restoreLargeFile(activeDocument)}>{t("actions.continueEditing")}</Button>}
          </div>}

          <div className="relative min-h-0 flex-1" ref={hostRef} aria-label={t("labels.editorForFile", { name: activeDocument.displayName })} onContextMenu={showEditorContextMenu}>
            {activeDocument.encoding === "unknown" && <div className="absolute inset-0 z-10 flex items-center justify-center bg-panel/95 p-6 text-center text-[11px] text-muted-foreground" role="status">
              {t("labels.encoding")}
            </div>}
          </div>

          {editorContextMenu && <div className="fixed inset-0 z-[80]" onMouseDown={() => setEditorContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setEditorContextMenu(null); }}>
            <div ref={editorContextMenuRef} role="menu" tabIndex={-1} aria-label={t("contextMenu.label")} className="fixed min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none" style={{ left: editorContextMenu.x, top: editorContextMenu.y }} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setEditorContextMenu(null); }}>
              <EditorMenuItem label={t("contextMenu.cut")} disabled={Boolean(activeDocument.readOnly || !connected || activeDocument.sessionId !== sessionId)} onClick={() => runEditorContextAction("editor.action.clipboardCutAction")} />
              <EditorMenuItem label={t("contextMenu.copy")} onClick={() => runEditorContextAction("editor.action.clipboardCopyAction")} />
              <EditorMenuItem label={t("contextMenu.paste")} disabled={Boolean(activeDocument.readOnly || !connected || activeDocument.sessionId !== sessionId)} onClick={() => runEditorContextAction("editor.action.clipboardPasteAction")} />
              <div role="separator" className="my-1 h-px bg-border/70" />
              <EditorMenuItem label={t("contextMenu.find")} onClick={() => runEditorContextAction("actions.find")} />
              <EditorMenuItem label={t("contextMenu.replace")} onClick={() => runEditorContextAction("editor.action.startFindReplaceAction")} />
              <EditorMenuItem label={t("contextMenu.selectAll")} onClick={() => runEditorContextAction("editor.action.selectAll")} />
            </div>
          </div>}

          <footer className="flex h-7 shrink-0 items-center justify-between bg-panel-header px-2 text-[10px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <select aria-label={t("actions.languageMode")} className="h-4 max-w-40 border-0 bg-transparent text-[9px] text-muted-foreground outline-none" value={activeDocument.languageId} onChange={(event) => {
                const languageId = event.target.value;
                setLanguage(activeDocument.documentId, languageId);
                const model = modelByDocument.get(activeDocument.documentId);
                if (model) monaco.editor.setModelLanguage(model, languageId);
              }}>
                {languageOptionsForDoc.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
              </select>
              <span>{activeDocument.encoding}</span><span>{activeDocument.lineEnding.toUpperCase()}</span>
              <span>{formatBytes(activeDocument.sizeBytes)}</span>
              {activeDocument.readOnly && <span>{t("actions.readOnlyPreview")}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span>{t("labels.rows", { line: cursor.line, column: cursor.column })}</span>
              <span className="inline-flex items-center gap-1" role="status">
                {activeDocument.dirty || activeDocument.saveState === "error" || activeDocument.saveState === "conflict"
                  ? <AlertCircle size={10} className="text-warning" />
                  : activeDocument.saveState === "saved" ? <Check size={10} className="text-success" /> : null}
                {saveStatus}
              </span>
            </div>
          </footer>
          {activeDocument.error && activeDocument.saveState === "error" && <div className="border-t border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive" role="alert">{activeDocument.error}</div>}
          {capabilityNote && <span className="sr-only" title={capabilityNote}>{t("labels.savedCapability")}</span>}
        </div>}
        {activeView === "editor" && !activeDocument && <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-muted-foreground">{t("labels.empty")}</div>}
      </div>

      <Dialog open={closePrompt !== null} onOpenChange={(open) => { if (!open) setClosePrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>{t("dialog.closeTitle")}</DialogTitle>
          <DialogDescription>{t("dialog.closeDescription")}</DialogDescription>
          {closePrompt && docs.find((item) => item.documentId === closePrompt.documentId)?.sensitive && <p className="rounded-sm border border-warning/40 bg-warning/5 p-2 text-[10px] leading-4 text-warning">{t("dialog.sensitiveClose")}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setClosePrompt(null)}>{t("dialog.cancel")}</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => {
              const tab = closePrompt && useEditorStore.getState().documents.find((item) => item.documentId === closePrompt.documentId);
              if (tab) void closeNow(tab);
            }}>{t("dialog.discard")}</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy} onClick={() => void chooseCloseSave()}>{t("dialog.saveClose")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sensitivePrompt !== null} onOpenChange={(open) => { if (!open) setSensitivePrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>{t("dialog.sensitiveTitle")}</DialogTitle>
          <DialogDescription>{sensitivePrompt?.asPath ?? (sensitivePrompt && docs.find((item) => item.documentId === sensitivePrompt.documentId)?.canonicalPath)}</DialogDescription>
          <p className="text-[10px] leading-4 text-warning">{t("dialog.sensitiveWarning")}</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setSensitivePrompt(null)}>{t("dialog.cancel")}</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy || !sensitivePrompt} onClick={() => {
              if (sensitivePrompt) void saveDocument(sensitivePrompt.documentId, true, sensitivePrompt.closeAfterSave, sensitivePrompt.asPath);
            }}>{t("dialog.confirmSave")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={conflictPrompt !== null} onOpenChange={(open) => { if (!open) setConflictPrompt(null); }}>
        <DialogContent className="w-[min(920px,calc(100vw-32px))] gap-0 p-3">
          <DialogTitle>{t("dialog.conflictTitle")}</DialogTitle>
          <DialogDescription>{conflictPrompt?.message}</DialogDescription>
          {conflictPrompt?.remote ? <div className="grid min-h-0 grid-cols-2 gap-2">
            <div className="min-h-0 rounded-sm border border-border">
              <div className="border-b border-border px-2 py-1 text-[10px] font-medium">{t("dialog.localBuffer")}</div>
              <pre className="compact-scrollbar max-h-[48vh] overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-4">{docs.find((item) => item.documentId === conflictPrompt.documentId)?.text}</pre>
            </div>
            <div className="min-h-0 rounded-sm border border-border">
              <div className="border-b border-border px-2 py-1 text-[10px] font-medium">{t("dialog.remoteVersion")}</div>
              <pre className="compact-scrollbar max-h-[48vh] overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px] leading-4">{conflictPrompt.remote.text ?? t("dialog.encodingUnrenderable")}</pre>
            </div>
          </div> : conflictPrompt?.loading ? <div className="flex h-24 items-center justify-center text-[11px] text-muted-foreground">{t("dialog.readingRemote")}</div> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-3">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setConflictPrompt(null)}>{t("dialog.cancel")}</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => {
              const tab = conflictPrompt && useEditorStore.getState().documents.find((item) => item.documentId === conflictPrompt.documentId);
              if (tab) {
                setSaveAsPath(`${parentPath(tab.canonicalPath)}/${tab.displayName}.copy`);
                setSaveAsPrompt(tab.documentId);
                setConflictPrompt(null);
              }
            }}>{t("dialog.saveAs")}</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-sm" disabled={busy || !connected || conflictPrompt?.loading} onClick={() => void onReload()}>{t("dialog.reload")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={saveAsPrompt !== null} onOpenChange={(open) => { if (!open) setSaveAsPrompt(null); }}>
        <DialogContent className="gap-0 p-3">
          <DialogTitle>{t("dialog.saveAsTitle")}</DialogTitle>
          <DialogDescription>{t("dialog.saveAsDescription")}</DialogDescription>
          <Input aria-label={t("dialog.saveAsPath")} value={saveAsPath} onChange={(event) => setSaveAsPath(event.target.value)} className="h-7 rounded-sm text-[11px]" autoFocus />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="xs" className="rounded-sm" onClick={() => setSaveAsPrompt(null)}>{t("dialog.cancel")}</Button>
            <Button type="button" size="xs" className="rounded-sm" disabled={busy || !saveAsPath.trim() || !saveAsPrompt} onClick={() => {
              const documentId = saveAsPrompt;
              if (documentId) void saveDocument(documentId, false, false, saveAsPath.trim());
            }}>{t("dialog.saveNew")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
