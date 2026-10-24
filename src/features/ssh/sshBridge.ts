import { Channel, invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { toast } from "sonner";
import { useWorkspaceStore, type AuthMethod, type ConnectionProfile } from "@/stores/workspaceStore";
import { saveConnectionProfile } from "@/features/connections/profileBridge";
import { statusLabel, useSshSessionStore } from "@/stores/sshSessionStore";
import { clearTerminal, deliverTerminalOutput } from "@/features/ssh/terminalRegistry";
import { isRetryableNetworkError, MAX_AUTO_RECONNECT_ATTEMPTS, reconnectDelayMs } from "@/features/ssh/reconnectPolicy";
import { useAiStore } from "@/features/ai/aiStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type {
  HostKeyChallenge,
  AuthPromptEvent,
  SavedCredentialKind,
  SavedCredentialStatus,
  SshAuth,
  SshConnectArgs,
  SshConnectResult,
  SshStatusEvent,
} from "@/features/ssh/sshTypes";

const inputQueues = new Map<string, Promise<void>>();
const MAX_WRITE_CHUNK = 16 * 1024;
type AutoReconnectRun = {
  profileId: string;
  currentAttemptId: string;
  attempts: number;
  cancelled: boolean;
  timer?: number;
};

const autoReconnectRuns = new Map<string, AutoReconnectRun>();

function createAttemptId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function errorCode(error: unknown) {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "connectionFailed";
}

function localizedErrorMessage(error: unknown) {
  return errorCode(error) === "jumpHostUnavailable"
    ? i18next.t("connections:manager.proxyJump.unavailable")
    : errorMessage(error);
}

function connectedSessionForProfile(profileId: string) {
  return Object.values(useSshSessionStore.getState().sessions).find((session) =>
    session.profile.id === profileId && session.state === "connected" && Boolean(session.sessionId),
  );
}

async function ensureJumpSession(profile: ConnectionProfile): Promise<{ ok: true; sessionId?: string } | { ok: false }> {
  if (!profile.jumpProfileId) return { ok: true };
  const jumpProfile = useWorkspaceStore.getState().profiles.find((item) => item.id === profile.jumpProfileId);
  if (!jumpProfile || jumpProfile.id === profile.id) {
    toast.error(i18next.t("connections:manager.proxyJump.invalid"));
    return { ok: false };
  }
  if (jumpProfile.jumpProfileId) {
    toast.error(i18next.t("connections:manager.proxyJump.nestedUnsupported"));
    return { ok: false };
  }
  const connected = connectedSessionForProfile(jumpProfile.id);
  if (connected?.sessionId) return { ok: true, sessionId: connected.sessionId };
  const inProgress = Object.values(useSshSessionStore.getState().sessions).some((session) =>
    session.profile.id === jumpProfile.id && ["connecting", "verifyingHostKey", "authenticating", "openingPty"].includes(session.state),
  );
  if (inProgress) {
    toast.message(i18next.t("connections:manager.proxyJump.connecting"));
    return { ok: false };
  }
  const result = await connectProfile(jumpProfile);
  if (result?.sessionId) return { ok: true, sessionId: result.sessionId };
  toast.message(i18next.t("connections:manager.proxyJump.connectFirst"));
  return { ok: false };
}

function releaseAttempt(attemptId: string, cancelRecovery = true) {
  if (cancelRecovery) stopAutoReconnect(attemptId, false);
  const session = useSshSessionStore.getState().sessions[attemptId];
  if (session?.sessionId) {
    void invoke("ssh_disconnect", { sessionId: session.sessionId }).catch(() => undefined);
    useAiStore.getState().clearSession(session.sessionId);
  } else if (session) {
    void invoke("ssh_cancel_connect", { attemptId }).catch(() => undefined);
  }
  clearTerminal(attemptId);
  inputQueues.delete(attemptId);
  useSshSessionStore.getState().removeSession(attemptId);
}

