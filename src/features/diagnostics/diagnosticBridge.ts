import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiStreamEvent } from "@/features/ai/aiTypes";
import type {
  DiagnosticEvent,
  DiagnosticGrantSummary,
  DiagnosticPlanCreateRequest,
  DiagnosticPlanPreview,
  DiagnosticReportPreview,
  DiagnosticRunSummary,
  DiagnosticShareGrantSummary,
  DiagnosticTemplateDescriptor,
} from "@/features/diagnostics/diagnosticTypes";

export function listDiagnosticTemplates() {
  return invoke<DiagnosticTemplateDescriptor[]>("diagnostic_templates_list");
}

export function createDiagnosticPlan(request: DiagnosticPlanCreateRequest) {
  return invoke<DiagnosticPlanPreview>("diagnostic_plan_create", { request });
}

export function reviseDiagnosticPlan(planId: string, revision: number, selectedStepIds: string[]) {
  return invoke<DiagnosticPlanPreview>("diagnostic_plan_revise", {
    request: { planId, revision, selectedStepIds },
  });
}

export function approveDiagnosticPlan(plan: DiagnosticPlanPreview, selectedStepIds: string[]) {
  return invoke<DiagnosticGrantSummary>("diagnostic_plan_approve", {
    request: {
      planId: plan.planId,
      revision: plan.revision,
      displayedHash: plan.planHash,
      selectedStepIds,
    },
  });
}

export function startDiagnostic(planId: string, grantId: string, onEvent: Channel<DiagnosticEvent>) {
  return invoke<string>("diagnostic_start", { planId, grantId, onEvent });
}

export function cancelDiagnostic(runId: string, sessionId: string) {
  return invoke<boolean>("diagnostic_cancel", { runId, sessionId });
}

export function getDiagnosticRun(runId: string, sessionId: string) {
  return invoke<DiagnosticRunSummary>("diagnostic_run_get", { runId, sessionId });
}

export function previewDiagnosticReport(runId: string, sessionId: string, providerId: string, evidenceIds: string[], uiLanguage: string) {
  return invoke<DiagnosticReportPreview>("diagnostic_report_preview", { runId, sessionId, providerId, evidenceIds, uiLanguage });
}

export function approveDiagnosticShare(preview: DiagnosticReportPreview) {
  return invoke<DiagnosticShareGrantSummary>("diagnostic_share_approve", {
    request: {
      previewId: preview.previewId,
      runId: preview.runId,
      evidenceIds: preview.evidence.map((item) => item.evidenceId),
      previewHash: preview.previewHash,
      providerId: preview.providerId,
    },
  });
}

export function generateDiagnosticReport(shareGrantId: string, onEvent: Channel<AiStreamEvent>) {
  return invoke<{ requestId: string }>("diagnostic_report_generate", { shareGrantId, onEvent });
}
