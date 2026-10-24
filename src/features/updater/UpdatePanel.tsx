import { useState } from "react";
import { Download, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { AppMetadata } from "@/features/settings/settingsBridge";
import { useAiStore } from "@/features/ai/aiStore";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useSftpSessionStore } from "@/stores/sftpSessionStore";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useTunnelStore } from "@/features/tunnels/tunnelStore";
import { inspectUpdateInstallGuard, type UpdateInstallGuard } from "./installGuard";
import { useUpdateMaintenanceTaskStore } from "./maintenanceTasks";
import { checkForUpdate, closePendingUpdate, downloadUpdate, installDownloadedUpdate, relaunchApplication } from "./updaterBridge";
import { updaterErrorCode } from "./updaterErrors";
import { useUpdaterStore } from "./updaterStore";
import { useTranslation } from "react-i18next";

type UpdatePanelProps = {
  metadata: AppMetadata | null;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return String(Math.round(bytes)) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

export function UpdatePanel({ metadata }: UpdatePanelProps) {
  const { t, i18n } = useTranslation("updater");
  const tDynamic = (key: string, options?: Record<string, unknown>): string =>
    String(i18n.t(key as never, { ns: "updater", ...options } as never));
  const phase = useUpdaterStore((state) => state.phase);
  const update = useUpdaterStore((state) => state.update);
  const downloadedBytes = useUpdaterStore((state) => state.downloadedBytes);
  const contentLength = useUpdaterStore((state) => state.contentLength);
  const error = useUpdaterStore((state) => state.error);
  const message = useUpdaterStore((state) => state.message);
  const setState = useUpdaterStore((state) => state.setState);
  const [installConfirmation, setInstallConfirmation] = useState<{ ssh: number; tunnels: number } | null>(null);
  const [allowManualRelaunch, setAllowManualRelaunch] = useState(false);

  useEditorStore((state) => state.documents.filter((document) => document.dirty).length);
  useSftpSessionStore((state) => Object.values(state.contexts).reduce((count, context) =>
    count + context.transfers.filter((transfer) => ["queued", "running", "awaitingConflict"].includes(transfer.status)).length, 0));
  useSshSessionStore((state) => state.sessions);
  useTunnelStore((state) => state.runtimes);
  useDiagnosticStore((state) => Object.values(state.runs).filter((run) => run.status === "queued" || run.status === "running").length);
  useAiStore((state) => Object.keys(state.activeRequests).length);
  useSettingsStore((state) => state.savingSection);
  useUpdateMaintenanceTaskStore((state) => state.tasks);

  const configured = Boolean(metadata?.updaterConfigured);
  const desktopRuntime = Boolean(metadata);
  const guard = inspectUpdateInstallGuard();
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  async function checkUpdates() {
    if (!configured || busy) return;
    setState({ phase: "checking", error: null, message: null });
    try {
      const found = await checkForUpdate(metadata?.platform ?? "unknown", metadata?.arch ?? "unknown");
      if (!found) {
        setState({ phase: "upToDate", update: null, downloadedBytes: 0, contentLength: null, error: null });
        return;
      }
      setState({ phase: "available", update: found, downloadedBytes: 0, contentLength: null, error: null });
    } catch (reason) {
      setState({ phase: "error", error: updaterErrorCode(reason), message: null });
    }
  }

  async function downloadUpdatePackage() {
    if (busy || !update) return;
    setState({ phase: "downloading", downloadedBytes: 0, contentLength: null, error: null, message: null });
    try {
      await downloadUpdate((event) => {
        if (event.event === "Started") {
          setState({ phase: "downloading", downloadedBytes: 0, contentLength: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          const current = useUpdaterStore.getState().downloadedBytes;
          setState({ phase: "downloading", downloadedBytes: current + event.data.chunkLength });
        }
      });
      setState({ phase: "downloaded", error: null, message: "downloadedNotInstalled" });
    } catch (reason) {
      setState({ phase: "error", error: updaterErrorCode(reason), message: null });
    }
  }

  function showBlockers(snapshot: UpdateInstallGuard) {
    if (snapshot.blockers.length === 0) return false;
    setState({
      phase: "downloaded",
      error: null,
      message: "completeBeforeInstall",
    });
    setInstallConfirmation(null);
    return true;
  }

  async function installUpdate(confirmed: { ssh: number; tunnels: number } | null = null) {
    const initial = inspectUpdateInstallGuard();
    if (showBlockers(initial)) return;

    const needsConfirmation = initial.activeSshSessions > 0 || initial.activeTunnels > 0;
    if (needsConfirmation && !confirmed) {
      setInstallConfirmation({ ssh: initial.activeSshSessions, tunnels: initial.activeTunnels });
      return;
    }
    if (confirmed && (initial.activeSshSessions > confirmed.ssh || initial.activeTunnels > confirmed.tunnels)) {
      setInstallConfirmation({ ssh: initial.activeSshSessions, tunnels: initial.activeTunnels });
      setState({ phase: "downloaded", message: "sessionCountChanged" });
      return;
    }

    const finalCheck = inspectUpdateInstallGuard();
    if (showBlockers(finalCheck)) return;
    if (
      (finalCheck.activeSshSessions > 0 || finalCheck.activeTunnels > 0)
      && (!confirmed
        || finalCheck.activeSshSessions > confirmed.ssh
        || finalCheck.activeTunnels > confirmed.tunnels)
    ) {
      setState({ phase: "downloaded", message: "sessionCountChanged" });
      setInstallConfirmation({ ssh: finalCheck.activeSshSessions, tunnels: finalCheck.activeTunnels });
      return;
    }

    setInstallConfirmation(null);
    setState({ phase: "installing", error: null, message: "startingInstaller" });
    try {
      const outcome = await installDownloadedUpdate();
      if (outcome === "restartRequired") {
        setAllowManualRelaunch(true);
        setState({ phase: "needsRestart", message: "installedRestartRequired" });
      } else if (outcome === "installerStarted") {
        setAllowManualRelaunch(false);
        setState({ phase: "needsRestart", message: "installerTookOver" });
      } else {
        setAllowManualRelaunch(false);
        setState({ phase: "installing", message: "installedRestarting" });
      }
    } catch (reason) {
      setState({ phase: "error", error: updaterErrorCode(reason), message: null });
    }
  }

  async function dismissUpdate() {
    await closePendingUpdate().catch(() => undefined);
    setInstallConfirmation(null);
    setAllowManualRelaunch(false);
    setState({ phase: "idle", update: null, downloadedBytes: 0, contentLength: null, error: null, message: null });
  }

  async function manualRelaunch() {
    try {
      await relaunchApplication();
    } catch (reason) {
      setState({ phase: "error", error: updaterErrorCode(reason), message: null });
    }
  }

  const progressPercent = contentLength && contentLength > 0
    ? Math.min(100, Math.floor((downloadedBytes / contentLength) * 100))
    : null;

  return <>
    <section className="rounded-sm border border-border bg-muted/20 p-3" aria-labelledby="update-panel-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {configured ? <ShieldCheck size={13} className="text-success" /> : <ShieldAlert size={13} className="text-muted-foreground" />}
            <h3 id="update-panel-heading" className="text-[11px] font-semibold text-foreground">{t("title")}</h3>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {configured
              ? t("description")
              : t(desktopRuntime ? "unavailable" : "desktopOnly")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-sm text-[10px]"
          disabled={!configured || busy}
          onClick={() => void checkUpdates()}
        >
          {phase === "checking" ? <><LoaderCircle size={12} className="animate-spin" />{t("checking")}</> : <><RefreshCw size={11} />{t("check")}</>}
        </Button>
      </div>

      {phase === "upToDate" && <p role="status" className="mt-2 text-[10px] text-muted-foreground">{t("upToDate")}</p>}
      {phase === "available" && update && <div className="mt-3 border-t border-border/70 pt-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-foreground">
          <strong>TermVista {update.version}</strong>
          <span className="text-muted-foreground">{t("currentVersion", { version: update.currentVersion })}</span>
          <span className="text-muted-foreground">{update.platform} · {update.arch}</span>
          {update.date && <time className="text-muted-foreground" dateTime={update.date}>{new Date(update.date).toLocaleDateString(i18n.resolvedLanguage)}</time>}
        </div>
        <div className="compact-scrollbar mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-sm border border-border bg-background/60 p-2 text-[10px] leading-4 text-foreground">
          {update.notes.trim() || t("noReleaseNotes")}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void dismissUpdate()}>{t("later")}</Button>
          <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void downloadUpdatePackage()}><Download size={11} />{t("download")}</Button>
        </div>
      </div>}

      {phase === "downloading" && <div className="mt-3 border-t border-border/70 pt-3" aria-live="polite">
        <div className="mb-1 flex justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{t("downloading", { version: update?.version })}</span>
          <span>{progressPercent === null
            ? t("downloadedUnknownSize", { size: formatBytes(downloadedBytes) })
            : t("downloadProgress", { percent: progressPercent, downloaded: formatBytes(downloadedBytes), total: formatBytes(contentLength ?? 0) })}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t("downloadProgressLabel")}
          aria-valuemin={0}
          aria-valuemax={progressPercent === null ? undefined : 100}
          aria-valuenow={progressPercent === null ? undefined : progressPercent}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div className={progressPercent === null ? "h-full w-1/3 animate-pulse rounded-full bg-primary" : "h-full rounded-full bg-primary transition-[width]"} style={progressPercent === null ? undefined : { width: progressPercent + "%" }} />
        </div>
      </div>}

      {phase === "downloaded" && <div className="mt-3 border-t border-border/70 pt-3">
        <p role="status" className="text-[10px] leading-4 text-foreground">{tDynamic(message ?? "downloadedNotInstalledShort")}</p>
        {guard.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] text-destructive">
          {guard.blockers.map((blocker) => <li key={blocker.key}>{tDynamic(`blockers.${blocker.key}`, {
            ...(blocker.count === undefined ? {} : { count: blocker.count }),
            ...(blocker.labels ? { labels: blocker.labels.map((label) => tDynamic(`tasks.${label}`)).join(", ") } : {}),
          })}</li>)}
        </ul>}
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{t("installRestartNotice")}</p>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void dismissUpdate()}>{t("later")}</Button>
          <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={busy || guard.blockers.length > 0} onClick={() => void installUpdate()}><Download size={11} />{t("installAndRestart")}</Button>
        </div>
      </div>}

      {phase === "installing" && <p role="status" className="mt-3 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">{message ? tDynamic(message) : t("installing")}</p>}
      {phase === "needsRestart" && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <p role="status" className="text-[10px] leading-4 text-muted-foreground">{message ? tDynamic(message) : null}</p>
        {allowManualRelaunch && <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void manualRelaunch()}>{t("relaunch")}</Button>}
      </div>}
      {phase === "error" && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <p className="min-w-0 flex-1 text-[10px] leading-4 text-destructive">{tDynamic(`errors.${error ?? "unknown"}`)}</p>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 rounded-sm text-[10px]" onClick={() => void checkUpdates()}>{t("retry")}</Button>
      </div>}
    </section>

    <Dialog open={installConfirmation !== null} onOpenChange={(open) => { if (!open) setInstallConfirmation(null); }}>
      <DialogContent className="gap-0 p-4">
        <DialogTitle>{t("confirmInstallTitle")}</DialogTitle>
        <DialogDescription className="pt-2 text-[11px] leading-5">
          {t("confirmInstallDescription", { ssh: installConfirmation?.ssh ?? 0, tunnels: installConfirmation?.tunnels ?? 0 })}
        </DialogDescription>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setInstallConfirmation(null)}>{t("later")}</Button>
          <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void installUpdate(installConfirmation)}>{t("confirmAndInstall")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
