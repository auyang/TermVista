export const locales = ["en-US", "zh-CN", "ja-JP", "zh-TW"] as const;
export type SupportedLocale = (typeof locales)[number];
export type LanguagePreference = SupportedLocale | "system";

export const nativeLanguageNames: Record<SupportedLocale, string> = {
  "en-US": "English",
  "zh-CN": "简体中文",
  "ja-JP": "日本語",
  "zh-TW": "繁體中文",
};

export function matchLocale(code: string): SupportedLocale | null {
  const canonical = code.trim().toLowerCase().replace(/_/g, "-");
  if (!canonical) return null;
  if (canonical === "zh-hant" || canonical.startsWith("zh-hant-") ||
    canonical === "zh-tw" || canonical.startsWith("zh-tw-") ||
    canonical === "zh-hk" || canonical.startsWith("zh-hk-") ||
    canonical === "zh-mo" || canonical.startsWith("zh-mo-")) return "zh-TW";
  if (canonical === "zh-hans" || canonical.startsWith("zh-hans-") ||
    canonical === "zh-cn" || canonical.startsWith("zh-cn-") ||
    canonical === "zh-sg" || canonical.startsWith("zh-sg-")) return "zh-CN";
  if (canonical === "ja" || canonical.startsWith("ja-")) return "ja-JP";
  if (canonical === "en" || canonical.startsWith("en-")) return "en-US";
  return null;
}

export function detectSystemLocale(preferred?: readonly string[]): SupportedLocale {
  const codes = preferred ?? (typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []);
  for (const code of codes) {
    const matched = matchLocale(code);
    if (matched) return matched;
  }
  return "en-US";
}

export function resolveLocale(preference: LanguagePreference, systemLanguages?: readonly string[]): SupportedLocale {
  return preference === "system" ? detectSystemLocale(systemLanguages) : preference;
}
