import { useEffect, useMemo, useRef } from "react";
import { init, use as registerEChartsModules, type EChartsCoreOption } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { NetworkPoint } from "./monitorTypes";
import { formatNetworkRate, toNetworkSeries } from "./networkChartModel";

registerEChartsModules([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

type NetworkTrendChartProps = {
  history: NetworkPoint[];
  theme: "dark" | "light";
  metricState?: string;
  reason?: string | null;
  interfaceName: string;
};

export function NetworkTrendChart({ history, theme, metricState, reason, interfaceName }: NetworkTrendChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof init> | null>(null);
  const data = useMemo(() => toNetworkSeries(history), [history]);
  const hasValue = data.some((point) => point.received !== null || point.sent !== null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = init(host, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => chart.resize());
    });
    observer.observe(host);
    chart.resize();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const host = hostRef.current;
    if (!chart || !host) return;
    const styles = getComputedStyle(host);
    const textColor = styles.getPropertyValue("--muted-foreground").trim() || (theme === "dark" ? "#9ba9ba" : "#718096");
    const gridColor = styles.getPropertyValue("--app-border").trim() || (theme === "dark" ? "#29384a" : "#dbe3ec");
    const sendColor = styles.getPropertyValue("--monitor-send").trim() || "#f97316";
    const receiveColor = styles.getPropertyValue("--monitor-receive").trim() || "#22a06b";
    const times = data.map((point) => point.timestamp);
    const option: EChartsCoreOption = {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { color: textColor, fontFamily: "system-ui, sans-serif", fontSize: 9 },
      grid: { left: 38, right: 8, top: 8, bottom: 22 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: gridColor } },
        backgroundColor: theme === "dark" ? "#172232" : "#ffffff",
        borderColor: gridColor,
        textStyle: { color: textColor, fontSize: 10 },
        valueFormatter: (value: unknown) => typeof value === "number" ? formatNetworkRate(value) : "无采样值",
      },
      xAxis: {
        type: "time",
        min: times.length ? times[0] : undefined,
        max: times.length > 1 ? times[times.length - 1] : undefined,
        axisLabel: {
          hideOverlap: true,
          color: textColor,
          fontSize: 8,
          formatter: (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }),
        },
        axisLine: { lineStyle: { color: gridColor } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        scale: true,
        axisLabel: { color: textColor, fontSize: 8, formatter: (value: number) => formatNetworkRate(value) },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: gridColor, type: "dashed", opacity: 0.65 } },
      },
      series: [
        {
          name: "↓ 接收",
          type: "line",
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: receiveColor, width: 1.5 },
          itemStyle: { color: receiveColor },
          data: data.map((point) => [point.timestamp, point.received]),
        },
        {
          name: "↑ 发送",
          type: "line",
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: sendColor, width: 1.5 },
          itemStyle: { color: sendColor },
          data: data.map((point) => [point.timestamp, point.sent]),
        },
      ],
    };
    chart.setOption(option, { notMerge: true, lazyUpdate: true });
    chart.resize();
  }, [data, interfaceName, metricState, reason, theme]);

  const statusText = metricState === "stale"
    ? "数据已过期，曲线仅保留最近的有效采样。"
    : metricState === "error" || metricState === "unsupported"
      ? reason ?? "当前无法读取网卡速率。"
      : !hasValue
        ? "等待有效网卡采样。"
        : null;

  return (
    <div className="relative h-[64px] w-full" aria-label={`${interfaceName} 服务器网络收发速率趋势`}>
      <div ref={hostRef} className="absolute inset-0" role="img" aria-label={`${interfaceName} 接收与发送速率，使用服务器真实采样时间`} />
      {statusText && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-panel/75 px-2 text-center text-[9px] text-muted-foreground">{statusText}</div>}
    </div>
  );
}
