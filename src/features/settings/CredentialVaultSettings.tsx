import { useCallback, useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SshKeyManager } from "@/features/settings/SshKeyManager";
import { runWithUpdateMaintenanceTask } from "@/features/updater/maintenanceTasks";
import { useTranslation } from "react-i18next";

type VaultStatus = {
  state: "uninitialized" | "locked" | "unlocked";
  mode: "keychain" | "masterPassword" | null;
};

export function CredentialVaultSettings() {
  const { t } = useTranslation("settings");
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
    }).catch(() => {
      if (current) setError("error");
    });
    return () => { current = false; };
  }, []);

  const run = useCallback(async (operation: () => Promise<VaultStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await runWithUpdateMaintenanceTask("vaultUpdate", operation));
      setPassword("");
      setConfirmation("");
      setShowMasterSetup(false);
      setShowMasterRotation(false);
    } catch {
      setError("error");
    } finally {
      setPassword("");
      setConfirmation("");
      setBusy(false);
    }
  }, []);

  const initializeMasterPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("mismatch");
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
      setError("newMismatch");
      return;
    }
    if (!window.confirm(t("vault.confirmRotate"))) return;
    const newMasterPassword = password;
    void run(() => invoke<VaultStatus>("credential_vault_rotate", { newMasterPassword }));
  };

  const rotateKeychainKey = () => {
    if (!window.confirm(t("vault.confirmKeychainRotate"))) return;
    void run(() => invoke<VaultStatus>("credential_vault_rotate", { newMasterPassword: null }));
  };

  return <>
    <section className="mb-3 rounded-sm border border-border bg-muted/20 p-3" aria-labelledby="credential-vault-heading">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 id="credential-vault-heading" className="text-[11px] font-semibold text-foreground">{t("vault.title")}</h3>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {status?.state === "unlocked"
              ? status.mode === "keychain" ? t("vault.unlockedKeychain") : t("vault.unlockedPassword")
              : status?.state === "locked"
                ? status.mode === "masterPassword"
                  ? t("vault.lockedPassword")
                  : t("vault.lockedKeychain")
                : status?.state === "uninitialized"
                  ? t("vault.uninitialized")
                  : t("vault.loading")}
          </p>

          {!status && !error && <div className="mt-2 h-7 animate-pulse rounded-sm bg-muted" />}

          {status?.state === "uninitialized" && !showMasterSetup && <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_initialize_keychain"))}>
              <KeyRound size={12} />{t("vault.useKeychain")}
            </Button>
            <Button type="button" variant="outline" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setError(null); setShowMasterSetup(true); }}>
              {t("vault.useMasterPassword")}
            </Button>
          </div>}

          {showMasterSetup && status?.state === "uninitialized" && <form className="mt-2 grid max-w-[430px] gap-2" onSubmit={initializeMasterPassword}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label={t("vault.newPassword")} placeholder={t("vault.passwordMin")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label={t("vault.confirmPassword")} placeholder={t("vault.repeatPassword")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex gap-2">
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>{t("vault.create")}</Button>
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setShowMasterSetup(false); setPassword(""); setConfirmation(""); }}>{t("vault.cancel")}</Button>
            </div>
          </form>}

          {status?.state === "locked" && status.mode === "masterPassword" && <form className="mt-2 flex max-w-[430px] gap-2" onSubmit={unlockMasterPassword}>
            <input type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label={t("vault.currentPassword")} placeholder={t("vault.enterPassword")} className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>{t("vault.unlock")}</Button>
          </form>}

          {status?.state === "locked" && status.mode === "keychain" && <Button type="button" size="xs" className="mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_unlock"))}>
            <LockKeyhole size={12} />{t("vault.unlockVault")}
          </Button>}

          {status?.state === "unlocked" && <Button type="button" variant="outline" size="xs" className="mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => void run(() => invoke<VaultStatus>("credential_vault_lock"))}>
            <LockKeyhole size={12} />{t("vault.lockNow")}
          </Button>}

          {status?.state === "unlocked" && status.mode === "keychain" && <Button type="button" variant="outline" size="xs" className="ml-2 mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={rotateKeychainKey}>
            {t("vault.rotateKey")}
          </Button>}

          {status?.state === "unlocked" && status.mode === "masterPassword" && !showMasterRotation && <Button type="button" variant="outline" size="xs" className="ml-2 mt-2 h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setError(null); setShowMasterRotation(true); }}>
            {t("vault.changePassword")}
          </Button>}

          {status?.state === "unlocked" && status.mode === "masterPassword" && showMasterRotation && <form className="mt-2 grid max-w-[430px] gap-2" onSubmit={rotateMasterPassword}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={(event) => setPassword(event.target.value)} aria-label={t("vault.newPassword")} placeholder={t("vault.newPasswordMin")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label={t("vault.confirmNewPassword")} placeholder={t("vault.repeatNewPassword")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <div className="flex gap-2">
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}>{t("vault.rotate")}</Button>
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setShowMasterRotation(false); setPassword(""); setConfirmation(""); }}>{t("vault.cancel")}</Button>
            </div>
          </form>}

          {error && <div role="alert" className="mt-2 rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">{error === "mismatch" ? t("vault.mismatch") : error === "newMismatch" ? t("vault.newMismatch") : t("vault.error")}<button type="button" className="ml-2 underline" onClick={() => void refresh().catch(() => undefined)}>{t("vault.retry")}</button></div>}
        </div>
      </div>
    </section>
    <SshKeyManager enabled={status?.state === "unlocked"} />
  </>;
}
