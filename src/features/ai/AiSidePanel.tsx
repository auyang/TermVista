import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Activity, Bot, FileCode2, FileText, History, Plus, Settings2, Sparkles, TerminalSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AiMessageView } from "@/features/ai/AiMessageView";
import { AiProviderDialog } from "@/features/ai/AiProviderDialog";
import { cancelAiChat, clearAiConversation, listAiProviders, previewAiContext, startAiChat } from "@/features/ai/aiBridge";
import { registerAiEditorRevision } from "@/features/editor/remoteEditorBridge";
import { useAiStore } from "@/features/ai/aiStore";
import { DiagnosticPanel } from "@/features/diagnostics/DiagnosticPanel";
import type { AiContextPreview, AiContextSource, AiStreamEvent, AiProviderView, AiTaskMode } from "@/features/ai/aiTypes";
import { getTerminalRecentOutput, getTerminalSelection } from "@/features/ssh/terminalRegistry";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const EMPTY_MESSAGES: never[] = [];
const EMPTY_SOURCES: AiContextSource[] = [];

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "操作失败，请检查当前会话和模型配置。";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function AiPanelBody({ onClose }: { onClose: () => void }) {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const sshSession = useSshSessionStore((state) => activeTab?.mode === "ssh" ? state.sessions[activeTab.id] : undefined);
  const sessionId = sshSession?.state === "connected" ? sshSession.sessionId ?? "" : "";
  const attemptId = activeTab?.mode === "ssh" ? activeTab.id : undefined;
  const editorConnectionId = sshSession?.profile.id ?? activeTab?.profileId ?? activeTab?.id ?? "workspace";
  const editorActiveId = useEditorStore((state) => state.activeByConnection[editorConnectionId] ?? "terminal");
  const editorDocuments = useEditorStore((state) => state.documents);
  const activeEditor = editorDocuments.find((document) => document.documentId === editorActiveId && document.sessionId === sessionId) ?? null;
  const providers = useAiStore((state) => state.providers);
  const selectedProviderId = useAiStore((state) => state.selectedProviderId);
  const conversations = useAiStore((state) => state.conversations);
  const activeRequests = useAiStore((state) => state.activeRequests);
  const intent = useAiStore((state) => state.intent);
  const setIntent = useAiStore((state) => state.setIntent);
  const setProviders = useAiStore((state) => state.setProviders);
  const setSelectedProviderId = useAiStore((state) => state.setSelectedProviderId);
  const beginStream = useAiStore((state) => state.beginStream);
  const applyDelta = useAiStore((state) => state.applyDelta);
  const applyUsage = useAiStore((state) => state.applyUsage);
  const finishStream = useAiStore((state) => state.finishStream);
  const clearSession = useAiStore((state) => state.clearSession);
  const messages = (sessionId ? conversations[sessionId] : undefined) ?? EMPTY_MESSAGES;
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const providerNeedsKey = Boolean(selectedProvider?.apiKeyRequired && !selectedProvider.apiKeyConfigured);
  const requestId = sessionId ? activeRequests[sessionId] : undefined;
  const connected = Boolean(sessionId && sshSession?.state === "connected");
  const [prompt, setPrompt] = useState("");
  const [sources, setSources] = useState<AiContextSource[]>([]);
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [preview, setPreview] = useState<AiContextPreview | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [mode, setMode] = useState<AiTaskMode>("ask");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [loadingProviders, setLoadingProviders] = useState(true);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const sourceIsStale = Boolean(
    (intent && intent.sessionId !== sessionId)
      || (sourceSessionId && sourceSessionId !== sessionId),
  );
  const effectivePrompt = intent?.sessionId === sessionId ? intent.prompt : prompt;
  const effectiveSources = sourceIsStale
    ? EMPTY_SOURCES
    : intent?.sessionId === sessionId
      ? intent.sources
      : sources;
  const visiblePreview = preview?.sessionId === sessionId ? preview : null;

  useEffect(() => {
    let active = true;
    void listAiProviders().then((loaded) => {
      if (active) setProviders(loaded);
    }).catch((error: unknown) => {
      if (active) toast.error(`读取模型配置失败：${errorMessage(error)}`);
    }).finally(() => {
      if (active) setLoadingProviders(false);
    });
    return () => { active = false; };
  }, [setProviders]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!preview) return;
    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.activeTabId !== activeTabId) setPreview(null);
    });
    const unsubscribeSessions = useSshSessionStore.subscribe((state) => {
      const current = activeTabId ? state.sessions[activeTabId] : undefined;
      const stillConnected = current?.sessionId === preview.sessionId && current.state === "connected";
      if (!stillConnected) setPreview(null);
    });
    const unsubscribeEditor = useEditorStore.subscribe((state) => {
      const isStale = preview.sources.some((source) => {
        if (!source.editorDocumentId || source.editorRevision === undefined) return false;
        const document = state.documents.find((item) => item.documentId === source.editorDocumentId);
        return !document
          || document.revision !== source.editorRevision
          || (source.kind === "editorBuffer" && source.editorDirty === true && !document.dirty);
      });
      if (isStale) setPreview(null);
    });
    return () => {
      unsubscribeWorkspace();
      unsubscribeSessions();
      unsubscribeEditor();
    };
  }, [activeTabId, preview]);

  const sourceKinds = useMemo(() => new Set(effectiveSources.map((source) => source.kind)), [effectiveSources]);

  const addSource = (source: AiContextSource, nextPrompt?: string) => {
    if (!sessionId) {
      toast.message("请先连接 SSH。");
      return;
    }
    const nextSources = [...effectiveSources.filter((item) => item.kind !== source.kind), source];
    if (nextSources.length > 3) {
      toast.message("一次最多选择三类上下文来源。请先移除一项。");
      return;
    }
    setIntent(null);
    setSources(nextSources);
    setSourceSessionId(sessionId);
    if (nextPrompt) setPrompt(nextPrompt);
  };

  const addTerminalSelection = () => {
    if (!attemptId) return toast.message("请先选中终端文本，再打开 AI 助手。");
    const text = getTerminalSelection(attemptId);
    if (!text.trim()) return toast.message("当前 xterm 终端没有选中的文本。");
    addSource(
      { kind: "terminalSelection", text },
      "请解释下面的终端输出，提取关键错误，并给出只读排查建议。",
    );
  };

  const addTerminalRecentOutput = () => {
    if (!attemptId) return toast.message("请先连接 SSH。");
    const text = getTerminalRecentOutput(attemptId, 80);
    if (!text) return toast.message("当前终端没有可读取的最近输出。");
    addSource({ kind: "terminalRecentOutput", text }, "请分析最近的终端输出，引用其中的错误行并给出只读建议。");
  };

  const addEditorSelection = () => {
    if (!activeEditor || activeEditor.sessionId !== sessionId) return toast.message("请先在当前 SSH 标签打开远程文件。");
    if (activeEditor.sensitive) return toast.error("敏感远程文件不能作为 AI 上下文。");
    if (!activeEditor.selectionText.trim()) return toast.message("请先在 Monaco 编辑器中选择一段文本。");
    addSource({ kind: "editorSelection", documentId: activeEditor.documentId, revision: activeEditor.revision, text: activeEditor.selectionText }, "请解释当前编辑器选区，并指出需要核对的上下文。");
  };

  const addEditorBuffer = () => {
    if (!activeEditor || activeEditor.sessionId !== sessionId) return toast.message("请先在当前 SSH 标签打开远程文件。");
    if (activeEditor.sensitive) return toast.error("敏感远程文件不能作为 AI 上下文。");
    addSource({ kind: "editorBuffer", documentId: activeEditor.documentId, revision: activeEditor.revision, dirty: activeEditor.dirty, text: activeEditor.text }, "请审阅当前 Monaco 编辑缓冲，只给出建议，不要保存到服务器。");
  };

  const addDiagnosticEvidence = (runId: string, evidenceIds: string[]) => {
    if (!evidenceIds.length) return toast.message("请至少选择一条诊断证据。");
    addSource({ kind: "diagnosticEvidenceRefs", runId, evidenceIds }, "请依据所选诊断证据区分事实和假设，并说明根因判断依据。");
  };

  const addMonitorSnapshot = () => addSource(
    { kind: "monitorSnapshot" },
    "请基于这次监控采样分析资源状态和可能的瓶颈，并给出只读排查建议。",
  );

  const removeSource = (kind: AiContextSource["kind"]) => {
    if (intent?.sessionId === sessionId) {
      const next = intent.sources.filter((source) => source.kind !== kind);
      setIntent(next.length ? { ...intent, sources: next } : null);
      return;
    }
    setSources((current) => current.filter((source) => source.kind !== kind));
  };

  const generatePreview = async () => {
    if (!connected || !sessionId || !selectedProvider) {
      toast.message(!selectedProvider ? "请先配置并选择一个模型。" : "请先连接 SSH。");
      return;
    }
    if (sourceIsStale) {
      setSources([]);
      setSourceSessionId("");
      setIntent(null);
      toast.error("SSH 标签已切换，原会话上下文已清除。请重新选择来源。");
      return;
    }
    if (!effectivePrompt.trim()) {
      toast.message("请输入希望 AI 处理的问题。");
      return;
    }
    setPreviewBusy(true);
    try {
      for (const source of effectiveSources) {
        if (source.kind !== "editorSelection" && source.kind !== "editorBuffer") continue;
        const document = useEditorStore.getState().documents.find((item) => item.documentId === source.documentId);
        if (!document || document.sessionId !== sessionId || document.revision !== source.revision) {
          throw new Error("Monaco 编辑缓冲已改变，请重新选择上下文并预览。");
        }
        if (source.kind === "editorBuffer" && (document.dirty !== source.dirty || document.text !== source.text)) {
          throw new Error("Monaco 编辑缓冲已改变，请重新选择上下文并预览。");
        }
        await registerAiEditorRevision(document.documentId, sessionId, document.revision, document.dirty, document.text);
      }
      const result = await previewAiContext({ sessionId, providerId: selectedProvider.id, prompt: effectivePrompt, sources: effectiveSources, includeHistory, mode });
      if (useWorkspaceStore.getState().activeTabId !== activeTab?.id) {
        toast.error("生成预览期间 SSH 标签已切换，请重新预览当前会话。");
        return;
      }
      setPreview(result);
    } catch (error) {
      toast.error(`无法生成发送预览：${errorMessage(error)}`);
    } finally {
      setPreviewBusy(false);
    }
  };

  const processEvent = (event: AiStreamEvent, targetSessionId: string, targetRequestId: string) => {
    if (event.sessionId !== targetSessionId || event.requestId !== targetRequestId) return;
    if (event.type === "delta") applyDelta(event.sessionId, event.requestId, event.text);
    if (event.type === "usage") applyUsage(event.sessionId, event.requestId, event.inputTokens, event.outputTokens);
    if (event.type === "completed") finishStream(event.sessionId, event.requestId, "complete", undefined, event.elapsedMs);
    if (event.type === "cancelled") finishStream(event.sessionId, event.requestId, "cancelled");
    if (event.type === "error") finishStream(event.sessionId, event.requestId, "error", event.message);
  };

  const confirmSend = async () => {
    if (!preview || !selectedProvider) {
      toast.message("请先配置并选择一个模型。");
      return;
    }
    if (providerNeedsKey) {
      toast.message("请先在模型设置中保存 API Key。");
      return;
    }
    if (preview.sessionId !== sessionId || preview.providerDestination !== selectedProvider.baseUrl) {
      setPreview(null);
      toast.error("会话或服务商已改变；旧预览已作废，请重新生成。");
      return;
    }
    if (preview.taskMode !== mode) {
      setPreview(null);
      toast.error("AI 工作模式已变化；旧预览已作废，请重新预览。");
      return;
    }
    try {
      for (const source of preview.sources) {
        if (!source.editorDocumentId || source.editorRevision === undefined) continue;
        const document = useEditorStore.getState().documents.find((item) => item.documentId === source.editorDocumentId);
        if (!document || document.sessionId !== sessionId || document.revision !== source.editorRevision) {
          setPreview(null);
          toast.error("Monaco 编辑缓冲在预览后发生变化；旧预览已作废，请重新预览。");
          return;
        }
        if (source.kind === "editorBuffer" && source.editorDirty === true && !document.dirty) {
          setPreview(null);
          toast.error("Monaco 缓冲已保存；旧预览已作废，请重新预览。");
          return;
        }
        await registerAiEditorRevision(document.documentId, sessionId, document.revision, document.dirty, document.text);
      }
    } catch (error) {
      toast.error(`无法确认编辑器版本：${errorMessage(error)}`);
      return;
    }
    const editorSource = preview.sources.find((source) => source.kind === "editorBuffer" && source.editorDocumentId && source.editorRevision !== undefined);
    const editorDocument = editorSource?.editorDocumentId
      ? useEditorStore.getState().documents.find((item) => item.documentId === editorSource.editorDocumentId)
      : undefined;
    const editorBinding = mode === "plan" && editorSource && editorDocument && editorDocument.revision === editorSource.editorRevision
      ? { documentId: editorDocument.documentId, revision: editorDocument.revision, originalText: editorDocument.text, languageId: editorDocument.languageId }
      : undefined;
    const channel = new Channel<AiStreamEvent>();
    let acceptedRequestId = "";
    const earlyEvents: AiStreamEvent[] = [];
    channel.onmessage = (event) => {
      if (!acceptedRequestId) {
        earlyEvents.push(event);
        return;
      }
      processEvent(event, preview.sessionId, acceptedRequestId);
    };
    try {
      const accepted = await startAiChat(preview.sessionId, selectedProvider.id, preview.snapshotId, channel);
      acceptedRequestId = accepted.requestId;
      beginStream(preview.sessionId, accepted.requestId, preview.redactedPrompt, mode, editorBinding);
      for (const event of earlyEvents) processEvent(event, preview.sessionId, accepted.requestId);
      setPreview(null);
      setPrompt("");
      setSources([]);
      setSourceSessionId("");
      setIntent(null);
    } catch (error) {
      toast.error(`AI 请求未能开始：${errorMessage(error)}`);
    }
  };

  const stop = async () => {
    if (!requestId) return;
    try {
      await cancelAiChat(requestId);
    } catch (error) {
      toast.error(`停止请求失败：${errorMessage(error)}`);
    }
  };

  const clearConversation = async () => {
    if (!sessionId || requestId) return;
    try {
      await clearAiConversation(sessionId);
      clearSession(sessionId);
    } catch (error) {
      toast.error(`清除对话失败：${errorMessage(error)}`);
    }
  };

  const editProvider = (provider: AiProviderView | null) => {
    setEditingProviderId(provider?.id ?? "");
    setProviderDialogOpen(true);
  };

  const onSavedProvider = (provider: AiProviderView) => {
    setProviders([...useAiStore.getState().providers.filter((item) => item.id !== provider.id), provider]);
    setSelectedProviderId(provider.id);
    setPreview(null);
  };

  const savePreviewSourceLabel = (source: AiContextSource) => {
    if (source.kind === "terminalSelection") return "终端选中文字";
    if (source.kind === "terminalRecentOutput") return "终端最近输出";
    if (source.kind === "monitorSnapshot") return "当前监控快照";
    if (source.kind === "sftpSelectedText") return `SFTP 文本：${source.remotePath}`;
    if (source.kind === "editorSelection") return "Monaco 编辑器选区";
    if (source.kind === "editorBuffer") return source.dirty ? "Monaco 未保存编辑缓冲" : "Monaco 编辑缓冲";
    return `诊断证据：${source.evidenceIds.length} 条`;
  };

  const body = (
    <>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        <div className="flex min-w-0 items-center gap-1.5"><Sparkles size={13} className="shrink-0 text-accent" /><span className="font-medium">AI 助手</span><span className="truncate text-[9px] text-muted-foreground">只读建议</span></div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label="模型设置" title="模型设置" onClick={() => editProvider(selectedProvider)}><Settings2 size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label="关闭 AI 面板" title="关闭" onClick={onClose}><X size={13} /></Button>
        </div>
      </header>

      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2">
        <Bot size={12} className="shrink-0 text-muted-foreground" />
        <select
          value={selectedProviderId}
          onChange={(event) => { setSelectedProviderId(event.target.value); setPreview(null); }}
          className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="选择 AI 模型"
          disabled={loadingProviders || providers.length === 0}
        >
          {providers.length === 0 ? <option value="">尚未配置模型</option> : providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
        </select>
        {providerNeedsKey && <span className="max-w-20 truncate text-[9px] text-amber-700 dark:text-amber-300">未配置密钥</span>}
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm" title="添加模型" aria-label="添加模型" onClick={() => editProvider(null)}><Plus size={12} /></Button>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-panel px-2" role="tablist" aria-label="AI 工作模式">
        {([ ["ask", "问答"], ["diagnose", "诊断"], ["plan", "计划"] ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={mode === value} className={`h-5 rounded-sm px-2 text-[10px] ${mode === value ? "bg-accent/10 font-medium text-accent" : "text-muted-foreground hover:bg-muted"}`} onClick={() => { setMode(value); setPreview(null); }}>{label}</button>)}
        {mode === "plan" && <span className="ml-2 truncate text-[9px] text-muted-foreground">命令只会插入终端栏；代码建议只改本地缓冲</span>}
      </div>

      {connected && <div className="flex min-h-7 shrink-0 items-center gap-1.5 border-b border-border bg-panel-header/60 px-2 text-[9px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="truncate" title={`${activeTab?.title ?? "SSH"} · ${activeTab?.host ?? ""}`}>{activeTab?.title ?? "SSH 会话"} · {activeTab?.host ?? "当前主机"}</span>
        <span className="ml-auto flex shrink-0 gap-0.5">
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("terminalSelection") ? "text-accent" : ""}`} onClick={addTerminalSelection} title="仅读取 xterm 当前选中的文本"><TerminalSquare size={10} />选区</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("terminalRecentOutput") ? "text-accent" : ""}`} onClick={addTerminalRecentOutput} title="仅读取当前 xterm 最近 80 行"><History size={10} />最近输出</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("editorSelection") ? "text-accent" : ""}`} onClick={addEditorSelection} disabled={!activeEditor || activeEditor.sensitive} title="添加当前 Monaco 选区"><FileCode2 size={10} />编辑选区</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("editorBuffer") ? "text-accent" : ""}`} onClick={addEditorBuffer} disabled={!activeEditor || activeEditor.sensitive} title="明确授权当前 Monaco 编辑缓冲进入预览"><FileText size={10} />编辑全文</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("monitorSnapshot") ? "text-accent" : ""}`} onClick={addMonitorSnapshot} title="读取当前已缓存监控快照"><Activity size={10} />监控</Button>
        </span>
      </div>}

      {mode === "diagnose" && <DiagnosticPanel sessionId={sessionId} connected={connected} onSelectAiEvidence={addDiagnosticEvidence} />}

      <div className="compact-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2" aria-label="AI 对话">
        {!selectedProvider && !loadingProviders && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Bot size={24} className="text-accent" /><strong className="font-medium text-foreground">先配置一个模型</strong><span className="leading-5">模型连接前不会发送任何数据。兼容 API 密钥保存在系统凭据库。</span><Button type="button" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => editProvider(null)}>配置模型</Button></div>}
        {!connected && selectedProvider && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Bot size={24} className="text-accent" /><strong className="font-medium text-foreground">连接 SSH 后开始使用</strong><span className="leading-5">AI 上下文只能来自当前选中的 SSH 会话，并在发送前由你检查。</span></div>}
        {connected && messages.length === 0 && selectedProvider && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Sparkles size={22} className="text-accent" /><strong className="font-medium text-foreground">你好，我是只读运维 Copilot</strong><span className="leading-5">写下问题，或选择终端、编辑器、监控、SFTP 或诊断证据。每次发送前都能预览实际内容。</span></div>}
        {messages.map((message) => <AiMessageView key={message.id} message={message} attemptId={attemptId} canInsert={connected} />)}
        <div ref={conversationEnd} />
      </div>

      {connected && <div className="shrink-0 border-t border-border bg-panel-header/60 p-2">
        {effectiveSources.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1" aria-label="已选择的上下文来源">
          {effectiveSources.map((source) => <span key={source.kind} className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-panel px-1.5 py-0.5 text-[9px] text-muted-foreground"><FileText size={9} /><span className="max-w-48 truncate">{savePreviewSourceLabel(source)}</span><button type="button" aria-label="移除上下文来源" className="text-muted-foreground hover:text-foreground" onClick={() => removeSource(source.kind)}>×</button></span>)}
        </div>}
        <textarea
          value={effectivePrompt}
          onChange={(event) => { setIntent(null); setPrompt(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void generatePreview(); } }}
          maxLength={16_000}
          placeholder={mode === "plan" ? "描述要规划的 SSH 命令或代码修改…（⌘/Ctrl + Enter 预览）" : mode === "diagnose" ? "描述故障现象，或选择已授权的诊断证据…" : "描述问题…（⌘/Ctrl + Enter 预览发送内容）"}
          className="compact-scrollbar min-h-16 max-h-36 w-full resize-y rounded-sm border border-border bg-background px-2 py-1.5 text-[11px] leading-4 outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="AI 提示内容"
          disabled={Boolean(requestId)}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-1.5 text-[9px] text-muted-foreground" disabled={!messages.length || Boolean(requestId)} onClick={() => void clearConversation()}><Trash2 size={10} />清空对话</Button>
          <label className="mr-auto ml-2 flex items-center gap-1 text-[9px] text-muted-foreground" title="启用后，发送预览会包含本 SSH 标签先前的对话">
            <input type="checkbox" checked={includeHistory} onChange={(event) => { setIncludeHistory(event.target.checked); setPreview(null); }} className="accent-primary" />包含本会话历史
          </label>
          {requestId ? <Button type="button" variant="destructive" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void stop()}>停止生成</Button> : <Button type="button" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void generatePreview()} disabled={previewBusy || !selectedProvider || providerNeedsKey}>{previewBusy ? "准备预览…" : "预览并发送"}</Button>}
        </div>
        {providerNeedsKey && <p className="mt-1 text-[9px] text-amber-700 dark:text-amber-300">请先在模型设置中保存 API Key。</p>}
      </div>}

      <AiProviderDialog
        open={providerDialogOpen}
        key={`${providerDialogOpen ? "open" : "closed"}-${editingProviderId}`}
        provider={providers.find((item) => item.id === editingProviderId) ?? null}
        onOpenChange={setProviderDialogOpen}
        onSaved={onSavedProvider}
      />

      <Dialog open={Boolean(visiblePreview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        {visiblePreview && <DialogContent className="flex max-h-[min(760px,calc(100vh-28px))] w-[min(760px,calc(100vw-24px))] flex-col gap-0 p-0">
          <header className="shrink-0 border-b border-border bg-panel-header px-3 py-2">
            <DialogTitle>发送前检查上下文</DialogTitle>
            <DialogDescription className="mt-1">确认后才会把以下脱敏内容发送给所选服务商；预览将在两分钟后失效。</DialogDescription>
          </header>
          <div className="compact-scrollbar min-h-0 flex-1 space-y-2 overflow-auto p-3 text-[11px]">
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-panel-header/50 p-2">
              <dt className="text-muted-foreground">SSH 会话</dt><dd className="truncate" title={visiblePreview.hostLabel}>{visiblePreview.hostLabel}</dd>
              <dt className="text-muted-foreground">主机指纹</dt><dd className="break-all font-mono text-[10px]">{visiblePreview.hostFingerprintSha256}</dd>
              <dt className="text-muted-foreground">发送目标</dt><dd className="break-all font-mono text-[10px]">{visiblePreview.providerKind === "ollama" ? "Ollama" : "OpenAI 兼容 API"} · {visiblePreview.providerDestination} · {visiblePreview.providerModel}</dd>
              <dt className="text-muted-foreground">对话历史</dt><dd>{visiblePreview.conversationHistoryIncluded ? "已包括本 SSH 会话历史" : "未包括"}</dd>
              <dt className="text-muted-foreground">本次问题</dt><dd className="break-words">{formatBytes(visiblePreview.promptBytes)}{visiblePreview.promptTruncated ? " · 已截断" : ""}{visiblePreview.promptRedacted ? " · 已脱敏" : ""}</dd>
              {visiblePreview.sources.map((source, index) => <div key={`${source.kind}-${index}`} className="contents"><dt className="text-muted-foreground">来源 {index + 1}</dt><dd className="break-words">{source.displayLabel} · {formatBytes(source.bytes)}{source.truncated ? " · 已截断" : ""}{source.redacted ? " · 已脱敏" : ""}</dd></div>)}
            </dl>
            <div className="rounded-sm border border-border">
              <h3 className="border-b border-border bg-panel-header px-2 py-1 text-[10px] font-medium">实际发送内容（脱敏预览）</h3>
              <pre className="compact-scrollbar max-h-[min(48vh,500px)] overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[10px] leading-4">{visiblePreview.redactedPreview}</pre>
            </div>
            <p className="text-[10px] leading-4 text-amber-700 dark:text-amber-300">自动脱敏无法识别所有秘密。请检查主机、来源、文件内容和命令，并确认只发送你愿意交给该服务商的数据。</p>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-panel-header/50 p-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setPreview(null)}>取消</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void confirmSend()} disabled={providerNeedsKey || Boolean(requestId)}>确认并发送</Button>
          </footer>
        </DialogContent>}
      </Dialog>
    </>
  );

  return <aside className="flex h-full w-full min-w-0 flex-col border-l border-border bg-panel" aria-label="AI 助手面板">{body}</aside>;
}

export function AiSidePanel({ sheet = false }: { sheet?: boolean }) {
  const setAiOpen = useWorkspaceStore((state) => state.setAiOpen);

  if (sheet) {
    return (
      <Dialog open onOpenChange={setAiOpen}>
        <DialogContent className="inset-y-0 right-0 left-auto top-0 h-full max-h-full w-[min(380px,calc(100vw-24px))] translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 p-0">
          <DialogTitle className="sr-only">AI 助手</DialogTitle>
          <DialogDescription className="sr-only">按需使用的只读 AI 面板。</DialogDescription>
          <AiPanelBody onClose={() => setAiOpen(false)} />
        </DialogContent>
      </Dialog>
    );
  }

  return <AiPanelBody onClose={() => setAiOpen(false)} />;
}
