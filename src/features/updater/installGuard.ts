import { useAiStore } from "@/features/ai/aiStore";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useSftpSessionStore } from "@/stores/sftpSessionStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useTunnelStore } from "@/features/tunnels/tunnelStore";
import { useUpdateMaintenanceTaskStore } from "./maintenanceTasks";

export type UpdateInstallGuard = {
  blockers: { key: string; count?: number; labels?: string[] }[];
  activeSshSessions: number;
  activeTunnels: number;
};

export function inspectUpdateInstallGuard(): UpdateInstallGuard {
  const blockers: UpdateInstallGuard["blockers"] = [];

  const dirtyDocuments = useEditorStore.getState().documents.filter((document) => document.dirty);
  if (dirtyDocuments.length > 0) {
    blockers.push({ key: "dirtyDocuments", count: dirtyDocuments.length });
  }

  const activeTransfers = Object.values(useSftpSessionStore.getState().contexts)
    .flatMap((context) => context.transfers)
    .filter((transfer) => ["queued", "running", "awaitingConflict"].includes(transfer.status));
  if (activeTransfers.length > 0) {
    blockers.push({ key: "activeTransfers", count: activeTransfers.length });
  }

  const activeDiagnostics = Object.values(useDiagnosticStore.getState().runs)
    .filter((run) => run.status === "queued" || run.status === "running");
  if (activeDiagnostics.length > 0) {
    blockers.push({ key: "activeDiagnostics", count: activeDiagnostics.length });
  }

  const activeAiRequests = Object.keys(useAiStore.getState().activeRequests).length;
  if (activeAiRequests > 0) {
    blockers.push({ key: "activeAiRequests", count: activeAiRequests });
  }

  const maintenanceTasks = useUpdateMaintenanceTaskStore.getState().tasks;
  if (maintenanceTasks.length > 0) {
    const labels = [...new Set(maintenanceTasks.map((task) => task.label))];
    blockers.push({ key: "maintenanceTasks", labels });
  }

  if (useSettingsStore.getState().savingSection !== null) {
    blockers.push({ key: "savingSettings" });
  }

  const sshSessions = Object.values(useSshSessionStore.getState().sessions);
  const connectingStates = new Set(["connecting", "verifyingHostKey", "authenticating", "openingPty", "disconnecting"]);
  const pendingSsh = sshSessions.filter((session) => connectingStates.has(session.state));
  const hasPendingPrompt = useSshSessionStore.getState().connectingProfile !== null
    || useSshSessionStore.getState().hostKeyChallenges.length > 0
    || useSshSessionStore.getState().authPrompts.length > 0;
  if (pendingSsh.length > 0 || hasPendingPrompt) {
    blockers.push({ key: "pendingSsh" });
  }

  const tunnelRuntimes = Object.values(useTunnelStore.getState().runtimes);
  const changingTunnels = tunnelRuntimes.filter((runtime) => runtime.state === "starting" || runtime.state === "stopping");
  if (changingTunnels.length > 0) {
    blockers.push({ key: "changingTunnels" });
  }

  return {
    blockers,
    activeSshSessions: sshSessions.filter((session) => session.state === "connected").length,
    activeTunnels: tunnelRuntimes.filter((runtime) => runtime.state === "running").length,
  };
}
