export type MetricState = "pending" | "fresh" | "stale" | "error" | "unsupported";

export type Monitored<T> = {
  state: MetricState;
  value: T | null;
  sampledAt: string | null;
  reason: string | null;
};

export type HostMetric = {
  hostname: string;
  displayIp: string;
  uptimeSeconds: number;
  load1: number;
  load5: number;
  load15: number;
};

export type CpuMetric = { busyPercent: number };

export type MemoryMetric = {
  totalBytes: string;
  availableBytes: string;
  usedPercent: number;
  swapTotalBytes: string;
  swapFreeBytes: string;
  swapUsedPercent: number | null;
};

export type ProcessMetric = {
  pid: number;
  command: string;
  cpuPercent: number;
  rssBytes: string;
};

export type NetworkInterfaceMetric = {
  name: string;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
};

export type NetworkMetric = {
  interfaces: NetworkInterfaceMetric[];
  selectedInterface: string | null;
};

export type LatencyMetric = {
  sshRoundTripMs: number;
  kind: "ssh-exec-round-trip";
};

export type DiskMetric = {
  filesystem: string;
  mountPoint: string;
  totalBytes: string;
  availableBytes: string;
};

export type MonitorSnapshot = {
  sessionId: string;
  sequence: number;
  collectedAt: string;
  host: Monitored<HostMetric>;
  cpu: Monitored<CpuMetric>;
  memory: Monitored<MemoryMetric>;
  processes: Monitored<ProcessMetric[]>;
  network: Monitored<NetworkMetric>;
  latency: Monitored<LatencyMetric>;
  disks: Monitored<DiskMetric[]>;
};

export type MonitorEvent =
  | { type: "snapshot"; subscriptionId: string; data: MonitorSnapshot }
  | {
      type: "status";
      subscriptionId: string;
      sessionId: string;
      status: "started" | "stopped" | "disconnected" | "unsupported";
      message?: string | null;
    };

export type MonitorSubscriptionId = { subscriptionId: string };

export type NetworkPoint = { sampledAt: string; rx: number; tx: number };
