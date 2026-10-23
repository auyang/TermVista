import { Channel } from "@tauri-apps/api/core";
import { approveDiagnosticPlan, approveDiagnosticShare, cancelDiagnostic, generateDiagnosticReport, getDiagnosticRun, reviseDiagnosticPlan, startDiagnostic } from "@/features/diagnostics/diagnosticBridge";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useAiStore } from "@/features/ai/aiStore";
import type { AiStreamEvent } from "@/features/ai/aiTypes";
import type { DiagnosticEvent, DiagnosticPlanPreview, DiagnosticReportPreview, DiagnosticRunSummary } from "@/features/diagnostics/diagnosticTypes";

const activeChannels = new Map<string, Channel<DiagnosticEvent>>();
const reportChannels = new Map<string, Channel<AiStreamEvent>>();

export async function approveAndStartDiagnostic(
  initialPlan: DiagnosticPlanPreview,
  selectedStepIds: string[],
): Promise<string> {
  const selected = new Set(selectedStepIds);
  const currentlySelected = initialPlan.steps.filter((step) => step.enabled).map((step) => step.stepId);
  let plan = initialPlan;
  if (currentlySelected.length !== selected.size || currentlySelected.some((id) => !selected.has(id))) {
    plan = await reviseDiagnosticPlan(initialPlan.planId, initialPlan.revision, selectedStepIds);
    useDiagnosticStore.getState().setPlan(plan);
  }
  const grant = await approveDiagnosticPlan(plan, plan.steps.filter((step) => step.enabled).map((step) => step.stepId));

  let acceptedRunId = "";
  const earlyEvents: DiagnosticEvent[] = [];
  const channel = new Channel<DiagnosticEvent>();
  channel.onmessage = (event) => {
    if (!acceptedRunId) {
      earlyEvents.push(event);
      return;
    }
    applyEvent(event, acceptedRunId, plan.sessionId);
  };
  const runId = await startDiagnostic(plan.planId, grant.grantId, channel);
  acceptedRunId = runId;
  activeChannels.set(runId, channel);
  useDiagnosticStore.getState().setActiveRun(plan.sessionId, runId);
  const queued: DiagnosticRunSummary = {
    runId,
    sessionId: plan.sessionId,
    host: plan.host,
    port: plan.port,
    username: plan.username,
    fingerprintSha256: plan.fingerprintSha256,
    status: "queued",
    createdAt: new Date().toISOString(),
    evidence: [],
  };
  useDiagnosticStore.getState().setRun(queued);
  for (const event of earlyEvents) applyEvent(event, runId, plan.sessionId);
  void refreshRun(runId, plan.sessionId);
  return runId;
}

export async function cancelRunningDiagnostic(runId: string, sessionId: string) {
  return cancelDiagnostic(runId, sessionId);
}

export async function approveAndStartDiagnosticReport(preview: DiagnosticReportPreview): Promise<string> {
  const grant = await approveDiagnosticShare(preview);
  let acceptedRequestId = "";
  const earlyEvents: AiStreamEvent[] = [];
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = (event) => {
    if (!acceptedRequestId) {
      earlyEvents.push(event);
      return;
    }
    applyAiEvent(event, preview.sessionId, acceptedRequestId);
  };
  const accepted = await generateDiagnosticReport(grant.shareGrantId, channel);
  acceptedRequestId = accepted.requestId;
  reportChannels.set(acceptedRequestId, channel);
  useAiStore.getState().beginStream(preview.sessionId, acceptedRequestId, `分析 ${preview.host} 的只读 SSH 诊断结果`, "diagnose");
  for (const event of earlyEvents) applyAiEvent(event, preview.sessionId, acceptedRequestId);
  return acceptedRequestId;
}

async function refreshRun(runId: string, sessionId: string) {
  try {
    const run = await getDiagnosticRun(runId, sessionId);
    if (useDiagnosticStore.getState().activeRunIds[sessionId] === runId) {
      useDiagnosticStore.getState().setRun(run);
      if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
        window.setTimeout(() => activeChannels.delete(runId), 30_000);
      }
    }
  } catch {
    // 标签关闭或 SSH 断开后，Rust 会回收当前会话的诊断记录。
  }
}

function applyEvent(event: DiagnosticEvent, runId: string, sessionId: string) {
  if (event.runId !== runId || event.sessionId !== sessionId) return;
  useDiagnosticStore.getState().applyEvent(event);
  if (event.type === "step_finished" || event.type === "evidence_ready" || event.type === "run_status") {
    void refreshRun(runId, sessionId);
  }
}

function applyAiEvent(event: AiStreamEvent, sessionId: string, requestId: string) {
  if (event.sessionId !== sessionId || event.requestId !== requestId) return;
  const store = useAiStore.getState();
  if (event.type === "delta") store.applyDelta(event.sessionId, event.requestId, event.text);
  if (event.type === "usage") store.applyUsage(event.sessionId, event.requestId, event.inputTokens, event.outputTokens);
  if (event.type === "completed") {
    store.finishStream(event.sessionId, event.requestId, "complete", undefined, event.elapsedMs);
    window.setTimeout(() => reportChannels.delete(requestId), 30_000);
  }
  if (event.type === "cancelled") {
    store.finishStream(event.sessionId, event.requestId, "cancelled");
    window.setTimeout(() => reportChannels.delete(requestId), 30_000);
  }
  if (event.type === "error") {
    store.finishStream(event.sessionId, event.requestId, "error", event.message);
    window.setTimeout(() => reportChannels.delete(requestId), 30_000);
  }
}