function prepareAttempt(
  profile: ConnectionProfile,
  username: string,
  attemptId: string,
  replaceTabId?: string,
  recovery?: { run: AutoReconnectRun; attempt: number },
) {
  if (replaceTabId && replaceTabId !== attemptId) {
    releaseAttempt(replaceTabId, !recovery);
    useWorkspaceStore.getState().replaceSshTab(replaceTabId, attemptId, profile.name, profile.host, profile.id);
  } else {
    useWorkspaceStore.getState().addSshTab(attemptId, profile.name, profile.host, profile.id);
  }
  useSshSessionStore.getState().addSession({
    attemptId,
    profile,
    username,
    state: "connecting",
    ...(recovery ? { autoReconnectAttempt: recovery.attempt } : {}),
  });
  if (recovery) {
    recovery.run.currentAttemptId = attemptId;
    autoReconnectRuns.delete(replaceTabId ?? "");
    autoReconnectRuns.set(attemptId, recovery.run);
  }
}

function sshChannels(attemptId: string) {
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (data) => deliverTerminalOutput(attemptId, data);
  const onStatus = new Channel<SshStatusEvent>();
  onStatus.onmessage = (event) => {
    const before = useSshSessionStore.getState().sessions[attemptId];
    const localizedEvent = event.error
      ? { ...event, error: { ...event.error, message: localizedErrorMessage(event.error) } }
      : event;
    useSshSessionStore.getState().applyStatus(localizedEvent);
    if (event.state === "error" && before?.state === "connected") beginAutoReconnect(attemptId, event.error?.code);
  };
  const onHostKey = new Channel<HostKeyChallenge>();
  onHostKey.onmessage = (challenge) => useSshSessionStore.getState().openHostKeyChallenge(challenge);
  const onAuthPrompt = new Channel<AuthPromptEvent>();
  onAuthPrompt.onmessage = (prompt) => useSshSessionStore.getState().openAuthPrompt(prompt);
  return { onData, onStatus, onHostKey, onAuthPrompt };
}

export async function connectSsh(
  profile: ConnectionProfile,
  username: string,
  auth: SshAuth,
  rememberCredential = false,
  replaceTabId?: string,
) {
  const jumpSessionId = profile.jumpProfileId
    ? connectedSessionForProfile(profile.jumpProfileId)?.sessionId
    : undefined;
  if (profile.jumpProfileId && !jumpSessionId) {
    toast.error(i18next.t("connections:manager.proxyJump.unavailable"));
    return null;
  }
  const attemptId = createAttemptId();
  const authMethod: AuthMethod = auth.method;
  const updatedProfile = {
    ...profile,
    username,
    authMethod,
    privateKeyPath: auth.method === "privateKey" && !auth.keyRef ? auth.privateKeyPath : auth.method === "privateKey" ? "" : profile.privateKeyPath,
    keyRef: auth.method === "privateKey" ? auth.keyRef : undefined,
  };
  useWorkspaceStore.getState().updateProfile(profile.id, updatedProfile);
  try {
    await saveConnectionProfile(updatedProfile);
  } catch (error) {
    toast.error(`配置暂未写入本机数据库，本次连接仍会继续：${errorMessage(error)}`);
  }
  prepareAttempt(updatedProfile, username, attemptId, replaceTabId);
  const { onData, onStatus, onHostKey, onAuthPrompt } = sshChannels(attemptId);
  const args: SshConnectArgs = {
    attemptId,
    profileId: profile.id,
    host: profile.host,
    port: profile.port || 22,
    username,
    jumpSessionId,
    auth,
    rememberCredential,
    initialSize: { cols: 80, rows: 24 },
    onData,
    onStatus,
    onHostKey,
    onAuthPrompt,
  };
  try {
    const result = await invoke<SshConnectResult>("ssh_connect", args);
    if (useSettingsStore.getState().settings.general.rememberRecentConnections) {
      useWorkspaceStore.getState().markProfileConnected(profile.id);
    }
    if (result.credentialSaved) {
      const currentProfile = useWorkspaceStore.getState().profiles.find((item) => item.id === profile.id);
      if (currentProfile) {
        const updated = { ...currentProfile, credentialAccounts: [...new Set([...currentProfile.credentialAccounts, username])] };
        try {
          await saveConnectionProfile(updated);
          useWorkspaceStore.getState().setProfile(updated);
        } catch (error) {
          toast.warning(`密码已加密保存，但账户标记无法同步到配置数据库：${errorMessage(error)}`);
        }
      }
    }
    if (result.credentialWarning) toast.warning(result.credentialWarning);
    if (result.profileWarning) toast.warning(result.profileWarning);
    return result;
  } catch (error) {
    const session = useSshSessionStore.getState().sessions[attemptId];
    if (session && session.state !== "error" && session.state !== "canceled") {
      useSshSessionStore.getState().applyStatus({
        attemptId,
        state: "error",
        error: { code: errorCode(error), message: localizedErrorMessage(error) },
      });
    }
    return null;
  }
}

