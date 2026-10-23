import { create } from "zustand";
import type { LocalEntry, RemoteEntry, TransferProgress } from "@/features/sftp/sftpBridge";

export type SftpViewState = {
  status: "idle" | "opening" | "ready" | "error" | "disconnected";
  path: string;
  pathDraft: string;
  shellPath?: string;
  backHistory: string[];
  forwardHistory: string[];
  entries: RemoteEntry[];
  transfers: TransferProgress[];
  treeEntries: Record<string, RemoteEntry[]>;
  expandedPaths: string[];
  treeLoading: string[];
  selectedPaths: string[];
  query: string;
  sortKey: "name" | "sizeBytes" | "kind" | "modifiedAtEpochMs" | "permissions" | "ownerLabel";
  sortDirection: "asc" | "desc";
  page: number;
  compact: boolean;
  loading: boolean;
  requestId: number;
  error?: string;
  localGrantId?: string;
  localRootPath?: string;
  localPath: string;
  localEntries: LocalEntry[];
  localSelectedPaths: string[];
  localLoading: boolean;
  localError?: string;
};

type SftpSessionStore = {
  contexts: Record<string, SftpViewState>;
  initialize: (sessionId: string) => void;
  remove: (sessionId: string) => void;
  setStatus: (sessionId: string, status: SftpViewState["status"], error?: string) => void;
  setPathDraft: (sessionId: string, value: string) => void;
  setShellPath: (sessionId: string, value: string) => void;
  setLocation: (sessionId: string, path: string, historyMode?: "push" | "back" | "forward" | "replace") => void;
  beginRead: (sessionId: string) => number;
  applyRead: (sessionId: string, path: string, requestId: number, entries: RemoteEntry[]) => void;
  failRead: (sessionId: string, path: string, requestId: number, message: string) => void;
  setTreeEntries: (sessionId: string, path: string, entries: RemoteEntry[]) => void;
  setTreeLoading: (sessionId: string, path: string, loading: boolean) => void;
  toggleExpanded: (sessionId: string, path: string) => void;
  selectPath: (sessionId: string, path: string, additive: boolean) => void;
  clearSelection: (sessionId: string) => void;
  setQuery: (sessionId: string, query: string) => void;
  setSort: (sessionId: string, sortKey: SftpViewState["sortKey"]) => void;
  setPage: (sessionId: string, page: number) => void;
  setCompact: (sessionId: string, compact: boolean) => void;
  setTransfers: (sessionId: string, transfers: TransferProgress[]) => void;
  updateTransfer: (sessionId: string, transfer: TransferProgress) => void;
  setLocalGrant: (sessionId: string, grantId: string, rootPath: string) => void;
  setLocalPath: (sessionId: string, path: string) => void;
  setLocalEntries: (sessionId: string, entries: LocalEntry[]) => void;
  setLocalLoading: (sessionId: string, loading: boolean, error?: string) => void;
  selectLocalPath: (sessionId: string, path: string, additive: boolean) => void;
};

const createContext = (): SftpViewState => ({
  status: "idle",
  path: "",
  pathDraft: "",
  shellPath: undefined,
  backHistory: [],
  forwardHistory: [],
  entries: [],
  transfers: [],
  treeEntries: {},
  expandedPaths: [],
  treeLoading: [],
  selectedPaths: [],
  query: "",
  sortKey: "name",
  sortDirection: "asc",
  page: 0,
  compact: false,
  loading: false,
  requestId: 0,
  localPath: "",
  localEntries: [],
  localSelectedPaths: [],
  localLoading: false,
});

