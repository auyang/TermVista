import type { DiagnosticTemplateId } from "@/features/diagnostics/diagnosticTypes";

const RULES: Array<{ id: DiagnosticTemplateId; matches: (text: string) => boolean }> = [
  {
    id: "nginx502",
    matches: (text) => /nginx|反向代理/.test(text) && /502|bad gateway|上游/.test(text),
  },
  {
    id: "serviceFailed",
    matches: (text) => /systemd|服务|service/.test(text) && /失败|停止|不可用|崩溃|failed|inactive/.test(text),
  },
  {
    id: "diskLow",
    matches: (text) => /磁盘|disk|filesystem|空间/.test(text) && /满|不足|低|full|low/.test(text),
  },
  {
    id: "highCpu",
    matches: (text) => /cpu|处理器|负载|load average/.test(text) && /高|飙|占用|high|过大/.test(text),
  },
  {
    id: "portUnbound",
    matches: (text) => /端口|port/.test(text) && /监听|未开放|未绑定|不通|listen|unbound/.test(text),
  },
  {
    id: "currentHost",
    matches: (text) => /主机信息|系统信息|服务器信息|host info/.test(text),
  },
];

export function matchDiagnosticIntent(prompt: string): DiagnosticTemplateId | null {
  const normalized = prompt.toLowerCase().replace(/[\s，。！？、：；,.!?;:]+/g, " ").trim();
  if (!normalized) return null;
  const matches = RULES.filter((rule) => rule.matches(normalized)).map((rule) => rule.id);
  return matches.length === 1 ? matches[0] : null;
}
