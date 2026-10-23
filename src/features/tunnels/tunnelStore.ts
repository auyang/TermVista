import { create } from "zustand";
import type { ForwardRuntime } from "./tunnelTypes";

type TunnelStore = {
  runtimes: Record<string, ForwardRuntime>;
  replaceRuntimes: (runtimes: ForwardRuntime[]) => void;
  applyRuntime: (runtime: ForwardRuntime) => void;
  clearRuntime: (ruleId: string) => void;
};

export const useTunnelStore = create<TunnelStore>((set) => ({
  runtimes: {},
  replaceRuntimes: (runtimes) => set({
    runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.ruleId, runtime])),
  }),
  applyRuntime: (runtime) => set((state) => ({
    runtimes: { ...state.runtimes, [runtime.ruleId]: runtime },
  })),
  clearRuntime: (ruleId) => set((state) => {
    const runtimes = { ...state.runtimes };
    delete runtimes[ruleId];
    return { runtimes };
  }),
}));
