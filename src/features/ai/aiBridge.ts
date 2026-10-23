import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AiConnectionTestResult,
  AiContextPreview,
  AiPreviewRequest,
  AiProviderInput,
  AiProviderView,
  AiStreamEvent,
} from "@/features/ai/aiTypes";
import { runWithUpdateMaintenanceTask } from "@/features/updater/maintenanceTasks";

export function listAiProviders() {
  return invoke<AiProviderView[]>("ai_provider_list");
}

export function saveAiProvider(input: AiProviderInput) {
  return invoke<AiProviderView>("ai_provider_save", { input });
}

export function testAiProvider(providerId: string) {
  return runWithUpdateMaintenanceTask("测试 AI 服务连接", () => invoke<AiConnectionTestResult>("ai_provider_test", { providerId }));
}

export function previewAiContext(request: AiPreviewRequest) {
  return invoke<AiContextPreview>("ai_context_preview", { request });
}

export function startAiChat(
  sessionId: string,
  providerId: string,
  snapshotId: string,
  onEvent: Channel<AiStreamEvent>,
) {
  return invoke<{ requestId: string }>("ai_chat_start", {
    sessionId,
    providerId,
    snapshotId,
    onEvent,
  });
}

export function cancelAiChat(requestId: string) {
  return invoke<boolean>("ai_chat_cancel", { requestId });
}

export function clearAiConversation(sessionId: string) {
  return invoke<void>("ai_conversation_clear", { sessionId });
}
