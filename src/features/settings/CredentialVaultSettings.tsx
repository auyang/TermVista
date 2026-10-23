import { useCallback, useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SshKeyManager } from "@/features/settings/SshKeyManager";
import { runWithUpdateMaintenanceTask } from "@/features/updater/maintenanceTasks";

type VaultStatus = {
  state: "uninitialized" | "locked" | "unlocked";
  mode: "keychain" | "masterPassword" | null;
};

export function CredentialVaultSettings() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMasterSetup, setShowMasterSetup] = useState(false);
  const [showMasterRotation, setShowMasterRotation] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const refresh = useCallback(async () => {
    const result = await invoke<VaultStatus>("credential_vault_status");
    setStatus(result);
    setError(null);
  }, []);

  useEffect(() => {
    let current = true;
    void invoke<VaultStatus>("credential_vault_status").then((result) => {
      if (current) setStatus(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { current = false; };
  }, []);

  const run = useCallback(async (operation: () => Promise<VaultStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await runWithUpdateMaintenanceTask("更新凭据保险库", operation));
      setPassword("");
      setConfirmation("");
      setShowMasterSetup(false);
      setShowMasterRotation(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPassword("");
      setConfirmation("");
      setBusy(false);
    }
  }, []);

  const initializeMasterPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("两次输入的主密码不一致。");
      return;
    }
    void run(() => invoke<VaultStatus>("credential_vault_initialize_master_password", { password }));
  };

  const unlockMasterPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(() => invoke<VaultStatus>("credential_vault_unlock", { password }));
  };

  const rotateMasterPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("两次输入的新主密码不一致。");
      return;
    }
    if (!window.confirm("轮换会重新加密保险库中的所有本机凭据。确认继续？")) return;
    const newMasterPassword = password;
    void run(() => invoke<VaultStatus>("credential_vault_rotate", { newMasterPassword }));
  };

  const rotateKeychainKey = () => {
    if (!window.confirm("轮换会重新生成主密钥并重新加密保险库中的所有本机凭据。确认继续？")) return;
    void run(() => invoke<VaultStatus>("credential_vault_rotate", { newMasterPassword: null }));
  };

  return <>
    <section className="mb-3 rounded-sm border border-border bg-muted/20 p-3" aria-labelledby="credential-vault-heading">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 id="credential-vault-heading" className="text-[11px] font-semibold text-foreground">登录凭据保险库</h3>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {status?.state === "unlocked"
              ? `保险库已解锁，${status.mode === "keychain" ? "主密钥由本机安全凭据库保护" : "本次由主密码解锁"}。密码与私钥口令以 AES-256-GCM 加密保存。`
              : status?.state === "locked"
                ? status.mode === "masterPassword"
                  ? "保险库已锁定。输入主密码后，已保存的登录凭据才能用于连接。"
                  : "保险库已锁定。可重新读取本机安全凭据库中的主密钥。"
                : status?.state === "uninitialized"
                  ? "设置后，选择安全记住的密码和私钥口令会加密保存在本机。"
                  : "正在读取本机保险库状态…"}
          </p>

          {!status && !error && <div className="mt-2 h-7 animate-pulse rounded-sm bg-muted" />}

          {status?.state === "uninitialized" && !showMasterSetup && <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_initialize_keychain"))}>
              <KeyRound size={12} />使用本机安全凭据库
            </Button>
            <Button type="button" variant="outline" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setError(null); setShowMasterSetup(true); }}>
              使用主密码
            </Button>
          </div>}

          {showMasterSetup && status?.state === "uninitialized" && <form className="mt-2 grid max-w-[430px] gap-2" onSubmit={initializeMasterPassword}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label="新保险库主密码" placeholder="主密码，至少 12 个字符" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label="确认保险库主密码" placeholder="再次输入主密码" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex gap-2">
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>创建保险库</Button>
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setShowMasterSetup(false); setPassword(""); setConfirmation(""); }}>取消</Button>
            </div>
          </form>}

          {status?.state === "locked" && status.mode === "masterPassword" && <form className="mt-2 flex max-w-[430px] gap-2" onSubmit={unlockMasterPassword}>
            <input type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label="保险库主密码" placeholder="输入主密码" className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>解锁</Button>
          </form>}

          {status?.state === "locked" && status.mode === "keychain" && <Button type="button" size="xs" className="mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_unlock"))}>
            <LockKeyhole size={12} />解锁保险库
          </Button>}

          {status?.state === "unlocked" && <Button type="button" variant="outline" size="xs" className="mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_lock"))}>
            <LockKeyhole size={12} />立即锁定
          </Button>}

          {status?.state === "unlocked" && status.mode === "keychain" && <Button type="button" variant="outline" size="xs" className="ml-2 mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={rotateKeychainKey}>
            轮换主密钥并重新加密
          </Button>}

          {status?.state === "unlocked" && status.mode === "masterPassword" && !showMasterRotation && <Button type="button" variant="outline" size="xs" className="ml-2 mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setError(null); setShowMasterRotation(true); }}>
            更改主密码并轮换
          </Button>}

          {status?.state === "unlocked" && status.mode === "masterPassword" && showMasterRotation && <form className="mt-2 grid max-w-[430px] gap-2" onSubmit={rotateMasterPassword}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label="新保险库主密码" placeholder="新主密码，至少 12 个字符" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label="确认新保险库主密码" placeholder="再次输入新主密码" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex gap-2">
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>轮换并重新加密</Button>
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setShowMasterRotation(false); setPassword(""); setConfirmation(""); }}>取消</Button>
            </div>
          </form>}

          {error && <div role="alert" className="mt-2 rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">{error}<button type="button" className="ml-2 underline" onClick={() => void refresh().catch(() => undefined)}>重试</button></div>}
        </div>
      </div>
    </section>
    <SshKeyManager enabled={status?.state === "unlocked"} />
  </>;
}
