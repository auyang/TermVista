export type ForwardRule = {
  id: string;
  profileId: string;
  name: string;
  localHost: "127.0.0.1";
  localPort: number;
  targetHost: string;
  targetPort: number;
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
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: number;
};
