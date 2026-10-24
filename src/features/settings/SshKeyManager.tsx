import { useCallback, useEffect, useState, type FormEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteSshKey, exportSshKey, generateSshKey, importSshKey, listSshKeys, type SshKeyMetadata } from "@/features/settings/sshKeyBridge";
import { useTranslation } from "react-i18next";
import i18next from "@/i18n";

export function SshKeyManager({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("settings");
  const [keys, setKeys] = useState<SshKeyMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  const [keyType, setKeyType] = useState<"ed25519" | "rsa" | "ecdsaP256">("ed25519");
  const [rsaBits, setRsaBits] = useState<3072 | 4096>(3072);
  const [passphrase, setPassphrase] = useState("");
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importAlias, setImportAlias] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [exportingKeyId, setExportingKeyId] = useState<string | null>(null);
  const [exportCurrentPassphrase, setExportCurrentPassphrase] = useState("");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setKeys(await listSshKeys());
      setError(null);
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void listSshKeys().then((items) => {
      if (active) setKeys(items);
    }).catch(() => {
      if (active) setError("error");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [enabled]);

  const createKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || busy) return;
    setBusy(true);
    setError(null);
    const keyPassphrase = passphrase;
    setPassphrase("");
    void generateSshKey({
      alias: alias.trim(),
      keyType,
      ...(keyType === "rsa" ? { rsaBits } : {}),
      passphrase: keyPassphrase,
    }).then(async () => {
      setAlias("");
      setPassphrase("");
      toast.success(t("keyManager.generated"));
      await refresh();
    }).catch(() => {
      setError("error");
    }).finally(() => setBusy(false));
  };

  const chooseImportFile = async () => {
    try {
      const result = await open({
        multiple: false,
        directory: false,
        title: t("keyManager.importPrompt"),
        filters: [{ name: t("keyManager.title"), extensions: ["*", "pem", "key"] }],
      });
      if (typeof result === "string") {
        setImportPath(result);
        const segments = result.split(/[\\/]/);
        setImportAlias((value) => value || segments[segments.length - 1]?.replace(/\.[^.]+$/, "") || t("keyManager.title"));
        setError(null);
      }
    } catch {
      setError("error");
    }
  };

  const importKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || busy || !importPath) return;
    setBusy(true);
    setError(null);
    const keyPassphrase = importPassphrase;
    setImportPassphrase("");
    void importSshKey({ path: importPath, alias: importAlias.trim(), ...(keyPassphrase ? { passphrase: keyPassphrase } : {}) })
      .then(async () => {
        setImportPath(null);
        setImportAlias("");
        setImportPassphrase("");
        toast.success(t("keyManager.imported"));
        await refresh();
      })
      .catch(() => {
        setError("error");
      })
      .finally(() => setBusy(false));
  };

  const exportKey = (event: FormEvent<HTMLFormElement>, key: SshKeyMetadata) => {
    event.preventDefault();
    if (!enabled || busy) return;
    if (exportPassphrase !== exportConfirmation) {
      setError("passphraseMismatch");
      return;
    }
    const currentPassphrase = exportCurrentPassphrase;
    const newPassphrase = exportPassphrase;
    const fileAlias = key.alias.replace(/[\\/]/g, "_").trim() || "ssh-key";
    setBusy(true);
    setError(null);
    setExportCurrentPassphrase("");
    setExportPassphrase("");
    setExportConfirmation("");
    void save({
      title: t("keyManager.exportTitle"),
      defaultPath: `${fileAlias}.openssh`,
      filters: [{ name: t("keyManager.title"), extensions: ["openssh", "key"] }],
    }).then(async (path) => {
      if (!path) return;
      await exportSshKey({
        keyId: key.id,
        path,
        ...(currentPassphrase ? { currentPassphrase } : {}),
        exportPassphrase: newPassphrase,
      });
      setExportingKeyId(null);
      toast.success(t("keyManager.exported"));
    }).catch(() => {
      setError("error");
    }).finally(() => {
      setExportCurrentPassphrase("");
      setExportPassphrase("");
      setExportConfirmation("");
      setBusy(false);
    });
  };

  const removeKey = (key: SshKeyMetadata) => {
    if (key.references > 0) return;
    if (!window.confirm(t("keyManager.deleteConfirm", { alias: key.alias }))) return;
    setBusy(true);
    setError(null);
    void deleteSshKey(key.id).then(async (deleted) => {
      if (deleted) toast.success(t("keyManager.deleted", { alias: key.alias }));
      await refresh();
    }).catch(() => {
      setError("error");
    }).finally(() => setBusy(false));
  };

  const copyPublicKey = async (key: SshKeyMetadata) => {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      setCopiedId(key.id);
      window.setTimeout(() => setCopiedId((current) => current === key.id ? null : current), 1200);
    } catch {
      toast.error(t("keyManager.copyFailed"));
    }
  };

  return <section className="mt-3 rounded-sm border border-border bg-background/40 p-3" aria-labelledby="ssh-key-manager-heading">
    <div className="mb-2 flex items-center gap-2">
      <KeyRound size={14} className="text-primary" />
      <h3 id="ssh-key-manager-heading" className="text-[11px] font-semibold text-foreground">{t("keyManager.title")}</h3>
      <span className="text-[9px] text-muted-foreground">{enabled ? t("keyManager.count", { count: keys.length }) : t("keyManager.locked")}</span>
    </div>

    {enabled && <>
      <form className="grid gap-2 border-b border-border/70 pb-3" onSubmit={createKey}>
        <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
          <Input aria-label={t("keyManager.newName")} className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.keyName")} maxLength={64} value={alias} onChange={(event) => setAlias(event.target.value)} required />
          <select aria-label={t("keyManager.keyType")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground" value={keyType} onChange={(event) => setKeyType(event.target.value as typeof keyType)}>
            <option value="ed25519">Ed25519</option>
            <option value="rsa">RSA</option>
            <option value="ecdsaP256">ECDSA P-256</option>
          </select>
        </div>
        {keyType === "rsa" && <select aria-label={t("keyManager.rsaLength")} className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground" value={rsaBits} onChange={(event) => setRsaBits(Number(event.target.value) as 3072 | 4096)}>
          <option value={3072}>{t("keyManager.rsa3072")}</option>
          <option value={4096}>{t("keyManager.rsa4096")}</option>
        </select>}
        <div className="flex gap-2">
          <Input aria-label={t("keyManager.generatePassphrase")} autoComplete="new-password" type="password" className="h-7 min-w-0 flex-1 rounded-sm text-[10px]" placeholder={t("keyManager.generatePassphrase")} minLength={8} maxLength={1024} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required />
          <Button type="submit" size="xs" className="h-7 shrink-0 rounded-sm text-[10px]" disabled={busy || !enabled}><Plus size={12} />{t("keyManager.generate")}</Button>
        </div>
        <p className="text-[9px] leading-4 text-muted-foreground">{t("keyManager.passphraseStorage")}</p>
      </form>

      <form className="grid gap-2 border-b border-border/70 py-3" onSubmit={importKey}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{importPath ? importPath.split(/[\\/]/).pop() : t("keyManager.importPrompt")}</span>
          <Button type="button" variant="outline" size="xs" className="h-7 shrink-0 rounded-sm text-[10px]" disabled={busy} onClick={() => void chooseImportFile()}><Upload size={12} />{t("keyManager.chooseFile")}</Button>
        </div>
        {importPath && <>
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label={t("keyManager.importName")} className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.keyName")} maxLength={64} value={importAlias} onChange={(event) => setImportAlias(event.target.value)} required />
            <Input aria-label={t("keyManager.importPassphrase")} autoComplete="current-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.importPassphrase")} maxLength={1024} value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} />
          </div>
          <div className="flex justify-end"><Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}><Upload size={12} />{t("keyManager.encryptImport")}</Button></div>
        </>}
      </form>

      {loading ? <p className="py-3 text-[10px] text-muted-foreground">{t("keyManager.loading")}</p> : keys.length === 0 ? <p className="py-3 text-[10px] text-muted-foreground">{t("keyManager.empty")}</p> : <ul className="divide-y divide-border/70">
        {keys.map((key) => <li key={key.id} className="py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium text-foreground"><span className="truncate">{key.alias}</span><span className="rounded-sm border border-border px-1 text-[9px] text-muted-foreground">{key.keyType}</span><span className="text-muted-foreground">{t("keyManager.createdAt", { date: new Intl.DateTimeFormat(i18next.resolvedLanguage ?? "en-US", { year: "numeric", month: "short", day: "numeric" }).format(key.createdAt) })}</span><span className="text-muted-foreground">{key.references ? t("keyManager.usedBy", { count: key.references }) : t("keyManager.unlinked")}</span></div>
              <div className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{key.fingerprint}</div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[9px] text-accent">{t("keyManager.showPublic")}</summary>
                <code className="mt-1 block break-all rounded-sm bg-muted/35 p-1.5 font-mono text-[9px] text-foreground">{key.publicKey}</code>
              </details>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("keyManager.copyPublicAria", { alias: key.alias })} title={t("keyManager.copyPublicTitle")} onClick={() => void copyPublicKey(key)}>{copiedId === key.id ? <Check size={12} /> : <Copy size={12} />}</Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={t("keyManager.exportPrivateAria", { alias: key.alias })} title={t("keyManager.exportTitle")} disabled={busy} onClick={() => { setError(null); setExportingKeyId((current) => current === key.id ? null : key.id); setExportCurrentPassphrase(""); setExportPassphrase(""); setExportConfirmation(""); }}><Download size={12} /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" aria-label={t("keyManager.deleteAria", { alias: key.alias })} title={key.references ? t("keyManager.referenced", { count: key.references }) : t("keyManager.deleteTitle")} disabled={busy || key.references > 0} onClick={() => removeKey(key)}><Trash2 size={12} /></Button>
            </div>
          </div>
          {exportingKeyId === key.id && <form className="mt-2 grid gap-2 rounded-sm border border-border/70 bg-muted/15 p-2" onSubmit={(event) => exportKey(event, key)}>
            <p className="text-[9px] leading-4 text-muted-foreground">{t("keyManager.exportSafety")}</p>
            <Input aria-label={t("keyManager.currentPassphrase")} autoComplete="current-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.sourcePassphraseHint")} maxLength={1024} value={exportCurrentPassphrase} onChange={(event) => setExportCurrentPassphrase(event.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label={t("keyManager.newExportPassphrase")} autoComplete="new-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.newExportPassphrase")} minLength={8} maxLength={1024} required value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} />
              <Input aria-label={t("keyManager.confirmExportPassphrase")} autoComplete="new-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder={t("keyManager.repeatExportPassphrase")} minLength={8} maxLength={1024} required value={exportConfirmation} onChange={(event) => setExportConfirmation(event.target.value)} />
            </div>
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setExportingKeyId(null); setExportCurrentPassphrase(""); setExportPassphrase(""); setExportConfirmation(""); }}>{t("keyManager.cancel")}</Button>
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}><Download size={12} />{t("keyManager.chooseExport")}</Button>
            </div>
          </form>}
        </li>)}
      </ul>}
    </>}
    {error && <div role="alert" className="mt-2 rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">{error === "passphraseMismatch" ? t("keyManager.passphraseMismatch") : t("keyManager.error")}<button type="button" className="ml-2 underline" onClick={() => void refresh()}>{t("keyManager.retry")}</button></div>}
  </section>;
}
