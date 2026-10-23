import { create } from "zustand";
import type { MonitorEvent, MonitorSnapshot, Monitored, NetworkPoint } from "@/features/monitor/monitorTypes";

type MonitorSessionContext = {
  subscriptionId?: string;
  snapshot?: MonitorSnapshot;
  status: "idle" | "started" | "stopped" | "disconnected" | "unsupported";
  message?: string;
  selectedInterface?: string;
  networkHistory: Record<string, NetworkPoint[]>;
  latencyHistory: number[];
};

type MonitorStore = {
  sessions: Record<string, MonitorSessionContext>;
  setSubscription: (sessionId: string, subscriptionId: string) => void;
  applySnapshot: (sessionId: string, subscriptionId: string, snapshot: MonitorSnapshot) => void;
  applyEvent: (sessionId: string, event: MonitorEvent) => void;
  setNetworkInterface: (sessionId: string, name: string) => void;
  markDisconnected: (sessionId: string, message?: string) => void;
  clearSession: (sessionId: string) => void;
};

const emptyContext = (): MonitorSessionContext => ({
  status: "idle",
  networkHistory: {},
  latencyHistory: [],
});

function markStale<T>(metric: Monitored<T>, reason: string): Monitored<T> {
  return { ...metric, state: metric.value === null ? "error" : "stale", reason };
}

function markSnapshotStale(snapshot: MonitorSnapshot, reason: string): MonitorSnapshot {
  return {
    ...snapshot,
    host: markStale(snapshot.host, reason),
    cpu: markStale(snapshot.cpu, reason),
    memory: markStale(snapshot.memory, reason),
    processes: markStale(snapshot.processes, reason),
    network: markStale(snapshot.network, reason),
    latency: markStale(snapshot.latency, reason),
    disks: markStale(snapshot.disks, reason),
  };
}

function withSnapshot(
  context: MonitorSessionContext,
  snapshot: MonitorSnapshot,
  subscriptionId: string,
): MonitorSessionContext {
  if (context.subscriptionId !== subscriptionId || snapshot.sequence <= (context.snapshot?.sequence ?? -1)) {
    return context;
  }

  const network = snapshot.network.value;
  const selectedInterface =
    context.selectedInterface && network?.interfaces.some((item) => item.name === context.selectedInterface)
      ? context.selectedInterface
      : network?.selectedInterface ?? network?.interfaces[0]?.name;
  const chosen = network?.interfaces.find((item) => item.name === selectedInterface);
  let networkHistory = context.networkHistory;
  if (selectedInterface && snapshot.network.state !== "pending") {
    const history = networkHistory[selectedInterface] ?? [];
    const safeRate = (value: number | null | undefined) =>
      value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
    networkHistory = {
      ...networkHistory,
      [selectedInterface]: [
        ...history,
        {
          sampledAt: snapshot.collectedAt,
          rx: chosen ? safeRate(chosen.rxBytesPerSec) : null,
          tx: chosen ? safeRate(chosen.txBytesPerSec) : null,
        },
      ].slice(-36),
    };
  }

  const latencyHistory = snapshot.latency.value
    ? [...context.latencyHistory, snapshot.latency.value.sshRoundTripMs].slice(-36)
    : context.latencyHistory;

  return { ...context, snapshot, selectedInterface, networkHistory, latencyHistory };
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  sessions: {},
  setSubscription: (sessionId, subscriptionId) => set((state) => {
    const context = state.sessions[sessionId] ?? emptyContext();
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...context, subscriptionId, status: "started", message: undefined },
      },
    };
  }),
  applySnapshot: (sessionId, subscriptionId, snapshot) => set((state) => {
    if (snapshot.sessionId !== sessionId) return state;
    const context = state.sessions[sessionId] ?? emptyContext();
    if (context.subscriptionId !== subscriptionId) return state;
    const updated = withSnapshot(context, snapshot, subscriptionId);
    return updated === context ? state : { sessions: { ...state.sessions, [sessionId]: updated } };
  }),
  applyEvent: (sessionId, event) => set((state) => {
    const context = state.sessions[sessionId] ?? emptyContext();
    if (context.subscriptionId && context.subscriptionId !== event.subscriptionId) return state;
    if (event.type === "snapshot") {
      if (event.data.sessionId !== sessionId) return state;
      const updated = withSnapshot(context, event.data, event.subscriptionId);
      return updated === context ? state : { sessions: { ...state.sessions, [sessionId]: updated } };
    }
    if (event.sessionId !== sessionId) return state;
    const next = { ...context, status: event.status, message: event.message ?? undefined };
    if (event.status === "disconnected" || event.status === "stopped") {
      if (next.snapshot) next.snapshot = markSnapshotStale(next.snapshot, event.message ?? "监控已停止。");
    }
    return { sessions: { ...state.sessions, [sessionId]: next } };
  }),
  setNetworkInterface: (sessionId, name) => set((state) => {
    const context = state.sessions[sessionId] ?? emptyContext();
    if (context.selectedInterface === name) return state;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...context,
          selectedInterface: name,
          networkHistory: { ...context.networkHistory, [name]: [] },
        },
      },
    };
  }),
  markDisconnected: (sessionId, message) => set((state) => {
    const context = state.sessions[sessionId];
    if (!context) return state;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...context,
          status: "disconnected",
          message,
          snapshot: context.snapshot
            ? markSnapshotStale(context.snapshot, message ?? "SSH 会话已断开。")
            : undefined,
        },
      },
    };
  }),
  clearSession: (sessionId) => set((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
}));
