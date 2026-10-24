import { lazy, Suspense, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Copy, Cpu, HardDrive, Network, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import type { Monitored, ProcessMetric } from "@/features/monitor/monitorTypes";
import { useMonitorStore } from "@/features/monitor/monitorStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";

const NetworkTrendChart = lazy(() => import("@/features/monitor/NetworkTrendChart").then((module) => ({ default: module.NetworkTrendChart })));

type MonitorSidebarProps = { collapsed: boolean; onToggle: () => void };
type ProcessSort = "memory" | "cpu" | "command";

export function MonitorSidebar({ collapsed, onToggle }: MonitorSidebarProps) {
  const { t, i18n } = useTranslation("monitor");
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
    ? t("status.notConnected")
    : monitor?.status === "unsupported"
      ? t("status.unsupported")
      : monitor?.status === "disconnected"
        ? t("status.disconnected")
        : monitor?.status === "started"
          ? t("status.sampling")
          : t("status.waitingSamples");
  const indicator = monitor?.status === "started" ? "bg-success" : connected ? "bg-warning" : "bg-muted-foreground/40";

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-panel" aria-label={t("title")}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel-header px-2">
        {!collapsed && <div className="flex items-center gap-1.5">
          <RefreshCw size={12} className={connected ? "text-foreground" : "text-muted-foreground"} />
          <span className="font-medium">{connected ? t("status.sync") : t("status.monitor")}</span>
          <span className={`h-1.5 w-1.5 rounded-full ${indicator}`} aria-hidden="true" />
          <span className="text-[10px] text-muted-foreground">{monitorLabel}</span>
        </div>}
        <Button type="button" variant="ghost" size="icon" className={`h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground ${collapsed ? "mx-auto" : ""}`} aria-label={collapsed ? t("expand") : t("collapse")} title={collapsed ? t("expand") : t("collapse")} onClick={onToggle}>
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </Button>
      </header>
      {collapsed ? (
        <div className="flex flex-1 items-start justify-center pt-3"><span className="[writing-mode:vertical-rl] text-[10px] tracking-widest text-muted-foreground">{t("shortTitle")}</span></div>
      ) : (
        <div className="compact-scrollbar min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-border px-3 py-2" aria-label={t("hostInfo")}>
            {connected ? <>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">{displayIp ? `IP ${displayIp}` : t("sshHost")}</span>
                {displayIp && <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 rounded-sm px-1.5 text-[10px]" onClick={() => void copyAddress()} aria-label={t("copyHostAddress")}><Copy size={10} />{copied ? t("copied") : t("copy")}</Button>}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1 truncate"><Server size={11} />{host?.hostname ?? sshSession?.profile.name}</span>
                <span className="shrink-0">{sshSession?.state === "connected" ? t("status.sshConnected") : t("status.sshDisconnected")}</span>
              </div>
            </> : <div className="flex min-h-9 items-center gap-2 text-[11px] text-muted-foreground"><Server size={13} /><span>{activeTab?.mode === "demo" ? t("demoNoMetrics") : t("connectToShowHost")}</span></div>}
          </section>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border" aria-label={t("systemInfo")}>
            <button type="button" className="flex h-9 w-full items-center justify-between border-b border-border/70 bg-panel-header/55 px-3 text-left hover:bg-accent/5" aria-expanded={systemOpen} onClick={() => setSystemOpen((value) => !value)}>
              <span className="flex items-center gap-2 text-[12px] font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-sm bg-accent/10 text-accent"><Cpu size={12} /></span>{t("systemInfo")}</span>
              {systemOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {systemOpen && <div className="px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate">{host ? formatUptime(host.uptimeSeconds, i18n.resolvedLanguage, t) : metricText(snapshot?.host, t)}</span>
                <span className="truncate text-right text-muted-foreground">{t("load", { value: host ? `${host.load1.toFixed(2)}, ${host.load5.toFixed(2)}, ${host.load15.toFixed(2)}` : "—" })}</span>
              </div>
              <ResourceBar label="CPU" value={cpu?.busyPercent ?? null} detail={metricSuffix(snapshot?.cpu, t)} tone="green" />
              <ResourceBar label={t("memory")} value={memory?.usedPercent ?? null} detail={memory ? `${formatBytes((BigInt(memory.totalBytes) - BigInt(memory.availableBytes)).toString())}/${formatBytes(memory.totalBytes)}` : metricText(snapshot?.memory, t)} tone="orange" />
              <ResourceBar label={t("swap")} value={swapPercent} detail={memory ? (BigInt(memory.swapTotalBytes) === 0n ? t("swapUnavailable") : `${formatBytes((BigInt(memory.swapTotalBytes) - BigInt(memory.swapFreeBytes)).toString())}/${formatBytes(memory.swapTotalBytes)}`) : metricText(snapshot?.memory, t)} tone="gray" />
            </div>}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("cpu")}><Activity size={12} />{t("diagnoseCpu")}</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border px-3 py-2" aria-label={t("processList")}>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
              <div className="shrink-0"><SectionHeading icon={<Activity size={12} />} title={t("processes")} /></div>
              <div className="flex h-6 shrink-0 items-center rounded-sm border border-border bg-panel-header p-0.5" role="tablist" aria-label={t("processSort") }>
                <MetricButton active={processSort === "memory"} onClick={() => setProcessSort("memory")}>{t("memory")}</MetricButton>
                <MetricButton active={processSort === "cpu"} onClick={() => setProcessSort("cpu")}>CPU</MetricButton>
                <MetricButton active={processSort === "command"} onClick={() => setProcessSort("command")}>{t("command")}</MetricButton>
              </div>
            </div>
            {snapshot?.processes.sampledAt && <div className="-mt-1 mb-1 text-right text-[8px] text-muted-foreground" title={t("processSampleTime", { time: snapshot.processes.sampledAt })}>{formatSampleTime(snapshot.processes.sampledAt, i18n.resolvedLanguage, t)}</div>}
            {snapshot?.processes.value ? <div className="overflow-hidden rounded-sm border border-border/70">
              <div className="grid h-6 grid-cols-[minmax(0,1fr)_52px_72px] items-center gap-2 bg-panel-header px-2 text-[10px] text-muted-foreground"><span>{t("command")}</span><span className="text-right">{processSort === "memory" ? t("memory") : processSort === "cpu" ? "CPU" : "PID"}</span><span className="text-right">{processSort === "command" || processSort === "memory" ? "CPU" : t("memory")}</span></div>
              {sortedProcesses.slice(0, 6).map((process) => <ProcessRow key={process.pid} process={process} sort={processSort} />)}
              {sortedProcesses.length === 0 && <div className="px-2 py-2 text-[10px] text-muted-foreground">{t("noProcesses")}</div>}
            </div> : <MetricPlaceholder metric={snapshot?.processes} fallback={connected ? t("waitProcesses") : t("connectToShowProcesses")} translate={t} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("processes")}><Activity size={12} />{t("diagnoseProcesses")}</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="border-b border-border px-3 py-2" aria-label={t("network")}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <SectionHeading icon={<Network size={12} />} title={t("network")} />
              <select className="h-6 max-w-24 rounded-sm border border-border bg-background px-1 text-[10px]" value={selectedInterface ?? ""} disabled={!network?.interfaces.length} onChange={(event) => sessionId && useMonitorStore.getState().setNetworkInterface(sessionId, event.target.value)} aria-label={t("selectInterface")}>
                {(network?.interfaces ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select>
            </div>
            {selectedNetwork ? <>
              <div className="mb-1 flex items-center justify-between text-[10px]"><span style={{ color: "var(--monitor-send)" }}>↑ {formatRate(selectedNetwork.txBytesPerSec, t)}</span><span style={{ color: "var(--monitor-receive)" }}>↓ {formatRate(selectedNetwork.rxBytesPerSec, t)}</span><span className="text-muted-foreground">{selectedInterface}</span></div>
              <Suspense fallback={<div className="flex h-[64px] items-center justify-center text-[9px] text-muted-foreground">{t("loadingNetworkTrend")}</div>}>
                <NetworkTrendChart
                  key={`${sessionId ?? "no-session"}:${selectedInterface ?? "no-interface"}`}
                  history={networkHistory}
                  theme={theme}
                  metricState={snapshot?.network.state}
                  interfaceName={selectedInterface ?? t("serverInterface")}
                />
              </Suspense>
            </> : <MetricPlaceholder metric={snapshot?.network} fallback={connected ? t("waitNetwork") : t("connectToShowNetwork")} translate={t} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("network")}><Activity size={12} />{t("diagnoseNetwork")}</ContextMenuItem></ContextMenuContent>
          </ContextMenu>

          <ContextMenu>
          <ContextMenuTrigger asChild><section className="px-3 py-2" aria-label={t("diskList")}>
            <div className="mb-1 flex items-center justify-between"><SectionHeading icon={<HardDrive size={12} />} title={t("disk")} />{snapshot?.disks.state === "stale" && <MetricStateLabel label={t("status.stale")} />}</div>
            {snapshot?.disks.value ? <>
              <div className="grid h-6 grid-cols-[minmax(0,1fr)_72px_72px] items-center border border-border bg-panel-header px-2 text-[9px] text-muted-foreground"><span>{t("path")}</span><span className="text-right">{t("available")}</span><span className="text-right">{t("totalSize")}</span></div>
              {snapshot.disks.value.slice(0, 12).map((disk) => <div key={`${disk.filesystem}:${disk.mountPoint}`} className="grid min-h-7 grid-cols-[minmax(0,1fr)_72px_72px] items-center border-x border-b border-border/70 px-2 text-[10px] even:bg-panel-header/35"><span className="truncate font-mono" title={disk.mountPoint}>{disk.mountPoint}</span><span className="text-right tabular-nums">{formatBytes(disk.availableBytes)}</span><span className="text-right tabular-nums">{formatBytes(disk.totalBytes)}</span></div>)}
            </> : <MetricPlaceholder metric={snapshot?.disks} fallback={connected ? t("waitDisk") : t("connectToShowDisks")} translate={t} />}
          </section></ContextMenuTrigger>
          <ContextMenuContent><ContextMenuItem disabled={!connected} onSelect={() => diagnoseMetric("disk")}><Activity size={12} />{t("diagnoseDisk")}</ContextMenuItem></ContextMenuContent>
          </ContextMenu>
          {monitor?.status === "unsupported" && <div className="border-t border-border px-3 py-2 text-[10px] text-warning">{monitor.message ?? t("unsupportedRemote")}</div>}
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
  return <div className="mb-1.5 grid grid-cols-[max-content_minmax(0,1fr)_72px] items-center gap-1.5 text-[10px]">
    <span className="whitespace-nowrap font-medium">{label}</span>
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

function MetricPlaceholder<T>({ metric, fallback, translate }: { metric?: Monitored<T>; fallback: string; translate: (key: string) => string }) {
  const text = metric?.state === "error" || metric?.state === "unsupported" ? translate("metricUnavailable") : metric?.state === "pending" ? translate("waitFirstSample") : fallback;
  return <div className="py-2 text-[10px] text-muted-foreground">{text}</div>;
}

function MetricButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} className={`h-5 whitespace-nowrap rounded-[2px] px-2 text-[9px] ${active ? "bg-accent text-primary-foreground" : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"}`} onClick={onClick}>{children}</button>;
}

function MetricStateLabel({ label }: { label: string }) {
  return <span className="text-[9px] text-muted-foreground">{label}</span>;
}

function metricText<T>(metric: Monitored<T> | undefined, translate: (key: string) => string) {
  if (!metric) return translate("status.waitingConnection");
  if (metric.state === "pending") return translate("status.waitingSamples");
  if (metric.state === "error" || metric.state === "unsupported") return translate("status.unavailable");
  if (metric.state === "stale") return translate("status.stale");
  return "";
}

function metricSuffix<T>(metric: Monitored<T> | undefined, translate: (key: string) => string) {
  if (!metric || metric.state === "fresh") return "";
  if (metric.state === "stale") return translate("status.stale");
  return metricText(metric, translate);
}

function formatSampleTime(sampledAt: string, locale: string | undefined, translate: (key: string, options?: Record<string, unknown>) => string) {
  const date = new Date(sampledAt);
  return Number.isNaN(date.valueOf())
    ? translate("status.updated")
    : translate("updatedAt", { time: date.toLocaleTimeString(locale, { hour12: false }) });
}

function formatUptime(seconds: number, locale: string | undefined, translate: (key: string, options?: Record<string, unknown>) => string) {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return days
    ? translate("uptimeDays", { days: new Intl.NumberFormat(locale).format(days), hours: new Intl.NumberFormat(locale).format(hours) })
    : translate("uptimeHours", { hours: new Intl.NumberFormat(locale).format(hours), minutes: new Intl.NumberFormat(locale).format(minutes) });
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

function formatRate(bytesPerSecond: number | null, translate: (key: string) => string) {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return translate("status.waitingSamples");
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
