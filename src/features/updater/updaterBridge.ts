import { isTauri } from "@tauri-apps/api/core";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdateDetails } from "./updaterStore";

type InstallOutcome = "relaunching" | "restartRequired" | "installerStarted";

let pendingUpdate: Update | null = null;
let pendingDetails: UpdateDetails | null = null;
let checkInFlight: Promise<UpdateDetails | null> | null = null;
let downloadInFlight: Promise<void> | null = null;
let installInFlight: Promise<InstallOutcome> | null = null;
let downloaded = false;

function requireDesktopRuntime() {
  if (!isTauri()) {
    throw new Error("在线更新只能在 TermVista 桌面应用中使用。");
  }
}

async function releaseCurrentUpdate() {
  const update = pendingUpdate;
  pendingUpdate = null;
  pendingDetails = null;
  downloaded = false;
  if (update) await update.close();
}

export function checkForUpdate(platform: string, arch: string): Promise<UpdateDetails | null> {
  requireDesktopRuntime();
  if (checkInFlight) return checkInFlight;
  if (pendingUpdate && pendingDetails) return Promise.resolve(pendingDetails);

  const operation = (async () => {
    await releaseCurrentUpdate();
    const update = await check({ timeout: 30000 });
    pendingUpdate = update;
    if (!update) return null;
    const details: UpdateDetails = {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date ?? null,
      notes: update.body ?? "",
      platform,
      arch,
    };
    pendingDetails = details;
    return details;
  })();

  checkInFlight = operation;
  return operation.finally(() => {
    if (checkInFlight === operation) checkInFlight = null;
  });
}

export function downloadUpdate(onEvent: (event: DownloadEvent) => void): Promise<void> {
  requireDesktopRuntime();
  if (downloadInFlight) return downloadInFlight;
  if (!pendingUpdate) return Promise.reject(new Error("请先检查更新并选择一个版本。"));
  if (downloaded) return Promise.resolve();

  const update = pendingUpdate;
  const operation = update.download(onEvent, { timeout: 120000 }).then(() => {
    downloaded = true;
  }).catch(async (error: unknown) => {
    await releaseCurrentUpdate().catch(() => undefined);
    throw error;
  }).finally(() => {
    if (downloadInFlight === operation) downloadInFlight = null;
  });

  downloadInFlight = operation;
  return operation;
}

export function installDownloadedUpdate(): Promise<InstallOutcome> {
  requireDesktopRuntime();
  if (installInFlight) return installInFlight;
  if (!pendingUpdate || !downloaded) {
    return Promise.reject(new Error("更新尚未完成下载，不能安装。"));
  }

  const update = pendingUpdate;
  const platform = pendingDetails?.platform ?? "";
  const operation = (async () => {
    await update.install({ restartAfterInstall: true });
    pendingUpdate = null;
    pendingDetails = null;
    downloaded = false;
    if (platform === "macOS") {
      try {
        await relaunch();
        return "relaunching" as const;
      } catch {
        return "restartRequired" as const;
      }
    }
    return "installerStarted" as const;
  })().catch(async (error: unknown) => {
    await releaseCurrentUpdate().catch(() => undefined);
    throw error;
  }).finally(() => {
    if (installInFlight === operation) installInFlight = null;
  });

  installInFlight = operation;
  return operation;
}

export async function closePendingUpdate(): Promise<void> {
  if (checkInFlight) {
    try {
      await checkInFlight;
    } catch {
      // 检查失败时没有更新资源需要释放。
    }
  }
  if (downloadInFlight) {
    try {
      await downloadInFlight;
    } catch {
      // 下载失败路径已释放资源。
    }
  }
  await releaseCurrentUpdate();
}

export async function relaunchApplication(): Promise<void> {
  requireDesktopRuntime();
  await relaunch();
}
