import { useState, type FormEvent } from "react";
import { Fingerprint, KeyRound, ShieldAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { connectSsh, decideHostKey, forgetSavedCredential, rotateVerifiedTrustedHost } from "@/features/ssh/sshBridge";
import type { SshErrorDetails } from "@/features/ssh/sshTypes";
import type { AuthPromptEvent } from "@/features/ssh/sshTypes";

export function SshCredentialsDialog() {
  const profile = useSshSessionStore((state) => state.connectingProfile);
  const replaceTabId = useSshSessionStore((state) => state.connectingTabId);
  const notice = useSshSessionStore((state) => state.credentialNotice);
  const close = useSshSessionStore((state) => state.closeCredentials);

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center gap-2 border-b border-border bg-panel-header px-3">
          <KeyRound size={14} className="text-accent" />
          <DialogTitle>SSH 身份验证</DialogTitle>
          <DialogDescription className="sr-only">凭据只用于本次连接，不会保存到界面配置。</DialogDescription>
        </header>
        {profile && <CredentialsForm key={`${profile.id}-${replaceTabId ?? "new"}`} profile={profile} replaceTabId={replaceTabId ?? undefined} notice={notice} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

function CredentialsForm({ profile, replaceTabId, notice, close }: { profile: NonNullable<ReturnType<typeof useSshSessionStore.getState>["connectingProfile"]>; replaceTabId?: string; notice: string | null; close: () => void }) {
  const [method, setMethod] = useState<"password" | "privateKey" | "keyboardInteractive">(profile.authMethod);
  const [username, setUsername] = useState(profile.username !== "未设置" ? profile.username : "");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState(profile.privateKeyPath);
  const [keyRef] = useState(profile.keyRef);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [rememberCredential, setRememberCredential] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim()) return;
    const auth = method === "password"
      ? { method: "password" as const, password }
      : method === "privateKey"
        ? { method: "privateKey" as const, privateKeyPath: keyRef ? "" : privateKeyPath.trim(), ...(keyRef ? { keyRef } : {}), ...(passphrase ? { passphrase } : {}) }
        : { method: "keyboardInteractive" as const };
    void connectSsh(profile, username.trim(), auth, rememberCredential, replaceTabId);
    setPassword("");
    setPassphrase("");
    close();
  };

  return (
        <form className="grid gap-3 p-4" onSubmit={submit}>
          {notice && <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] leading-4 text-amber-700 dark:text-amber-300">{notice}</p>}
          <div className="truncate rounded-sm border border-border bg-background/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
            {profile.host}:{profile.port || 22}
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            用户名
            <Input autoFocus autoComplete="username" className="h-8 rounded-sm text-xs" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            认证方式
            <select className="h-8 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={method} onChange={(event) => { setMethod(event.target.value as "password" | "privateKey" | "keyboardInteractive"); setRememberCredential(false); }}>
              <option value="password">密码</option>
              <option value="privateKey">私钥文件</option>
              <option value="keyboardInteractive">多重提示（密码/验证码）</option>
            </select>
          </label>
          {method === "password" ? (
            <div className="grid gap-1">
              <label htmlFor="ssh-auth-password" className="text-[11px] text-muted-foreground">密码</label>
              <Input id="ssh-auth-password" autoComplete="current-password" type="password" className="h-8 rounded-sm text-xs" value={password} onChange={(event) => setPassword(event.target.value)} required />
              <label htmlFor="ssh-auth-remember-password" className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                <input id="ssh-auth-remember-password" type="checkbox" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} className="accent-primary" />
                <span>记住密码</span>
              </label>
            </div>
          ) : method === "privateKey" ? <>
            {keyRef
              ? <p className="rounded-sm border border-border bg-muted/25 px-2 py-1.5 text-[10px] text-muted-foreground">使用连接配置中受保险库保护的 SSH 密钥。</p>
              : <label className="grid gap-1 text-[11px] text-muted-foreground">
                私钥文件路径
                <Input className="h-8 rounded-sm font-mono text-xs" placeholder="~/.ssh/id_ed25519" value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} required />
              </label>}
            <div className="grid gap-1">
              <label htmlFor="ssh-private-key-passphrase" className="text-[11px] text-muted-foreground">私钥口令（如有）</label>
              <Input id="ssh-private-key-passphrase" type="password" autoComplete="off" className="h-8 rounded-sm text-xs" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
              {passphrase && <label htmlFor="ssh-auth-remember-passphrase" className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                <input id="ssh-auth-remember-passphrase" type="checkbox" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} className="accent-primary" />
                <span>记住私钥口令</span>
              </label>}
            </div>
          </> : <p className="rounded-sm border border-border bg-muted/30 p-2 text-[10px] leading-4 text-muted-foreground">服务器会在连接过程中逐项请求密码、验证码或其他响应。输入内容仅用于当前 SSH 认证，不会保存或用于自动重连。</p>}
          {method !== "keyboardInteractive" && <p className="text-[10px] leading-4 text-muted-foreground">默认仅用于本次连接。勾选保存前，请先在“设置 → 连接与安全”中设置保险库。凭据仅在主机验证和登录成功后加密保存；保险库不可用时不会明文降级。</p>}
          <footer className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={busy} onClick={() => {
              setBusy(true);
              void forgetSavedCredential(profile).then(() => toast.success("已清除该配置下保存的 SSH 凭据。"))
                .catch((error: unknown) => toast.error(`无法清除已保存凭据：${error instanceof Error ? error.message : String(error)}`))
                .finally(() => setBusy(false));
            }}>忘记已存凭据</Button>
            <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={close}>取消</Button>
            <Button type="submit" size="sm" className="h-7 rounded-sm px-3" disabled={method === "password" ? !password : method === "privateKey" ? !keyRef && !privateKeyPath.trim() : false}>连接</Button>
            </div>
          </footer>
        </form>
  );
}

