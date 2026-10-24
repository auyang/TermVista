import { create } from "zustand";
import { defaultSettings, getSettings, patchSettings, type PublicSettings } from "@/features/settings/settingsBridge";

type WritableSection = "general" | "terminal" | "connections" | "monitoring" | "appearance";

type SettingsState = {
  settings: PublicSettings;
  loaded: boolean;
  loading: boolean;
  savingSection: WritableSection | null;
  error: string | null;
  load: () => Promise<PublicSettings>;
  update: <T extends WritableSection>(section: T, patch: Partial<PublicSettings[T]>) => Promise<PublicSettings>;
};

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "设置无法保存，请重试。";
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  let updateQueue: Promise<void> = Promise.resolve();
  return ({
  settings: defaultSettings,
  loaded: false,
  loading: false,
  savingSection: null,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await getSettings();
      set({ settings, loaded: true, loading: false });
      return settings;
    } catch (error) {
      set({ loading: false, error: errorText(error) });
      throw error;
    }
  },
  update: async (section, patch) => {
    set({ savingSection: section, error: null });
    const operation = updateQueue.then(async () => {
      const { settings } = get();
      try {
        const updated = await patchSettings(section, patch, settings.revision);
        set({ settings: updated, loaded: true, savingSection: null });
        return updated;
      } catch (error) {
        const message = errorText(error);
        try {
          const latest = await getSettings();
          set({ settings: latest, loaded: true });
        } catch {
          // 保留旧值和原始错误，不能显示保存成功。
        }
        set({ savingSection: null, error: message });
        throw error;
      }
    });
    updateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  },
  });
});
