import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, PanelRight, Search, Settings2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sendSshBytes } from "@/features/ssh/sshBridge";
import { registerCommandInput } from "@/features/terminal/commandBarRegistry";
import { useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";

function CommandInput({ attemptId, enabled }: { attemptId?: string; enabled: boolean }) {
  const { t } = useTranslation("terminal");
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
    }).catch(() => {
      setError(t("inputNotSent"));
    });
  };

  return (
    <form className="min-w-0 flex-1" onSubmit={submit}>
      <input
        className="h-7 w-full rounded-sm border border-terminal-border bg-terminal-input px-2.5 text-[11px] text-terminal-fg placeholder:text-terminal-muted disabled:opacity-90"
        placeholder={enabled ? t("commandConnected") : t("commandDisconnected")}
        disabled={!enabled}
        value={command}
        aria-label={t("commandLabel")}
        title={error}
        onChange={(event) => setCommand(event.target.value)}
      />
    </form>
  );
}

export function TerminalCommandBar() {
  const { t } = useTranslation("terminal");
  const activeTab = useWorkspaceStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const session = useSshSessionStore((state) => activeTab?.mode === "ssh" ? state.sessions[activeTab.id] : undefined);
  const enabled = activeTab?.mode === "ssh" && session?.state === "connected";

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-terminal-border bg-terminal-toolbar px-3" aria-label={t("commandBar")}>
      <CommandInput key={activeTab?.id ?? "no-tab"} attemptId={activeTab?.id} enabled={Boolean(enabled)} />
      <div className="flex shrink-0 items-center gap-0.5 border-l border-terminal-border pl-1.5">
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-action hover:bg-terminal-hover hover:text-terminal-action" aria-label={t("shortcutUnavailable")} title={t("shortcutUnavailable")} disabled><Zap size={14} fill="currentColor" /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label={t("copyUnavailable")} title={t("copyUnavailable")} disabled><Copy size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label={t("searchUnavailable")} title={t("searchUnavailable")} disabled><Search size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label={t("settingsUnavailable")} title={t("settingsUnavailable")} disabled><Settings2 size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label={t("downloadUnavailable")} title={t("downloadUnavailable")} disabled><Download size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label={t("layoutUnavailable")} title={t("layoutUnavailable")} disabled><PanelRight size={14} /></Button>
      </div>
    </div>
  );
}
