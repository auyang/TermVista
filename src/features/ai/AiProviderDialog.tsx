import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { listOllamaModels, saveAiProvider, testAiProvider } from "@/features/ai/aiBridge";
import type { AiProviderInput, AiProviderKind, AiProviderModelOption, AiProviderView } from "@/features/ai/aiTypes";

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
    setTestMessage("正在读取 Ollama 已安装模型…");
    try {
      const result = await listOllamaModels(baseUrl, allowInsecureHttp);
      setModels(result);
      setTestMessage(result.length ? `已读取 ${result.length} 个本机模型。` : "Ollama 已连接，但没有已安装模型；请先运行 ollama pull 下载模型。");
    } catch (error) {
      setModels([]);
      setTestMessage(`读取模型失败：${messageOf(error)}`);
    } finally {
      setModelsLoading(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedTimeout = Number(timeoutSeconds);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < 3 || parsedTimeout > 300) {
      toast.error("超时秒数需设置在 3–300 之间。");
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
      toast.success(kind === "ollama" ? "Ollama 配置已保存到本机。" : "模型配置已保存到本机；API Key 由系统凭据库保管。");
    } catch (error) {
      toast.error(`保存模型配置失败：${messageOf(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!provider?.id || apiKey || kind !== provider.kind) {
      setTestMessage("请先保存当前修改，再进行连接测试。");
      return;
    }
    setTesting(true);
    setTestMessage("正在连接模型服务…");
    try {
      const result = await testAiProvider(provider.id);
      const elapsed = result.elapsedMs === undefined ? "" : ` · ${result.elapsedMs} ms`;
      const code = result.errorCode ? `（${result.errorCode}）` : "";
      setTestMessage(result.success ? `连接成功 · ${result.model ?? provider.model}${elapsed}` : `${result.message}${code}${elapsed}`);
    } catch (error) {
      setTestMessage(`连接测试失败：${messageOf(error)}`);
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
          <DialogTitle>模型服务设置</DialogTitle>
          <DialogDescription className="mt-1">Ollama 直接连接本机模型服务；兼容 API 的密钥只保存在系统凭据库。</DialogDescription>
        </div>
        <form className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" onSubmit={(event) => void save(event)}>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              配置名称
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="h-8 rounded-sm text-xs" placeholder={kind === "ollama" ? "例如：本机 Ollama" : "例如：OpenAI API"} />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              服务类型
              <select value={kind} onChange={(event) => chooseKind(event.target.value as AiProviderKind)} className="h-8 rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="openAiCompatible">OpenAI 兼容 API</option>
                <option value="ollama">Ollama 本地模型</option>
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            {kind === "ollama" ? "Ollama 服务地址" : "OpenAI 兼容服务地址"}
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} maxLength={600} required className="h-8 rounded-sm font-mono text-[11px]" placeholder={kind === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1"} autoComplete="off" />
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
              模型名称
              <Input list={kind === "ollama" ? "ollama-model-options" : undefined} value={model} onChange={(event) => setModel(event.target.value)} maxLength={160} required className="h-8 rounded-sm text-xs" placeholder={kind === "ollama" ? "先发现模型，或输入已安装模型名称" : "model-name"} autoComplete="off" />
              {kind === "ollama" && <datalist id="ollama-model-options">{models.map((item) => <option key={item.id} value={item.id} />)}</datalist>}
            </label>
            {kind === "ollama" && <Button type="button" variant="outline" size="sm" className="h-8 rounded-sm px-2 text-[10px]" onClick={() => void discoverModels()} disabled={modelsLoading || saving}>{modelsLoading ? "读取中…" : "发现模型"}</Button>}
          </div>
          {kind === "ollama" && models.some((item) => item.id === model) && <p className="-mt-2 text-[10px] text-muted-foreground">能力：流式输出 {models.find((item) => item.id === model)?.streaming ? "支持" : "未知"} · 工具调用 {models.find((item) => item.id === model)?.toolCalling === undefined ? "未知" : models.find((item) => item.id === model)?.toolCalling ? "支持" : "不支持"}。本应用不会把工具调用授权给模型。</p>}
          {kind === "openAiCompatible" && <label className="grid gap-1 text-[11px] text-muted-foreground">
            API Key {provider?.apiKeyConfigured ? "（已保存；留空保持不变）" : ""}
            <Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); if (event.target.value) setClearApiKey(false); }} maxLength={4096} className="h-8 rounded-sm font-mono text-xs" placeholder={provider?.apiKeyConfigured ? "留空保持现有凭据" : "输入 API Key"} autoComplete="new-password" spellCheck={false} />
          </label>}
          {kind === "ollama" && provider?.apiKeyConfigured && <p className="text-[10px] text-muted-foreground">此配置仍保留已保存的凭据，但 Ollama 不会读取或发送它。</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              请求超时（秒）
              <Input type="number" min={3} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} className="h-8 rounded-sm text-xs" />
            </label>
            <div className="grid content-end gap-1 text-[11px] text-muted-foreground">
              身份验证
              <div className="flex h-8 items-center rounded-sm border border-border bg-panel px-2 text-xs text-foreground">{kind === "ollama" ? "本机服务 · 无 API Key" : "API Key · 系统凭据库"}</div>
            </div>
          </div>
          {kind === "openAiCompatible" && <label className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} className="mt-0.5 accent-primary" />
            <span>允许明文 HTTP。HTTP 会暴露 API Key 与请求内容；只对我明确配置的服务地址使用。</span>
          </label>}
          {needsRemoteOllamaHttpConsent && <label className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} className="mt-0.5 accent-primary" />
            <span>允许连接远程 Ollama 的明文 HTTP。流量未加密，建议使用 HTTPS。</span>
          </label>}
          {provider?.apiKeyConfigured && <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} disabled={Boolean(apiKey)} className="accent-primary" />
            删除已保存的 API Key
          </label>}
          {testMessage && <div className="rounded-sm border border-border bg-panel-header px-2 py-1.5 text-[11px] text-muted-foreground" role="status">{testMessage}</div>}
          <footer className="flex items-center justify-between border-t border-border pt-2">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => void test()} disabled={testing || saving || !provider?.id || (provider.kind === "openAiCompatible" && !provider.apiKeyConfigured) || Boolean(apiKey) || kind !== provider?.kind}>{testing ? "测试中…" : "测试连接"}</Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" size="sm" className="h-7 rounded-sm text-[11px]" disabled={saving || testing}>{saving ? "保存中…" : "保存配置"}</Button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function messageOf(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "请检查地址、网络和配置。";
}

function isLoopbackUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}
