import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createDiagnosticPlan, listDiagnosticTemplates, previewDiagnosticReport } from "@/features/diagnostics/diagnosticBridge";
import { approveAndStartDiagnostic, approveAndStartDiagnosticReport, cancelRunningDiagnostic } from "@/features/diagnostics/diagnosticController";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import type { DiagnosticPlanPreview, DiagnosticReportPreview, DiagnosticSelectedContext, DiagnosticTemplateDescriptor, DiagnosticTemplateId } from "@/features/diagnostics/diagnosticTypes";
import { matchDiagnosticIntent } from "@/features/diagnostics/diagnosticIntent";
import { useAiStore } from "@/features/ai/aiStore";
import i18next from "@/i18n";
import { useTranslation } from "react-i18next";


type Translate = (key: string, options?: Record<string, unknown>) => string;

function useDiagnosticTranslate(): Translate {
  const { t } = useTranslation("diagnostics");
  return (key, options) => String(t(key as never, options as never));
}

function templateTitle(t: Translate, id: DiagnosticTemplateId) { return t(`templates.${id}.title`); }
function templateDescription(t: Translate, id: DiagnosticTemplateId) { return t(`templates.${id}.description`); }

function stepKey(toolId: string) {
  const keys: Record<string, string> = { "host.system_info": "systemInfo", "host.resource_snapshot": "resourceSnapshot", "process.list": "processList", "service.inspect": "serviceInspect", "network.listening_ports": "listeningPorts", "log.read_recent": "recentLogs", "file.read_excerpt": "fileExcerpt", "terminal.selection": "terminalSelection" };
  return keys[toolId] ?? "systemInfo";
}

function localizedReadScope(t: Translate, toolId: string, raw: string) {
  const key = stepKey(toolId);
  if (toolId === "process.list") {
    const count = raw.match(/(\d+) 个进程/)?.[1] ?? "0";
    const sort = raw.includes("CPU") ? t("processCpu") : t("processMemory");
    return t(`steps.${key}.scope`, { sort, count });
  }
  if (toolId === "service.inspect") return t(`steps.${key}.scope`, { service: raw.split("：").slice(1).join("：") });
  if (toolId === "log.read_recent") {
    const match = raw.match(/journalctl：(.+) 最近 (\d+) 行/);
    return t(`steps.${key}.scope`, { service: match?.[1] ?? raw, count: match?.[2] ?? "" });
  }
  if (toolId === "file.read_excerpt") {
    const match = raw.match(/^(.+)，最多 (\d+) KiB$/);
    return t(`steps.${key}.scope`, { path: match?.[1] ?? raw, size: match?.[2] ?? "16" });
  }
  if (toolId === "terminal.selection") {
    const count = raw.match(/共 (\d+) 字节/)?.[1] ?? "0";
    return t(`steps.${key}.scope`, { count });
  }
  if (toolId === "network.listening_ports") {
    const port = raw.match(/目标端口 (\d+)/)?.[1];
    const protocol = raw.includes("UDP") ? "UDP" : "TCP";
    if (port) return t(`steps.${key}.scope`, { protocol, port });
    const count = raw.match(/最多 (\d+) 条/)?.[1] ?? "100";
    return t(`steps.${key}.scopeMany`, { protocol, count });
  }
  return t(`steps.${key}.scope`);
}

function shortFingerprint(fingerprint: string) {
  const value = fingerprint.replace(/^SHA256:/, "");
  return `SHA256:${value.slice(0, 12)}…`;
}

const contextTemplate = (context: DiagnosticSelectedContext): DiagnosticTemplateId => {
  if (context.kind === "monitorMetric") {
    if (context.metric === "cpu" || context.metric === "processes") return "highCpu";
    if (context.metric === "disk") return "diskLow";
  }
  return "currentHost";
};

