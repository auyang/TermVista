import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Copy,
  FolderSync,
  Info,
  Palette,
  Settings2,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { brand } from "@/app/brand";
import { defaultSettings, getAppMetadata, getSanitizedDiagnostics, type AppMetadata, type SettingsSection } from "@/features/settings/settingsBridge";
import { CredentialVaultSettings } from "@/features/settings/CredentialVaultSettings";
import { UpdatePanel } from "@/features/updater/UpdatePanel";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";
import i18next, { applyLanguagePreference } from "@/i18n";
import { nativeLanguageNames, type LanguagePreference, type SupportedLocale } from "@/i18n/locale";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const navigation: { id: SettingsSection | "about"; labelKey: "nav.general" | "nav.terminal" | "nav.connections" | "nav.sftp" | "nav.monitoring" | "nav.aiPrivacy" | "nav.appearance" | "nav.about"; icon: typeof Settings2 }[] = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "terminal", labelKey: "nav.terminal", icon: TerminalSquare },
  { id: "connections", labelKey: "nav.connections", icon: ShieldCheck },
  { id: "sftp", labelKey: "nav.sftp", icon: FolderSync },
  { id: "monitoring", labelKey: "nav.monitoring", icon: Activity },
  { id: "aiPrivacy", labelKey: "nav.aiPrivacy", icon: Bot },
  { id: "appearance", labelKey: "nav.appearance", icon: Palette },
  { id: "about", labelKey: "nav.about", icon: Info },
];

