import { create } from "zustand";

export type UpdateMaintenanceTask = {
  id: string;
  label: string;
  startedAt: number;
};

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
  label: string,
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
