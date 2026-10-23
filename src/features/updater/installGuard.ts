import { useAiStore } from "@/features/ai/aiStore";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useSftpSessionStore } from "@/stores/sftpSessionStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useTunnelStore } from "@/features/tunnels/tunnelStore";
import { useUpdateMaintenanceTaskStore } from "./maintenanceTasks";

export type UpdateInstallGuard = {
  blockers: string[];
  activeSshSessions: number;
  activeTunnels: number;
};

export function inspectUpdateInstallGuard(): UpdateInstallGuard {
  const blockers: string[] = [];

  const dirtyDocuments = useEditorStore.getState().documents.filter((document) => document.dirty);
  if (dirtyDocuments.length > 0) {
    blockers.push("有 " + dirtyDocuments.length + " 个未保存的远程文件，请先保存或取消更新。");
  }

  const activeTransfers = Object.values(useSftpSessionStore.getState().contexts)
    .flatMap((context) => context.transfers)
    .filter((transfer) => ["queued", "running", "awaitingConflict"].includes(transfer.status));
  if (activeTransfers.length > 0) {
    blockers.push("有 " + activeTransfers.length + " 个 SFTP 传输任务未结束，请等待完成或取消。");
  }

  const activeDiagnostics = Object.values(useDiagnosticStore.getState().runs)
    .filter((run) => run.status === "queued" || run.status === "running");
  if (activeDiagnostics.length > 0) {
    blockers.push("有 " + activeDiagnostics.length + " 个服务器诊断任务正在运行。");
  }

  const activeAiRequests = Object.keys(useAiStore.getState().activeRequests).length;
  if (activeAiRequests > 0) {
    blockers.push("有 " + activeAiRequests + " 个 AI 请求正在生成。");
  }

  const maintenanceTasks = useUpdateMaintenanceTaskStore.getState().tasks;
  if (maintenanceTasks.length > 0) {
    const labels = [...new Set(maintenanceTasks.map((task) => task.label))].join("、");
    blockers.push("正在执行本机或远程操作：" + labels + "。");
  }

  if (useSettingsStore.getState().savingSection !== null) {
    blockers.push("应用设置正在保存，请稍后再安装更新。");
  }

  const sshSessions = Object.values(useSshSessionStore.getState().sessions);
  const connectingStates = new Set(["connecting", "verifyingHostKey", "authenticating", "openingPty", "disconnecting"]);
  const pendingSsh = sshSessions.filter((session) => connectingStates.has(session.state));
  const hasPendingPrompt = useSshSessionStore.getState().connectingProfile !== null
    || useSshSessionStore.getState().hostKeyChallenges.length > 0
    || useSshSessionStore.getState().authPrompts.length > 0;
  if (pendingSsh.length > 0 || hasPendingPrompt) {
    blockers.push("SSH 连接、认证或断开操作尚未完成。");
  }

  const tunnelRuntimes = Object.values(useTunnelStore.getState().runtimes);
  const changingTunnels = tunnelRuntimes.filter((runtime) => runtime.state === "starting" || runtime.state === "stopping");
  if (changingTunnels.length > 0) {
    blockers.push("端口转发正在启动或停止，请稍后再安装。");
  }

  return {
    blockers,
    activeSshSessions: sshSessions.filter((session) => session.state === "connected").length,
    activeTunnels: tunnelRuntimes.filter((runtime) => runtime.state === "running").length,
  };
}
