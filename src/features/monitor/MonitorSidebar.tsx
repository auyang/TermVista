import { useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronUp, CircleGauge, Copy, Cpu, HardDrive, Network, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import type { Monitored, ProcessMetric } from "@/features/monitor/monitorTypes";
import { useMonitorStore } from "@/features/monitor/monitorStore";
import { NetworkTrendChart } from "@/features/monitor/NetworkTrendChart";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

type MonitorSidebarProps = { collapsed: boolean; onToggle: () => void };
type ProcessSort = "memory" | "cpu" | "command";

export function MonitorSidebar({ collapsed, onToggle }: MonitorSidebarProps) {
  const activeTab = useWorkspaceStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const sshSession = useSshSessionStore((state) => activeTab ? state.sessions[activeTab.id] ?? null : null);
  const sessionId = sshSession?.sessionId;
  const monitor = useMonitorStore((state) => sessionId ? state.sessions[sessionId] : undefined);
  const theme = useWorkspaceStore((state) => state.theme);
  const snapshot = monitor?.snapshot;
  const [systemOpen, setSystemOpen] = useState(true);
  const [processSort, setProcessSort] = useState<ProcessSort>("memory");
  const [copied, setCopied] = useState(false);
  const connected = sshSession?.state === "connected" && Boolean(sessionId);
  const host = snapshot?.host.value;
  const displayIp = host?.displayIp ?? (connected ? sshSession?.profile.host : undefined);
  const memory = snapshot?.memory.value;
  const cpu = snapshot?.cpu.value;
  const swapPercent = memory?.swapUsedPercent ?? null;
  const network = snapshot?.network.value;
  const selectedInterface = monitor?.selectedInterface ?? network?.selectedInterface ?? network?.interfaces[0]?.name;
  const selectedNetwork = network?.interfaces.find((item) => item.name === selectedInterface);
  const networkHistory = selectedInterface ? monitor?.networkHistory[selectedInterface] ?? [] : [];
  const latencyHistory = monitor?.latencyHistory ?? [];
  const sortedProcesses = useMemo(() => {
    const items = [...(snapshot?.processes.value ?? [])];
    if (processSort === "cpu") return items.sort((a, b) => b.cpuPercent - a.cpuPercent);
    if (processSort === "command") return items.sort((a, b) => a.command.localeCompare(b.command));
    return items.sort((a, b) => BigInt(b.rssBytes) > BigInt(a.rssBytes) ? 1 : BigInt(b.rssBytes) < BigInt(a.rssBytes) ? -1 : 0);
  }, [processSort, snapshot?.processes.value]);

  const copyAddress = async () => {
    if (!displayIp) return;
    try {
      await navigator.clipboard?.writeText(displayIp);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const diagnoseMetric = (metric: "cpu" | "memory" | "disk" | "processes" | "network") => {
    if (!sessionId || !connected) return;
    useDiagnosticStore.getState().setPendingContext({ sessionId, context: { kind: "monitorMetric", metric } });
    useWorkspaceStore.getState().setAiOpen(true);
  };

  const monitorLabel = !connected
    ? "未连接"
    : monitor?.status === "unsupported"
      ? "不支持"
      : monitor?.status === "disconnected"
        ? "已断开"
        : monitor?.status === "started"
          ? "采样中"
          : "等待采样";
  const indicator = monitor?.status === "started" ? "bg-success" : connected ? "bg-warning" : "bg-muted-foreground/40";

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-panel" aria-label="服务器监控面板">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        {!collapsed && <div className="flex items-center gap-1.5">
          <RefreshCw size={12} className={connected ? "text-foreground" : "text-muted-foreground"} />
          <span className="font-medium">{connected ? "同步状态" : "监控状态"}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${indicator}`} aria-hidden="true" />
          <span className="text-[10px] text-muted-foreground">{monitorLabel}</span>
        </div>}
        <Button type="button" variant="ghost" size="icon" className={`h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground ${collapsed ? "mx-auto" : ""}`} aria-label={collapsed ? "展开监控面板" : "折叠监控面板"} title={collapsed ? "展开监控面板" : "折叠监控面板"} onClick={onToggle}>
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </Button>
      </header>
      {collapsed ? (
        <div className="flex flex-1 items-start justify-center pt-3"><span className="[writing-mode:vertical-rl] text-[10px] tracking-widest text-muted-foreground">监控</span></div>
      ) : (
        <div className="compact-scrollbar min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-border px-3 py-2" aria-label="主机信息">
            {connected ? <>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">{displayIp ? `IP ${displayIp}` : "SSH 主机"}</span>
                {displayIp && <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 rounded-sm px-1.5 text-[10px]" onClick={() => void copyAddress()} aria-label="复制 SSH 主机地址"><Copy size={10} />{copied ? "已复制" : "复制"}</Button>}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1 truncate"><Server size={11} />{host?.hostname ?? sshSession?.profile.name}</span>
                <span className="shrink-0">{sshSession?.state === "connected" ? "SSH 已连接" : "SSH 未连接"}</span>
              </div>
            </> : <div className="flex min-h-9 items-center gap-2 text-[11px] text-muted-foreground"><Server size={13} /><span>{activeTab?.mode === "demo" ? "演示标签未连接真实主机；无监控数据。" : "尚未连接；连接后显示主机地址。"}</span></div>}
          </section>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border" aria-label="系统信息">
            <button type="button" className="flex h-9 w-full items-center justify-between border-b border-border/70 bg-panel-header/55 px-3 text-left hover:bg-accent/5" aria-expanded={systemOpen} onClick={() => setSystemOpen((value) => !value)}>
              <span className="flex items-center gap-2 text-[12px] font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-sm bg-accent/10 text-accent"><Cpu size={12} /></span>系统信息</span>
              {systemOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {systemOpen && <div className="px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate">运行 {host ? formatUptime(host.uptimeSeconds) : metricText(snapshot?.host)}</span>
                <span className="truncate text-right text-muted-foreground">负载 {host ? `${host.load1.toFixed(2)}, ${host.load5.toFixed(2)}, ${host.load15.toFixed(2)}` : "—"}</span>
              </div>
              <ResourceBar label="CPU" value={cpu?.busyPercent ?? null} detail={metricSuffix(snapshot?.cpu)} tone="green" />
              <ResourceBar label="内存" value={memory?.usedPercent ?? null} detail={memory ? `${formatBytes((BigInt(memory.totalBytes) - BigInt(memory.availableBytes)).toString())}/${formatBytes(memory.totalBytes)}` : metricText(snapshot?.memory)} tone="orange" />
              <ResourceBar label="交换" value={swapPercent} detail={memory ? (BigInt(memory.swapTotalBytes) === 0n ? "未配置交换空间" : `${formatBytes((BigInt(memory.swapTotalBytes) - BigInt(memory.swapFreeBytes)).toString())}/${formatBytes(memory.swapTotalBytes)}`) : metricText(snapshot?.memory)} tone="gray" />
            </div>}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("cpu")}><Activity size={12} />诊断当前 CPU 与系统指标</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border px-3 py-2" aria-label="进程列表">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <SectionHeading icon={<Activity size={12} />} title="进程" />
              <div className="flex h-6 items-center rounded-sm border border-border bg-panel-header p-0.5" role="tablist" aria-label="进程排序维度">
                <MetricButton active={processSort === "memory"} onClick={() => setProcessSort("memory")}>内存</MetricButton>
                <MetricButton active={processSort === "cpu"} onClick={() => setProcessSort("cpu")}>CPU</MetricButton>
                <MetricButton active={processSort === "command"} onClick={() => setProcessSort("command")}>命令</MetricButton>
              </div>
            </div>
            {snapshot?.processes.sampledAt && <div className="-mt-1 mb-1 text-right text-[8px] text-muted-foreground" title={`进程数据采样时间：${snapshot.processes.sampledAt}`}>{formatSampleTime(snapshot.processes.sampledAt)}</div>}
            {snapshot?.processes.value ? <div className="overflow-hidden rounded-sm border border-border/70">
              <div className="grid h-6 grid-cols-[minmax(0,1fr)_52px_72px] items-center gap-2 bg-panel-header px-2 text-[10px] text-muted-foreground"><span>命令</span><span className="text-right">{processSort === "memory" ? "内存" : processSort === "cpu" ? "CPU" : "PID"}</span><span className="text-right">{processSort === "command" ? "CPU" : processSort === "memory" ? "CPU" : "内存"}</span></div>
              {sortedProcesses.slice(0, 6).map((process) => <ProcessRow key={process.pid} process={process} sort={processSort} />)}
              {sortedProcesses.length === 0 && <div className="px-2 py-2 text-[10px] text-muted-foreground">当前没有可显示的进程。</div>}
            </div> : <MetricPlaceholder metric={snapshot?.processes} fallback={connected ? "等待服务器进程采样…" : "连接后显示进程列表。"} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("processes")}><Activity size={12} />诊断当前进程列表</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border px-3 py-2" aria-label="网络流量">
            <div className="mb-1 flex items-center justify-between gap-2">
              <SectionHeading icon={<Network size={12} />} title="网络流量" />
              <select className="h-6 max-w-24 rounded-sm border border-border bg-background px-1 text-[10px]" value={selectedInterface ?? ""} disabled={!network?.interfaces.length} onChange={(event) => sessionId && useMonitorStore.getState().setNetworkInterface(sessionId, event.target.value)} aria-label="选择服务器网卡">
                {(network?.interfaces ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select>
            </div>
            {selectedNetwork ? <>
              <div className="mb-1 flex items-center justify-between text-[10px]"><span style={{ color: "var(--monitor-send)" }}>↑ {formatRate(selectedNetwork.txBytesPerSec)}</span><span style={{ color: "var(--monitor-receive)" }}>↓ {formatRate(selectedNetwork.rxBytesPerSec)}</span><span className="text-muted-foreground">{selectedInterface}</span></div>
              <NetworkTrendChart
                history={networkHistory}
                theme={theme}
                metricState={snapshot?.network.state}
                reason={snapshot?.network.reason}
                interfaceName={selectedInterface ?? "服务器网卡"}
              />
            </> : <MetricPlaceholder metric={snapshot?.network} fallback={connected ? "等待服务器网卡采样…" : "连接后显示网卡吞吐趋势。"} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("network")}><Activity size={12} />诊断当前网络指标</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <section className="border-b border-border px-3 py-2" aria-label="SSH 请求往返">
            <div className="mb-1 flex items-center justify-between"><SectionHeading icon={<CircleGauge size={12} />} title="延迟监测" /><span className="text-[9px] text-muted-foreground">SSH RTT</span></div>
            {snapshot?.latency.value ? <>
              <div className="mb-1 flex items-center justify-between text-[10px]"><span className="text-muted-foreground">SSH 请求往返</span><span className={`font-mono ${snapshot.latency.state === "stale" ? "text-muted-foreground" : "text-accent"}`}>{snapshot.latency.value.sshRoundTripMs.toFixed(1)} ms{snapshot.latency.state === "stale" ? " · 过期" : ""}</span></div>
              <Sparkline values={latencyHistory} ariaLabel="SSH exec 请求往返时间趋势" height={40} color="var(--monitor-latency)" />
            </> : <MetricPlaceholder metric={snapshot?.latency} fallback={connected ? "等待 SSH 请求往返采样…" : "连接后显示 SSH exec 往返时间。"} />}
          </section>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="px-3 py-2" aria-label="磁盘列表">
            <div className="mb-1 flex items-center justify-between"><SectionHeading icon={<HardDrive size={12} />} title="磁盘" />{snapshot?.disks.state === "stale" && <MetricStateLabel />}</div>
            {snapshot?.disks.value ? <>
              <div className="grid h-6 grid-cols-[minmax(0,1fr)_72px_72px] items-center border border-border bg-panel-header px-2 text-[9px] text-muted-foreground"><span>路径</span><span className="text-right">可用</span><span className="text-right">总大小</span></div>
              {snapshot.disks.value.slice(0, 12).map((disk) => <div key={`${disk.filesystem}:${disk.mountPoint}`} className="grid min-h-7 grid-cols-[minmax(0,1fr)_72px_72px] items-center border-x border-b border-border/70 px-2 text-[10px] even:bg-panel-header/35"><span className="truncate font-mono" title={disk.mountPoint}>{disk.mountPoint}</span><span className="text-right tabular-nums">{formatBytes(disk.availableBytes)}</span><span className="text-right tabular-nums">{formatBytes(disk.totalBytes)}</span></div>)}
            </> : <MetricPlaceholder metric={snapshot?.disks} fallback={connected ? "等待磁盘采样…" : "连接后显示挂载点与容量。"} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("disk")}><Activity size={12} />诊断当前磁盘指标</ContextMenuItem></ContextMenuContent>
          </ContextMenu>
          {monitor?.status === "unsupported" && <div className="border-t border-border px-3 py-2 text-[10px] text-warning">{monitor.message ?? "当前远程系统暂不支持监控。"}</div>}
          {monitor?.message && monitor.status === "disconnected" && <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">{monitor.message}</div>}
        </div>
      )}
    </aside>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <span className="flex items-center gap-1.5 text-[11px] font-semibold">{icon}{title}</span>;
}

function ResourceBar({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: "green" | "orange" | "gray" }) {
  const colors = { green: "var(--resource-green)", orange: "var(--resource-orange)", gray: "var(--resource-gray)" };
  const percent = value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));
  return <div className="mb-1.5 grid grid-cols-[32px_minmax(0,1fr)_72px] items-center gap-1.5 text-[10px]">
    <span className="font-medium">{label}</span>
    <div className="relative h-[17px] overflow-hidden rounded-[2px] bg-muted">
      {percent !== null && <span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${percent}%`, backgroundColor: colors[tone] }} />}
      <span className="relative z-[1] flex h-full items-center rounded-[2px] bg-panel/85 px-1 text-[9px] font-semibold text-foreground">{percent === null ? "—" : `${percent.toFixed(0)}%`}</span>
    </div>
    <span className="truncate text-right tabular-nums text-muted-foreground">{detail}</span>
  </div>;
}