export function DiagnosticPanel({ sessionId, connected, onSelectAiEvidence }: { sessionId: string; connected: boolean; onSelectAiEvidence?: (runId: string, evidenceIds: string[]) => void }) {
  const t = useDiagnosticTranslate();
  const plan = useDiagnosticStore((state) => sessionId ? state.plans[sessionId] : undefined);
  const run = useDiagnosticStore((state) => sessionId ? state.runs[sessionId] : undefined);
  const activeRunId = useDiagnosticStore((state) => sessionId ? state.activeRunIds[sessionId] : undefined);
  const pendingContext = useDiagnosticStore((state) => state.pendingContext);
  const setPlan = useDiagnosticStore((state) => state.setPlan);
  const setPendingContext = useDiagnosticStore((state) => state.setPendingContext);
  const providers = useAiStore((state) => state.providers);
  const selectedProviderId = useAiStore((state) => state.selectedProviderId);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const providerNeedsKey = Boolean(selectedProvider?.apiKeyRequired && !selectedProvider.apiKeyConfigured);
  const [templates, setTemplates] = useState<DiagnosticTemplateDescriptor[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [serviceName, setServiceName] = useState("nginx.service");
  const [port, setPort] = useState("443");
  const [intentPrompt, setIntentPrompt] = useState("");
  const [matchedTemplateId, setMatchedTemplateId] = useState<DiagnosticTemplateId | null>(null);
  const [working, setWorking] = useState(false);
  const [reportWorking, setReportWorking] = useState(false);
  const [reportPreview, setReportPreview] = useState<DiagnosticReportPreview | null>(null);
  const [evidenceSelection, setEvidenceSelection] = useState<{ runId: string; ids: string[] } | null>(null);
  const [selection, setSelection] = useState<{ planId: string; revision: number; stepIds: string[] } | null>(null);
  const creatingContextId = useRef("");
  const selectedStepIds = selection && plan && selection.planId === plan.planId && selection.revision === plan.revision
    ? selection.stepIds
    : plan?.steps.filter((step) => step.enabled).map((step) => step.stepId) ?? [];
  const selected = new Set(selectedStepIds);
  const selectedEvidenceIds = evidenceSelection && run && evidenceSelection.runId === run.runId
    ? evidenceSelection.ids
    : run?.evidence.map((evidence) => evidence.evidenceId) ?? [];
  const selectedEvidence = new Set(selectedEvidenceIds);
  const isExpanded = expanded || Boolean(plan);

  useEffect(() => {
    void listDiagnosticTemplates().then(setTemplates).catch(() => {
      toast.error(t("panel.errors.loadTemplates"));
    });
  }, [t]);

  const createPlan = useCallback(async (templateId: DiagnosticTemplateId, context?: DiagnosticSelectedContext) => {
    if (!connected || !sessionId) {
      toast.message(t("panel.errors.connectFirst"));
      return;
    }
    if (templateId === "portUnbound" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      toast.error(t("panel.errors.invalidPort"));
      return;
    }
    setWorking(true);
    try {
      const result = await createDiagnosticPlan({
        sessionId,
        templateId,
        ...(templateId === "serviceFailed" ? { serviceName } : {}),
        ...(templateId === "portUnbound" ? { port: Number(port) } : {}),
        ...(context ? { selectedContext: context } : {}),
      });
      setPlan(result);
      toast.success(t("panel.noChanges"));
    } catch {
      toast.error(t("panel.errors.createPlan"));
    } finally {
      setWorking(false);
    }
  }, [connected, port, serviceName, sessionId, setPlan, t]);

  const recognizeIntent = () => {
    const match = matchDiagnosticIntent(intentPrompt);
    setMatchedTemplateId(match);
    if (!match) toast.message(t("panel.matchNote"));
  };

  useEffect(() => {
    if (!pendingContext) return;
    if (!sessionId || pendingContext.sessionId !== sessionId) {
      setPendingContext(null);
      return;
    }
    if (!connected || creatingContextId.current === sessionId) return;
    creatingContextId.current = sessionId;
    const context = pendingContext.context;
    const templateId = contextTemplate(context);
    setPendingContext(null);
    void createPlan(templateId, context).finally(() => { creatingContextId.current = ""; });
  }, [connected, createPlan, pendingContext, sessionId, setPendingContext]);

  const start = async (targetPlan: DiagnosticPlanPreview) => {
    if (selectedStepIds.length === 0) {
      toast.error(t("panel.errors.generic"));
      return;
    }
    setWorking(true);
    try {
      await approveAndStartDiagnostic(targetPlan, selectedStepIds);
      setPlan(null, targetPlan.sessionId);
      toast.success(t("panel.noChanges"));
    } catch {
      toast.error(t("panel.errors.start"));
    } finally {
      setWorking(false);
    }
  };

  const cancel = async () => {
    if (!activeRunId || !sessionId) return;
    try {
      await cancelRunningDiagnostic(activeRunId, sessionId);
    } catch {
      toast.error(t("panel.errors.cancel"));
    }
  };

  const prepareReport = async () => {
    if (!run || !sessionId || run.status !== "completed" || !selectedProvider) return;
    if (selectedProvider.apiKeyRequired && !selectedProvider.apiKeyConfigured) {
      toast.message(t("panel.needSavedKey"));
      return;
    }
    if (!selectedEvidenceIds.length) {
      toast.error(t("panel.errors.generic"));
      return;
    }
    setReportWorking(true);
    try {
      const preview = await previewDiagnosticReport(run.runId, sessionId, selectedProvider.id, selectedEvidenceIds, i18next.resolvedLanguage ?? "en-US");
      if (useDiagnosticStore.getState().activeRunIds[sessionId] !== run.runId) {
        toast.error(t("panel.errors.reportPreview"));
        return;
      }
      setReportPreview(preview);
    } catch {
      toast.error(t("panel.errors.reportPreview"));
    } finally {
      setReportWorking(false);
    }
  };

  const confirmReport = async () => {
    if (!reportPreview
      || reportPreview.sessionId !== sessionId
      || selectedProvider?.id !== reportPreview.providerId
      || selectedProvider.baseUrl !== reportPreview.providerDestination
      || selectedProvider.model !== reportPreview.providerModel) {
      setReportPreview(null);
      toast.error(t("panel.errors.reportPreview"));
      return;
    }
    setReportWorking(true);
    try {
      await approveAndStartDiagnosticReport(reportPreview);
      setReportPreview(null);
      toast.success(t("panel.noChanges"));
    } catch {
      toast.error(t("panel.errors.report"));
    } finally {
      setReportWorking(false);
    }
  };

  const title = connected ? t("panel.readOnly") : t("panel.diagnoseHost");
  return (
    <section className="shrink-0 border-b border-border bg-panel" aria-label={t("panel.readOnly")}>
      <header className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-panel-header/55 px-2">
        <Activity size={12} className="text-accent" />
        <strong className="text-[10px] font-semibold">{title}</strong>
        {run && <span className="truncate text-[9px] text-muted-foreground">{run.host} · {t(`panel.status${run.status === "running" ? "Running" : run.status === "completed" ? "Completed" : run.status === "cancelled" ? "Cancelled" : "Queued"}`)}</span>}
        <Button type="button" variant="ghost" size="icon" className="ml-auto h-6 w-6 rounded-sm" aria-label={isExpanded ? t("panel.collapse") : t("panel.expand")} onClick={() => setExpanded((value) => !value)}>
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </Button>
      </header>

      {isExpanded && <div className="compact-scrollbar max-h-64 space-y-2 overflow-auto p-2">
        {!connected ? <div className="flex items-center gap-2 rounded-sm border border-border bg-panel-header/40 p-2 text-[10px] text-muted-foreground"><ShieldCheck size={13} />{t("panel.connectHint")}</div> : <>
          <div className="flex items-center gap-1.5 rounded-sm border border-border bg-panel-header/40 px-2 py-1 text-[9px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{t("panel.sessionGuard")}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <label className="col-span-2 flex items-center gap-1.5 text-[9px] text-muted-foreground">{t("panel.service")}<input className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" value={serviceName} onChange={(event) => setServiceName(event.target.value)} maxLength={128} aria-label={t("panel.service")} /></label>
            <label className="col-span-2 flex items-center gap-1.5 text-[9px] text-muted-foreground">{t("panel.port")}<input className="h-6 w-24 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} maxLength={5} aria-label={t("panel.port")} /><span>TCP</span></label>
          </div>
          <div className="grid grid-cols-2 gap-1" aria-label={t("panel.templates")}>
            {templates.map((template) => <Button key={template.id} type="button" variant="outline" size="sm" className="h-auto min-h-7 justify-start rounded-sm px-1.5 py-1 text-left text-[9px] leading-3" disabled={working || Boolean(activeRunId && run?.status === "running")} title={templateDescription(t, template.id)} onClick={() => void createPlan(template.id)}>
              <Sparkles size={10} className="shrink-0 text-accent" />{template.title}
            </Button>)}
          </div>
          <div className="space-y-1 rounded-sm border border-border bg-panel-header/35 p-1.5">
            <label className="grid gap-1 text-[9px] text-muted-foreground">{t("panel.intentLabel")}
              <input className="h-6 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" value={intentPrompt} onChange={(event) => { setIntentPrompt(event.target.value); setMatchedTemplateId(null); }} maxLength={300} placeholder={t("panel.intentPlaceholder")} aria-label={t("panel.intentAria")} />
            </label>
            <div className="flex items-center gap-1.5">
              <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!intentPrompt.trim() || working} onClick={recognizeIntent}>{t("panel.match")}</Button>
              {matchedTemplateId && <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">{t("panel.matchLabel", { title: matchedTemplateId ? templateTitle(t, matchedTemplateId) : "" })}</span>}
              {matchedTemplateId && <Button type="button" size="sm" className="h-6 shrink-0 rounded-sm px-1.5 text-[9px]" disabled={working} onClick={() => void createPlan(matchedTemplateId)}>{t("panel.createMatched")}</Button>}
            </div>
            <p className="text-[8px] leading-3 text-muted-foreground">{t("panel.matchNote")}</p>
          </div>
        </>}

        {plan?.sessionId === sessionId && <PlanReview
          plan={plan}
          selected={selected}
          working={working}
          onToggle={(stepId, checked) => setSelection({
            planId: plan.planId,
            revision: plan.revision,
            stepIds: checked ? [...selectedStepIds, stepId] : selectedStepIds.filter((id) => id !== stepId),
          })}
          onStart={() => void start(plan)}
          onCancel={() => setPlan(null, sessionId)}
        />}

        {run?.sessionId === sessionId && <div className="space-y-1.5 border-t border-border pt-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium"><CheckCircle2 size={12} className={run.status === "completed" ? "text-emerald-600" : "text-muted-foreground"} />{t("panel.results", { count: run.evidence.length })}{run.evidence.some((item) => item.truncated) ? t("panel.truncated") : ""}
            {run.status === "running" && <Button type="button" variant="ghost" size="sm" className="ml-auto h-5 rounded-sm px-1 text-[9px] text-destructive" onClick={() => void cancel()}><X size={10} />{t("panel.cancel")}</Button>}
          </div>
          {run.evidence.map((evidence) => <details key={evidence.evidenceId} className="rounded-sm border border-border bg-background/60">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[9px]">
              {run.status === "completed" && <input type="checkbox" className="accent-blue-600" checked={selectedEvidence.has(evidence.evidenceId)} onClick={(event) => event.stopPropagation()} onChange={(event) => setEvidenceSelection({ runId: run.runId, ids: event.target.checked ? [...selectedEvidenceIds, evidence.evidenceId] : selectedEvidenceIds.filter((id) => id !== evidence.evidenceId) })} aria-label={t("panel.chooseEvidence", { id: evidence.evidenceId })} />}
              <span className={`h-1.5 w-1.5 rounded-full ${evidence.status === "success" ? "bg-emerald-500" : evidence.status === "unsupported" ? "bg-amber-500" : evidence.status === "running" ? "bg-blue-500" : "bg-red-500"}`} /><span className="font-medium">{evidence.toolId}</span><span className="ml-auto text-muted-foreground">{t(`statuses.${evidence.status}`)} · {evidence.elapsedMs} ms</span></summary>
            <div className="border-t border-border px-2 py-1.5 text-[9px] text-muted-foreground">{t(`steps.${stepKey(evidence.toolId)}.title`)}{evidence.commandTemplate ? ` · ${evidence.commandTemplate}` : ""}{evidence.exitStatus != null ? ` · exit ${evidence.exitStatus}` : ""}{evidence.truncated ? t("panel.truncated") : ""}<pre className="compact-scrollbar mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] text-foreground">{evidence.safePreview || t("panel.emptyOutput")}</pre></div>
          </details>)}
          {run.status === "completed" && run.evidence.length > 0 && <>
            <p className="text-[9px] text-muted-foreground">{t("panel.reportSafety")}</p>
            {onSelectAiEvidence && <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!selectedEvidenceIds.length} onClick={() => onSelectAiEvidence(run.runId, selectedEvidenceIds)}>{t("panel.addEvidence")}</Button>}
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">{selectedProvider?.name ?? t("panel.noProvider")}</span>
              <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={reportWorking || !selectedProvider || providerNeedsKey || selectedEvidenceIds.length === 0} onClick={() => void prepareReport()}><Sparkles size={10} />{reportWorking ? t("panel.preparing") : t("panel.prepareReport")}</Button>
            </div>
          {providerNeedsKey && <p className="text-[9px] text-amber-700 dark:text-amber-300">{t("panel.needSavedKey")}</p>}
          </>}
        </div>}
        {working && <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground"><LoaderCircle size={11} className="animate-spin" />{t("panel.working")}</div>}
      </div>}

      <Dialog open={Boolean(reportPreview?.sessionId === sessionId)} onOpenChange={(open) => { if (!open) setReportPreview(null); }}>
        {reportPreview?.sessionId === sessionId && <DialogContent className="flex max-h-[min(700px,calc(100vh-32px))] w-[min(760px,calc(100vw-24px))] flex-col gap-0 p-0">
          <header className="shrink-0 border-b border-border bg-panel-header px-3 py-2">
            <DialogTitle className="text-sm">{t("panel.shareTitle")}</DialogTitle>
            <DialogDescription className="mt-1 text-[10px]">{t("panel.shareDescription")}</DialogDescription>
          </header>
          <div className="compact-scrollbar min-h-0 flex-1 space-y-2 overflow-auto p-3 text-[10px]">
            <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-panel-header/50 p-2">
              <dt className="text-muted-foreground">{t("panel.host")}</dt><dd className="break-all">{reportPreview.host} · {reportPreview.sessionId}</dd>
              <dt className="text-muted-foreground">{t("panel.fingerprint")}</dt><dd className="break-all font-mono">{reportPreview.fingerprintSha256}</dd>
              <dt className="text-muted-foreground">{t("panel.destination")}</dt><dd className="break-all font-mono">{reportPreview.providerDestination} · {reportPreview.providerModel}</dd>
              <dt className="text-muted-foreground">{t("panel.evidence")}</dt><dd>{t("panel.results", { count: reportPreview.evidence.length })}{t("panel.redactedPreview")}{reportPreview.contentTruncated ? t("panel.truncated") : ""}</dd>
            </dl>
            <div className="rounded-sm border border-border">
              <h3 className="border-b border-border bg-panel-header px-2 py-1 text-[10px] font-medium">{t("panel.actualPayload")}</h3>
              <pre className="compact-scrollbar max-h-[min(42vh,450px)] overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[9px] leading-4">{reportPreview.redactedContent}</pre>
            </div>
            <p className="text-[9px] leading-4 text-amber-700 dark:text-amber-300">{t("panel.shareWarning")}</p>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-panel-header/50 p-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setReportPreview(null)}>{t("panel.decline")}</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={reportWorking} onClick={() => void confirmReport()}>{reportWorking ? t("panel.sending") : t("panel.approveReport")}</Button>
          </footer>
        </DialogContent>}
      </Dialog>
    </section>
  );
}

