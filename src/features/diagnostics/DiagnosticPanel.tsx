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

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
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
    void listDiagnosticTemplates().then(setTemplates).catch((error: unknown) => {
      toast.error(`读取诊断模板失败：${errorMessage(error)}`);
    });
  }, []);

  const createPlan = useCallback(async (templateId: DiagnosticTemplateId, context?: DiagnosticSelectedContext) => {
    if (!connected || !sessionId) {
      toast.message("请先连接 SSH，再创建诊断计划。");
      return;
    }
    if (templateId === "portUnbound" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      toast.error("请输入 1 到 65535 之间的端口号。");
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
      toast.success("已生成待审核计划；尚未在服务器运行检查。");
    } catch (error) {
      toast.error(`无法生成只读诊断计划：${errorMessage(error)}`);
    } finally {
      setWorking(false);
    }
  }, [connected, port, serviceName, sessionId, setPlan]);

  const recognizeIntent = () => {
    const match = matchDiagnosticIntent(intentPrompt);
    setMatchedTemplateId(match);
    if (!match) toast.message("未能唯一匹配已有只读模板；请使用下面的模板按钮，或补充更具体的故障描述。");
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
      toast.error("至少保留一个只读检查步骤。");
      return;
    }
    setWorking(true);
    try {
      await approveAndStartDiagnostic(targetPlan, selectedStepIds);
      setPlan(null, targetPlan.sessionId);
      toast.success("只读诊断已开始；远端命令不会写入服务器。 ");
    } catch (error) {
      toast.error(`无法开始诊断：${errorMessage(error)}`);
    } finally {
      setWorking(false);
    }
  };

  const cancel = async () => {
    if (!activeRunId || !sessionId) return;
    try {
      await cancelRunningDiagnostic(activeRunId, sessionId);
    } catch (error) {
      toast.error(`停止诊断失败：${errorMessage(error)}`);
    }
  };

  const prepareReport = async () => {
    if (!run || !sessionId || run.status !== "completed" || !selectedProvider) return;
    if (selectedProvider.apiKeyRequired && !selectedProvider.apiKeyConfigured) {
      toast.message("请先在 AI 设置中保存当前服务商的 API Key。");
      return;
    }
    if (!selectedEvidenceIds.length) {
      toast.error("请至少选择一条证据再生成报告。");
      return;
    }
    setReportWorking(true);
    try {
      const preview = await previewDiagnosticReport(run.runId, sessionId, selectedProvider.id, selectedEvidenceIds);
      if (useDiagnosticStore.getState().activeRunIds[sessionId] !== run.runId) {
        toast.error("当前诊断已切换，请重新选择证据并预览。");
        return;
      }
      setReportPreview(preview);
    } catch (error) {
      toast.error(`无法准备报告预览：${errorMessage(error)}`);
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
      toast.error("SSH 会话或模型服务商已变化；请重新检查外发范围。");
      return;
    }
    setReportWorking(true);
    try {
      await approveAndStartDiagnosticReport(reportPreview);
      setReportPreview(null);
      toast.success("已按单独授权发送脱敏证据，正在生成报告。");
    } catch (error) {
      toast.error(`未能生成诊断报告：${errorMessage(error)}`);
    } finally {
      setReportWorking(false);
    }
  };

  const title = connected ? "只读诊断" : "诊断当前服务器";
  return (
    <section className="shrink-0 border-b border-border bg-panel" aria-label="只读诊断">
      <header className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-panel-header/55 px-2">
        <Activity size={12} className="text-accent" />
        <strong className="text-[10px] font-semibold">{title}</strong>
        {run && <span className="truncate text-[9px] text-muted-foreground">{run.host} · {run.status === "running" ? "检查中" : run.status === "completed" ? "已完成" : run.status === "cancelled" ? "已取消" : "待查看"}</span>}
        <Button type="button" variant="ghost" size="icon" className="ml-auto h-6 w-6 rounded-sm" aria-label={isExpanded ? "收起诊断入口" : "展开诊断入口"} onClick={() => setExpanded((value) => !value)}>
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </Button>
      </header>

      {isExpanded && <div className="compact-scrollbar max-h-64 space-y-2 overflow-auto p-2">
        {!connected ? <div className="flex items-center gap-2 rounded-sm border border-border bg-panel-header/40 p-2 text-[10px] text-muted-foreground"><ShieldCheck size={13} />连接 SSH 后可以为当前服务器生成检查计划。</div> : <>
          <div className="flex items-center gap-1.5 rounded-sm border border-border bg-panel-header/40 px-2 py-1 text-[9px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />当前已连接会话 · 诊断前再次校验主机密钥
          </div>
          <div className="grid grid-cols-2 gap-1">
            <label className="col-span-2 flex items-center gap-1.5 text-[9px] text-muted-foreground">服务名<input className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" value={serviceName} onChange={(event) => setServiceName(event.target.value)} maxLength={128} aria-label="服务名称" /></label>
            <label className="col-span-2 flex items-center gap-1.5 text-[9px] text-muted-foreground">目标端口<input className="h-6 w-24 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} maxLength={5} aria-label="目标端口" /><span>TCP</span></label>
          </div>
          <div className="grid grid-cols-2 gap-1" aria-label="一键诊断模板">
            {templates.map((template) => <Button key={template.id} type="button" variant="outline" size="sm" className="h-auto min-h-7 justify-start rounded-sm px-1.5 py-1 text-left text-[9px] leading-3" disabled={working || Boolean(activeRunId && run?.status === "running")} title={template.description} onClick={() => void createPlan(template.id)}>
              <Sparkles size={10} className="shrink-0 text-accent" />{template.title}
            </Button>)}
          </div>
          <div className="space-y-1 rounded-sm border border-border bg-panel-header/35 p-1.5">
            <label className="grid gap-1 text-[9px] text-muted-foreground">用自然语言描述问题
              <input className="h-6 rounded-sm border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" value={intentPrompt} onChange={(event) => { setIntentPrompt(event.target.value); setMatchedTemplateId(null); }} maxLength={300} placeholder="例如：为什么 Nginx 返回 502？" aria-label="自然语言诊断问题" />
            </label>
            <div className="flex items-center gap-1.5">
              <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!intentPrompt.trim() || working} onClick={recognizeIntent}>匹配只读模板</Button>
              {matchedTemplateId && <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">匹配：{templates.find((template) => template.id === matchedTemplateId)?.title ?? matchedTemplateId}</span>}
              {matchedTemplateId && <Button type="button" size="sm" className="h-6 shrink-0 rounded-sm px-1.5 text-[9px]" disabled={working} onClick={() => void createPlan(matchedTemplateId)}>检查参数并生成计划</Button>}
            </div>
            <p className="text-[8px] leading-3 text-muted-foreground">本地匹配到已有模板后仍需检查目标服务/端口及读取范围；生成计划不会启动远端检查。</p>
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
          <div className="flex items-center gap-1.5 text-[10px] font-medium"><CheckCircle2 size={12} className={run.status === "completed" ? "text-emerald-600" : "text-muted-foreground"} />检查结果 · {run.evidence.length} 条证据{run.evidence.some((item) => item.truncated) ? " · 有截断" : ""}
            {run.status === "running" && <Button type="button" variant="ghost" size="sm" className="ml-auto h-5 rounded-sm px-1 text-[9px] text-destructive" onClick={() => void cancel()}><X size={10} />取消</Button>}
          </div>
          {run.evidence.map((evidence) => <details key={evidence.evidenceId} className="rounded-sm border border-border bg-background/60">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[9px]">
              {run.status === "completed" && <input type="checkbox" className="accent-blue-600" checked={selectedEvidence.has(evidence.evidenceId)} onClick={(event) => event.stopPropagation()} onChange={(event) => setEvidenceSelection({ runId: run.runId, ids: event.target.checked ? [...selectedEvidenceIds, evidence.evidenceId] : selectedEvidenceIds.filter((id) => id !== evidence.evidenceId) })} aria-label={`选择证据 ${evidence.evidenceId} 用于 AI 报告`} />}
              <span className={`h-1.5 w-1.5 rounded-full ${evidence.status === "success" ? "bg-emerald-500" : evidence.status === "unsupported" ? "bg-amber-500" : evidence.status === "running" ? "bg-blue-500" : "bg-red-500"}`} /><span className="font-medium">{evidence.toolId}</span><span className="ml-auto text-muted-foreground">{evidence.status} · {evidence.elapsedMs} ms</span></summary>
            <div className="border-t border-border px-2 py-1.5 text-[9px] text-muted-foreground">{evidence.source}{evidence.commandTemplate ? ` · ${evidence.commandTemplate}` : ""}{evidence.exitStatus != null ? ` · exit ${evidence.exitStatus}` : ""}{evidence.truncated ? " · 内容已截断" : ""}<pre className="compact-scrollbar mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] text-foreground">{evidence.safePreview || "（无文本输出）"}</pre></div>
          </details>)}
          {run.status === "completed" && run.evidence.length > 0 && <>
            <p className="text-[9px] text-muted-foreground">未发送给 AI。生成模型报告会再次展示脱敏内容和发送目标，需单独确认；拒绝后不会发起模型请求。</p>
            {onSelectAiEvidence && <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!selectedEvidenceIds.length} onClick={() => onSelectAiEvidence(run.runId, selectedEvidenceIds)}>把所选证据加入对话</Button>}
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">{selectedProvider?.name ?? "尚未配置模型"}</span>
              <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={reportWorking || !selectedProvider || providerNeedsKey || selectedEvidenceIds.length === 0} onClick={() => void prepareReport()}><Sparkles size={10} />{reportWorking ? "准备中…" : "预览并生成报告"}</Button>
            </div>
          {providerNeedsKey && <p className="text-[9px] text-amber-700 dark:text-amber-300">请先配置并选择一个已保存 API Key 的模型服务商。</p>}
          </>}
        </div>}
        {working && <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground"><LoaderCircle size={11} className="animate-spin" />正在处理…</div>}
      </div>}

      <Dialog open={Boolean(reportPreview?.sessionId === sessionId)} onOpenChange={(open) => { if (!open) setReportPreview(null); }}>
        {reportPreview?.sessionId === sessionId && <DialogContent className="flex max-h-[min(700px,calc(100vh-32px))] w-[min(760px,calc(100vw-24px))] flex-col gap-0 p-0">
          <header className="shrink-0 border-b border-border bg-panel-header px-3 py-2">
            <DialogTitle className="text-sm">单独确认外发诊断证据</DialogTitle>
            <DialogDescription className="mt-1 text-[10px]">读取服务器的授权不等于同意发送给模型。只有确认后才会发起 API 请求。</DialogDescription>
          </header>
          <div className="compact-scrollbar min-h-0 flex-1 space-y-2 overflow-auto p-3 text-[10px]">
            <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border bg-panel-header/50 p-2">
              <dt className="text-muted-foreground">SSH 主机</dt><dd className="break-all">{reportPreview.host} · {reportPreview.sessionId}</dd>
              <dt className="text-muted-foreground">主机指纹</dt><dd className="break-all font-mono">{reportPreview.fingerprintSha256}</dd>
              <dt className="text-muted-foreground">发送目标</dt><dd className="break-all font-mono">{reportPreview.providerDestination} · {reportPreview.providerModel}</dd>
              <dt className="text-muted-foreground">证据</dt><dd>{reportPreview.evidence.length} 项 · 已脱敏预览{reportPreview.contentTruncated ? " · 内容已截断" : ""}</dd>
            </dl>
            <div className="rounded-sm border border-border">
              <h3 className="border-b border-border bg-panel-header px-2 py-1 text-[10px] font-medium">实际发送内容</h3>
              <pre className="compact-scrollbar max-h-[min(42vh,450px)] overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[9px] leading-4">{reportPreview.redactedContent}</pre>
            </div>
            <p className="text-[9px] leading-4 text-amber-700 dark:text-amber-300">远程日志和文件可能包含未识别的秘密或恶意提示。请检查实际内容与服务商；报告只分析当前所选证据，不会触发新检查或自动修复。</p>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-panel-header/50 p-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setReportPreview(null)}>拒绝外发</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={reportWorking} onClick={() => void confirmReport()}>{reportWorking ? "正在发送…" : "单独授权并生成报告"}</Button>
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
  return <div className="space-y-1.5 rounded-sm border border-accent/30 bg-accent/5 p-2" aria-label="诊断计划审核">
    <div className="flex items-start gap-1.5"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-accent" /><div className="min-w-0"><strong className="text-[10px]">检查计划</strong><p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">目标 {plan.host}:{plan.port} · {plan.username}<br />已验证指纹 {shortFingerprint(plan.fingerprintSha256)}</p><p className="text-[9px] leading-4">{plan.why}</p></div></div>
    {plan.contextSummary && <p className="rounded-sm bg-background/70 px-1.5 py-1 text-[9px] text-muted-foreground">{plan.contextSummary}</p>}
    <div className="space-y-1">
      {plan.steps.map((step) => <label key={step.stepId} className="flex cursor-pointer gap-1.5 rounded-sm border border-border bg-background/70 p-1.5 text-[9px]">
        <input type="checkbox" className="mt-0.5 accent-blue-600" checked={selected.has(step.stepId)} onChange={(event) => onToggle(step.stepId, event.target.checked)} aria-label={`允许 ${step.title}`} />
        <span className="min-w-0"><strong className="font-medium">{step.title}</strong><span className="ml-1 text-muted-foreground">最多 {Math.ceil(step.maxOutputBytes / 1024)} KiB</span><span className="mt-0.5 block leading-4 text-muted-foreground">读取：{step.readScope}<br />敏感信息：{step.sensitiveData}</span></span>
      </label>)}
    </div>
    <p className="text-[8px] leading-3.5 text-amber-700 dark:text-amber-300">远程内容只作为不可信证据；此项授权只允许当前计划的只读检查，不会发送到模型或执行修复。</p>
    <div className="flex justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={working} onClick={onCancel}>取消计划</Button>
      <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={working || selected.size === 0} onClick={onStart}><Activity size={10} />开始只读检查</Button>
    </div>
  </div>;
}