export async function saveSshPassword(profile: ConnectionProfile, password: string) {
  const username = profile.username.trim();
  await invoke<void>("ssh_credential_save", {
    profileId: profile.id,
    username,
    password,
  });

  const updatedProfile = {
    ...profile,
    credentialAccounts: [...new Set([...profile.credentialAccounts, username])],
  };
  try {
    await saveConnectionProfile(updatedProfile);
  } catch (error) {
    toast.warning(`密码已安全保存，但账户标记未同步到配置数据库：${errorMessage(error)}`);
  }
  return updatedProfile;
}

async function connectSavedSsh(
  profile: ConnectionProfile,
  replaceTabId?: string,
  recovery?: { run: AutoReconnectRun; attempt: number },
  jumpSessionId = profile.jumpProfileId ? connectedSessionForProfile(profile.jumpProfileId)?.sessionId : undefined,
) {
  if (profile.jumpProfileId && !jumpSessionId) {
    if (recovery) toast.warning(i18next.t("connections:manager.proxyJump.unavailable"));
    else toast.error(i18next.t("connections:manager.proxyJump.unavailable"));
    return null;
  }
  const username = profile.username.trim();
  const attemptId = createAttemptId();
  prepareAttempt(profile, username, attemptId, replaceTabId, recovery);
  const { onData, onStatus, onHostKey, onAuthPrompt } = sshChannels(attemptId);
  try {
    const result = await invoke<SshConnectResult>("ssh_connect_saved", {
      attemptId,
      profileId: profile.id,
      host: profile.host,
      port: profile.port || 22,
      username,
      jumpSessionId,
      authMethod: profile.authMethod,
      privateKeyPath: profile.privateKeyPath || null,
      keyRef: profile.keyRef ?? null,
      initialSize: { cols: 80, rows: 24 },
      onData,
      onStatus,
      onHostKey,
    onAuthPrompt,
    });
    if (useSettingsStore.getState().settings.general.rememberRecentConnections) {
      useWorkspaceStore.getState().markProfileConnected(profile.id);
    }
    if (result.profileWarning) toast.warning(result.profileWarning);
    return result;
  } catch (error) {
    const code = errorCode(error);
    const message = localizedErrorMessage(error);
    const session = useSshSessionStore.getState().sessions[attemptId];
    if (session && session.state !== "error" && session.state !== "canceled") {
      useSshSessionStore.getState().applyStatus({
        attemptId,
        state: "error",
        error: { code, message },
      });
    }
    if (!recovery && ["authFailed", "privateKeyInvalid", "credentialStoreUnavailable"].includes(code)) {
      useSshSessionStore.getState().openCredentials(profile, attemptId, message);
    }
    return null;
  }
}

export async function connectProfile(profile: ConnectionProfile, replaceTabId?: string) {
  const route = await ensureJumpSession(profile);
  if (!route.ok) return null;
  const username = profile.username.trim();
  if (!username || username === "未设置") {
    useSshSessionStore.getState().openCredentials(profile, replaceTabId, "请先输入 SSH 用户名和本次连接凭据。");
    return null;
  }
  if (profile.authMethod === "keyboardInteractive") {
    return connectSsh(profile, username, { method: "keyboardInteractive" }, false, replaceTabId);
  }
  if (profile.authMethod === "privateKey" && !profile.keyRef && !profile.privateKeyPath.trim()) {
    useSshSessionStore.getState().openCredentials(profile, replaceTabId, "请先设置 SSH 私钥文件路径。");
    return null;
  }

  const kind: SavedCredentialKind = profile.authMethod === "privateKey" ? "privateKeyPassphrase" : "password";
  let status: SavedCredentialStatus;
  try {
    status = await invoke<SavedCredentialStatus>("ssh_credential_status", {
      profileId: profile.id,
      username,
      kind,
    });
  } catch {
    useSshSessionStore.getState().openCredentials(profile, replaceTabId, "无法访问本机加密保险库，请手动输入本次 SSH 凭据；设置后可安全记住凭据。");
    return null;
  }

  if (profile.authMethod === "password" && status !== "saved") {
    const notice = status === "unavailable"
      ? "登录凭据保险库已锁定或不可用，请手动输入密码；未保存的密码不会自动重试。"
      : "尚未保存 SSH 密码，请输入本次连接凭据。";
    useSshSessionStore.getState().openCredentials(profile, replaceTabId, notice);
    return null;
  }
  if (status === "unavailable") {
    useSshSessionStore.getState().openCredentials(profile, replaceTabId, "登录凭据保险库已锁定或不可用，请手动输入私钥口令或尝试无口令私钥。");
    return null;
  }
  return connectSavedSsh(profile, replaceTabId, undefined, route.sessionId);
}

