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
import { useTranslation } from "react-i18next";
import { localizedSshError, sshErrorCode } from "@/features/ssh/sshErrors";

export function SshCredentialsDialog() {
  const { t } = useTranslation("connections");
  const profile = useSshSessionStore((state) => state.connectingProfile);
  const replaceTabId = useSshSessionStore((state) => state.connectingTabId);
  const notice = useSshSessionStore((state) => state.credentialNotice);
  const close = useSshSessionStore((state) => state.closeCredentials);

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center gap-2 border-b border-border bg-panel-header px-3">
          <KeyRound size={14} className="text-accent" />
          <DialogTitle>{t("sshAuthTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("sshAuthDescription")}</DialogDescription>
        </header>
        {profile && <CredentialsForm key={`${profile.id}-${replaceTabId ?? "new"}`} profile={profile} replaceTabId={replaceTabId ?? undefined} notice={notice} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

function CredentialsForm({ profile, replaceTabId, notice, close }: { profile: NonNullable<ReturnType<typeof useSshSessionStore.getState>["connectingProfile"]>; replaceTabId?: string; notice: string | null; close: () => void }) {
  const { t } = useTranslation("connections");
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
            {t("username")}
            <Input autoFocus autoComplete="username" className="h-8 rounded-sm text-xs" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            {t("authMethod")}
            <select className="h-8 rounded-sm border border-input bg-background px-2 text-xs text-foreground" value={method} onChange={(event) => { setMethod(event.target.value as "password" | "privateKey" | "keyboardInteractive"); setRememberCredential(false); }}>
              <option value="password">{t("password")}</option>
              <option value="privateKey">{t("privateKeyFile")}</option>
              <option value="keyboardInteractive">{t("keyboardInteractive")}</option>
            </select>
          </label>
          {method === "password" ? (
            <div className="grid gap-1">
              <label htmlFor="ssh-auth-password" className="text-[11px] text-muted-foreground">{t("password")}</label>
              <Input id="ssh-auth-password" autoComplete="current-password" type="password" className="h-8 rounded-sm text-xs" value={password} onChange={(event) => setPassword(event.target.value)} required />
              <label htmlFor="ssh-auth-remember-password" className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                <input id="ssh-auth-remember-password" type="checkbox" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} className="accent-primary" />
                <span>{t("rememberPassword")}</span>
              </label>
            </div>
          ) : method === "privateKey" ? <>
            {keyRef
              ? <p className="rounded-sm border border-border bg-muted/25 px-2 py-1.5 text-[10px] text-muted-foreground">{t("vaultProtectedKey")}</p>
              : <label className="grid gap-1 text-[11px] text-muted-foreground">
                {t("privateKeyPath")}
                <Input className="h-8 rounded-sm font-mono text-xs" placeholder="~/.ssh/id_ed25519" value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} required />
              </label>}
            <div className="grid gap-1">
              <label htmlFor="ssh-private-key-passphrase" className="text-[11px] text-muted-foreground">{t("privateKeyPassphrase")}</label>
              <Input id="ssh-private-key-passphrase" type="password" autoComplete="off" className="h-8 rounded-sm text-xs" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
              {passphrase && <label htmlFor="ssh-auth-remember-passphrase" className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                <input id="ssh-auth-remember-passphrase" type="checkbox" checked={rememberCredential} onChange={(event) => setRememberCredential(event.target.checked)} className="accent-primary" />
                <span>{t("rememberPassphrase")}</span>
              </label>}
            </div>
          </> : <p className="rounded-sm border border-border bg-muted/30 p-2 text-[10px] leading-4 text-muted-foreground">{t("keyboardInteractiveDescription")}</p>}
          {method !== "keyboardInteractive" && <p className="text-[10px] leading-4 text-muted-foreground">{t("credentialSaveDescription")}</p>}
          <footer className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2 text-[10px]" disabled={busy} onClick={() => {
              setBusy(true);
              void forgetSavedCredential(profile).then(() => toast.success(t("forgetCredentials")))
                .catch((error: unknown) => toast.error(t("credentialClearFailed", { error: localizedSshError(sshErrorCode(error)) })))
                .finally(() => setBusy(false));
            }}>{t("forgetCredentials")}</Button>
            <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={close}>{t("cancel")}</Button>
            <Button type="submit" size="sm" className="h-7 rounded-sm px-3" disabled={method === "password" ? !password : method === "privateKey" ? !keyRef && !privateKeyPath.trim() : false}>{t("connect")}</Button>
            </div>
          </footer>
        </form>
  );
}

export function SshAuthPromptDialog() {
  const { t } = useTranslation("connections");
  const prompt = useSshSessionStore((state) => state.authPrompts[0] ?? null);
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => {
      if (!open && prompt) {
        void invoke("ssh_cancel_connect", { attemptId: prompt.attemptId }).catch(() => undefined);
        useSshSessionStore.getState().closeAuthPrompt(prompt.attemptId);
      }
    }}>
      <DialogContent className="gap-0 p-0">
        <DialogDescription className="sr-only">{t("authResponsePrivacy")}</DialogDescription>
        {prompt && <AuthPromptForm key={prompt.promptId} prompt={prompt} />}
      </DialogContent>
    </Dialog>
  );
}

