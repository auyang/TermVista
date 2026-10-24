import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runWithUpdateMaintenanceTask } from "@/features/updater/maintenanceTasks";
import type { ForwardRule, ForwardRuntime, Socks5Rule, Socks5Runtime, TcpCheckResult, TunnelEvent } from "./tunnelTypes";

export async function listForwardRules(profileId?: string | null) {
  return invoke<ForwardRule[]>("tunnel_rules_list", { profileId: profileId ?? null });
}

export async function saveForwardRule(rule: ForwardRule) {
  return runWithUpdateMaintenanceTask("tunnelSave", () => invoke<ForwardRule>("tunnel_rule_save", { rule }));
}

export async function deleteForwardRule(ruleId: string) {
  return runWithUpdateMaintenanceTask("tunnelDelete", () => invoke<boolean>("tunnel_rule_delete", { ruleId }));
}

export async function startForward(ruleId: string, sessionId: string) {
  return runWithUpdateMaintenanceTask("tunnelStart", () => invoke<ForwardRuntime>("tunnel_start", { ruleId, sessionId }));
}

export async function stopForward(ruleId: string) {
  return runWithUpdateMaintenanceTask("tunnelStop", () => invoke<ForwardRuntime>("tunnel_stop", { ruleId }));
}

export async function listForwardRuntimes() {
  return invoke<ForwardRuntime[]>("tunnel_status_list");
}

export async function listenForwardRuntimes(onRuntime: (runtime: ForwardRuntime) => void) {
  if (!isTauri()) return () => {};
  return listen<ForwardRuntime>("tunnel-runtime", (event) => onRuntime(event.payload));
}

export async function listSocks5Rules(profileId?: string | null) {
  return invoke<Socks5Rule[]>("socks5_rules_list", { profileId: profileId ?? null });
}

export async function saveSocks5Rule(rule: Socks5Rule) {
  return runWithUpdateMaintenanceTask("socks5Save", () => invoke<Socks5Rule>("socks5_rule_save", { rule }));
}

export async function deleteSocks5Rule(ruleId: string) {
  return runWithUpdateMaintenanceTask("socks5Delete", () => invoke<boolean>("socks5_rule_delete", { ruleId }));
}

export async function startSocks5(ruleId: string, sessionId: string) {
  return runWithUpdateMaintenanceTask("socks5Start", () => invoke<Socks5Runtime>("socks5_start", { ruleId, sessionId }));
}

export async function stopSocks5(ruleId: string) {
  return runWithUpdateMaintenanceTask("socks5Stop", () => invoke<Socks5Runtime>("socks5_stop", { ruleId }));
}

export async function listSocks5Runtimes() {
  return invoke<Socks5Runtime[]>("socks5_status_list");
}

export async function listenSocks5Runtimes(onRuntime: (runtime: Socks5Runtime) => void) {
  if (!isTauri()) return () => {};
  return listen<Socks5Runtime>("socks5-runtime", (event) => onRuntime(event.payload));
}

export async function listTunnelEvents() {
  return invoke<TunnelEvent[]>("tunnel_event_history");
}

export async function checkTunnelTarget(ruleId: string, sessionId: string) {
  return invoke<TcpCheckResult>("tunnel_check_target", { ruleId, sessionId });
}