function beginAutoReconnect(attemptId: string, errorCode?: string) {
  const session = useSshSessionStore.getState().sessions[attemptId];
  const profile = session && useWorkspaceStore.getState().profiles.find((item) => item.id === session.profile.id);
  const enabled = useSettingsStore.getState().settings.connections.autoReconnectEnabled;
  if (!session || !enabled || !profile?.autoReconnect || profile.authMethod === "keyboardInteractive" || !isRetryableNetworkError(errorCode) || autoReconnectRuns.has(attemptId)) return;
  const run: AutoReconnectRun = {
    profileId: profile.id,
    currentAttemptId: attemptId,
    attempts: 0,
    cancelled: false,
  };
  autoReconnectRuns.set(attemptId, run);
  void runAutoReconnect(run);
}

async function runAutoReconnect(run: AutoReconnectRun) {
  let connected = false;
  while (!run.cancelled && run.attempts < MAX_AUTO_RECONNECT_ATTEMPTS) {
    const profile = useWorkspaceStore.getState().profiles.find((item) => item.id === run.profileId);
    if (!profile?.autoReconnect || profile.authMethod === "keyboardInteractive" || !useSettingsStore.getState().settings.connections.autoReconnectEnabled) break;
    const username = profile.username.trim();
    const kind: SavedCredentialKind = profile.authMethod === "privateKey" ? "privateKeyPassphrase" : "password";
    let credentialStatus: SavedCredentialStatus;
    try {
      credentialStatus = await invoke<SavedCredentialStatus>("ssh_credential_status", {
        profileId: profile.id,
        username,
        kind,
      });
    } catch {
      credentialStatus = "unavailable";
    }
    if (credentialStatus === "unavailable" || (profile.authMethod === "password" && credentialStatus !== "saved")) {
      toast.warning("自动重连已停止：本机登录凭据保险库不可用或缺少已保存凭据。请手动重新连接。");
      break;
    }

    const attempt = run.attempts + 1;
    const delay = reconnectDelayMs(attempt);
    run.attempts = attempt;
    const currentId = run.currentAttemptId;
    useSshSessionStore.getState().setAutoReconnectProgress(currentId, attempt, Date.now() + delay);
    await new Promise<void>((resolve) => {
      run.timer = window.setTimeout(resolve, delay);
    });
    run.timer = undefined;
    if (run.cancelled) break;

    const currentProfile = useWorkspaceStore.getState().profiles.find((item) => item.id === run.profileId);
    if (!currentProfile?.autoReconnect || !useSettingsStore.getState().settings.connections.autoReconnectEnabled) break;
    const result = await connectSavedSsh(currentProfile, run.currentAttemptId, { run, attempt });
    if (result) {
      connected = true;
      useSshSessionStore.getState().setAutoReconnectProgress(run.currentAttemptId, null);
      break;
    }
    if (run.cancelled) break;
    const error = useSshSessionStore.getState().sessions[run.currentAttemptId]?.errorEvent;
    if (!isRetryableNetworkError(error?.code)) {
      toast.warning(error?.code === "hostKeyMismatch"
        ? "自动重连已停止：服务器主机指纹发生变化。"
        : error?.code === "authFailed" || error?.code === "privateKeyInvalid"
          ? "自动重连已停止：SSH 登录凭据被拒绝，请手动重新输入。"
          : `自动重连已停止：${error?.message ?? "连接失败。"}`);
      break;
    }
  }

  const currentId = run.currentAttemptId;
  autoReconnectRuns.delete(currentId);
  useSshSessionStore.getState().setAutoReconnectProgress(currentId, null);
  if (!run.cancelled && !connected && run.attempts >= MAX_AUTO_RECONNECT_ATTEMPTS) {
    toast.warning("自动重连已停止：已达到 5 次尝试上限。可手动重新连接。");
  }
}

