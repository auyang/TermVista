import { create } from "zustand";
import type { RemoteDocument, SaveStatus } from "./remoteEditorBridge";

export type EditorSaveState = "ready" | "saving" | "saved" | "conflict" | "offline" | "error";

export type RemoteEditorTab = Omit<RemoteDocument, "text"> & {
  text: string;
  languageId: string;
  revision: number;
  selectionText: string;
  savedText: string;
  dirty: boolean;
  saveState: EditorSaveState;
  error: string | null;
};

type EditorState = {
  documents: RemoteEditorTab[];
  activeByConnection: Record<string, string>;
  open: (document: RemoteDocument, languageId: string) => { documentId: string; overLimit: boolean };
  activate: (connectionId: string, documentId: string) => void;
  updateText: (documentId: string, text: string) => void;
  updateSelection: (documentId: string, text: string) => void;
  setLanguage: (documentId: string, languageId: string) => void;
  setSaveState: (documentId: string, saveState: EditorSaveState, error?: string | null) => void;
  markSaved: (documentId: string, result: { sha256: string; text: string; canonicalPath: string; displayName: string; sizeBytes: number }) => void;
  mergeRemote: (document: RemoteDocument, keepDirtyText: boolean) => void;
  remove: (documentId: string) => void;
  removeCleanDocuments: () => void;
  activateTerminal: (connectionId: string) => void;
};

const MAX_OPEN_DOCUMENTS = 20;

function toEditorTab(document: RemoteDocument, languageId: string): RemoteEditorTab {
  const text = document.text ?? "";
  return {
    ...document,
    text,
    savedText: text,
    revision: 0,
    selectionText: "",
    languageId,
    dirty: false,
    saveState: document.sessionId ? "ready" : "offline",
    error: document.readOnlyReason,
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  documents: [],
  activeByConnection: {},
  open: (document, languageId) => {
    const existing = get().documents.find((item) => item.documentId === document.documentId);
    if (existing) {
      set((state) => ({
        activeByConnection: { ...state.activeByConnection, [document.connectionId]: document.documentId },
        documents: state.documents.map((item) => item.documentId === document.documentId && !item.dirty
          ? { ...item, ...document, text: document.text ?? "", savedText: document.text ?? "", languageId, revision: item.revision + Number(item.text !== (document.text ?? "")) }
          : item),
      }));
      return { documentId: document.documentId, overLimit: false };
    }
    if (get().documents.length >= MAX_OPEN_DOCUMENTS) return { documentId: "", overLimit: true };
    set((state) => ({
      documents: [...state.documents, toEditorTab(document, languageId)],
      activeByConnection: { ...state.activeByConnection, [document.connectionId]: document.documentId },
    }));
    return { documentId: document.documentId, overLimit: false };
  },
  activate: (connectionId, documentId) => set((state) => ({
    activeByConnection: { ...state.activeByConnection, [connectionId]: documentId },
  })),
  updateText: (documentId, text) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === documentId
      ? { ...item, text, revision: item.revision + Number(item.text !== text), dirty: text !== item.savedText, saveState: "ready", error: null }
      : item),
  })),
  updateSelection: (documentId, selectionText) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === documentId ? { ...item, selectionText } : item),
  })),
  setLanguage: (documentId, languageId) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === documentId ? { ...item, languageId } : item),
  })),
  setSaveState: (documentId, saveState, error = null) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === documentId ? { ...item, saveState, error } : item),
  })),
  markSaved: (documentId, result) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === documentId
      ? { ...item, sha256: result.sha256, savedText: result.text, text: result.text, canonicalPath: result.canonicalPath, displayName: result.displayName, sizeBytes: result.sizeBytes, dirty: false, saveState: "saved", error: null }
      : item),
  })),
  mergeRemote: (document, keepDirtyText) => set((state) => ({
    documents: state.documents.map((item) => item.documentId === document.documentId
      ? {
        ...item,
        ...document,
        text: keepDirtyText ? item.text : document.text ?? "",
        revision: item.revision + Number(!keepDirtyText && item.text !== (document.text ?? "")),
        selectionText: keepDirtyText ? item.selectionText : "",
        savedText: keepDirtyText ? item.savedText : document.text ?? "",
        dirty: keepDirtyText ? item.dirty : false,
        languageId: item.languageId,
        saveState: keepDirtyText && item.dirty ? "conflict" : "ready",
      }
      : item),
  })),
  remove: (documentId) => set((state) => {
    const removed = state.documents.find((item) => item.documentId === documentId);
    const documents = state.documents.filter((item) => item.documentId !== documentId);
    if (!removed) return { documents };
    const activeByConnection = { ...state.activeByConnection };
    if (activeByConnection[removed.connectionId] === documentId) {
      activeByConnection[removed.connectionId] = documents.find((item) => item.connectionId === removed.connectionId)?.documentId ?? "terminal";
    }
    return { documents, activeByConnection };
  }),
  removeCleanDocuments: () => set((state) => ({
    documents: state.documents.filter((item) => item.dirty),
    activeByConnection: Object.fromEntries(Object.entries(state.activeByConnection).map(([connectionId, activeId]) => [
      connectionId,
      state.documents.some((item) => item.documentId === activeId && item.dirty) ? activeId : "terminal",
    ])),
  })),
  activateTerminal: (connectionId) => set((state) => ({
    activeByConnection: { ...state.activeByConnection, [connectionId]: "terminal" },
  })),
}));

export function isSuccessfulSaveStatus(status: SaveStatus) {
  return status === "saved";
}
