import { create } from "zustand";
import type {
  DiagnosticEvent,
  DiagnosticPlanPreview,
  DiagnosticRunSummary,
  DiagnosticSelectedContext,
} from "@/features/diagnostics/diagnosticTypes";

type PendingDiagnosticContext = { sessionId: string; context: DiagnosticSelectedContext };

type DiagnosticState = {
  plans: Record<string, DiagnosticPlanPreview>;
  runs: Record<string, DiagnosticRunSummary>;
  activeRunIds: Record<string, string>;
  pendingContext: PendingDiagnosticContext | null;
  setPlan: (plan: DiagnosticPlanPreview | null, sessionId?: string) => void;
  setRun: (run: DiagnosticRunSummary) => void;
  setActiveRun: (sessionId: string, runId: string) => void;
  setPendingContext: (pending: PendingDiagnosticContext | null) => void;
  applyEvent: (event: DiagnosticEvent) => void;
  clearSession: (sessionId: string) => void;
};

export const useDiagnosticStore = create<DiagnosticState>((set) => ({
  plans: {},
  runs: {},
  activeRunIds: {},
  pendingContext: null,
  setPlan: (plan, sessionId) => set((state) => ({
    plans: plan
      ? { ...state.plans, [plan.sessionId]: plan }
      : Object.fromEntries(Object.entries(state.plans).filter(([id]) => id !== sessionId)),
  })),
  setRun: (run) => set((state) => ({ runs: { ...state.runs, [run.sessionId]: run } })),
  setActiveRun: (sessionId, runId) => set((state) => ({ activeRunIds: { ...state.activeRunIds, [sessionId]: runId } })),
  setPendingContext: (pendingContext) => set({ pendingContext }),
  applyEvent: (event) => set((state) => {
    const run = state.runs[event.sessionId];
    if (!run || run.runId !== event.runId) return state;
    if (event.type === "run_status") {
      return { runs: { ...state.runs, [event.sessionId]: { ...run, status: event.status } } };
    }
    return state;
  }),
  clearSession: (sessionId) => set((state) => ({
    plans: Object.fromEntries(Object.entries(state.plans).filter(([id]) => id !== sessionId)),
    runs: Object.fromEntries(Object.entries(state.runs).filter(([id]) => id !== sessionId)),
    activeRunIds: Object.fromEntries(Object.entries(state.activeRunIds).filter(([id]) => id !== sessionId)),
  })),
}));
