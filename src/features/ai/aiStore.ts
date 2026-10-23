import { create } from "zustand";
import type { AiContextSource, AiMessage, AiProviderView } from "@/features/ai/aiTypes";

export type AiIntent = {
  sessionId: string;
  prompt: string;
  sources: AiContextSource[];
};

type AiState = {
  providers: AiProviderView[];
  selectedProviderId: string;
  conversations: Record<string, AiMessage[]>;
  activeRequests: Record<string, string>;
  streamingMessageIds: Record<string, string>;
  intent: AiIntent | null;
  setProviders: (providers: AiProviderView[]) => void;
  setSelectedProviderId: (providerId: string) => void;
  setIntent: (intent: AiIntent | null) => void;
  beginStream: (sessionId: string, requestId: string, userText: string) => void;
  applyDelta: (sessionId: string, requestId: string, text: string) => void;
  finishStream: (sessionId: string, requestId: string, status: "complete" | "cancelled" | "error", errorMessage?: string) => void;
  clearSession: (sessionId: string) => void;
};

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAiStore = create<AiState>((set) => ({
  providers: [],
  selectedProviderId: "",
  conversations: {},
  activeRequests: {},
  streamingMessageIds: {},
  intent: null,
  setProviders: (providers) => set((state) => ({
    providers,
    selectedProviderId: providers.some((provider) => provider.id === state.selectedProviderId)
      ? state.selectedProviderId
      : providers[0]?.id ?? "",
  })),
  setSelectedProviderId: (selectedProviderId) => set({ selectedProviderId }),
  setIntent: (intent) => set({ intent }),
  beginStream: (sessionId, requestId, userText) => set((state) => {
    const assistantId = makeId();
    const userMessage: AiMessage = { id: makeId(), role: "user", content: userText, status: "complete" };
    const assistantMessage: AiMessage = { id: assistantId, role: "assistant", content: "", status: "streaming" };
    return {
      conversations: { ...state.conversations, [sessionId]: [...(state.conversations[sessionId] ?? []), userMessage, assistantMessage] },
      activeRequests: { ...state.activeRequests, [sessionId]: requestId },
      streamingMessageIds: { ...state.streamingMessageIds, [sessionId]: assistantId },
    };
  }),
  applyDelta: (sessionId, requestId, text) => set((state) => {
    if (state.activeRequests[sessionId] !== requestId) return state;
    const messageId = state.streamingMessageIds[sessionId];
    return {
      conversations: {
        ...state.conversations,
        [sessionId]: (state.conversations[sessionId] ?? []).map((message) =>
          message.id === messageId ? { ...message, content: message.content + text } : message,
        ),
      },
    };
  }),
  finishStream: (sessionId, requestId, status, errorMessage) => set((state) => {
    if (state.activeRequests[sessionId] !== requestId) return state;
    const messageId = state.streamingMessageIds[sessionId];
    return {
      activeRequests: Object.fromEntries(Object.entries(state.activeRequests).filter(([id]) => id !== sessionId)),
      streamingMessageIds: Object.fromEntries(Object.entries(state.streamingMessageIds).filter(([id]) => id !== sessionId)),
      conversations: {
        ...state.conversations,
        [sessionId]: (state.conversations[sessionId] ?? []).map((message) =>
          message.id === messageId ? { ...message, status, errorMessage } : message,
        ),
      },
    };
  }),
  clearSession: (sessionId) => set((state) => ({
    conversations: Object.fromEntries(Object.entries(state.conversations).filter(([id]) => id !== sessionId)),
    activeRequests: Object.fromEntries(Object.entries(state.activeRequests).filter(([id]) => id !== sessionId)),
    streamingMessageIds: Object.fromEntries(Object.entries(state.streamingMessageIds).filter(([id]) => id !== sessionId)),
  })),
}));
