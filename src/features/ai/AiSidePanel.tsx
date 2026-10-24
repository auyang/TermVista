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
import i18next from "@/i18n";
import { useTranslation } from "react-i18next";

const EMPTY_MESSAGES: never[] = [];
const EMPTY_SOURCES: AiContextSource[] = [];

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function AiPanelBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("ai");
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
    }).catch(() => {
      if (active) toast.error(t("panel.errors.loadProviders"));
    }).finally(() => {
      if (active) setLoadingProviders(false);
    });
    return () => { active = false; };
  }, [setProviders, t]);

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
      toast.message(t("panel.errors.action"));
      return;
    }
    const nextSources = [...effectiveSources.filter((item) => item.kind !== source.kind), source];
    if (nextSources.length > 3) {
      toast.message(t("panel.errors.action"));
      return;
    }
    setIntent(null);
    setSources(nextSources);
    setSourceSessionId(sessionId);
    if (nextPrompt) setPrompt(nextPrompt);
  };

  const addTerminalSelection = () => {
    if (!attemptId) return toast.message(t("panel.terminalSelectedTitle"));
    const text = getTerminalSelection(attemptId);
    if (!text.trim()) return toast.message(t("panel.terminalSelectedTitle"));
    addSource(
      { kind: "terminalSelection", text },
      t("prompts.terminalSelection"),
    );
  };

  const addTerminalRecentOutput = () => {
    if (!attemptId) return toast.message(t("panel.errors.action"));
    const text = getTerminalRecentOutput(attemptId, 80);
    if (!text) return toast.message(t("panel.terminalRecentTitle"));
    addSource({ kind: "terminalRecentOutput", text }, t("prompts.terminalRecent"));
  };

  const addEditorSelection = () => {
    if (!activeEditor || activeEditor.sessionId !== sessionId) return toast.message(t("panel.editorSelectionTitle"));
    if (activeEditor.sensitive) return toast.error(t("panel.errors.action"));
    if (!activeEditor.selectionText.trim()) return toast.message(t("panel.editorSelectionTitle"));
    addSource({ kind: "editorSelection", documentId: activeEditor.documentId, revision: activeEditor.revision, text: activeEditor.selectionText }, t("prompts.editorSelection"));
  };

  const addEditorBuffer = () => {
    if (!activeEditor || activeEditor.sessionId !== sessionId) return toast.message(t("panel.editorSelectionTitle"));
    if (activeEditor.sensitive) return toast.error(t("panel.errors.action"));
    addSource({ kind: "editorBuffer", documentId: activeEditor.documentId, revision: activeEditor.revision, dirty: activeEditor.dirty, text: activeEditor.text }, t("prompts.editorBuffer"));
  };

  const addDiagnosticEvidence = (runId: string, evidenceIds: string[]) => {
    if (!evidenceIds.length) return toast.message(t("panel.errors.action"));
    addSource({ kind: "diagnosticEvidenceRefs", runId, evidenceIds }, t("prompts.diagnosticEvidence"));
  };

  const addMonitorSnapshot = () => addSource(
    { kind: "monitorSnapshot" },
    t("prompts.monitorSnapshot"),
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
      toast.message(!selectedProvider ? t("panel.errors.action") : t("panel.errors.action"));
      return;
    }
    if (sourceIsStale) {
      setSources([]);
      setSourceSessionId("");
      setIntent(null);
      toast.error(t("panel.errors.previewSessionChanged"));
      return;
    }
    if (!effectivePrompt.trim()) {
      toast.message(t("panel.errors.action"));
      return;
    }
    setPreviewBusy(true);
    try {
      for (const source of effectiveSources) {
        if (source.kind !== "editorSelection" && source.kind !== "editorBuffer") continue;
        const document = useEditorStore.getState().documents.find((item) => item.documentId === source.documentId);
        if (!document || document.sessionId !== sessionId || document.revision !== source.revision) {
          throw new Error(t("panel.errors.editorChanged"));
        }
        if (source.kind === "editorBuffer" && (document.dirty !== source.dirty || document.text !== source.text)) {
          throw new Error(t("panel.errors.editorChanged"));
        }
        await registerAiEditorRevision(document.documentId, sessionId, document.revision, document.dirty, document.text);
      }
      const result = await previewAiContext({ sessionId, providerId: selectedProvider.id, prompt: effectivePrompt, sources: effectiveSources, includeHistory, mode, uiLanguage: i18next.resolvedLanguage ?? "en-US" });
      if (useWorkspaceStore.getState().activeTabId !== activeTab?.id) {
        toast.error(t("panel.errors.previewSessionChanged"));
        return;
      }
      setPreview(result);
    } catch {
      toast.error(t("panel.errors.preview"));
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
      toast.message(t("panel.errors.action"));
      return;
    }
    if (providerNeedsKey) {
      toast.message(t("panel.saveApiKeyHint"));
      return;
    }
    if (preview.sessionId !== sessionId || preview.providerDestination !== selectedProvider.baseUrl) {
      setPreview(null);
      toast.error(t("panel.errors.previewSessionChanged"));
      return;
    }
    if (preview.taskMode !== mode) {
      setPreview(null);
      toast.error(t("panel.errors.preview"));
      return;
    }
    try {
      for (const source of preview.sources) {
        if (!source.editorDocumentId || source.editorRevision === undefined) continue;
        const document = useEditorStore.getState().documents.find((item) => item.documentId === source.editorDocumentId);
        if (!document || document.sessionId !== sessionId || document.revision !== source.editorRevision) {
          setPreview(null);
          toast.error(t("panel.errors.editorChanged"));
          return;
        }
        if (source.kind === "editorBuffer" && source.editorDirty === true && !document.dirty) {
          setPreview(null);
          toast.error(t("panel.errors.editorChanged"));
          return;
        }
        await registerAiEditorRevision(document.documentId, sessionId, document.revision, document.dirty, document.text);
      }
    } catch {
      toast.error(t("panel.errors.confirmEditor"));
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
    } catch {
      toast.error(t("panel.errors.startRequest"));
    }
  };

  const stop = async () => {
    if (!requestId) return;
    try {
      await cancelAiChat(requestId);
    } catch {
      toast.error(t("panel.errors.stopRequest"));
    }
  };

  const clearConversation = async () => {
    if (!sessionId || requestId) return;
    try {
      await clearAiConversation(sessionId);
      clearSession(sessionId);
    } catch {
      toast.error(t("panel.errors.clearConversation"));
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
    if (source.kind === "terminalSelection") return t("panel.sourceTerminalSelection");
    if (source.kind === "terminalRecentOutput") return t("panel.sourceTerminalRecent");
    if (source.kind === "monitorSnapshot") return t("panel.sourceMonitor");
    if (source.kind === "sftpSelectedText") return t("panel.sourceSftp", { path: source.remotePath });
    if (source.kind === "editorSelection") return t("panel.sourceEditorSelection");
    if (source.kind === "editorBuffer") return source.dirty ? t("panel.sourceEditorBuffer") : t("panel.sourceEditorSavedBuffer");
    if (source.kind === "tunnelRule") return t("panel.sourceTunnelRule");
    return t("panel.sourceDiagnostics", { count: source.evidenceIds.length });
  };

  const body = (
    <>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        <div className="flex min-w-0 items-center gap-1.5"><Sparkles size={13} className="shrink-0 text-accent" /><span className="font-medium">{t("panel.title")}</span><span className="truncate text-[9px] text-muted-foreground">{t("panel.readOnlyAdvice")}</span></div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("panel.modelSettings")} title={t("panel.modelSettings")} onClick={() => editProvider(selectedProvider)}><Settings2 size={13} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("panel.closePanel")} title={t("panel.close")} onClick={onClose}><X size={13} /></Button>
        </div>
      </header>

      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2">
        <Bot size={12} className="shrink-0 text-muted-foreground" />
        <select
          value={selectedProviderId}
          onChange={(event) => { setSelectedProviderId(event.target.value); setPreview(null); }}
          className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t("panel.selectModel")}
          disabled={loadingProviders || providers.length === 0}
        >
          {providers.length === 0 ? <option value="">{t("panel.noModel")}</option> : providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
        </select>
        {providerNeedsKey && <span className="max-w-20 truncate text-[9px] text-amber-700 dark:text-amber-300">{t("panel.missingKey")}</span>}
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-sm" title={t("panel.addModel")} aria-label={t("panel.addModel")} onClick={() => editProvider(null)}><Plus size={12} /></Button>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-panel px-2" role="tablist" aria-label={t("panel.workingMode")}>
        {([ ["ask", t("panel.ask")], ["diagnose", t("panel.diagnose")], ["plan", t("panel.plan")] ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={mode === value} className={`h-5 rounded-sm px-2 text-[10px] ${mode === value ? "bg-accent/10 font-medium text-accent" : "text-muted-foreground hover:bg-muted"}`} onClick={() => { setMode(value); setPreview(null); }}>{label}</button>)}
        {mode === "plan" && <span className="ml-2 truncate text-[9px] text-muted-foreground">{t("panel.planSafety")}</span>}
      </div>

      {connected && <div className="flex min-h-7 shrink-0 items-center gap-1.5 border-b border-border bg-panel-header/60 px-2 text-[9px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="truncate" title={`${activeTab?.title ?? "SSH"} · ${activeTab?.host ?? ""}`}>{activeTab?.title ?? t("panel.sshSession")} · {activeTab?.host ?? t("panel.currentHost")}</span>
        <span className="ml-auto flex shrink-0 gap-0.5">
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("terminalSelection") ? "text-accent" : ""}`} onClick={addTerminalSelection} title={t("panel.terminalSelectedTitle")}><TerminalSquare size={10} />{t("panel.terminalSelected")}</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("terminalRecentOutput") ? "text-accent" : ""}`} onClick={addTerminalRecentOutput} title={t("panel.terminalRecentTitle")}><History size={10} />{t("panel.terminalRecent")}</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("editorSelection") ? "text-accent" : ""}`} onClick={addEditorSelection} disabled={!activeEditor || activeEditor.sensitive} title={t("panel.editorSelectionTitle")}><FileCode2 size={10} />{t("panel.editorSelection")}</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("editorBuffer") ? "text-accent" : ""}`} onClick={addEditorBuffer} disabled={!activeEditor || activeEditor.sensitive} title={t("panel.editorBufferTitle")}><FileText size={10} />{t("panel.editorBuffer")}</Button>
          <Button type="button" variant="ghost" size="sm" className={`h-5 rounded-sm px-1 text-[9px] ${sourceKinds.has("monitorSnapshot") ? "text-accent" : ""}`} onClick={addMonitorSnapshot} title={t("panel.monitorTitle")}><Activity size={10} />{t("panel.monitor")}</Button>
        </span>
      </div>}

      {mode === "diagnose" && <DiagnosticPanel sessionId={sessionId} connected={connected} onSelectAiEvidence={addDiagnosticEvidence} />}

      <div className="compact-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2" aria-label={t("panel.conversation")}>
        {!selectedProvider && !loadingProviders && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Bot size={24} className="text-accent" /><strong className="font-medium text-foreground">{t("panel.configureModelTitle")}</strong><span className="leading-5">{t("panel.modelPrivacy")}</span><Button type="button" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => editProvider(null)}>{t("panel.configureModel")}</Button></div>}
        {!connected && selectedProvider && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Bot size={24} className="text-accent" /><strong className="font-medium text-foreground">{t("panel.connectToStart")}</strong><span className="leading-5">{t("panel.contextPrivacy")}</span></div>}
        {connected && messages.length === 0 && selectedProvider && <div className="m-auto flex max-w-64 flex-col items-center gap-2 text-center text-xs text-muted-foreground"><Sparkles size={22} className="text-accent" /><strong className="font-medium text-foreground">{t("panel.welcome")}</strong><span className="leading-5">{t("panel.welcomeHint")}</span></div>}
        {messages.map((message) => <AiMessageView key={message.id} message={message} attemptId={attemptId} canInsert={connected} />)}
        <div ref={conversationEnd} />
      </div>

      {connected && <div className="shrink-0 border-t border-border bg-panel-header/60 p-2">
        {effectiveSources.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1" aria-label={t("panel.selectedSources")}>
          {effectiveSources.map((source) => <span key={source.kind} className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-panel px-1.5 py-0.5 text-[9px] text-muted-foreground"><FileText size={9} /><span className="max-w-48 truncate">{savePreviewSourceLabel(source)}</span><button type="button" aria-label={t("panel.removeSource")} className="text-muted-foreground hover:text-foreground" onClick={() => removeSource(source.kind)}>×</button></span>)}
        </div>}
        <textarea
          value={effectivePrompt}
          onChange={(event) => { setIntent(null); setPrompt(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void generatePreview(); } }}
          maxLength={16_000}
          placeholder={mode === "plan" ? t("panel.promptPlan") : mode === "diagnose" ? t("panel.promptDiagnose") : t("panel.promptAsk")}
          className="compact-scrollbar min-h-16 max-h-36 w-full resize-y rounded-sm border border-border bg-background px-2 py-1.5 text-[11px] leading-4 outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t("panel.promptLabel")}
          disabled={Boolean(requestId)}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-1.5 text-[9px] text-muted-foreground" disabled={!messages.length || Boolean(requestId)} onClick={() => void clearConversation()}><Trash2 size={10} />{t("panel.clearConversationButton")}</Button>
          <label className="mr-auto ml-2 flex items-center gap-1 text-[9px] text-muted-foreground" title={t("panel.includeHistoryTitle")}>
            <input type="checkbox" checked={includeHistory} onChange={(event) => { setIncludeHistory(event.target.checked); setPreview(null); }} className="accent-primary" />{t("panel.includeHistory")}
          </label>
          {requestId ? <Button type="button" variant="destructive" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void stop()}>{t("panel.stopGeneration")}</Button> : <Button type="button" size="sm" className="h-6 rounded-sm px-2 text-[10px]" onClick={() => void generatePreview()} disabled={previewBusy || !selectedProvider || providerNeedsKey}>{previewBusy ? t("panel.preparingPreview") : t("panel.previewAndSend")}</Button>}
        </div>
        {providerNeedsKey && <p className="mt-1 text-[9px] text-amber-700 dark:text-amber-300">{t("panel.saveApiKeyHint")}</p>}
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
            <DialogTitle>{t("panel.previewTitle")}</DialogTitle>
            <DialogDescription className="mt-1">{t("panel.previewDescription")}</DialogDescription>
          </header>
          <div className="compact-scrollbar min-h-0 flex-1 space-y-2 overflow-auto p-3 text-[11px]">
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-panel-header/50 p-2">
              <dt className="text-muted-foreground">{t("panel.sshSession")}</dt><dd className="truncate" title={visiblePreview.hostLabel}>{visiblePreview.hostLabel}</dd>
              <dt className="text-muted-foreground">{t("panel.hostFingerprint")}</dt><dd className="break-all font-mono text-[10px]">{visiblePreview.hostFingerprintSha256}</dd>
              <dt className="text-muted-foreground">{t("panel.destination")}</dt><dd className="break-all font-mono text-[10px]">{visiblePreview.providerKind === "ollama" ? "Ollama" : t("panel.openAiCompatible")} · {visiblePreview.providerDestination} · {visiblePreview.providerModel}</dd>
              <dt className="text-muted-foreground">{t("panel.history")}</dt><dd>{visiblePreview.conversationHistoryIncluded ? t("panel.includedHistory") : t("panel.notIncluded")}</dd>
              <dt className="text-muted-foreground">{t("panel.currentQuestion")}</dt><dd className="break-words">{formatBytes(visiblePreview.promptBytes)}{visiblePreview.promptTruncated ? ` · ${t("panel.truncated")}` : ""}{visiblePreview.promptRedacted ? ` · ${t("panel.redacted")}` : ""}</dd>
              {visiblePreview.sources.map((source, index) => <div key={`${source.kind}-${index}`} className="contents"><dt className="text-muted-foreground">{t("panel.source", { index: index + 1 })}</dt><dd className="break-words">{source.displayLabel} · {formatBytes(source.bytes)}{source.truncated ? ` · ${t("panel.truncated")}` : ""}{source.redacted ? ` · ${t("panel.redacted")}` : ""}</dd></div>)}
            </dl>
            <div className="rounded-sm border border-border">
              <h3 className="border-b border-border bg-panel-header px-2 py-1 text-[10px] font-medium">{t("panel.actualPayload")}</h3>
              <pre className="compact-scrollbar max-h-[min(48vh,500px)] overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[10px] leading-4">{visiblePreview.redactedPreview}</pre>
            </div>
            <p className="text-[10px] leading-4 text-amber-700 dark:text-amber-300">{t("panel.redactionWarning")}</p>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-panel-header/50 p-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setPreview(null)}>{t("panel.cancel")}</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void confirmSend()} disabled={providerNeedsKey || Boolean(requestId)}>{t("panel.confirmSend")}</Button>
          </footer>
        </DialogContent>}
      </Dialog>
    </>
  );

  return <aside className="flex h-full w-full min-w-0 flex-col border-l border-border bg-panel" aria-label={t("panel.panelLabel")}>{body}</aside>;
}

export function AiSidePanel({ sheet = false }: { sheet?: boolean }) {
  const { t } = useTranslation("ai");
  const setAiOpen = useWorkspaceStore((state) => state.setAiOpen);

  if (sheet) {
    return (
      <Dialog open onOpenChange={setAiOpen}>
        <DialogContent className="inset-y-0 right-0 left-auto top-0 h-full max-h-full w-[min(380px,calc(100vw-24px))] translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 p-0">
          <DialogTitle className="sr-only">{t("panel.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("panel.onDemandDescription")}</DialogDescription>
          <AiPanelBody onClose={() => setAiOpen(false)} />
        </DialogContent>
      </Dialog>
    );
  }

  return <AiPanelBody onClose={() => setAiOpen(false)} />;
}
