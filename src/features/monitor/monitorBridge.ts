import { Channel, invoke } from "@tauri-apps/api/core";
import type { MonitorEvent, MonitorSnapshot, MonitorSubscriptionId } from "@/features/monitor/monitorTypes";
import { useMonitorStore } from "@/features/monitor/monitorStore";

type MonitorChannel = {
  channel: Channel<MonitorEvent>;
  subscriptionId?: string;
  pending: MonitorEvent[];
  start: Promise<string>;
};

const channels = new Map<string, MonitorChannel>();

export async function startMonitoring(sessionId: string): Promise<string> {
  const existing = channels.get(sessionId);
  if (existing) return existing.start;

  const entry: MonitorChannel = {
    channel: new Channel<MonitorEvent>(),
    pending: [],
    start: Promise.resolve(""),
  };
  entry.channel.onmessage = (event) => {
    if (!entry.subscriptionId) {
      entry.pending.push(event);
      return;
    }
    useMonitorStore.getState().applyEvent(sessionId, event);
  };
  channels.set(sessionId, entry);

  entry.start = invoke<MonitorSubscriptionId>("monitor_start", { sessionId, onUpdate: entry.channel })
    .then(async ({ subscriptionId }) => {
      entry.subscriptionId = subscriptionId;
      useMonitorStore.getState().setSubscription(sessionId, subscriptionId);
      for (const event of entry.pending.splice(0)) {
        useMonitorStore.getState().applyEvent(sessionId, event);
      }
      const snapshot = await invoke<MonitorSnapshot | null>("monitor_snapshot", { sessionId });
      if (snapshot) useMonitorStore.getState().applySnapshot(sessionId, subscriptionId, snapshot);
      return subscriptionId;
    })
    .catch((error: unknown) => {
      if (channels.get(sessionId) === entry) channels.delete(sessionId);
      throw error;
    });
  return entry.start;
}

export async function setActiveMonitorSession(sessionId: string | null) {
  await invoke<void>("monitor_set_active", { sessionId });
}

export async function stopMonitoring(sessionId: string) {
  const entry = channels.get(sessionId);
  if (!entry) return;
  channels.delete(sessionId);
  try {
    const subscriptionId = entry.subscriptionId ?? await entry.start;
    await invoke<void>("monitor_stop", { subscriptionId });
  } catch {
    useMonitorStore.getState().markDisconnected(sessionId, "监控订阅已结束。");
  }
}

export function monitoredSessionIds() {
  return [...channels.keys()];
}
