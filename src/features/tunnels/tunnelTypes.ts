export type ForwardRule = {
  id: string;
  profileId: string;
  name: string;
  groupName: string;
  localHost: "127.0.0.1";
  localPort: number;
  targetHost: string;
  targetPort: number;
  createdAt: number;
  updatedAt: number;
};

export type Socks5Rule = {
  id: string;
  profileId: string;
  name: string;
  groupName: string;
  localHost: "127.0.0.1";
  localPort: number;
  createdAt: number;
  updatedAt: number;
};

export type TunnelState = "stopped" | "starting" | "running" | "stopping" | "error";

export type ForwardRuntime = {
  ruleId: string;
  profileId: string;
  sessionId: string | null;
  state: TunnelState;
  localAddress: string | null;
  activeConnections: number;
  bytesFromLocal: string;
  bytesToLocal: string;
  bytesPerSecondFromLocal: number;
  bytesPerSecondToLocal: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: number;
};

export type Socks5Runtime = Omit<ForwardRuntime, "bytesFromLocal" | "bytesToLocal">;

export type TunnelEvent = {
  id: string;
  ruleId: string;
  profileId: string;
  protocol: "local_tcp" | "socks5";
  occurredAt: number;
  code: string;
  message: string;
};

export type TcpCheckResult = {
  ruleId: string;
  profileId: string;
  sessionId: string;
  targetHost: string;
  targetPort: number;
  reachable: boolean;
  elapsedMs: number | null;
  checkedAt: number;
  errorCode: string | null;
};

export type TunnelRulesImportResult = { imported: number; skipped: number };