export function SshAuthPromptDialog() {
  const prompt = useSshSessionStore((state) => state.authPrompts[0] ?? null);
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => {
      if (!open && prompt) {
        void invoke("ssh_cancel_connect", { attemptId: prompt.attemptId }).catch(() => undefined);
        useSshSessionStore.getState().closeAuthPrompt(prompt.attemptId);
      }
    }}>
      <DialogContent className="gap-0 p-0">
        <DialogDescription className="sr-only">輸入 SSH 服務器要求的多重提示認證內容；輸入只用於本次連接。</DialogDescription>
        {prompt && <AuthPromptForm key={prompt.promptId} prompt={prompt} />}
      </DialogContent>
    </Dialog>
  );
}

function AuthPromptForm({ prompt }: { prompt: AuthPromptEvent }) {
  const [responses, setResponses] = useState(() => prompt.prompts.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void invoke("ssh_auth_respond", {
      attemptId: prompt.attemptId,
      promptId: prompt.promptId,
      responses,
    }).then(() => {
      setResponses((values) => values.map(() => ""));
      useSshSessionStore.getState().closeAuthPrompt(prompt.attemptId, prompt.promptId);
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setBusy(false));
  };

  const cancel = () => {
    setResponses((values) => values.map(() => ""));
    void invoke("ssh_cancel_connect", { attemptId: prompt.attemptId }).catch(() => undefined);
    useSshSessionStore.getState().closeAuthPrompt(prompt.attemptId);
  };

  return <>
    <header className="flex h-10 items-center gap-2 border-b border-border bg-panel-header px-3">
      <ShieldAlert size={14} className="text-accent" />
      <DialogTitle className="truncate">{prompt.name || "服务器需要额外验证"}</DialogTitle>
    </header>
    <form className="grid gap-3 p-4" onSubmit={submit}>
      {prompt.instructions && <p className="whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/30 p-2 text-[10px] leading-4 text-muted-foreground">{prompt.instructions}</p>}
      {prompt.prompts.map((field, index) => <label key={`${index}-${field.prompt}`} className="grid gap-1 text-[11px] text-muted-foreground">
        <span className="whitespace-pre-wrap break-words">{field.prompt || `验证项目 ${index + 1}`}</span>
        <Input
          autoFocus={index === 0}
          type={field.echo ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          className="h-8 rounded-sm text-xs"
          value={responses[index] ?? ""}
          onChange={(event) => setResponses((values) => values.map((value, current) => current === index ? event.target.value : value))}
          aria-label={field.prompt || `验证项目 ${index + 1}`}
        />
      </label>)}
      <p className="text-[10px] leading-4 text-muted-foreground">密码、验证码及其他响应只发给当前 SSH 连接，不会保存，也不会用于自动重连。</p>
      {error && <p role="alert" className="text-[10px] text-destructive">提交失败：{error}</p>}
      <footer className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3 text-[10px]" disabled={busy} onClick={cancel}>取消连接</Button>
        <Button type="submit" size="sm" className="h-7 rounded-sm px-3 text-[10px]" disabled={busy}>继续验证</Button>
      </footer>
    </form>
  </>;
}

export function HostKeyDialog() {
  const challenge = useSshSessionStore((state) => state.hostKeyChallenges[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ attemptId: string; message: string } | null>(null);

  const respond = async (decision: "trustOnce" | "trustAndSave" | "reject") => {
    if (!challenge || busy) return;
    setBusy(true);
    setError(null);
    try {
      await decideHostKey(challenge, decision);
    } catch (reason) {
      setError({
        attemptId: challenge.attemptId,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={challenge !== null} onOpenChange={(open) => { if (!open && challenge) void respond("reject"); }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center gap-2 border-b border-border bg-panel-header px-3">
          <Fingerprint size={14} className="text-accent" />
          <DialogTitle>验证 SSH 主机密钥</DialogTitle>
          <DialogDescription className="sr-only">首次连接时确认服务器公钥指纹。</DialogDescription>
        </header>
        {challenge && <div className="grid gap-3 p-4">
          <div className="flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] leading-5">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>请通过可信渠道核对这个指纹。仅在确认它属于目标服务器时选择信任。</span>
          </div>
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
            <dt className="text-muted-foreground">服务器</dt><dd className="font-mono">{challenge.host}:{challenge.port}</dd>
            <dt className="text-muted-foreground">密钥算法</dt><dd className="font-mono">{challenge.keyType}</dd>
            <dt className="text-muted-foreground">SHA256 指纹</dt><dd className="break-all font-mono text-accent">{challenge.fingerprintSha256}</dd>
          </dl>
          <p className="text-[10px] leading-4 text-muted-foreground">“本次信任”只对当前 SSH 连接有效；“永久保存”会把公钥写入本机受保护的主机密钥记录，后续连接自动校验。</p>
          {error?.attemptId === challenge.attemptId && <p role="alert" className="text-[10px] text-destructive">主机密钥选择未能完成：{error.message}</p>}
          <footer className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("reject")}>拒绝并断开</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("trustOnce")}>仅本次信任</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("trustAndSave")}>永久保存</Button>
          </footer>
        </div>}
      </DialogContent>
    </Dialog>
  );
}

export function HostKeyMismatchDialog() {
  const sessions = useSshSessionStore((state) => state.sessions);
  const mismatch = Object.values(sessions).find((session) => session.errorEvent?.code === "hostKeyMismatch");
  const details = mismatch?.errorEvent?.details;
  const [dismissedAttemptId, setDismissedAttemptId] = useState<string | null>(null);

  return (
    <Dialog open={Boolean(mismatch && dismissedAttemptId !== mismatch.attemptId)} onOpenChange={(open) => {
      if (!open && mismatch) setDismissedAttemptId(mismatch.attemptId);
    }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3">
          <ShieldAlert size={14} className="text-destructive" />
          <DialogTitle>服务器身份发生变化</DialogTitle>
          <DialogDescription className="sr-only">服务器公钥与本机可信记录不同，连接已被阻止。</DialogDescription>
        </header>
        {mismatch && <HostKeyMismatchContent
          key={mismatch.attemptId}
          attemptId={mismatch.attemptId}
          details={details?.kind === "hostKeyChanged" ? details : null}
          onDismiss={() => setDismissedAttemptId(mismatch.attemptId)}
          onOpenTrustedHosts={() => {
            setDismissedAttemptId(mismatch.attemptId);
            useWorkspaceStore.getState().setManagerView("trustedHosts");
            useWorkspaceStore.getState().setManagerOpen(true);
          }}
        />}
      </DialogContent>
    </Dialog>
  );
}

function HostKeyMismatchContent({
  attemptId,
  details,
  onDismiss,
  onOpenTrustedHosts,
}: {
  attemptId: string;
  details: Extract<SshErrorDetails, { kind: "hostKeyChanged" }> | null;
  onDismiss: () => void;
  onOpenTrustedHosts: () => void;
}) {
  const [publicKey, setPublicKey] = useState("");
  const [confirmedFingerprint, setConfirmedFingerprint] = useState("");
  const [independentlyVerified, setIndependentlyVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const fingerprintMatches = Boolean(details && confirmedFingerprint.trim() === details.currentFingerprint);

  const rotate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!details || !fingerprintMatches || !independentlyVerified || !publicKey.trim()) return;
    setBusy(true);
    void rotateVerifiedTrustedHost(attemptId, publicKey.trim())
      .then(() => {
        toast.success("已更新可信主机密钥记录。请手动重新连接。", { duration: 6000 });
        onDismiss();
      })
      .catch((error: unknown) => toast.error(`未更新可信主机记录：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setBusy(false));
  };

  return <form className="grid gap-3 p-4" onSubmit={rotate}>
    <p role="alert" className="rounded-sm border border-destructive/35 bg-destructive/5 p-2.5 text-[11px] leading-5 text-foreground">
      连接已停止，未发送 SSH 登录凭据。请从服务器控制台或其他独立可信渠道取得新公钥；不确定时请关闭此窗口并联系管理员。
    </p>
    {details ? <>
      <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
        <dt className="text-muted-foreground">服务器</dt><dd className="font-mono">{details.host}:{details.port}</dd>
        <dt className="text-muted-foreground">密钥算法</dt><dd className="font-mono">{details.keyType}</dd>
        <dt className="text-muted-foreground">可信旧指纹</dt><dd className="break-all font-mono">{details.priorFingerprint}</dd>
        <dt className="text-muted-foreground">当前观察指纹</dt><dd className="break-all font-mono text-destructive">{details.currentFingerprint}</dd>
      </dl>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        从独立可信渠道取得的 OpenSSH 主机公钥
        <textarea
          className="min-h-16 resize-y rounded-sm border border-input bg-background px-2 py-1.5 font-mono text-[10px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="ssh-ed25519 AAAA…"
          required
        />
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        再次输入已独立核验的当前指纹
        <Input className="h-7 rounded-sm font-mono text-[10px]" value={confirmedFingerprint} onChange={(event) => setConfirmedFingerprint(event.target.value)} autoComplete="off" required />
        {confirmedFingerprint && !fingerprintMatches && <span className="text-destructive">输入与当前观察指纹不一致。</span>}
      </label>
      <label className="flex items-start gap-2 text-[10px] leading-4 text-foreground">
        <input className="mt-0.5 accent-primary" type="checkbox" checked={independentlyVerified} onChange={(event) => setIndependentlyVerified(event.target.checked)} />
        我已通过独立可信渠道核对上面的服务器公钥和指纹，并确认它属于此服务器。
      </label>
      <p className="text-[10px] leading-4 text-muted-foreground">客户端会校验粘贴公钥与本次网络观察到的密钥一致，并要求旧可信记录未变化。更新后不会自动连接，请重新发起 SSH 连接。</p>
    </> : <p className="text-[10px] text-destructive">缺少本次连接的指纹详情，不能执行安全轮换。</p>}
    <footer className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-3" onClick={onOpenTrustedHosts}>查看可信主机记录</Button>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={onDismiss}>关闭警告</Button>
        <Button type="submit" size="sm" className="h-7 rounded-sm px-3" disabled={busy || !details || !fingerprintMatches || !independentlyVerified || !publicKey.trim()}>
          {busy ? "正在核验…" : "核验并更新记录"}
        </Button>
      </div>
    </footer>
  </form>;
}