function SettingRow({
  title,
  description,
  value,
  defaultValue,
  timing,
  control,
}: {
  title: string;
  description: string;
  value: string;
  defaultValue?: string;
  timing: string;
  control: ReactNode;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-h-[58px] items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-foreground">{title}</div>
        <p className="mt-0.5 max-w-2xl text-[10px] leading-4 text-muted-foreground">{description}</p>
        <p className="mt-1 text-[9px] text-muted-foreground/75">{t(defaultValue ? "row.stateWithDefault" : "row.state", { value, defaultValue, timing })}</p>
      </div>
      <div className="flex shrink-0 items-center justify-end">{control}</div>
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div className="mb-2 border-b border-border pb-2">
    <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</p>
  </div>;
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useTranslation("settings");
  return <label className={`inline-flex items-center gap-2 text-[10px] text-foreground ${disabled ? "opacity-60" : "cursor-pointer"}`}>
    <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
    <span aria-hidden="true" className={`relative h-[18px] w-[32px] rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${checked ? "border-primary bg-primary" : "border-input bg-muted"}`}>
      <span className={`absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
    </span>
    <span>{checked ? t("toggle.on") : t("toggle.off")}</span>
  </label>;
}

function SelectControl({ value, label, children, onChange }: { value: string; label: string; children: ReactNode; onChange: (value: string) => void }) {
  return <select aria-label={label} className="h-7 min-w-32 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>;
}

function SettingValue({ children }: { children: ReactNode }) {
  return <span className="rounded-sm border border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">{children}</span>;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation("settings");
  const [section, setSection] = useState<SettingsSection | "about">("general");
  const languageUpdateSequence = useRef(0);
  const settings = useSettingsStore((state) => state.settings);
  const loaded = useSettingsStore((state) => state.loaded);
  const loading = useSettingsStore((state) => state.loading);
  const savingSection = useSettingsStore((state) => state.savingSection);
  const settingsError = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);
  const update = useSettingsStore((state) => state.update);
  const [metadata, setMetadata] = useState<AppMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const setManagerView = useWorkspaceStore((state) => state.setManagerView);
  const setAiOpen = useWorkspaceStore((state) => state.setAiOpen);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && section === "about") setSection("general");
    onOpenChange(nextOpen);
  }, [section, onOpenChange]);
  const closeDialog = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  useEffect(() => {
    if (open && !loaded && !loading) void load().catch(() => undefined);
  }, [open, loaded, loading, load]);

  useEffect(() => {
    if (!open || section !== "about") return;
    let current = true;
    void getAppMetadata().then((value) => {
      if (current) {
        setMetadata(value);
        setMetadataError(null);
      }
    }).catch((error: unknown) => {
      if (current) setMetadataError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, section]);

  const updateSetting = useCallback(async <T extends "general" | "terminal" | "connections" | "monitoring" | "appearance",>(target: T, patch: Partial<typeof settings[T]>) => {
    try {
      await update(target, patch);
    } catch {
      // Store retains the original value and displays the Rust error in the dialog.
    }
  }, [update]);

  const updateLanguagePreference = useCallback(async (preference: LanguagePreference) => {
    const sequence = ++languageUpdateSequence.current;
    try {
      await applyLanguagePreference(preference);
      await update("appearance", { languagePreference: preference });
    } catch {
      if (sequence !== languageUpdateSequence.current) return;
      const persistedPreference = useSettingsStore.getState().settings.appearance.languagePreference;
      const resolved = await applyLanguagePreference(persistedPreference);
      toast.error(i18next.t("settings:saveFailed", { language: resolved }));
    }
  }, [update]);

  const resetCurrentSection = async () => {
    if (!(section in defaultSettings)) return;
    const resetSection = navigation.find((item) => item.id === section);
    const confirm = window.confirm(t("dialog.resetConfirm", { section: resetSection ? String(t(resetSection.labelKey)) : String(t("nav.general")) }));
    if (!confirm) return;
    const sectionDefaults = defaultSettings[section as keyof typeof defaultSettings];
    if (section === "general" || section === "terminal" || section === "connections" || section === "monitoring" || section === "appearance") {
      await updateSetting(section, sectionDefaults as never);
    }
  };

  const resetAvailable = section === "general" || section === "terminal" || section === "connections" || section === "monitoring" || section === "appearance";
  const currentLabel = (() => { const item = navigation.find((candidate) => candidate.id === section); return String(item ? t(item.labelKey) : t("nav.general")); })();
  const copyDiagnostics = useCallback(async () => {
    try {
      const info = await getSanitizedDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      toast.success(String(t("aboutPanel.diagnosticsCopied")));
    } catch {
      toast.error(String(t("aboutPanel.diagnosticsCopyFailed")));
    }
  }, [t]);

  const settingsBody = useMemo(() => {
    if (!loaded) return <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">{loading ? t("loading.reading") : t("loading.notLoaded")}</div>;
    switch (section) {
      case "general":
        return <>
          <SectionHeading title={t("general.title")} description={t("general.description")} />
          <SettingRow title={t("general.restoreWorkspace.title")} description={t("general.restoreWorkspace.description")} value={String(t(settings.general.restoreLastTabs ? "values.on" : "values.off"))} defaultValue={String(t("values.on"))} timing={String(t("values.nextLaunch"))} control={<Toggle checked={settings.general.restoreLastTabs} label={t("general.restoreWorkspace.title")} onChange={(value) => void updateSetting("general", { restoreLastTabs: value })} />} />
          <SettingRow title={t("general.autoConnect.title")} description={t("general.autoConnect.description")} value={String(t(settings.general.autoConnectSavedHosts ? "values.on" : "values.off"))} defaultValue={String(t("values.off"))} timing={String(t("values.nextLaunch"))} control={<Toggle checked={settings.general.autoConnectSavedHosts} label={t("general.autoConnect.title")} onChange={(value) => void updateSetting("general", { autoConnectSavedHosts: value })} />} />
          <SettingRow title={t("general.recentConnections.title")} description={t("general.recentConnections.description")} value={String(t(settings.general.rememberRecentConnections ? "values.on" : "values.off"))} defaultValue={String(t("values.on"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.general.rememberRecentConnections} label={t("general.recentConnections.title")} onChange={(value) => void updateSetting("general", { rememberRecentConnections: value })} />} />
          <SettingRow title={t("general.checkUpdates.title")} description={t("general.checkUpdates.description")} value={String(t(settings.general.autoCheckUpdates ? "values.on" : "values.off"))} defaultValue={String(t("values.on"))} timing={String(t("values.nextLaunch"))} control={<Toggle checked={settings.general.autoCheckUpdates} label={t("general.checkUpdates.title")} onChange={(value) => void updateSetting("general", { autoCheckUpdates: value })} />} />
          <SettingRow title={t("general.newTab.title")} description={t("general.newTab.description")} value={String(t("values.quickConnect"))} defaultValue={String(t("values.quickConnect"))} timing={String(t("values.immediately"))} control={<SettingValue>{t("values.quickConnect")}</SettingValue>} />
          <SettingRow title={t("interfaceLanguage")} description={t("restartNotRequired")} value={settings.appearance.languagePreference} timing={t("restartNotRequired")} control={<div className="flex items-center gap-2"><select aria-label={t("interfaceLanguage")} className="h-7 min-w-36 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" value={settings.appearance.languagePreference} onChange={(event) => void updateLanguagePreference(event.target.value as LanguagePreference)}><option value="system">{t("systemLanguage")}</option>{(Object.keys(nativeLanguageNames) as SupportedLocale[]).map((locale) => <option key={locale} value={locale}>{nativeLanguageNames[locale]}</option>)}</select><span className="min-w-12 text-right text-[10px] tabular-nums text-muted-foreground">{i18next.resolvedLanguage}</span></div>} />
        </>;
      case "terminal":
        return <>
          <SectionHeading title={t("terminal.title")} description={t("terminal.description")} />
          <SettingRow title={t("terminal.fontSize.title")} description={t("terminal.fontSize.description")} value={`${settings.terminal.fontSize} px`} defaultValue="14 px" timing={String(t("values.immediately"))} control={<div className="flex items-center gap-2"><input aria-label={t("terminal.fontSize.title")} type="range" min="11" max="24" value={settings.terminal.fontSize} onChange={(event) => void updateSetting("terminal", { fontSize: Number(event.target.value) })} className="w-28 accent-primary" /><span className="w-7 text-right text-[10px] tabular-nums">{settings.terminal.fontSize}</span></div>} />
          <SettingRow title={t("terminal.font.title")} description={t("terminal.font.description")} value="Menlo / Monaco" defaultValue="Menlo / Monaco" timing={String(t("values.newTerminal"))} control={<SettingValue>Menlo · Monaco</SettingValue>} />
          <SettingRow title={t("terminal.lineHeight.title")} description={t("terminal.lineHeight.description")} value={`${settings.terminal.lineHeight.toFixed(2)}×`} defaultValue="1.25×" timing={String(t("values.immediately"))} control={<div className="flex items-center gap-2"><input aria-label={t("terminal.lineHeight.title")} type="range" min="1" max="2" step="0.05" value={settings.terminal.lineHeight} onChange={(event) => void updateSetting("terminal", { lineHeight: Number(event.target.value) })} className="w-28 accent-primary" /><span className="w-8 text-right text-[10px] tabular-nums">{settings.terminal.lineHeight.toFixed(2)}</span></div>} />
          <SettingRow title={t("terminal.cursorStyle.title")} description={t("terminal.cursorStyle.description")} value={String(t(`terminal.cursorStyle.${settings.terminal.cursorStyle}`))} defaultValue={String(t("terminal.cursorStyle.block"))} timing={String(t("values.immediately"))} control={<SelectControl label={t("terminal.cursorStyle.title")} value={settings.terminal.cursorStyle} onChange={(value) => void updateSetting("terminal", { cursorStyle: value as typeof settings.terminal.cursorStyle })}><option value="block">{t("terminal.cursorStyle.block")}</option><option value="underline">{t("terminal.cursorStyle.underline")}</option><option value="bar">{t("terminal.cursorStyle.bar")}</option></SelectControl>} />
          <SettingRow title={t("terminal.cursorBlink.title")} description={t("terminal.cursorBlink.description")} value={String(t(settings.terminal.cursorBlink ? "values.on" : "values.off"))} defaultValue={String(t("values.on"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.terminal.cursorBlink} label={t("terminal.cursorBlink.title")} onChange={(value) => void updateSetting("terminal", { cursorBlink: value })} />} />
          <SettingRow title={t("terminal.colorScheme.title")} description={t("terminal.colorScheme.description")} value={String(t(settings.terminal.colorScheme === "follow" ? "terminal.colorScheme.follow" : "terminal.colorScheme.dark"))} defaultValue={String(t("terminal.colorScheme.follow"))} timing={String(t("values.newTerminal"))} control={<SelectControl label={t("terminal.colorScheme.title")} value={settings.terminal.colorScheme} onChange={(value) => void updateSetting("terminal", { colorScheme: value as typeof settings.terminal.colorScheme })}><option value="follow">{t("terminal.colorScheme.follow")}</option><option value="dark">{t("terminal.colorScheme.dark")}</option></SelectControl>} />
          <SettingRow title={t("terminal.scrollback.title")} description={t("terminal.scrollback.description")} value={`${new Intl.NumberFormat(i18next.resolvedLanguage ?? "en-US").format(settings.terminal.scrollback)} ${t("values.lines")}`} defaultValue={`${new Intl.NumberFormat(i18next.resolvedLanguage ?? "en-US").format(5000)} ${t("values.lines")}`} timing={String(t("values.newTerminal"))} control={<SelectControl label={t("terminal.scrollback.title")} value={String(settings.terminal.scrollback)} onChange={(value) => void updateSetting("terminal", { scrollback: Number(value) })}><option value="1000">1,000</option><option value="5000">5,000</option><option value="10000">10,000</option><option value="20000">20,000</option><option value="50000">50,000</option></SelectControl>} />
          <SettingRow title={t("terminal.pastePreview.title")} description={t("terminal.pastePreview.description")} value={String(t(settings.terminal.pastePreview ? "values.on" : "values.off"))} defaultValue={String(t("values.on"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.terminal.pastePreview} label={t("terminal.pastePreview.title")} onChange={(value) => void updateSetting("terminal", { pastePreview: value })} />} />
          <SettingRow title={t("terminal.clearHistory.title")} description={t("terminal.clearHistory.description")} value={String(t("values.confirmEach"))} defaultValue={String(t("values.confirmEach"))} timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.enabled")}</SettingValue>} />
        </>;
      case "connections":
        return <>
          <SectionHeading title={t("connections.title")} description={t("connections.description")} />
          <CredentialVaultSettings />
          <SettingRow title={t("connections.autoReconnect.title")} description={t("connections.autoReconnect.description")} value={String(t(settings.connections.autoReconnectEnabled ? "values.on" : "values.off"))} defaultValue={String(t("values.off"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.connections.autoReconnectEnabled} label={t("connections.autoReconnect.title")} onChange={(value) => void updateSetting("connections", { autoReconnectEnabled: value })} />} />
          <SettingRow title={t("connections.hostKey.title")} description={t("connections.hostKey.description")} value={String(t("values.enforced"))} defaultValue={String(t("values.enforced"))} timing={String(t("values.eachConnection"))} control={<SettingValue>{t("values.enabled")}</SettingValue>} />
          <SettingRow title={t("connections.trustedHosts.title")} description={t("connections.trustedHosts.description")} value={String(t("values.byProvider"))} timing={String(t("values.immediately"))} control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setManagerView("trustedHosts"); setManagerOpen(true); closeDialog(); }}>{t("connections.trustedHosts.button")}</Button>} />
          <SettingRow title={t("connections.timeout.title")} description={t("connections.timeout.description")} value={String(t("values.engineDefault"))} timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.notAvailable")}</SettingValue>} />
          <SettingRow title={t("connections.credentials.title")} description={t("connections.credentials.description")} value={String(t("values.byProvider"))} timing={String(t("values.eachConnection"))} control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setManagerView("connections"); setManagerOpen(true); closeDialog(); }}>{t("connections.credentials.button")}</Button>} />
        </>;
      case "sftp":
        return <>
          <SectionHeading title={t("sftp.title")} description={t("sftp.description")} />
          <SettingRow title={t("sftp.concurrency.title")} description={t("sftp.concurrency.description")} value="1" defaultValue="1" timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.orderedQueue")}</SettingValue>} />
          <SettingRow title={t("sftp.conflicts.title")} description={t("sftp.conflicts.description")} value={String(t("values.ask"))} defaultValue={String(t("values.ask"))} timing={String(t("values.eachTask"))} control={<SettingValue>{t("values.confirmEach")}</SettingValue>} />
          <SettingRow title={t("sftp.delete.title")} description={t("sftp.delete.description")} value={String(t("values.enforced"))} defaultValue={String(t("values.on"))} timing={String(t("values.eachTask"))} control={<SettingValue>{t("values.enforced")}</SettingValue>} />
          <SettingRow title={t("sftp.downloadLocation.title")} description={t("sftp.downloadLocation.description")} value={String(t("values.ask"))} timing={String(t("values.eachDownload"))} control={<SettingValue>{t("values.systemPicker")}</SettingValue>} />
          <SettingRow title={t("sftp.editorConflict.title")} description={t("sftp.editorConflict.description")} value={String(t("values.notAvailable"))} timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.notConfigured")}</SettingValue>} />
        </>;
      case "monitoring":
        return <>
          <SectionHeading title={t("monitoring.title")} description={t("monitoring.description")} />
          <SettingRow title={t("monitoring.enabled.title")} description={t("monitoring.enabled.description")} value={String(t(settings.monitoring.enabled ? "values.on" : "values.paused"))} defaultValue={String(t("values.on"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.monitoring.enabled} label={t("monitoring.enabled.title")} onChange={(value) => void updateSetting("monitoring", { enabled: value })} />} />
          <SettingRow title={t("monitoring.hostSampling.title")} description={t("monitoring.hostSampling.description")} value="2 s / 15 s" timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.enginePolicy")}</SettingValue>} />
          <SettingRow title={t("monitoring.processSampling.title")} description={t("monitoring.processSampling.description")} value="2 s / 15 s" timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.enginePolicy")}</SettingValue>} />
          <SettingRow title={t("monitoring.diskSampling.title")} description={t("monitoring.diskSampling.description")} value="20 s" timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.enginePolicy")}</SettingValue>} />
          <SettingRow title={t("monitoring.disconnect.title")} description={t("monitoring.disconnect.description")} value={String(t("values.enabled"))} timing={String(t("values.immediately"))} control={<SettingValue>{t("values.enabled")}</SettingValue>} />
        </>;
      case "aiPrivacy":
        return <>
          <SectionHeading title={t("aiPrivacy.title")} description={t("aiPrivacy.description")} />
          <SettingRow title={t("aiPrivacy.provider.title")} description={t("aiPrivacy.provider.description")} value={String(t("values.currentConnections"))} timing="AI" control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setAiOpen(true); closeDialog(); }}>{t("aiPrivacy.provider.button")}</Button>} />
          <SettingRow title={t("aiPrivacy.context.title")} description={t("aiPrivacy.context.description")} value={String(t("values.permissionEachTime"))} defaultValue={String(t("values.off"))} timing={String(t("values.eachRequest"))} control={<SettingValue>{t("values.ask")}</SettingValue>} />
          <SettingRow title={t("aiPrivacy.diagnostics.title")} description={t("aiPrivacy.diagnostics.description")} value={String(t("values.readOnlyAllowlist"))} defaultValue={String(t("values.readOnlyAllowlist"))} timing={String(t("values.eachTask"))} control={<SettingValue>{t("values.enforced")}</SettingValue>} />
          <SettingRow title={t("aiPrivacy.apiKey.title")} description={t("aiPrivacy.apiKey.description")} value={String(t("values.byProvider"))} timing={String(t("values.eachProvider"))} control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setAiOpen(true); closeDialog(); }}>{t("aiPrivacy.provider.button")}</Button>} />
          <SettingRow title={t("aiPrivacy.history.title")} description={t("aiPrivacy.history.description")} value={String(t("values.sessionIsolated"))} timing={String(t("values.currentSession"))} control={<SettingValue>{t("values.enabled")}</SettingValue>} />
        </>;
      case "appearance":
        return <>
          <SectionHeading title={t("appearance.title")} description={t("appearance.description")} />
          <SettingRow title={t("appearance.theme.title")} description={t("appearance.theme.description")} value={String(t(settings.appearance.themeMode === "system" ? "values.followSystem" : settings.appearance.themeMode === "light" ? "values.light" : "values.dark"))} defaultValue={String(t("values.followSystem"))} timing={String(t("values.immediately"))} control={<SelectControl label={t("appearance.theme.title")} value={settings.appearance.themeMode} onChange={(value) => void updateSetting("appearance", { themeMode: value as typeof settings.appearance.themeMode })}><option value="system">{t("values.followSystem")}</option><option value="light">{t("values.light")}</option><option value="dark">{t("values.dark")}</option></SelectControl>} />
          <SettingRow title={t("appearance.monitorSidebar.title")} description={t("appearance.monitorSidebar.description")} value={String(t(settings.appearance.showMonitorSidebar ? "values.show" : "values.hide"))} defaultValue={String(t("values.show"))} timing={String(t("values.immediately"))} control={<Toggle checked={settings.appearance.showMonitorSidebar} label={t("appearance.monitorSidebar.title")} onChange={(value) => void updateSetting("appearance", { showMonitorSidebar: value })} />} />
          <SettingRow title={t("appearance.aiPanel.title")} description={t("appearance.aiPanel.description")} value={String(t(settings.appearance.aiPanelOpenByDefault ? "values.expanded" : "values.hide"))} defaultValue={String(t("values.hide"))} timing={String(t("values.nextLaunch"))} control={<Toggle checked={settings.appearance.aiPanelOpenByDefault} label={t("appearance.aiPanel.title")} onChange={(value) => void updateSetting("appearance", { aiPanelOpenByDefault: value })} />} />
          <SettingRow title={t("appearance.density.title")} description={t("appearance.density.description")} value={String(t("values.compact"))} defaultValue={String(t("values.compact"))} timing={String(t("values.currentVersion"))} control={<SettingValue>{t("values.compact")}</SettingValue>} />
          <div className="mt-3 rounded-sm border border-border bg-muted/25 px-3 py-2">
            <div className="mb-1.5 text-[10px] font-medium text-foreground">{t("appearance.shortcuts.title")}</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] text-muted-foreground"><span>{t("appearance.shortcuts.settings")}</span><kbd>⌘ , / Ctrl ,</kbd><span>{t("appearance.shortcuts.search")}</span><kbd>⌘ K / Ctrl K</kbd><span>{t("appearance.shortcuts.newTab")}</span><kbd>⌘ T / Ctrl T</kbd><span>{t("appearance.shortcuts.toggleAi")}</span><kbd>⌘ J / Ctrl J</kbd></div>
            <p className="mt-2 text-[9px] text-muted-foreground">{t("appearance.shortcuts.description")}</p>
          </div>
        </>;
      case "about":
        return <>
          <SectionHeading title={t("aboutPanel.title", { name: brand.name })} description={t("aboutPanel.description")} />
          <div className="flex flex-col items-center pt-3 text-center">
            <img src="/termvista-icon-v2.png" alt={t("aboutPanel.iconAlt")} className="h-20 w-20 rounded-xl border border-border bg-white p-1 shadow-sm" />
            <h2 className="mt-3 text-[18px] font-semibold tracking-tight text-foreground">{brand.name} <span className="font-normal text-muted-foreground">{brand.nameZh}</span></h2>
            <p className="mt-1 text-[10px] text-muted-foreground">{t("aboutPanel.englishDescription")}</p>
            <p className="mt-2 max-w-[460px] text-[10px] leading-5 text-muted-foreground">{t("aboutPanel.descriptionText")}</p>
            <p className="mt-1 text-[10px] text-primary">{t("aboutPanel.tagline")}</p>
          </div>
          <div className="mx-auto mt-5 grid max-w-[430px] grid-cols-[108px_1fr] gap-y-2 rounded-sm border border-border bg-muted/25 p-3 text-[10px] text-foreground">
            <span className="text-muted-foreground">{t("aboutPanel.version")}</span><span>{metadata ? metadata.version : metadataError ? t("aboutPanel.metadataUnavailable") : t("loading.reading")}</span>
            <span className="text-muted-foreground">{t("aboutPanel.platform")}</span><span>{metadata ? `${metadata.platform} · ${metadata.arch}` : "—"}</span>
            {metadata?.channel && <><span className="text-muted-foreground">{t("aboutPanel.channel")}</span><span>{metadata.channel}</span></>}
            {metadata?.buildHash && <><span className="text-muted-foreground">{t("aboutPanel.buildHash")}</span><span className="font-mono">{metadata.buildHash}</span></>}
            <span className="text-muted-foreground">{t("aboutPanel.updater")}</span><span>{metadata?.updaterConfigured ? t("aboutPanel.updaterConfigured") : metadata ? t("aboutPanel.updaterUnavailable") : t("aboutPanel.updaterChecking")}</span>
          </div>
          {metadataError && <p role="alert" className="mt-2 text-center text-[10px] text-destructive">{t("aboutPanel.metadataError", { error: t("aboutPanel.metadataUnavailable") })}</p>}
          <div className="mx-auto mt-4 w-full max-w-[560px]">
            <UpdatePanel metadata={metadata} />
          </div>
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void copyDiagnostics()}><Copy size={12} />{t("aboutPanel.copyDiagnostics")}</Button>
          </div>
          <p className="mt-3 text-center text-[9px] text-muted-foreground">{brand.fullName} · {brand.protocols}</p>
        </>;
    }
  }, [loaded, loading, section, settings, metadata, metadataError, setManagerView, setManagerOpen, setAiOpen, closeDialog, updateSetting, updateLanguagePreference, copyDiagnostics, t]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(700px,90vh)] w-[min(980px,92vw)] flex-col gap-0 p-0">
        <DialogDescription className="sr-only">{t("dialog.description")}</DialogDescription>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel-header px-4">
          <img src="/termvista-icon-v2.png" alt="" className="h-6 w-6 rounded-sm" />
          <DialogTitle>{brand.name} {t("title")}</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t("dialog.categories")} className="flex w-[210px] shrink-0 flex-col border-r border-border bg-panel-header/60 p-2">
            <div className="grid gap-0.5">
              {navigation.map(({ id, labelKey, icon: Icon }) => <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined} className={`flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[10px] transition-colors ${section === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon size={13} />{String(t(labelKey))}</button>)}
            </div>
          </nav>
          <main className="compact-scrollbar min-w-0 flex-1 overflow-y-auto px-5 py-4" aria-label={section === "about" ? String(t("nav.about")) : currentLabel}>
            {settingsError && <div role="alert" className="mb-3 rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">{t("dialog.saveError", { error: t("aboutPanel.metadataUnavailable") })}</div>}
            {settingsBody}
          </main>
        </div>
        <footer className={`flex h-12 shrink-0 items-center border-t border-border bg-panel-header/50 px-4 ${resetAvailable ? "justify-between" : "justify-end"}`}>
          {resetAvailable && <Button type="button" variant="ghost" size="sm" disabled={savingSection !== null} className="h-7 rounded-sm text-[10px]" onClick={() => void resetCurrentSection()}>{t("dialog.reset", { section: currentLabel })}</Button>}
          <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={closeDialog}>{t("dialog.close")}</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
