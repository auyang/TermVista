type ProfileTab = { id: string; mode: string; profileId?: string };
type ProfileSession = { state: string; sessionId?: string } | undefined;

const connectingStates = new Set(["connecting", "verifyingHostKey", "authenticating", "openingPty"]);

export function findReusableProfileTab(
  tabs: readonly ProfileTab[],
  sessions: Record<string, ProfileSession>,
  profileId: string,
) {
  const matches = tabs.filter((tab) => tab.mode === "ssh" && tab.profileId === profileId);
  return matches.find((tab) => sessions[tab.id]?.state === "connected" && Boolean(sessions[tab.id]?.sessionId))
    ?? matches.find((tab) => connectingStates.has(sessions[tab.id]?.state ?? ""))
    ?? matches[0]
    ?? null;
}
