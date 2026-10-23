import assert from "node:assert/strict";
import test from "node:test";
import { toNetworkSeries, formatNetworkRate } from "../src/features/monitor/networkChartModel.ts";

test("网络曲线按真实采样时间保留接收与发送方向", () => {
  const points = toNetworkSeries([
    { sampledAt: "2026-10-23T08:00:00.000Z", rx: 1024, tx: 2048 },
    { sampledAt: "2026-10-23T08:00:03.500Z", rx: 4096, tx: 8192 },
  ]);

  assert.deepEqual(points, [
    { timestamp: Date.parse("2026-10-23T08:00:00.000Z"), received: 1024, sent: 2048 },
    { timestamp: Date.parse("2026-10-23T08:00:03.500Z"), received: 4096, sent: 8192 },
  ]);
});

test("计数器重置和缺失值以断点表示，不绘制假零值或尖峰", () => {
  const points = toNetworkSeries([
    { sampledAt: "2026-10-23T08:00:00.000Z", rx: 32, tx: 64 },
    { sampledAt: "2026-10-23T08:00:02.000Z", rx: null, tx: -1 },
    { sampledAt: "invalid-time", rx: 100, tx: 100 },
  ]);

  assert.equal(points.length, 2);
  assert.equal(points[0].received, 32);
  assert.equal(points[1].received, null);
  assert.equal(points[1].sent, null);
});

test("速率轴使用可读单位", () => {
  assert.equal(formatNetworkRate(100), "100 B/s");
  assert.equal(formatNetworkRate(1536), "1.5 KB/s");
  assert.equal(formatNetworkRate(Number.NaN), "—");
});
