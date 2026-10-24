export type UpdaterErrorCode = "notFound" | "forbidden" | "signature" | "network" | "unknown";

/** 将系统更新插件错误归类为稳定代码，前端再按当前语言显示。 */
export function updaterErrorCode(error: unknown): UpdaterErrorCode {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("404")) return "notFound";
  if (lower.includes("403")) return "forbidden";
  if (lower.includes("signature") || lower.includes("signing") || lower.includes("pubkey")) return "signature";
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("dns") || lower.includes("connect")) return "network";
  return "unknown";
}
