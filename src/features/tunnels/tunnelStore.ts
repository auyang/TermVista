import { create } from "zustand";
import type { ForwardRuntime, Socks5Runtime } from "./tunnelTypes";

type TunnelStore = {
  runtimes: Record<string, ForwardRuntime>;
  socks5Runtimes: Record<string, Socks5Runtime>;
  replaceRuntimes: (runtimes: ForwardRuntime[]) => void;
  applyRuntime: (runtime: ForwardRuntime) => void;
  clearRuntime: (ruleId: string) => void;
  replaceSocks5Runtimes: (runtimes: Socks5Runtime[]) => void;
  applySocks5Runtime: (runtime: Socks5Runtime) => void;
  clearSocks5Runtime: (ruleId: string) => void;
};

export const useTunnelStore = create<TunnelStore>((set) => ({
  runtimes: {},
  socks5Runtimes: {},
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
  replaceSocks5Runtimes: (runtimes) => set({
    socks5Runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.ruleId, runtime])),
  }),
  applySocks5Runtime: (runtime) => set((state) => ({
    socks5Runtimes: { ...state.socks5Runtimes, [runtime.ruleId]: runtime },
  })),
  clearSocks5Runtime: (ruleId) => set((state) => {
    const socks5Runtimes = { ...state.socks5Runtimes };
    delete socks5Runtimes[ruleId];
    return { socks5Runtimes };
  }),
}));
