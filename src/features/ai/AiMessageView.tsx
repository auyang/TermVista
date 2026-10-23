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

export function AiMessageView({ message, attemptId, canInsert }: { message: AiMessage; attemptId?: string; canInsert: boolean }) {
  return (
    <article className={`rounded-sm border px-2.5 py-2 ${message.role === "user" ? "ml-5 border-accent/25 bg-accent/5" : "mr-2 border-border bg-panel-header/60"}`}>
      <header className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{message.role === "user" ? "你" : message.mode === "plan" ? "AI 计划 · 仅供审阅" : "AI 助手 · 生成内容需自行审阅"}</span>
        {message.status === "streaming" && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />生成中</span>}
        {message.status === "cancelled" && <span>已停止</span>}
        {message.role === "assistant" && (message.elapsedMs !== undefined || message.usage) && <span className="text-muted-foreground">{message.elapsedMs !== undefined ? `${(message.elapsedMs / 1000).toFixed(1)} 秒` : ""}{message.usage && ` · 输入 ${message.usage.inputTokens ?? "—"} / 输出 ${message.usage.outputTokens ?? "—"} tokens`}</span>}
      </header>
      {message.role === "assistant" && message.mode === "plan" && message.status === "complete" ? (
        <PlanOutput message={message} attemptId={attemptId} canInsert={canInsert} />
      ) : message.role === "assistant" ? (
        <div className="min-w-0 break-words text-[11px] leading-[1.65] text-foreground">
          <ReactMarkdown components={markdownComponents(attemptId, canInsert)}>{message.content || (message.status === "streaming" ? "…" : "")}</ReactMarkdown>
        </div>
      ) : <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground">{message.content}</p>}
      {message.errorMessage && <p className="mt-1 text-[10px] text-destructive">{message.errorMessage}</p>}
    </article>
  );
}

function PlanOutput({ message, attemptId, canInsert }: { message: AiMessage; attemptId?: string; canInsert: boolean }) {
  const plan = parseAiPlanResult(message.content);
  if (!plan) {
    return <div className="space-y-1.5 text-[10px]">
      <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-800 dark:text-amber-200">模型输出不符合可验证的计划格式，未提供应用操作。</p>
      <div className="whitespace-pre-wrap break-words font-mono text-[10px]">{message.content}</div>
    </div>;
  }
  if (plan.kind === "question") return <div className="rounded-sm border border-border bg-background px-2 py-1.5 text-[11px]">{plan.summary}</div>;
  if (plan.kind === "command") return <div className="space-y-1.5"><p className="text-[10px] leading-4">{plan.summary}</p><CodeBlock attemptId={attemptId} canInsert={canInsert}><code className="language-shell">{plan.command}</code></CodeBlock><p className="text-[9px] text-muted-foreground">插入只会填入终端命令栏；命令尚未发送，需由你审阅并手动执行。</p></div>;
  return <CodeEditOutput message={message} summary={plan.summary} replacement={plan.replacement} />;
}

function CodeEditOutput({ message, summary, replacement }: { message: AiMessage; summary: string; replacement: string }) {
  const theme = useWorkspaceStore((state) => state.theme);
  const binding = message.editorBinding;
  const current = useEditorStore((state) => binding ? state.documents.find((document) => document.documentId === binding.documentId) : undefined);
  const canApply = Boolean(binding && current && current.revision === binding.revision);
  const apply = () => {
    if (!binding) return;
    const document = useEditorStore.getState().documents.find((item) => item.documentId === binding.documentId);
    if (!document || document.revision !== binding.revision) {
      toast.error("编辑器内容在生成建议后已改变。请重新选择缓冲并生成差异建议。");
      return;
    }
    useEditorStore.getState().updateText(binding.documentId, replacement);
    toast.success("建议已应用到本地 Monaco 缓冲。远程文件尚未保存。");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(replacement);
      toast.success("建议文本已复制。");
    } catch {
      toast.error("无法访问剪贴板。");
    }
  };

  return <section className="space-y-1.5">
    <p className="text-[10px] leading-4">{summary}</p>
    {binding ? <MonacoDiff original={binding.originalText} modified={replacement} language={binding.languageId} theme={theme} /> : <p className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-200">本次没有授权 Monaco 全文上下文，不能将代码建议应用到编辑器。</p>}
    <div className="flex items-center justify-between gap-2 text-[9px]">
      <span className="text-muted-foreground">仅作用于本地缓冲；远程文件不会自动保存。</span>
      <span className="flex shrink-0 gap-1">
        <Button type="button" variant="outline" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" onClick={() => void copy()}>复制建议</Button>
        <Button type="button" size="sm" className="h-6 rounded-sm px-1.5 text-[9px]" disabled={!canApply} onClick={apply}>应用到本地缓冲</Button>
      </span>
    </div>
  </section>;
}

function MonacoDiff({ original, modified, language, theme }: { original: string; modified: string; language: string; theme: "light" | "dark" }) {
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
  return <div ref={containerRef} className="h-64 w-full overflow-hidden rounded-sm border border-border" aria-label="Monaco 代码差异" />;
}

function markdownComponents(attemptId: string | undefined, canInsert: boolean): Components {
  return {
    a: ({ children }) => <span className="text-accent underline decoration-dotted">{children}</span>,
    img: () => <span className="text-muted-foreground">[图片链接已隐藏]</span>,
    p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
    ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    h1: ({ children }) => <h1 className="my-2 text-sm font-semibold">{children}</h1>,
    h2: ({ children }) => <h2 className="my-2 text-xs font-semibold">{children}</h2>,
    h3: ({ children }) => <h3 className="my-1.5 text-[11px] font-semibold">{children}</h3>,
    blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-accent/40 pl-2 text-muted-foreground">{children}</blockquote>,
    pre: ({ children }) => <CodeBlock attemptId={attemptId} canInsert={canInsert}>{children}</CodeBlock>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    hr: () => <hr className="my-2 border-border" />,
  };
}

function CodeBlock({ children, attemptId, canInsert }: { children: ReactNode; attemptId?: string; canInsert: boolean }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children).find(isValidElement);
  const childProps = child?.props as { children?: ReactNode; className?: string } | undefined;
  const code = textContent(childProps?.children ?? children).replace(/\n$/, "");
  const language = childProps?.className?.replace(/^language-/, "") ?? "命令或代码";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("无法访问剪贴板，请手动选择代码复制。");
    }
  };

  const insert = () => {
    if (!attemptId || !canInsert) return;
    if (!insertAiCommand(attemptId, code)) {
      toast.error("只允许插入单行、无控制字符且不超过 4 KiB 的命令；多行代码请先复制并审阅。");
      return;
    }
    toast.success("已插入终端命令栏。内容尚未发送，请审阅后手动按 Enter。");
  };

  return (
    <section className="my-2 overflow-hidden rounded-sm border border-border bg-muted/35 text-foreground">
      <header className="flex h-6 items-center justify-between border-b border-border px-2 text-[9px] text-muted-foreground">
        <span>{language}</span>
        <span className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-5 rounded-sm px-1.5 text-[9px] hover:bg-accent/15 hover:text-foreground" onClick={() => void copy()}>{copied ? <Check size={10} /> : <Copy size={10} />}{copied ? "已复制" : "复制"}</Button>
          <Button type="button" variant="ghost" size="sm" className="h-5 rounded-sm px-1.5 text-[9px] hover:bg-accent/15 hover:text-foreground" disabled={!canInsert || !attemptId} title="仅填入命令栏，不会发送到 SSH" onClick={insert}><TerminalSquare size={10} />插入命令栏</Button>
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
