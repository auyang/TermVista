import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { listOllamaModels, saveAiProvider, testAiProvider } from "@/features/ai/aiBridge";
import type { AiProviderInput, AiProviderKind, AiProviderModelOption, AiProviderView } from "@/features/ai/aiTypes";
import { useTranslation } from "react-i18next";

export function AiProviderDialog({
  open,
  provider,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  provider: AiProviderView | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (provider: AiProviderView) => void;
}) {
  const { t } = useTranslation("ai");
  const [kind, setKind] = useState<AiProviderKind>(provider?.kind ?? "openAiCompatible");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(provider?.timeoutSeconds ?? 60));
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(provider?.allowInsecureHttp ?? false);
  const [models, setModels] = useState<AiProviderModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const needsRemoteOllamaHttpConsent = kind === "ollama" && baseUrl.trim().startsWith("http://") && !isLoopbackUrl(baseUrl);

  const discoverModels = async () => {
    if (kind !== "ollama") return;
    setModelsLoading(true);
    setTestMessage(t("provider.discovering"));
    try {
      const result = await listOllamaModels(baseUrl, allowInsecureHttp);
      setModels(result);
      setTestMessage(result.length ? t("provider.modelsRead", { count: result.length }) : t("provider.noModels"));
    } catch {
      setModels([]);
      setTestMessage(t("provider.modelsFailed"));
    } finally {
      setModelsLoading(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedTimeout = Number(timeoutSeconds);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < 3 || parsedTimeout > 300) {
      toast.error(t("provider.timeoutRange"));
      return;
    }
    const input: AiProviderInput = {
      providerId: provider?.id,
      name,
      kind,
      baseUrl,
      model,
      timeoutSeconds: parsedTimeout,
      apiKey: kind === "openAiCompatible" ? apiKey || undefined : undefined,
      clearApiKey: clearApiKey && !apiKey,
      allowInsecureHttp,
    };
    setSaving(true);
    setTestMessage("");
    try {
      const saved = await saveAiProvider(input);
      setApiKey("");
      onSaved(saved);
      onOpenChange(false);
      toast.success(kind === "ollama" ? t("provider.ollamaSaved") : t("provider.providerSaved"));
    } catch {
      toast.error(t("provider.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!provider?.id || apiKey || kind !== provider.kind) {
      setTestMessage(t("provider.saveBeforeTest"));
      return;
    }
    setTesting(true);
    setTestMessage(t("provider.connecting"));
    try {
      const result = await testAiProvider(provider.id);
      const elapsed = result.elapsedMs === undefined ? "" : ` · ${result.elapsedMs} ms`;
      const code = result.errorCode ? `（${result.errorCode}）` : "";
      setTestMessage(result.success ? t("provider.connected", { model: result.model ?? provider.model, elapsed }) : `${t("provider.testFailed")}${code}${elapsed}`);
    } catch {
      setTestMessage(t("provider.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  const chooseKind = (next: AiProviderKind) => {
    setKind(next);
    setModels([]);
    setTestMessage("");
    if (next === "ollama" && !baseUrl) setBaseUrl("http://127.0.0.1:11434");
    if (next === "openAiCompatible" && !baseUrl) setBaseUrl("https://api.example.com/v1");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(540px,calc(100vw-24px))] gap-3 p-4">
        <div>
          <DialogTitle>{t("provider.title")}</DialogTitle>
          <DialogDescription className="mt-1">{t("provider.description")}</DialogDescription>
        </div>
        <form className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" onSubmit={(event) => void save(event)}>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              {t("provider.configName")}
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="h-8 rounded-sm text-xs" placeholder={kind === "ollama" ? t("provider.ollamaExample") : t("provider.apiExample")} />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              {t("provider.serviceType")}
              <select value={kind} onChange={(event) => chooseKind(event.target.value as AiProviderKind)} className="h-8 rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="openAiCompatible">{t("provider.openAiCompatible")}</option>
                <option value="ollama">{t("provider.ollamaLocal")}</option>
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            {kind === "ollama" ? t("provider.ollamaAddress") : t("provider.apiAddress")}
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} maxLength={600} required className="h-8 rounded-sm font-mono text-[11px]" placeholder={kind === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1"} autoComplete="off" />
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
              {t("provider.modelName")}
              <Input list={kind === "ollama" ? "ollama-model-options" : undefined} value={model} onChange={(event) => setModel(event.target.value)} maxLength={160} required className="h-8 rounded-sm text-xs" placeholder={kind === "ollama" ? t("provider.discoverPlaceholder") : "model-name"} autoComplete="off" />
              {kind === "ollama" && <datalist id="ollama-model-options">{models.map((item) => <option key={item.id} value={item.id} />)}</datalist>}
            </label>
            {kind === "ollama" && <Button type="button" variant="outline" size="sm" className="h-8 rounded-sm px-2 text-[10px]" onClick={() => void discoverModels()} disabled={modelsLoading || saving}>{modelsLoading ? t("provider.discovering") : t("provider.discover")}</Button>}
          </div>
          {kind === "ollama" && models.some((item) => item.id === model) && <p className="-mt-2 text-[10px] text-muted-foreground">{t("provider.capabilities", {
            streaming: models.find((item) => item.id === model)?.streaming ? t("provider.supported") : t("provider.unknown"),
            tools: models.find((item) => item.id === model)?.toolCalling === undefined ? t("provider.unknown") : models.find((item) => item.id === model)?.toolCalling ? t("provider.supported") : t("provider.unsupported"),
          })}</p>}
          {kind === "openAiCompatible" && <label className="grid gap-1 text-[11px] text-muted-foreground">
            {t("provider.apiKey")} {provider?.apiKeyConfigured ? t("provider.savedKeepBlank") : ""}
            <Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); if (event.target.value) setClearApiKey(false); }} maxLength={4096} className="h-8 rounded-sm font-mono text-xs" placeholder={provider?.apiKeyConfigured ? t("provider.keepSavedCredential") : t("provider.enterApiKey")} autoComplete="new-password" spellCheck={false} />
          </label>}
          {kind === "ollama" && provider?.apiKeyConfigured && <p className="text-[10px] text-muted-foreground">{t("provider.ollamaStoredKey")}</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              {t("provider.timeout")}
              <Input type="number" min={3} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} className="h-8 rounded-sm text-xs" />
            </label>
            <div className="grid content-end gap-1 text-[11px] text-muted-foreground">
              {t("provider.authentication")}
              <div className="flex h-8 items-center rounded-sm border border-border bg-panel px-2 text-xs text-foreground">{kind === "ollama" ? t("provider.localNoKey") : t("provider.systemCredential")}</div>
            </div>
          </div>
          {kind === "openAiCompatible" && <label className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} className="mt-0.5 accent-primary" />
            <span>{t("provider.allowHttp")}</span>
          </label>}
          {needsRemoteOllamaHttpConsent && <label className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} className="mt-0.5 accent-primary" />
            <span>{t("provider.allowRemoteOllamaHttp")}</span>
          </label>}
          {provider?.apiKeyConfigured && <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} disabled={Boolean(apiKey)} className="accent-primary" />
            {t("provider.deleteKey")}
          </label>}
          {testMessage && <div className="rounded-sm border border-border bg-panel-header px-2 py-1.5 text-[11px] text-muted-foreground" role="status">{testMessage}</div>}
          <footer className="flex items-center justify-between border-t border-border pt-2">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => void test()} disabled={testing || saving || !provider?.id || (provider.kind === "openAiCompatible" && !provider.apiKeyConfigured) || Boolean(apiKey) || kind !== provider?.kind}>{testing ? t("provider.testing") : t("provider.test")}</Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => onOpenChange(false)}>{t("provider.cancel")}</Button>
              <Button type="submit" size="sm" className="h-7 rounded-sm text-[11px]" disabled={saving || testing}>{saving ? t("provider.saving") : t("provider.save")}</Button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function isLoopbackUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}
