import type { SupportedLocale } from "./locale";

type MonacoNlsGlobal = typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[];
  _VSCODE_NLS_LANGUAGE?: string;
};

type MonacoMessages = { messages: string[]; language: string };

const messagesByLocale = new Map<SupportedLocale, MonacoMessages>();

export async function applyMonacoLocale(locale: SupportedLocale) {
  const target = globalThis as MonacoNlsGlobal;
  if (locale === "en-US") {
    target._VSCODE_NLS_MESSAGES = undefined;
    target._VSCODE_NLS_LANGUAGE = "en";
    return;
  }

  let messages = messagesByLocale.get(locale);
  if (!messages) {
    if (locale === "ja-JP") await import("monaco-editor/nls/lang/ja.js");
    else if (locale === "zh-CN") await import("monaco-editor/nls/lang/zh-cn.js");
    else await import("monaco-editor/nls/lang/zh-tw.js");
    messages = {
      messages: target._VSCODE_NLS_MESSAGES ?? [],
      language: target._VSCODE_NLS_LANGUAGE ?? "en",
    };
    messagesByLocale.set(locale, messages);
  }
  target._VSCODE_NLS_MESSAGES = messages.messages;
  target._VSCODE_NLS_LANGUAGE = messages.language;
}
