import type { NetworkPoint } from "./monitorTypes";

export type NetworkSeriesPoint = [timestamp: number, value: number | null];

export function toNetworkSeries(history: NetworkPoint[]) {
  return history.flatMap((point) => {
    const timestamp = Date.parse(point.sampledAt);
    if (!Number.isFinite(timestamp)) return [];
    const safeRate = (value: number | null) =>
      value !== null && Number.isFinite(value) && value >= 0 ? value : null;
    return [{
      timestamp,
      received: safeRate(point.rx),
      sent: safeRate(point.tx),
    }];
  });
}

export function formatNetworkRate(value: number) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let display = Math.max(0, value);
  let unit = 0;
  while (display >= 1024 && unit < units.length - 1) {
    display /= 1024;
    unit += 1;
  }
  return `${display.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
