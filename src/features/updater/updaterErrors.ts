export function updaterErrorMessage(error: unknown): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("404")) return "更新清单尚未发布（HTTP 404）。请稍后重试，或查看 GitHub Releases。";
  if (lower.includes("403")) return "GitHub 暂时拒绝访问更新清单（HTTP 403）。请稍后重试。";
  if (lower.includes("signature") || lower.includes("signing") || lower.includes("pubkey")) {
    return "更新包签名验证失败，TermVista 已阻止安装。请勿手动绕过验证。";
  }
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("dns") || lower.includes("connect")) {
    return "无法连接更新服务。请检查网络后重试。";
  }
  return "更新操作失败。请检查网络和系统时间后重试。";
}
