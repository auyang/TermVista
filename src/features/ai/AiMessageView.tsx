import { Children, isValidElement, useEffect, useRef, type ReactNode } from "react";
import * as monaco from "monaco-editor";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { insertAiCommand } from "@/features/terminal/commandBarRegistry";
import { parseAiPlanResult } from "@/features/ai/planResult";
import type { AiMessage } from "@/features/ai/aiTypes";
import { useEditorStore } from "@/features/editor/editorStore";
import "@/features/editor/monacoWorkers";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";
import i18next from "@/i18n";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function useAiTranslate(): Translate {
  const { t } = useTranslation("ai");
  return (key, options) => String(t(key as never, options as never));
}

export function AiMessageView({ message, attemptId, canInsert }: { message: AiMessage; attemptId?: string; canInsert: boolean }) {
  const t = useAiTranslate();
  return (
    <article className={`rounded-sm border px-2.5 py-2 ${message.role === "user" ? "ml-5 border-accent/25 bg-accent/5" : "mr-2 border-border bg-panel-header/60"}`}>
      <header className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{message.role === "user" ? t("message.user") : message.mode === "plan" ? t("message.assistantPlan") : t("message.assistantReview")}</span>
        {message.status === "streaming" && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{t("message.generating")}</span>}
        {message.status === "cancelled" && <span>{t("message.stopped")}</span>}
        {message.role === "assistant" && (message.elapsedMs !== undefined || message.usage) && <span className="text-muted-foreground">{message.elapsedMs !== undefined ? t("message.seconds", { value: new Intl.NumberFormat(i18next.resolvedLanguage ?? "en-US", { maximumFractionDigits: 1 }).format(message.elapsedMs / 1000) }) : ""}{message.usage && ` · ${t("message.tokenUsage", { input: message.usage.inputTokens ?? "—", output: message.usage.outputTokens ?? "—" })}`}</span>}
      </header>
      {message.role === "assistant" && message.mode === "plan" && message.status === "complete" ? (
        <PlanOutput message={message} attemptId={attemptId} canInsert={canInsert} />
      ) : message.role === "assistant" ? (
        <div className="min-w-0 break-words text-[11px] leading-[1.65] text-foreground">
          <ReactMarkdown components={markdownComponents(attemptId, canInsert, t)}>{message.content || (message.status === "streaming" ? "…" : "")}</ReactMarkdown>
        </div>
      ) : <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground">{message.content}</p>}
      {message.errorMessage && <p className="mt-1 text-[10px] text-destructive">{t("panel.errors.action")}</p>}
    </article>
  );
}

function PlanOutput({ message, attemptId, canInsert }: { message: AiMessage; attemptId?: string; canInsert: boolean }) {
  const t = useAiTranslate();
  const plan = parseAiPlanResult(message.content);
  if (!plan) {
    return <div className="space-y-1.5 text-[10px]">
      <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-800 dark:text-amber-200">{t("message.invalidPlan")}</p>
      <div className="whitespace-pre-wrap break-words font-mono text-[10px]">{message.content}</div>
    </div>;
  }
  if (plan.kind === "question") return <div className="rounded-sm border border-border bg-background px-2 py-1.5 text-[11px]">{plan.summary}</div>;
  if (plan.kind === "command") return <div className="space-y-1.5"><p className="text-[10px] leading-4">{plan.summary}</p><CodeBlock attemptId={attemptId} canInsert={canInsert} t={t}><code className="language-shell">{plan.command}</code></CodeBlock><p className="text-[9px] text-muted-foreground">{t("message.commandNotice")}</p></div>;
  return <CodeEditOutput message={message} summary={plan.summary} replacement={plan.replacement} />;
}

function CodeEditOutput({ message, summary, replacement }: { message: AiMessage; summary: string; replacement: string }) {
  const t = useAiTranslate();
  const theme = useWorkspaceStore((state) => state.theme);
  const binding = message.editorBinding;
  const current = useEditorStore((state) => binding ? state.documents.find((document) => document.documentId === binding.documentId) : undefined);
  const canApply = Boolean(binding && current && current.revision === binding.revision);
  const apply = () => {
    if (!binding) return;
    const document = useEditorStore.getState().documents.find((item) => item.documentId === binding.documentId);
    if (!document || document.revision !== binding.revision) {
      toast.error(t("message.editorChanged"));
      return;
    }
    useEditorStore.getState().updateText(binding.documentId, replacement);
    toast.success(t("message.applied"));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(replacement);
      toast.success(t("message.copiedSuggestion"));
    } catch {
      toast.error(t("message.clipboard"));
    }
  };

  return <section className="space-y-1.5">
    <p className="text-[10px] leading-4">{summary}</p>
    {binding ? <MonacoDiff original={binding.originalText} modified={replacement} language={binding.languageId} theme={theme} /> : <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-200"> {t("message.noEditorContext")}</p>}
    <div className="flex items-center justify-between gap-2 text-[9px]">
      <span className="text-muted-foreground">{t("message.localOnly")}</span>
      <span className="flex shrink-0 gap-1">
        <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" onClick={() => void copy()}>{t("message.copySuggestion")}</Button>
        <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!canApply} onClick={apply}>{t("message.applyLocal")}</Button>
      </span>
    </div>
  </section>;
}

