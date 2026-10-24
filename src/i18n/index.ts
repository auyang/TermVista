import enCommon from "./locales/en-US/common.json";
import cnCommon from "./locales/zh-CN/common.json";
import jaCommon from "./locales/ja-JP/common.json";
import twCommon from "./locales/zh-TW/common.json";
import enSettings from "./locales/en-US/settings.json";
import cnSettings from "./locales/zh-CN/settings.json";
import jaSettings from "./locales/ja-JP/settings.json";
import twSettings from "./locales/zh-TW/settings.json";
import enHome from "./locales/en-US/home.json";
import cnHome from "./locales/zh-CN/home.json";
import jaHome from "./locales/ja-JP/home.json";
import twHome from "./locales/zh-TW/home.json";
import enConnections from "./locales/en-US/connections.json";
import cnConnections from "./locales/zh-CN/connections.json";
import jaConnections from "./locales/ja-JP/connections.json";
import twConnections from "./locales/zh-TW/connections.json";
import enTerminal from "./locales/en-US/terminal.json";
import cnTerminal from "./locales/zh-CN/terminal.json";
import jaTerminal from "./locales/ja-JP/terminal.json";
import twTerminal from "./locales/zh-TW/terminal.json";
import enSftp from "./locales/en-US/sftp.json";
import cnSftp from "./locales/zh-CN/sftp.json";
import jaSftp from "./locales/ja-JP/sftp.json";
import twSftp from "./locales/zh-TW/sftp.json";
import enEditor from "./locales/en-US/editor.json";
import cnEditor from "./locales/zh-CN/editor.json";
import jaEditor from "./locales/ja-JP/editor.json";
import twEditor from "./locales/zh-TW/editor.json";
import enMonitor from "./locales/en-US/monitor.json";
import cnMonitor from "./locales/zh-CN/monitor.json";
import jaMonitor from "./locales/ja-JP/monitor.json";
import twMonitor from "./locales/zh-TW/monitor.json";
import enAi from "./locales/en-US/ai.json";
import cnAi from "./locales/zh-CN/ai.json";
import jaAi from "./locales/ja-JP/ai.json";
import twAi from "./locales/zh-TW/ai.json";
import enDiagnostics from "./locales/en-US/diagnostics.json";
import cnDiagnostics from "./locales/zh-CN/diagnostics.json";
import jaDiagnostics from "./locales/ja-JP/diagnostics.json";
import twDiagnostics from "./locales/zh-TW/diagnostics.json";
import enTunnels from "./locales/en-US/tunnels.json";
import cnTunnels from "./locales/zh-CN/tunnels.json";
import jaTunnels from "./locales/ja-JP/tunnels.json";
import twTunnels from "./locales/zh-TW/tunnels.json";
import enUpdater from "./locales/en-US/updater.json";
import cnUpdater from "./locales/zh-CN/updater.json";
import jaUpdater from "./locales/ja-JP/updater.json";
import twUpdater from "./locales/zh-TW/updater.json";
import enWorkspace from "./locales/en-US/workspace.json";
import cnWorkspace from "./locales/zh-CN/workspace.json";
import jaWorkspace from "./locales/ja-JP/workspace.json";
import twWorkspace from "./locales/zh-TW/workspace.json";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { detectSystemLocale, resolveLocale, type LanguagePreference, type SupportedLocale } from "./locale";
import { applyMonacoLocale } from "./monacoNls";

// Seed locale resources only: Codex must migrate ALL visible strings before release.
export const resources = {
  "en-US": { common: enCommon, settings: enSettings, home: enHome, connections: enConnections, terminal: enTerminal, sftp: enSftp, editor: enEditor, monitor: enMonitor, ai: enAi, diagnostics: enDiagnostics, tunnels: enTunnels, updater: enUpdater, workspace: enWorkspace },
  "zh-CN": { common: cnCommon, settings: cnSettings, home: cnHome, connections: cnConnections, terminal: cnTerminal, sftp: cnSftp, editor: cnEditor, monitor: cnMonitor, ai: cnAi, diagnostics: cnDiagnostics, tunnels: cnTunnels, updater: cnUpdater, workspace: cnWorkspace },
  "ja-JP": { common: jaCommon, settings: jaSettings, home: jaHome, connections: jaConnections, terminal: jaTerminal, sftp: jaSftp, editor: jaEditor, monitor: jaMonitor, ai: jaAi, diagnostics: jaDiagnostics, tunnels: jaTunnels, updater: jaUpdater, workspace: jaWorkspace },
  "zh-TW": { common: twCommon, settings: twSettings, home: twHome, connections: twConnections, terminal: twTerminal, sftp: twSftp, editor: twEditor, monitor: twMonitor, ai: twAi, diagnostics: twDiagnostics, tunnels: twTunnels, updater: twUpdater, workspace: twWorkspace },
} as const;

export const defaultNS = "common" as const;
export const namespaces = ["common", "settings", "home", "connections", "terminal", "sftp", "editor", "monitor", "ai", "diagnostics", "tunnels", "updater", "workspace"] as const;

// Initialize once before React mounts. The settings bootstrap must synchronize
// the persisted preference BEFORE the full UI is displayed.
export const i18nReady = i18next.use(initReactI18next).init({
  resources,
  lng: detectSystemLocale(),
  fallbackLng: "en-US",
  supportedLngs: ["en-US", "zh-CN", "ja-JP", "zh-TW"],
  ns: [...namespaces],
  defaultNS,
  returnNull: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export async function applyResolvedLocale(locale: SupportedLocale): Promise<unknown> {
  await applyMonacoLocale(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
  }
  return i18next.changeLanguage(locale);
}

export async function applyLanguagePreference(preference: LanguagePreference): Promise<SupportedLocale> {
  await i18nReady;
  const locale = resolveLocale(preference);
  await applyResolvedLocale(locale);
  return locale;
}

export default i18next;
