import { create } from "zustand";

export type UpdateMaintenanceTask = {
  id: string;
  label: MaintenanceTaskKey;
  startedAt: number;
};

export type MaintenanceTaskKey =
  | "sftpCreateDirectory" | "sftpRename" | "sftpDelete" | "sftpTransfer"
  | "aiTestProvider" | "aiReadModels" | "vaultUpdate"
  | "sshKeyGenerate" | "sshKeyImport" | "sshKeyExport" | "sshKeyDelete"
  | "tunnelSave" | "tunnelDelete" | "tunnelStart" | "tunnelStop"
  | "socks5Save" | "socks5Delete" | "socks5Start" | "socks5Stop";

type UpdateMaintenanceTaskState = {
  tasks: UpdateMaintenanceTask[];
  begin: (task: UpdateMaintenanceTask) => void;
  finish: (taskId: string) => void;
};

export const useUpdateMaintenanceTaskStore = create<UpdateMaintenanceTaskState>((set) => ({
  tasks: [],
  begin: (task) => set((state) => ({ tasks: [...state.tasks, task] })),
  finish: (taskId) => set((state) => ({
    tasks: state.tasks.filter((task) => task.id !== taskId),
  })),
}));

let nextTaskId = 0;

export async function runWithUpdateMaintenanceTask<T>(
  label: MaintenanceTaskKey,
  operation: () => Promise<T>,
): Promise<T> {
  nextTaskId += 1;
  const taskId = "maintenance-" + String(nextTaskId);
  const store = useUpdateMaintenanceTaskStore.getState();
  store.begin({ id: taskId, label, startedAt: Date.now() });
  try {
    return await operation();
  } finally {
    useUpdateMaintenanceTaskStore.getState().finish(taskId);
  }
}
