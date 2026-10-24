import { Moon, RotateCcw, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { statusLabel, useSshSessionStore } from "@/stores/sshSessionStore";
import { rememberManagerOpener } from "@/features/connections/managerFocus";
import { brand } from "@/app/brand";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export function StatusBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation("workspace");
  const activeTab = useWorkspaceStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null);
  const theme = useWorkspaceStore((state) => state.theme);
  const resetLayout = useWorkspaceStore((state) => state.resetLayout);
  const updateSettings = useSettingsStore((state) => state.update);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const isDemo = import.meta.env.DEV && activeTab?.mode === "demo";
  const sshSession = useSshSessionStore((state) => activeTab?.mode === "ssh" ? state.sessions[activeTab.id] : undefined);
  const connected = sshSession?.state === "connected";

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-panel-header px-2 text-[10px] text-muted-foreground" aria-label={t("statusBar")}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex items-center gap-1.5" role="status">
          <span className={`h-1.5 w-1.5 rounded-full ${isDemo ? "bg-accent" : connected ? "bg-emerald-500" : "bg-muted-foreground/60"}`} aria-hidden="true" />
          {isDemo ? t("demoUnconnected") : sshSession ? `${statusLabel(sshSession.state)} · ${sshSession.profile.host}` : t("notConnected")}
        </span>
        <span className="hidden border-l border-border pl-3 sm:inline">UTF-8</span>
        <span className="hidden sm:inline">{brand.name} · {brand.nameZh}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="h-5 w-6 rounded-sm text-muted-foreground hover:text-foreground" aria-label={t("settings")} title={t("settings")} onClick={onOpenSettings}><Settings size={11} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-6 rounded-sm text-muted-foreground hover:text-foreground" aria-label={t("resetLayout")} title={t("resetLayout")} onClick={resetLayout}><RotateCcw size={11} /></Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-6 rounded-sm text-muted-foreground hover:text-foreground" aria-label={theme === "dark" ? t("switchToLight") : t("switchToDark")} title={t("switchTheme")} onClick={() => void updateSettings("appearance", { themeMode: theme === "dark" ? "light" : "dark" }).catch(() => toast.error(t("themeSaveFailed")))}>
          {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
        </Button>
        <span className="mx-1 h-3.5 w-px bg-border" aria-hidden="true" />
        <Button type="button" variant="ghost" size="sm" className="ml-1 h-5 rounded-sm px-1.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={(event) => { rememberManagerOpener(event.currentTarget); setManagerOpen(true); }}>
          {t("connectionManager")}
        </Button>
      </div>
    </footer>
  );
}
