import { useCallback, useEffect, useState, type FormEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteSshKey, exportSshKey, generateSshKey, importSshKey, listSshKeys, type SshKeyMetadata } from "@/features/settings/sshKeyBridge";

export function SshKeyManager({ enabled }: { enabled: boolean }) {
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void listSshKeys().then((items) => {
      if (active) setKeys(items);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
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
      toast.success("SSH 密钥已生成并加密保存到本机保险库。");
      await refresh();
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setBusy(false));
  };

  const chooseImportFile = async () => {
    try {
      const result = await open({
        multiple: false,
        directory: false,
        title: "选择 OpenSSH 私钥",
        filters: [{ name: "SSH 私钥", extensions: ["*", "pem", "key"] }],
      });
      if (typeof result === "string") {
        setImportPath(result);
        const segments = result.split(/[\\/]/);
        setImportAlias((value) => value || segments[segments.length - 1]?.replace(/\.[^.]+$/, "") || "导入的密钥");
        setError(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
        toast.success("SSH 私钥已验证并加密保存到本机保险库。");
        await refresh();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setBusy(false));
  };

  const exportKey = (event: FormEvent<HTMLFormElement>, key: SshKeyMetadata) => {
    event.preventDefault();
    if (!enabled || busy) return;
    if (exportPassphrase !== exportConfirmation) {
      setError("两次输入的导出私钥口令不一致。");
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
      title: "导出加密 SSH 私钥",
      defaultPath: `${fileAlias}.openssh`,
      filters: [{ name: "OpenSSH 私钥", extensions: ["openssh", "key"] }],
    }).then(async (path) => {
      if (!path) return;
      await exportSshKey({
        keyId: key.id,
        path,
        ...(currentPassphrase ? { currentPassphrase } : {}),
        exportPassphrase: newPassphrase,
      });
      setExportingKeyId(null);
      toast.success("已导出使用新口令加密的 SSH 私钥。");
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      setExportCurrentPassphrase("");
      setExportPassphrase("");
      setExportConfirmation("");
      setBusy(false);
    });
  };

  const removeKey = (key: SshKeyMetadata) => {
    if (key.references > 0) return;
    if (!window.confirm(`删除“${key.alias}”及其保险库中的私钥？此操作无法撤销。`)) return;
    setBusy(true);
    setError(null);
    void deleteSshKey(key.id).then(async (deleted) => {
      if (deleted) toast.success(`已删除密钥“${key.alias}”。`);
      await refresh();
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setBusy(false));
  };

  const copyPublicKey = async (key: SshKeyMetadata) => {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      setCopiedId(key.id);
      window.setTimeout(() => setCopiedId((current) => current === key.id ? null : current), 1200);
    } catch {
      toast.error("无法复制 SSH 公钥，请检查系统剪贴板权限。");
    }
  };

  return <section className="mt-3 rounded-sm border border-border bg-background/40 p-3" aria-labelledby="ssh-key-manager-heading">
    <div className="mb-2 flex items-center gap-2">
      <KeyRound size={14} className="text-primary" />
      <h3 id="ssh-key-manager-heading" className="text-[11px] font-semibold text-foreground">SSH 密钥</h3>
      <span className="text-[9px] text-muted-foreground">{enabled ? `${keys.length} 个` : "保险库解锁后可管理"}</span>
    </div>

    {enabled && <>
      <form className="grid gap-2 border-b border-border/70 pb-3" onSubmit={createKey}>
        <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
          <Input aria-label="新密钥名称" className="h-7 rounded-sm text-[10px]" placeholder="密钥名称" maxLength={64} value={alias} onChange={(event) => setAlias(event.target.value)} required />
          <select aria-label="新密钥类型" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground" value={keyType} onChange={(event) => setKeyType(event.target.value as typeof keyType)}>
            <option value="ed25519">Ed25519</option>
            <option value="rsa">RSA</option>
            <option value="ecdsaP256">ECDSA P-256</option>
          </select>
        </div>
        {keyType === "rsa" && <select aria-label="RSA 密钥长度" className="h-7 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground" value={rsaBits} onChange={(event) => setRsaBits(Number(event.target.value) as 3072 | 4096)}>
          <option value={3072}>RSA 3072 位</option>
          <option value={4096}>RSA 4096 位</option>
        </select>}
        <div className="flex gap-2">
          <Input aria-label="生成私钥口令" autoComplete="new-password" type="password" className="h-7 min-w-0 flex-1 rounded-sm text-[10px]" placeholder="私钥口令，至少 8 个字符" minLength={8} maxLength={1024} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required />
          <Button type="submit" size="xs" className="h-7 shrink-0 rounded-sm text-[10px]" disabled={busy || !enabled}><Plus size={12} />生成</Button>
        </div>
        <p className="text-[9px] leading-4 text-muted-foreground">私钥以口令加密后存入本机保险库；口令需妥善保存。</p>
      </form>

      <form className="grid gap-2 border-b border-border/70 py-3" onSubmit={importKey}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{importPath ? importPath.split(/[\\/]/).pop() : "选择要导入的 OpenSSH 私钥"}</span>
          <Button type="button" variant="outline" size="xs" className="h-7 shrink-0 rounded-sm text-[10px]" disabled={busy} onClick={() => void chooseImportFile()}><Upload size={12} />选择文件</Button>
        </div>
        {importPath && <>
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="导入密钥名称" className="h-7 rounded-sm text-[10px]" placeholder="密钥名称" maxLength={64} value={importAlias} onChange={(event) => setImportAlias(event.target.value)} required />
            <Input aria-label="导入私钥口令" autoComplete="current-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder="加密私钥口令（如有）" maxLength={1024} value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} />
          </div>
          <div className="flex justify-end"><Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}><Upload size={12} />加密导入</Button></div>
        </>}
      </form>

      {loading ? <p className="py-3 text-[10px] text-muted-foreground">正在读取密钥列表…</p> : keys.length === 0 ? <p className="py-3 text-[10px] text-muted-foreground">暂无已保存的 SSH 密钥。</p> : <ul className="divide-y divide-border/70">
        {keys.map((key) => <li key={key.id} className="py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium text-foreground"><span className="truncate">{key.alias}</span><span className="rounded-sm border border-border px-1 text-[9px] text-muted-foreground">{key.keyType}</span><span className="text-muted-foreground">创建于 {new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(key.createdAt)}</span><span className="text-muted-foreground">{key.references ? `已用于 ${key.references} 个连接` : "未关联连接"}</span></div>
              <div className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{key.fingerprint}</div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[9px] text-accent">显示公钥</summary>
                <code className="mt-1 block break-all rounded-sm bg-muted/35 p-1.5 font-mono text-[9px] text-foreground">{key.publicKey}</code>
              </details>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={`复制 ${key.alias} 公钥`} title="复制公钥" onClick={() => void copyPublicKey(key)}>{copiedId === key.id ? <Check size={12} /> : <Copy size={12} />}</Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={`导出 ${key.alias} 私钥`} title="导出加密私钥" disabled={busy} onClick={() => { setError(null); setExportingKeyId((current) => current === key.id ? null : key.id); setExportCurrentPassphrase(""); setExportPassphrase(""); setExportConfirmation(""); }}><Download size={12} /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive" aria-label={`删除密钥 ${key.alias}`} title={key.references ? `仍被 ${key.references} 个连接引用` : "删除密钥"} disabled={busy || key.references > 0} onClick={() => removeKey(key)}><Trash2 size={12} /></Button>
            </div>
          </div>
          {exportingKeyId === key.id && <form className="mt-2 grid gap-2 rounded-sm border border-border/70 bg-muted/15 p-2" onSubmit={(event) => exportKey(event, key)}>
            <p className="text-[9px] leading-4 text-muted-foreground">导出文件会使用新口令加密，并以仅当前用户可读的权限创建。已加密的源私钥还需输入当前口令；目标文件名必须尚不存在。</p>
            <Input aria-label="当前私钥口令" autoComplete="current-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder="当前私钥口令（源密钥已加密时填写）" maxLength={1024} value={exportCurrentPassphrase} onChange={(event) => setExportCurrentPassphrase(event.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="导出私钥口令" autoComplete="new-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder="新导出口令，至少 8 个字符" minLength={8} maxLength={1024} required value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} />
              <Input aria-label="确认导出私钥口令" autoComplete="new-password" type="password" className="h-7 rounded-sm text-[10px]" placeholder="再次输入新口令" minLength={8} maxLength={1024} required value={exportConfirmation} onChange={(event) => setExportConfirmation(event.target.value)} />
            </div>
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy} onClick={() => { setExportingKeyId(null); setExportCurrentPassphrase(""); setExportPassphrase(""); setExportConfirmation(""); }}>取消</Button>
              <Button type="submit" size="xs" className="h-7 rounded-sm text-[10px]" disabled={busy}><Download size={12} />选择导出位置</Button>
            </div>
          </form>}
        </li>)}
      </ul>}
    </>}
    {error && <div role="alert" className="mt-2 rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">{error}<button type="button" className="ml-2 underline" onClick={() => void refresh()}>重试</button></div>}
  </section>;
}