function ProcessRow({ process, sort }: { process: ProcessMetric; sort: ProcessSort }) {
  const value = sort === "memory" ? formatBytes(process.rssBytes) : sort === "cpu" ? `${process.cpuPercent.toFixed(1)}%` : String(process.pid);
  const detail = sort === "command" || sort === "memory" ? `${process.cpuPercent.toFixed(1)}%` : formatBytes(process.rssBytes);
  return <div className="grid h-[22px] grid-cols-[minmax(0,1fr)_52px_72px] items-center gap-2 px-2 text-[10px] odd:bg-panel-header/35"><span className="truncate" title={process.command}>{process.command}</span><span className="text-right tabular-nums">{value}</span><span className="truncate text-right text-muted-foreground">{detail}</span></div>;
}

function MetricPlaceholder<T>({ metric, fallback }: { metric?: Monitored<T>; fallback: string }) {
  const text = metric?.state === "error" || metric?.state === "unsupported" ? metric.reason ?? "此项数据暂不可用。" : metric?.state === "pending" ? "等待首次采样…" : fallback;
  return <div className="py-2 text-[10px] text-muted-foreground">{text}</div>;
}

function MetricButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} className={`h-5 rounded-[2px] px-2 text-[9px] ${active ? "bg-accent text-primary-foreground" : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"}`} onClick={onClick}>{children}</button>;
}

