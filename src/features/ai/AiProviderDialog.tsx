import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { saveAiProvider, testAiProvider } from "@/features/ai/aiBridge";
import type { AiProviderInput, AiProviderView } from "@/features/ai/aiTypes";

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
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(provider?.timeoutSeconds ?? 60));
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(provider?.allowInsecureHttp ?? false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState("");

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
      kind: "openAiCompatible",
      baseUrl,
      model,
      timeoutSeconds: parsedTimeout,
      apiKey: apiKey || undefined,
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
      toast.success("模型配置已保存到本机；API Key 由系统凭据库保管。");
    } catch (error) {
      toast.error(`保存模型配置失败：${messageOf(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!provider?.id || apiKey) {
      setTestMessage("请先保存当前修改，再进行连接测试。");
      return;
    }
    setTesting(true);
    setTestMessage("正在连接模型服务…");
    try {
      const result = await testAiProvider(provider.id);
      setTestMessage(result.success ? `连接成功 · ${result.model ?? provider.model}` : result.message);
    } catch (error) {
      setTestMessage(`连接测试失败：${messageOf(error)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(540px,calc(100vw-24px))] gap-3 p-4">
        <div>
          <DialogTitle>模型服务设置</DialogTitle>
          <DialogDescription className="mt-1">API Key 只写入本机系统凭据库，不进入应用配置或浏览器存储。</DialogDescription>
        </div>
        <form className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1" onSubmit={(event) => void save(event)}>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            配置名称
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="h-8 rounded-sm text-xs" placeholder="例如：OpenAI API" />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            OpenAI 兼容服务地址
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} maxLength={600} required className="h-8 rounded-sm font-mono text-[11px]" placeholder="https://api.example.com/v1" autoComplete="off" />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            模型名称
            <Input value={model} onChange={(event) => setModel(event.target.value)} maxLength={160} required className="h-8 rounded-sm text-xs" placeholder="model-name" autoComplete="off" />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            API Key {provider?.apiKeyConfigured ? "（已保存；留空保持不变）" : ""}
            <Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); if (event.target.value) setClearApiKey(false); }} maxLength={4096} className="h-8 rounded-sm font-mono text-xs" placeholder={provider?.apiKeyConfigured ? "留空保持现有凭据" : "输入 API Key"} autoComplete="new-password" spellCheck={false} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              请求超时（秒）
              <Input type="number" min={3} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} className="h-8 rounded-sm text-xs" />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Provider
              <Input value="OpenAI 兼容 API" readOnly className="h-8 rounded-sm text-xs" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} className="mt-0.5 accent-primary" />
            <span>允许明文 HTTP。HTTP 会暴露 API Key 与请求内容；只对我明确配置的服务地址使用。</span>
          </label>
          {provider?.apiKeyConfigured && <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} disabled={Boolean(apiKey)} className="accent-primary" />
            删除已保存的 API Key
          </label>}
          {testMessage && <div className="rounded-sm border border-border bg-panel-header px-2 py-1.5 text-[11px] text-muted-foreground" role="status">{testMessage}</div>}
          <footer className="flex items-center justify-between border-t border-border pt-2">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[11px]" onClick={() => void test()} disabled={testing || saving || !provider?.apiKeyConfigured || Boolean(apiKey)}>{testing ? "测试中…" : "测试连接"}</Button>
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
