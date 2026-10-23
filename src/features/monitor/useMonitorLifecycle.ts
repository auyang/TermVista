import { useEffect } from "react";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useMonitorStore } from "@/features/monitor/monitorStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  monitoredSessionIds,
  setActiveMonitorSession,
  startMonitoring,
  stopMonitoring,
} from "@/features/monitor/monitorBridge";

export function useMonitorLifecycle(activeSessionId: string | null) {
  const monitorEnabled = useSettingsStore((state) => state.settings.monitoring.enabled);
  const sshSessions = useSshSessionStore((state) => state.sessions);
  const connectedSessionIds = monitorEnabled ? Object.values(sshSessions)
    .filter((session) => session.state === "connected" && session.sessionId)
    .map((session) => session.sessionId as string)
    .sort() : [];
  const connectedKey = connectedSessionIds.join("|");

  useEffect(() => {
    const sessionIds = connectedKey ? connectedKey.split("|") : [];
    const desired = new Set(sessionIds);
    for (const sessionId of monitoredSessionIds()) {
      if (!desired.has(sessionId)) {
        useMonitorStore.getState().markDisconnected(sessionId, "SSH 会话已断开，监控数据已过期。");
        void stopMonitoring(sessionId);
      }
    }
    for (const sessionId of sessionIds) {
      void startMonitoring(sessionId).catch((error: unknown) => {
        useMonitorStore.getState().markDisconnected(
          sessionId,
          error instanceof Error ? error.message : "无法启动服务器监控。",
        );
      });
    }
  }, [connectedKey, monitorEnabled]);

  useEffect(() => {
    const currentSessionIds = connectedKey ? connectedKey.split("|") : [];
    const isConnected = activeSessionId !== null && currentSessionIds.includes(activeSessionId);
    let current = true;
    if (!isConnected || !activeSessionId) {
      void setActiveMonitorSession(null).catch(() => undefined);
      return () => { current = false; };
    }

    void startMonitoring(activeSessionId)
      .then(async () => {
        if (current) await setActiveMonitorSession(activeSessionId);
      })
      .catch(() => {
        if (current) void setActiveMonitorSession(null).catch(() => undefined);
      });
    return () => { current = false; };
  }, [activeSessionId, connectedKey, monitorEnabled]);

  useEffect(() => () => {
    for (const sessionId of monitoredSessionIds()) void stopMonitoring(sessionId);
  }, []);
}