function MonacoDiff({ original, modified, language, theme }: { original: string; modified: string; language: string; theme: "light" | "dark" }) {
  const t = useAiTranslate();
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const editor = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      minimap: { enabled: false },
      folding: true,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      fontSize: 10,
      wordWrap: "on",
      renderOverviewRuler: false,
    });
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    editor.setModel({ original: originalModel, modified: modifiedModel });
    return () => {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [language, modified, original, theme]);
  return <div ref={containerRef} className="h-64 w-full overflow-hidden rounded-sm border border-border" aria-label={t("message.diffLabel")} />;
}

function markdownComponents(attemptId: string | undefined, canInsert: boolean, t: Translate): Components {
  return {
    a: ({ children }) => <span className="text-accent underline decoration-dotted">{children}</span>,
    img: () => <span className="text-muted-foreground">{t("message.imageHidden")}</span>,
    p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
    ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    h1: ({ children }) => <h1 className="my-2 text-sm font-semibold">{children}</h1>,
    h2: ({ children }) => <h2 className="my-2 text-xs font-semibold">{children}</h2>,
    h3: ({ children }) => <h3 className="my-1.5 text-[11px] font-semibold">{children}</h3>,
    blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-accent/40 pl-2 text-muted-foreground">{children}</blockquote>,
    pre: ({ children }) => <CodeBlock attemptId={attemptId} canInsert={canInsert} t={t}>{children}</CodeBlock>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    hr: () => <hr className="my-2 border-border" />,
  };
}

function CodeBlock({ children, attemptId, canInsert, t }: { children: ReactNode; attemptId?: string; canInsert: boolean; t: Translate }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children).find(isValidElement);
  const childProps = child?.props as { children?: ReactNode; className?: string } | undefined;
  const code = textContent(childProps?.children ?? children).replace(/\n$/, "");
  const language = childProps?.className?.replace(/^language-/, "") ?? t("message.codeLabel");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(t("message.clipboardManual"));
    }
  };

  const insert = () => {
    if (!attemptId || !canInsert) return;
    if (!insertAiCommand(attemptId, code)) {
      toast.error(t("message.commandRestriction"));
      return;
    }
    toast.success(t("message.inserted"));
  };

  return (
    <section className="my-2 overflow-hidden rounded-sm border border-border bg-muted/35 text-foreground">
      <header className="flex h-6 items-center justify-between border-b border-border px-2 text-[9px] text-muted-foreground">
        <span>{language}</span>
        <span className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-5 rounded-sm px-1.5 text-[9px] hover:bg-accent/15 hover:text-foreground" onClick={() => void copy()}>{copied ? <Check size={10} /> : <Copy size={10} />}{copied ? t("message.copied") : t("message.copy")}</Button>
          <Button type="button" variant="ghost" size="sm" className="h-5 rounded-sm px-1.5 text-[9px] hover:bg-accent/15 hover:text-foreground" disabled={!canInsert || !attemptId} title={t("message.insertTitle")} onClick={insert}><TerminalSquare size={10} />{t("message.insertCommand")}</Button>
        </span>
      </header>
      <pre className="compact-scrollbar max-h-60 overflow-auto p-2 font-mono text-[10px] leading-4"><code>{code}</code></pre>
    </section>
  );
}

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (isValidElement(value)) return textContent((value.props as { children?: ReactNode }).children);
  return "";
}