function AuthPromptForm({ prompt }: { prompt: AuthPromptEvent }) {
  const { t } = useTranslation("connections");
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
      setError(localizedSshError(sshErrorCode(reason)));
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
      <DialogTitle className="truncate">{prompt.name || t("serverNeedsMoreAuth")}</DialogTitle>
    </header>
    <form className="grid gap-3 p-4" onSubmit={submit}>
      {prompt.instructions && <p className="whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/30 p-2 text-[10px] leading-4 text-muted-foreground">{prompt.instructions}</p>}
      {prompt.prompts.map((field, index) => <label key={`${index}-${field.prompt}`} className="grid gap-1 text-[11px] text-muted-foreground">
        <span className="whitespace-pre-wrap break-words">{field.prompt || t("verificationItem", { number: index + 1 })}</span>
        <Input
          autoFocus={index === 0}
          type={field.echo ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          className="h-8 rounded-sm text-xs"
          value={responses[index] ?? ""}
          onChange={(event) => setResponses((values) => values.map((value, current) => current === index ? event.target.value : value))}
          aria-label={field.prompt || t("verificationItem", { number: index + 1 })}
        />
      </label>)}
      <p className="text-[10px] leading-4 text-muted-foreground">{t("authResponsePrivacy")}</p>
      {error && <p role="alert" className="text-[10px] text-destructive">{t("submitFailed", { error })}</p>}
      <footer className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3 text-[10px]" disabled={busy} onClick={cancel}>{t("cancelConnection")}</Button>
        <Button type="submit" size="sm" className="h-7 rounded-sm px-3 text-[10px]" disabled={busy}>{t("continueVerification")}</Button>
      </footer>
    </form>
  </>;
}

export function HostKeyDialog() {
  const { t } = useTranslation("connections");
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
          <DialogTitle>{t("hostKeyVerifyTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("firstHostKeyDescription")}</DialogDescription>
        </header>
        {challenge && <div className="grid gap-3 p-4">
          <div className="flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] leading-5">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>{t("verifyTrustedChannel")}</span>
          </div>
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
            <dt className="text-muted-foreground">{t("server")}</dt><dd className="font-mono">{challenge.host}:{challenge.port}</dd>
            <dt className="text-muted-foreground">{t("keyAlgorithm")}</dt><dd className="font-mono">{challenge.keyType}</dd>
            <dt className="text-muted-foreground">{t("fingerprint")}</dt><dd className="break-all font-mono text-accent">{challenge.fingerprintSha256}</dd>
          </dl>
          <p className="text-[10px] leading-4 text-muted-foreground">{t("trustOnceAndPermanent")}</p>
          {error?.attemptId === challenge.attemptId && <p role="alert" className="text-[10px] text-destructive">{t("hostKeySelectionFailed")}</p>}
          <footer className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("reject")}>{t("rejectDisconnect")}</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("trustOnce")}>{t("trustOnce")}</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm px-3" disabled={busy} onClick={() => void respond("trustAndSave")}>{t("savePermanently")}</Button>
          </footer>
        </div>}
      </DialogContent>
    </Dialog>
  );
}

export function HostKeyMismatchDialog() {
  const { t } = useTranslation("connections");
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
          <DialogTitle>{t("serverIdentityChanged")}</DialogTitle>
          <DialogDescription className="sr-only">{t("identityChangedDescription")}</DialogDescription>
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
  const { t } = useTranslation("connections");
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
        toast.success(t("trustedKeyUpdated"), { duration: 6000 });
        onDismiss();
      })
      .catch((error: unknown) => toast.error(t("trustedKeyUpdateFailed", { error: localizedSshError(sshErrorCode(error)) })))
      .finally(() => setBusy(false));
  };

  return <form className="grid gap-3 p-4" onSubmit={rotate}>
    <p role="alert" className="rounded-sm border border-destructive/35 bg-destructive/5 p-2.5 text-[11px] leading-5 text-foreground">
      {t("identityBlockedDetail")}
    </p>
    {details ? <>
      <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
        <dt className="text-muted-foreground">{t("server")}</dt><dd className="font-mono">{details.host}:{details.port}</dd>
        <dt className="text-muted-foreground">{t("keyAlgorithm")}</dt><dd className="font-mono">{details.keyType}</dd>
        <dt className="text-muted-foreground">{t("oldTrustedFingerprint")}</dt><dd className="break-all font-mono">{details.priorFingerprint}</dd>
        <dt className="text-muted-foreground">{t("observedFingerprint")}</dt><dd className="break-all font-mono text-destructive">{details.currentFingerprint}</dd>
      </dl>
      <label className="grid gap-1 text-[10px] text-muted-foreground">
        {t("newPublicKey")}
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
        {t("confirmCurrentFingerprint")}
        <Input className="h-7 rounded-sm font-mono text-[10px]" value={confirmedFingerprint} onChange={(event) => setConfirmedFingerprint(event.target.value)} autoComplete="off" required />
        {confirmedFingerprint && !fingerprintMatches && <span className="text-destructive">{t("fingerprintMismatch")}</span>}
      </label>
      <label className="flex items-start gap-2 text-[10px] leading-4 text-foreground">
        <input className="mt-0.5 accent-primary" type="checkbox" checked={independentlyVerified} onChange={(event) => setIndependentlyVerified(event.target.checked)} />
        {t("independentVerificationConfirm")}
      </label>
      <p className="text-[10px] leading-4 text-muted-foreground">{t("rotationDescription")}</p>
    </> : <p className="text-[10px] text-destructive">{t("rotationUnavailable")}</p>}
    <footer className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
      <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-3" onClick={onOpenTrustedHosts}>{t("viewTrustedHosts")}</Button>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={onDismiss}>{t("dismissWarning")}</Button>
        <Button type="submit" size="sm" className="h-7 rounded-sm px-3" disabled={busy || !details || !fingerprintMatches || !independentlyVerified || !publicKey.trim()}>
          {busy ? t("verifying") : t("verifyAndUpdate")}
        </Button>
      </div>
    </footer>
  </form>;
}
