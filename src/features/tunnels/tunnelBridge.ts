import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ForwardRule, ForwardRuntime } from "./tunnelTypes";

export async function listForwardRules(profileId?: string | null) {
  return invoke<ForwardRule[]>("tunnel_rules_list", { profileId: profileId ?? null });
}

export async function saveForwardRule(rule: ForwardRule) {
  return invoke<ForwardRule>("tunnel_rule_save", { rule });
}

export async function deleteForwardRule(ruleId: string) {
  return invoke<boolean>("tunnel_rule_delete", { ruleId });
}

export async function startForward(ruleId: string, sessionId: string) {
  return invoke<ForwardRuntime>("tunnel_start", { ruleId, sessionId });
}

export async function stopForward(ruleId: string) {
  return invoke<ForwardRuntime>("tunnel_stop", { ruleId });
}

export async function listForwardRuntimes() {
  return invoke<ForwardRuntime[]>("tunnel_status_list");
}

export async function listenForwardRuntimes(onRuntime: (runtime: ForwardRuntime) => void) {
  if (!isTauri()) return () => {};
  return listen<ForwardRuntime>("tunnel-runtime", (event) => onRuntime(event.payload));
}