function MetricStateLabel() {
  return <span className="text-[9px] text-muted-foreground">过期</span>;
}

function Sparkline({ values, secondary, ariaLabel, height = 64, color = "var(--monitor-send)" }: { values: number[]; secondary?: number[]; ariaLabel: string; height?: number; color?: string }) {
  const path = useMemo(() => chartPath(values, height), [values, height]);
  const secondPath = useMemo(() => secondary ? chartPath(secondary, height) : "", [secondary, height]);
  if (values.length < 2) return <div className="h-2" aria-label={ariaLabel} />;
  return <svg className="h-full max-h-16 w-full" style={{ height }} viewBox={`0 0 280 ${height}`} preserveAspectRatio="none" aria-label={ariaLabel} role="img">
    <path d={`M0 ${height - 1}H280M0 ${height / 2}H280`} fill="none" stroke="var(--app-border)" strokeDasharray="2 3" strokeWidth=".7" />
    <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    {secondPath && <path d={secondPath} fill="none" stroke="var(--monitor-receive)" strokeWidth="1.5" />}
  </svg>;
}

function chartPath(values: number[], height: number) {
  if (values.length < 2) return "";
  const ceiling = Math.max(...values, 1);
  return values.map((value, index) => {
    const x = index * 280 / (values.length - 1);
    const y = height - 2 - Math.min(ceiling, Math.max(0, value)) / ceiling * (height - 4);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function metricText<T>(metric?: Monitored<T>) {
  if (!metric) return "等待连接";
  if (metric.state === "pending") return "等待采样";
  if (metric.state === "error" || metric.state === "unsupported") return "不可用";
  if (metric.state === "stale") return "数据过期";
  return "";
}

function metricSuffix<T>(metric?: Monitored<T>) {
  if (!metric || metric.state === "fresh") return "";
  if (metric.state === "stale") return "过期";
  return metricText(metric);
}

function formatSampleTime(sampledAt: string) {
  const date = new Date(sampledAt);
  return Number.isNaN(date.valueOf())
    ? "已更新"
    : `更新 ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

function formatUptime(seconds: number) {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  return days ? `${days}天 ${hours}小时` : `${hours}小时 ${Math.floor((total % 3_600) / 60)}分`;
}

function formatBytes(value: string) {
  try {
    const bytes = BigInt(value);
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let unit = 0;
    let display = Number(bytes);
    while (display >= 1024 && unit < units.length - 1) { display /= 1024; unit += 1; }
    return `${display >= 10 || unit === 0 ? display.toFixed(0) : display.toFixed(1)} ${units[unit]}`;
  } catch {
    return "—";
  }
}

function formatRate(bytesPerSecond: number | null) {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return "等待采样";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
