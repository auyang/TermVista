import { create } from "zustand";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "needsRestart"
  | "error";

export type UpdateDetails = {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string;
  platform: string;
  arch: string;
};

export type UpdaterViewState = {
  phase: UpdaterPhase;
  update: UpdateDetails | null;
  downloadedBytes: number;
  contentLength: number | null;
  error: string | null;
  message: string | null;
};

type UpdaterStore = UpdaterViewState & {
  setState: (patch: Partial<UpdaterViewState>) => void;
  reset: () => void;
};

const initialState: UpdaterViewState = {
  phase: "idle",
  update: null,
  downloadedBytes: 0,
  contentLength: null,
  error: null,
  message: null,
};

export const useUpdaterStore = create<UpdaterStore>((set) => ({
  ...initialState,
  setState: (patch) => set((state) => ({ ...state, ...patch })),
  reset: () => set(initialState),
}));
