import { create } from "zustand";
import i18next from "@/i18n";
import type { ConnectionProfile } from "@/stores/workspaceStore";
import type { AuthPromptEvent, HostKeyChallenge, SshError, SshStatusEvent, SshState } from "@/features/ssh/sshTypes";

export type SshTabSession = {
  attemptId: string;
  profile: ConnectionProfile;
  username: string;
  sessionId?: string;
  state: SshState;
  error?: string;
  errorEvent?: SshError;
  autoReconnectAttempt?: number;
  autoReconnectNextAt?: number;
};

type SshSessionState = {
  sessions: Record<string, SshTabSession>;
  connectingProfile: ConnectionProfile | null;
  connectingTabId: string | null;
  credentialNotice: string | null;
  hostKeyChallenges: HostKeyChallenge[];
  authPrompts: AuthPromptEvent[];
  openCredentials: (profile: ConnectionProfile, replaceTabId?: string | null, notice?: string | null) => void;
  closeCredentials: () => void;
  openHostKeyChallenge: (challenge: HostKeyChallenge) => void;
  closeHostKeyChallenge: (attemptId?: string) => void;
  openAuthPrompt: (prompt: AuthPromptEvent) => void;
  closeAuthPrompt: (attemptId: string, promptId?: string) => void;
  addSession: (session: SshTabSession) => void;
  applyStatus: (event: SshStatusEvent) => void;
  setAutoReconnectProgress: (attemptId: string, attempt: number | null, nextAt?: number) => void;
  removeSession: (attemptId: string) => void;
};

export const useSshSessionStore = create<SshSessionState>((set) => ({
  sessions: {},
  connectingProfile: null,
  connectingTabId: null,
  credentialNotice: null,
  hostKeyChallenges: [],
  authPrompts: [],
  openCredentials: (profile, connectingTabId = null, credentialNotice = null) => set({ connectingProfile: profile, connectingTabId, credentialNotice }),
  closeCredentials: () => set({ connectingProfile: null, connectingTabId: null, credentialNotice: null }),
  openHostKeyChallenge: (challenge) => set((state) => ({
    hostKeyChallenges: state.hostKeyChallenges.some((item) => item.attemptId === challenge.attemptId)
      ? state.hostKeyChallenges
      : [...state.hostKeyChallenges, challenge],
  })),
  closeHostKeyChallenge: (attemptId) => set((state) => ({
    hostKeyChallenges: attemptId
      ? state.hostKeyChallenges.filter((challenge) => challenge.attemptId !== attemptId)
      : state.hostKeyChallenges.slice(1),
  })),
  openAuthPrompt: (prompt) => set((state) => ({
    authPrompts: state.authPrompts.some((item) => item.promptId === prompt.promptId)
      ? state.authPrompts
      : [...state.authPrompts, prompt],
  })),
  closeAuthPrompt: (attemptId, promptId) => set((state) => ({
    authPrompts: state.authPrompts.filter((prompt) => prompt.attemptId !== attemptId || (promptId && prompt.promptId !== promptId)),
  })),
  addSession: (session) => set((state) => ({ sessions: { ...state.sessions, [session.attemptId]: session } })),
  applyStatus: (event) => set((state) => {
    const session = state.sessions[event.attemptId];
    if (!session) return state;
    return {
      sessions: {
        ...state.sessions,
        [event.attemptId]: {
          ...session,
          sessionId: event.sessionId ?? session.sessionId,
          state: event.state,
          error: event.error?.message,
          errorEvent: event.error,
        },
      },
      hostKeyChallenges: ["error", "canceled", "disconnected"].includes(event.state)
        ? state.hostKeyChallenges.filter((challenge) => challenge.attemptId !== event.attemptId)
        : state.hostKeyChallenges,
      authPrompts: ["error", "canceled", "disconnected"].includes(event.state)
        ? state.authPrompts.filter((prompt) => prompt.attemptId !== event.attemptId)
        : state.authPrompts,
    };
  }),
  setAutoReconnectProgress: (attemptId, attempt, nextAt) => set((state) => {
    const session = state.sessions[attemptId];
    if (!session) return state;
    const sessions = { ...state.sessions };
    if (attempt === null) {
      const remaining = { ...session };
      delete remaining.autoReconnectAttempt;
      delete remaining.autoReconnectNextAt;
      sessions[attemptId] = remaining;
    } else {
      sessions[attemptId] = { ...session, autoReconnectAttempt: attempt, autoReconnectNextAt: nextAt };
    }
    return { sessions };
  }),
  removeSession: (attemptId) => set((state) => {
    const sessions = { ...state.sessions };
    delete sessions[attemptId];
    return {
      sessions,
      hostKeyChallenges: state.hostKeyChallenges.filter((challenge) => challenge.attemptId !== attemptId),
      authPrompts: state.authPrompts.filter((prompt) => prompt.attemptId !== attemptId),
    };
  }),
}));

export function statusLabel(state: SshState): string {
  switch (state) {
    case "connecting": return i18next.t("connecting", { ns: "common" });
    case "verifyingHostKey": return i18next.t("verifyingHostKey", { ns: "common" });
    case "authenticating": return i18next.t("authenticating", { ns: "common" });
    case "openingPty": return i18next.t("openingTerminal", { ns: "common" });
    case "connected": return i18next.t("connected", { ns: "common" });
    case "disconnecting": return i18next.t("disconnecting", { ns: "common" });
    case "disconnected": return i18next.t("disconnected", { ns: "common" });
    case "canceled": return i18next.t("canceled", { ns: "common" });
    case "error": return i18next.t("connectionError", { ns: "common" });
  }
}
