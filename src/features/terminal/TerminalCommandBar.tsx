import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, PanelRight, Search, Settings2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sendSshBytes } from "@/features/ssh/sshBridge";
import { registerCommandInput } from "@/features/terminal/commandBarRegistry";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

function CommandInput({ attemptId, enabled }: { attemptId?: string; enabled: boolean }) {
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!attemptId) return;
    return registerCommandInput(attemptId, setCommand);
  }, [attemptId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || !attemptId) return;
    const value = `${command}\r`;
    void sendSshBytes(attemptId, new TextEncoder().encode(value)).then(() => {
      setCommand("");
      setError("");
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "终端输入未发送。连接状态可能已改变。");
    });
  };

  return (
    <form className="min-w-0 flex-1" onSubmit={submit}>
      <input
        className="h-7 w-full rounded-sm border border-terminal-border bg-terminal-input px-2.5 text-[11px] text-terminal-fg placeholder:text-terminal-muted disabled:opacity-90"
        placeholder={enabled ? "命令输入（Enter 发送到当前 SSH PTY）" : "命令输入（SSH 连接后启用）"}
        disabled={!enabled}
        value={command}
        aria-label="命令输入，共用当前 SSH 终端 PTY"
        title={error}
        onChange={(event) => setCommand(event.target.value)}
      />
    </form>
  );
}

export function TerminalCommandBar() {
  const activeTab = useWorkspaceStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const session = useSshSessionStore((state) => activeTab?.mode === "ssh" ? state.sessions[activeTab.id] : undefined);
  const enabled = activeTab?.mode === "ssh" && session?.state === "connected";

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-terminal-border bg-terminal-toolbar px-3" aria-label="终端命令栏">
      <CommandInput key={activeTab?.id ?? "no-tab"} attemptId={activeTab?.id} enabled={Boolean(enabled)} />
      <div className="flex shrink-0 items-center gap-0.5 border-l border-terminal-border pl-1.5">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-action hover:bg-terminal-hover hover:text-terminal-action" aria-label="快捷命令（未接入）" title="快捷命令（未接入）" disabled><Zap size={14} fill="currentColor" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="复制终端内容（未接入）" title="复制（未接入）" disabled><Copy size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="搜索终端（未接入）" title="搜索（未接入）" disabled><Search size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="终端设置（未接入）" title="设置（未接入）" disabled><Settings2 size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="下载终端记录（未接入）" title="下载（未接入）" disabled><Download size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="终端面板布局（未接入）" title="面板布局（未接入）" disabled><PanelRight size={14} /></Button>
      </div>
    </div>
  );
}
