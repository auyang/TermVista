import { useEffect, useMemo, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { LoaderCircle, Save, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { listAiProviders, previewAiContext, saveAiTunnelSuggestion, startAiChat } from "@/features/ai/aiBridge";
import type { AiContextPreview, AiProviderView, AiStreamEvent, AiTunnelProtocol } from "@/features/ai/aiTypes";
import i18next from "@/i18n";
import { useTranslation } from "react-i18next";

type CopilotMode = "tunnelDiagnose" | "tunnelSuggest";
type TunnelCopilotRule = { id: string; name: string; protocol: AiTunnelProtocol };
type TunnelReport = {
  summary: string;
  facts: Array<{ text: string; evidenceIds: string[] }>;
  possibleCauses: Array<{ cause: string; confidence: "low" | "medium" | "high"; uncertainty: string; evidenceIds: string[] }>;
  recommendations: Array<{ text: string; evidenceIds: string[] }>;
};
type TunnelProposal = {
  summary: string;
  proposalToken: string;
  proposal: {
    action: "create" | "updateSelected";
    protocol: AiTunnelProtocol;
    name: string;
    groupName: string;
    localHost: string;
    localPort: number;
    targetHost: string | null;
    targetPort: number | null;
  };
};

function parseReport(value: string): TunnelReport {
  const parsed = JSON.parse(value) as TunnelReport;
  if (!parsed.summary || !Array.isArray(parsed.facts) || !Array.isArray(parsed.possibleCauses) || !Array.isArray(parsed.recommendations)) {
    throw new Error("invalid response");
  }
  return parsed;
}

function parseProposal(value: string): TunnelProposal {
  const parsed = JSON.parse(value) as TunnelProposal;
  if (!parsed.proposalToken || !parsed.summary || !parsed.proposal?.name || !parsed.proposal.localPort) {
    throw new Error("invalid response");
  }
  return parsed;
}

function invokeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  if (typeof error === "string") {
    try { return String((JSON.parse(error) as { code?: string }).code ?? "generic"); } catch { return "generic"; }
  }
  return "generic";
}

export function TunnelCopilotDialog({
  open,
  onOpenChange,
  sessionId,
  rule,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  rule: TunnelCopilotRule | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation("tunnels");
  const { t: aiT } = useTranslation("ai");
  const [providers, setProviders] = useState<AiProviderView[]>([]);
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<CopilotMode>("tunnelDiagnose");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<AiContextPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<TunnelReport | null>(null);
  const [proposal, setProposal] = useState<TunnelProposal | null>(null);
  const [requestError, setRequestError] = useState("");

  const provider = useMemo(() => providers.find((item) => item.id === providerId) ?? null, [providerId, providers]);
  const providerNeedsKey = Boolean(provider?.apiKeyRequired && !provider.apiKeyConfigured);
  const errorMessage = (code: string) => {
    switch (code) {
      case "invalidTunnelDiagnostic": return String(t("copilot.errors.invalidTunnelDiagnostic"));
      case "invalidTunnelSuggestion": return String(t("copilot.errors.invalidTunnelSuggestion"));
      case "tunnelContextChanged": return String(t("copilot.errors.tunnelContextChanged"));
      case "sessionUnavailable": return String(t("copilot.errors.sessionUnavailable"));
      case "tunnelSessionMismatch": return String(t("copilot.errors.tunnelSessionMismatch"));
      case "providerNotFound": return String(t("copilot.errors.providerNotFound"));
      case "ruleRunning": return String(t("copilot.errors.ruleRunning"));
      default: return String(t("copilot.errors.generic"));
    }
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    void listAiProviders().then((items) => {
      if (!active) return;
      setProviders(items);
      setProviderId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
    }).catch(() => {
      if (active) setRequestError(t("copilot.noProviders"));
    });
    return () => { active = false; };
  }, [open, t]);

  const close = () => {
    setPreview(null);
    setReport(null);
    setProposal(null);
    setRequestError("");
    onOpenChange(false);
  };

  const preparePreview = async () => {
    if (!rule || !sessionId || !provider || providerNeedsKey || !prompt.trim()) return;
    setPreviewBusy(true);
    setRequestError("");
    setReport(null);
    setProposal(null);
    try {
      const next = await previewAiContext({
        sessionId,
        providerId: provider.id,
        prompt: prompt.trim(),
        sources: [{ kind: "tunnelRule", ruleId: rule.id, protocol: rule.protocol }],
        includeHistory: false,
        mode,
        uiLanguage: i18next.resolvedLanguage ?? "en-US",
      });
      setPreview(next);
    } catch (error) {
      setRequestError(errorMessage(invokeErrorCode(error)));
    } finally {
      setPreviewBusy(false);
    }
  };

  const sendReviewedContext = async () => {
    if (!preview || !provider || preview.sessionId !== sessionId || preview.providerDestination !== provider.baseUrl || preview.providerModel !== provider.model) {
      setPreview(null);
      setRequestError(t("copilot.errors.tunnelContextChanged"));
      return;
    }
    setSending(true);
    setRequestError("");
    let acceptedRequestId = "";
    let output = "";
    const queued: AiStreamEvent[] = [];
    const consume = (event: AiStreamEvent) => {
      if (event.sessionId !== preview.sessionId || (acceptedRequestId && event.requestId !== acceptedRequestId)) return;
      if (event.type === "delta") output += event.text;
      if (event.type === "error") {
        setRequestError(errorMessage(event.code));
        setSending(false);
      }
      if (event.type === "completed") {
        try {
          if (mode === "tunnelDiagnose") setReport(parseReport(output));
          else setProposal(parseProposal(output));
        } catch {
          setRequestError(t("copilot.errors.generic"));
        }
        setSending(false);
      }
      if (event.type === "cancelled") setSending(false);
    };
    const channel = new Channel<AiStreamEvent>();
    channel.onmessage = (event) => {
      if (!acceptedRequestId) queued.push(event);
      else consume(event);
    };
    try {
      const accepted = await startAiChat(preview.sessionId, provider.id, preview.snapshotId, channel);
      acceptedRequestId = accepted.requestId;
      queued.forEach(consume);
      setPreview(null);
    } catch {
      setRequestError(t("copilot.errors.generic"));
      setSending(false);
    }
  };

  const saveProposal = async () => {
    if (!proposal) return;
    setSaving(true);
    setRequestError("");
    try {
      await saveAiTunnelSuggestion(proposal.proposalToken, true);
      setProposal(null);
      toast.success(t("copilot.saved"));
      onSaved();
    } catch (error) {
      setRequestError(invokeErrorCode(error) === "ruleRunning" ? String(t("copilot.errors.ruleRunning")) : String(t("copilot.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const evidence = (ids: string[]) => <span className="font-mono text-[9px] text-muted-foreground">{ids.map((id) => `〔${id}〕`).join(" ")}</span>;
  const content = preview ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
      <p className="text-[10px] leading-4 text-muted-foreground">{t("copilot.previewHint")}</p>
      <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-sm border border-border/60 bg-panel-header/40 p-2 text-[10px]">
        <span className="text-muted-foreground">{t("copilot.provider")}</span><span className="truncate">{provider?.name} · {preview.providerModel}</span>
        <span className="text-muted-foreground">{aiT("panel.destination")}</span><span className="truncate font-mono">{preview.providerDestination}</span>
        <span className="text-muted-foreground">{aiT("panel.sshSession")}</span><span className="truncate">{preview.hostLabel}</span>
        <span className="text-muted-foreground">{aiT("panel.hostFingerprint")}</span><span className="break-all font-mono text-[9px]">{preview.hostFingerprintSha256}</span>
        <span className="text-muted-foreground">{t("name")}</span><span className="truncate">{rule?.name}</span>
      </div>
      <div className="compact-scrollbar min-h-0 flex-1 overflow-auto rounded-sm border border-border/60">
        <div className="border-b border-border/50 bg-panel-header/50 px-2 py-1 text-[10px] font-medium">{t("copilot.redactedPayload")}</div>
        <pre className="whitespace-pre-wrap break-words p-2 font-mono text-[9px] leading-4">{preview.redactedPreview}</pre>
      </div>
      <p className="text-[9px] leading-4 text-amber-700 dark:text-amber-300">{aiT("panel.redactionWarning")}</p>
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setPreview(null)}>{t("cancel")}</Button>
        <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={sending} onClick={() => void sendReviewedContext()}>{t("copilot.confirmSend")}</Button>
      </div>
    </div>
  ) : report ? (
    <div className="compact-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[11px]">
      <section className="rounded-sm border border-border/60 bg-panel-header/30 p-2"><h3 className="mb-1 text-[10px] font-semibold">{t("copilot.summary")}</h3><p className="leading-5">{report.summary}</p></section>
      <section><h3 className="mb-1 text-[10px] font-semibold">{t("copilot.facts")}</h3><ul className="space-y-1.5">{report.facts.map((item, index) => <li key={index} className="leading-5">• {item.text}<div>{evidence(item.evidenceIds)}</div></li>)}</ul></section>
      <section><h3 className="mb-1 text-[10px] font-semibold">{t("copilot.possibleCauses")}</h3><ul className="space-y-1.5">{report.possibleCauses.map((item, index) => <li key={index} className="leading-5">• {item.cause} <span className="text-muted-foreground">({t("copilot.confidence")}: {item.confidence})</span><div className="text-muted-foreground">{item.uncertainty}</div><div>{evidence(item.evidenceIds)}</div></li>)}</ul></section>
      <section><h3 className="mb-1 text-[10px] font-semibold">{t("copilot.recommendations")}</h3><ul className="space-y-1.5">{report.recommendations.map((item, index) => <li key={index} className="leading-5">• {item.text}<div>{evidence(item.evidenceIds)}</div></li>)}</ul></section>
    </div>
  ) : proposal ? (
    <div className="compact-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[11px]">
      <section className="rounded-sm border border-accent/25 bg-accent/5 p-2"><h3 className="mb-1 text-[10px] font-semibold">{t("copilot.proposal")}</h3><p className="leading-5">{proposal.summary}</p></section>
      <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-sm border border-border/60 bg-panel-header/30 p-2">
        <dt className="text-muted-foreground">{t("copilot.mode")}</dt><dd>{proposal.proposal.action === "create" ? t("copilot.actionCreate") : t("copilot.actionUpdate")}</dd>
        <dt className="text-muted-foreground">{t("copilot.protocol")}</dt><dd>{proposal.proposal.protocol === "localTcp" ? "TCP" : "SOCKS5"}</dd>
        <dt className="text-muted-foreground">{t("copilot.name")}</dt><dd className="break-words">{proposal.proposal.name}</dd>
        <dt className="text-muted-foreground">{t("copilot.group")}</dt><dd className="break-words">{proposal.proposal.groupName || t("defaultGroup")}</dd>
        <dt className="text-muted-foreground">{t("copilot.localAddress")}</dt><dd className="font-mono">{proposal.proposal.localHost}:{proposal.proposal.localPort}</dd>
        {proposal.proposal.protocol === "localTcp" && <><dt className="text-muted-foreground">{t("copilot.remoteTarget")}</dt><dd className="font-mono">{proposal.proposal.targetHost}:{proposal.proposal.targetPort}</dd></>}
      </dl>
      <p className="text-[10px] leading-4 text-muted-foreground">{t("copilot.safety")}</p>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <label className="grid gap-1 text-[10px] text-muted-foreground">{t("copilot.provider")}
        <select value={providerId} onChange={(event) => { setProviderId(event.target.value); setPreview(null); }} className="h-8 rounded-sm border border-border/60 bg-background px-2 text-[11px]" disabled={!providers.length}>
          {providers.length ? providers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>) : <option value="">{t("copilot.noProviders")}</option>}
        </select>
      </label>
      <label className="grid gap-1 text-[10px] text-muted-foreground">{t("copilot.mode")}
        <select value={mode} onChange={(event) => { setMode(event.target.value as CopilotMode); setPreview(null); setReport(null); setProposal(null); }} className="h-8 rounded-sm border border-border/60 bg-background px-2 text-[11px]">
          <option value="tunnelDiagnose">{t("copilot.diagnose")}</option><option value="tunnelSuggest">{t("copilot.suggest")}</option>
        </select>
      </label>
      <label className="grid min-h-32 flex-1 gap-1 text-[10px] text-muted-foreground">{t("copilot.promptLabel")}
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={8000} placeholder={mode === "tunnelDiagnose" ? t("copilot.diagnosePlaceholder") : t("copilot.suggestPlaceholder")} className="compact-scrollbar min-h-28 flex-1 resize-y rounded-sm border border-border/60 bg-background p-2 text-[11px] leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </label>
      <p className="text-[9px] leading-4 text-muted-foreground">{t("copilot.safety")}</p>
      {providerNeedsKey && <p className="text-[10px] text-amber-700 dark:text-amber-300">{aiT("panel.saveApiKeyHint")}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={!rule || !sessionId || !provider || providerNeedsKey || !prompt.trim() || previewBusy || sending} onClick={() => void preparePreview()}>{previewBusy && <LoaderCircle size={12} className="animate-spin" />}{previewBusy ? t("copilot.preparing") : t("copilot.preparePreview")}</Button>
      </div>
    </div>
  );

  return <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
    <DialogContent className="flex h-[min(680px,calc(100vh-40px))] w-[min(680px,calc(100vw-28px))] flex-col gap-0 overflow-hidden p-0">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-panel-header px-3">
        <div className="flex min-w-0 items-center gap-2"><Sparkles size={13} className="text-accent" /><DialogTitle className="truncate text-xs">{t("copilot.title")}</DialogTitle><span className="truncate text-[9px] text-muted-foreground">{rule?.name}</span></div>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-sm" aria-label={aiT("panel.closePanel")} onClick={close}><X size={13} /></Button>
      </header>
      <DialogDescription className="border-b border-border/40 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground">{t("copilot.previewHint")}</DialogDescription>
      {content}
      {sending && <div className="flex shrink-0 items-center gap-2 border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground"><LoaderCircle size={12} className="animate-spin" />{t("copilot.sending")}</div>}
      {requestError && <div role="alert" className="shrink-0 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">{requestError}</div>}
      {report && <footer className="flex shrink-0 justify-end gap-1.5 border-t border-border/50 p-2"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => { setReport(null); setPrompt(""); }}>{t("copilot.preparePreview")}</Button><Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" onClick={close}>{t("cancel")}</Button></footer>}
      {proposal && <footer className="flex shrink-0 justify-end gap-1.5 border-t border-border/50 p-2"><Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => setProposal(null)}>{t("cancel")}</Button><Button type="button" size="sm" className="h-7 rounded-sm text-[10px]" disabled={saving} onClick={() => void saveProposal()}>{saving ? <LoaderCircle size={12} className="animate-spin" /> : <Save size={11} />}{saving ? t("copilot.saving") : t("copilot.saveSuggestion")}</Button></footer>}
    </DialogContent>
  </Dialog>;
}