function PlanReview({
  plan,
  selected,
  working,
  onToggle,
  onStart,
  onCancel,
}: {
  plan: DiagnosticPlanPreview;
  selected: Set<string>;
  working: boolean;
  onToggle: (stepId: string, checked: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const t = useDiagnosticTranslate();
  return <div className="space-y-1.5 rounded-sm border border-accent/30 bg-accent/5 p-2" aria-label={t("panel.planTitle")}>
    <div className="flex items-start gap-1.5"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-accent" /><div className="min-w-0"><strong className="text-[10px]">{t("panel.planTitle")}</strong><p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{t("panel.target", { host: plan.host, port: plan.port, username: plan.username })}<br />{t("panel.verifiedFingerprint", { fingerprint: shortFingerprint(plan.fingerprintSha256) })}</p><p className="text-[9px] leading-4">{templateDescription(t, plan.templateId)}</p></div></div>
    {plan.contextSummary && <p className="rounded-sm bg-background/70 px-1.5 py-1 text-[9px] text-muted-foreground">{t("panel.contextAuthorized")}</p>}
    <div className="space-y-1">
      {plan.steps.map((step) => <label key={step.stepId} className="flex cursor-pointer gap-1.5 rounded-sm border border-border bg-background/70 p-1.5 text-[9px]">
        <input type="checkbox" className="mt-0.5 accent-blue-600" checked={selected.has(step.stepId)} onChange={(event) => onToggle(step.stepId, event.target.checked)} aria-label={t("panel.allowStep", { title: t(`steps.${stepKey(step.toolId)}.title`) })} />
        <span className="min-w-0"><strong className="font-medium">{t(`steps.${stepKey(step.toolId)}.title`)}</strong><span className="ml-1 text-muted-foreground">{t("panel.maxOutput", { size: new Intl.NumberFormat(i18next.resolvedLanguage ?? "en-US").format(Math.ceil(step.maxOutputBytes / 1024)) })}</span><span className="mt-0.5 block leading-4 text-muted-foreground">{t("panel.readScope", { scope: localizedReadScope(t, step.toolId, step.readScope) })}<br />{t("panel.sensitiveData", { value: t(`steps.${stepKey(step.toolId)}.sensitive`) })}</span></span>
      </label>)}
    </div>
    <p className="text-[8px] leading-3.5 text-amber-700 dark:text-amber-300">{t("panel.planSafety")}</p>
    <div className="flex justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={working} onClick={onCancel}>{t("panel.cancelPlan")}</Button>
      <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={working || selected.size === 0} onClick={onStart}><Activity size={10} />{t("panel.startCheck")}</Button>
    </div>
  </div>;
}