function stopAutoReconnect(attemptId: string, notify = true) {
  const run = autoReconnectRuns.get(attemptId);
  if (!run) return false;
  run.cancelled = true;
  if (run.timer !== undefined) window.clearTimeout(run.timer);
  autoReconnectRuns.delete(attemptId);
  const session = useSshSessionStore.getState().sessions[run.currentAttemptId];
  if (session && ["connecting", "verifyingHostKey", "authenticating", "openingPty"].includes(session.state)) {
    void invoke("ssh_cancel_connect", { attemptId: run.currentAttemptId }).catch(() => undefined);
  }
  useSshSessionStore.getState().setAutoReconnectProgress(run.currentAttemptId, null);
  if (notify) toast.message("已停止自动重连。");
  return true;
}

export function cancelAutoReconnect(attemptId: string) {
  return stopAutoReconnect(attemptId);
}

export async function forgetSavedCredential(profile: ConnectionProfile) {
  const kinds: SavedCredentialKind[] = ["password", "privateKeyPassphrase"];
  const usernames = [...new Set([profile.username, ...profile.credentialAccounts].filter((username) => username && username !== "未设置"))];
  await Promise.all(usernames.flatMap((username) => kinds.map((kind) => invoke("ssh_credential_forget", {
    profileId: profile.id,
    username,
    kind,
  }))));
  useWorkspaceStore.getState().clearCredentialAccounts(profile.id);
}

export async function listTrustedHosts() {
  return invoke<TrustedHostSummary[]>("trusted_hosts_list");
}

export async function forgetTrustedHost(host: string, port: number) {
  return invoke<boolean>("trusted_host_forget", { host, port });
}

export async function rotateVerifiedTrustedHost(attemptId: string, opensshPublicKey: string) {
  await invoke("trusted_host_rotate_verified", {
    attemptId,
    opensshPublicKey,
    independentlyVerified: true,
  });
}

export async function decideHostKey(challenge: HostKeyChallenge, decision: "trustOnce" | "trustAndSave" | "reject") {
  await invoke("ssh_host_key_decision", {
    attemptId: challenge.attemptId,
    decision,
  });
  useSshSessionStore.getState().closeHostKeyChallenge(challenge.attemptId);
}

export async function closeSshTab(attemptId: string) {
  const waitingForTrust = useSshSessionStore.getState().hostKeyChallenges.some((item) => item.attemptId === attemptId);
  if (waitingForTrust) {
    void invoke("ssh_host_key_decision", { attemptId, decision: "reject" }).catch(() => undefined);
  }
  releaseAttempt(attemptId);
}

export function sendSshBytes(attemptId: string, bytes: Uint8Array): Promise<void> {
  const session = useSshSessionStore.getState().sessions[attemptId];
  if (session?.state !== "connected" || !session.sessionId) {
    return Promise.reject(new Error("SSH 终端尚未连接。"));
  }
  const sessionId = session.sessionId;
  const previous = inputQueues.get(attemptId) ?? Promise.resolve();
  const write = previous.then(async () => {
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_CHUNK) {
      const chunk = bytes.subarray(offset, Math.min(offset + MAX_WRITE_CHUNK, bytes.length));
      await invoke("ssh_write", { sessionId, data: Array.from(chunk) });
    }
  });
  inputQueues.set(attemptId, write.catch(() => undefined));
  return write;
}

export async function resizeSsh(attemptId: string, cols: number, rows: number) {
  const session = useSshSessionStore.getState().sessions[attemptId];
  if (session?.state !== "connected" || !session.sessionId) return;
  await invoke("ssh_resize", { sessionId: session.sessionId, cols, rows });
}

export function getSshStatusText(attemptId: string) {
  const session = useSshSessionStore.getState().sessions[attemptId];
  return session ? statusLabel(session.state) : "SSH 会话";
}

export type TrustedHostSummary = {
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  firstTrustedAt: number;
  lastVerifiedAt: number;
  source: string;
};