export const useSftpSessionStore = create<SftpSessionStore>((set) => ({
  contexts: {},
  initialize: (sessionId) => set((state) => state.contexts[sessionId]
    ? state
    : { contexts: { ...state.contexts, [sessionId]: createContext() } }),
  remove: (sessionId) => set((state) => {
    const contexts = { ...state.contexts };
    delete contexts[sessionId];
    return { contexts };
  }),
  setStatus: (sessionId, status, error) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, status, error } } };
  }),
  setPathDraft: (sessionId, value) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, pathDraft: value } } };
  }),
  setShellPath: (sessionId, value) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    if (context.shellPath === value) return state;
    return { contexts: { ...state.contexts, [sessionId]: { ...context, shellPath: value } } };
  }),
  setLocation: (sessionId, path, historyMode = "push") => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    if (!path || path === context.path && historyMode !== "replace") return state;
    let backHistory = context.backHistory;
    let forwardHistory = context.forwardHistory;
    if (historyMode === "push") {
      backHistory = context.path ? [...backHistory, context.path] : backHistory;
      forwardHistory = [];
    } else if (historyMode === "back") {
      const previous = backHistory[backHistory.length - 1];
      backHistory = backHistory.slice(0, -1);
      forwardHistory = previous ? [...forwardHistory, context.path] : forwardHistory;
    } else if (historyMode === "forward") {
      const next = forwardHistory[forwardHistory.length - 1];
      forwardHistory = forwardHistory.slice(0, -1);
      backHistory = next ? [...backHistory, context.path] : backHistory;
    }
    return {
      contexts: {
        ...state.contexts,
        [sessionId]: { ...context, path, pathDraft: path, backHistory, forwardHistory, selectedPaths: [], entries: [], page: 0 },
      },
    };
  }),
  beginRead: (sessionId) => {
    let requestId = 0;
    set((state) => {
      const context = state.contexts[sessionId] ?? createContext();
      requestId = context.requestId + 1;
      return { contexts: { ...state.contexts, [sessionId]: { ...context, requestId, loading: true, error: undefined } } };
    });
    return requestId;
  },
  applyRead: (sessionId, path, requestId, entries) => set((state) => {
    const context = state.contexts[sessionId];
    if (!context || context.path !== path || context.requestId !== requestId) return state;
    return { contexts: { ...state.contexts, [sessionId]: { ...context, entries, loading: false, error: undefined } } };
  }),
  failRead: (sessionId, path, requestId, message) => set((state) => {
    const context = state.contexts[sessionId];
    if (!context || context.path !== path || context.requestId !== requestId) return state;
    return { contexts: { ...state.contexts, [sessionId]: { ...context, loading: false, error: message } } };
  }),
  setTreeEntries: (sessionId, path, entries) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, treeEntries: { ...context.treeEntries, [path]: entries } } } };
  }),
  setTreeLoading: (sessionId, path, loading) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const treeLoading = loading
      ? [...new Set([...context.treeLoading, path])]
      : context.treeLoading.filter((item) => item !== path);
    return { contexts: { ...state.contexts, [sessionId]: { ...context, treeLoading } } };
  }),
  toggleExpanded: (sessionId, path) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const expandedPaths = context.expandedPaths.includes(path)
      ? context.expandedPaths.filter((item) => item !== path)
      : [...context.expandedPaths, path];
    return { contexts: { ...state.contexts, [sessionId]: { ...context, expandedPaths } } };
  }),
  selectPath: (sessionId, path, additive) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const selectedPaths = additive
      ? context.selectedPaths.includes(path)
        ? context.selectedPaths.filter((item) => item !== path)
        : [...context.selectedPaths, path]
      : [path];
    return { contexts: { ...state.contexts, [sessionId]: { ...context, selectedPaths } } };
  }),
  clearSelection: (sessionId) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, selectedPaths: [] } } };
  }),
  setQuery: (sessionId, query) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, query, page: 0 } } };
  }),
  setSort: (sessionId, sortKey) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const sortDirection = context.sortKey === sortKey && context.sortDirection === "asc" ? "desc" : "asc";
    return { contexts: { ...state.contexts, [sessionId]: { ...context, sortKey, sortDirection } } };
  }),
  setPage: (sessionId, page) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, page: Math.max(0, page) } } };
  }),
  setCompact: (sessionId, compact) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, compact } } };
  }),
  setTransfers: (sessionId, transfers) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, transfers } } };
  }),
  updateTransfer: (sessionId, transfer) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const existing = context.transfers.findIndex((item) => item.transferId === transfer.transferId);
    const transfers = existing < 0
      ? [...context.transfers, transfer]
      : context.transfers.map((item, index) => index === existing ? transfer : item);
    return { contexts: { ...state.contexts, [sessionId]: { ...context, transfers } } };
  }),
  setLocalGrant: (sessionId, localGrantId, localRootPath) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, localGrantId, localRootPath, localPath: "", localEntries: [], localSelectedPaths: [], localError: undefined } } };
  }),
  setLocalPath: (sessionId, localPath) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, localPath, localSelectedPaths: [], localLoading: true, localError: undefined } } };
  }),
  setLocalEntries: (sessionId, localEntries) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, localEntries, localLoading: false, localError: undefined } } };
  }),
  setLocalLoading: (sessionId, localLoading, localError) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    return { contexts: { ...state.contexts, [sessionId]: { ...context, localLoading, localError } } };
  }),
  selectLocalPath: (sessionId, path, additive) => set((state) => {
    const context = state.contexts[sessionId] ?? createContext();
    const localSelectedPaths = additive
      ? context.localSelectedPaths.includes(path)
        ? context.localSelectedPaths.filter((item) => item !== path)
        : [...context.localSelectedPaths, path]
      : [path];
    return { contexts: { ...state.contexts, [sessionId]: { ...context, localSelectedPaths } } };
  }),
}));
