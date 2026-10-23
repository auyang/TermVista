import { useMemo, useState, type KeyboardEvent } from "react";
import { Activity, ArrowRight, Folder, Plus, Search, Server, Sparkles, TerminalSquare } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { connectProfile } from "@/features/ssh/sshBridge";
import { statusLabel, useSshSessionStore } from "@/stores/sshSessionStore";
import { useWorkspaceStore, type ConnectionProfile, type WorkspaceTab } from "@/stores/workspaceStore";

type PaletteItem = {
  id: string;
  group: string;
  label: string;
  detail: string;
  keywords: string;
  icon: typeof Server;
  disabled?: boolean;
  run: () => void;
};

function connectOrFocus(profile: ConnectionProfile) {
  const state = useWorkspaceStore.getState();
  const tab = state.tabs.find((item) => item.mode === "ssh" && item.profileId === profile.id);
  if (!tab) {
    void connectProfile(profile);
    return;
  }
  state.activateTab(tab.id);
  const session = useSshSessionStore.getState().sessions[tab.id];
  if (session && ["connected", "connecting", "verifyingHostKey", "authenticating", "openingPty"].includes(session.state)) return;
  void connectProfile(profile, tab.id);
}

function tabDescription(tab: WorkspaceTab) {
  const session = tab.mode === "ssh" ? useSshSessionStore.getState().sessions[tab.id] : undefined;
  return tab.mode === "ssh" ? `${tab.host ?? "SSH"} · ${session ? statusLabel(session.state) : "待重连"}` : tab.mode === "blank" ? "快速连接首页" : "演示布局";
}

function focusSftpPath(tab: WorkspaceTab) {
  useWorkspaceStore.getState().activateTab(tab.id);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent("aissh:focus-sftp-path", {
      detail: { sessionId: useSshSessionStore.getState().sessions[tab.id]?.sessionId },
    }));
  }));
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const profiles = useWorkspaceStore((state) => state.profiles);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const aiOpen = useWorkspaceStore((state) => state.aiOpen);
  const activeSession = useSshSessionStore((state) => activeTabId ? state.sessions[activeTabId] : undefined);

  const items = useMemo<PaletteItem[]>(() => {
    const profileItems = profiles.map((profile) => ({
      id: `profile:${profile.id}`,
      group: profile.favorite ? "收藏服务器" : profile.lastConnectedAt ? "最近连接" : "服务器",
      label: profile.name,
      detail: `${profile.username || "未设置用户"}@${profile.host}:${profile.port || 22}${profile.group ? ` · ${profile.group}` : ""}`,
      keywords: `${profile.name} ${profile.host} ${profile.username} ${profile.group} ${profile.environment}`,
      icon: Server,
      run: () => connectOrFocus(profile),
    }));
    const tabItems = tabs.map((tab) => ({
      id: `tab:${tab.id}`,
      group: "已打开标签",
      label: tab.title,
      detail: tabDescription(tab),
      keywords: `${tab.title} ${tab.host ?? ""}`,
      icon: tab.mode === "ssh" ? TerminalSquare : Folder,
      run: () => useWorkspaceStore.getState().activateTab(tab.id),
    }));
    const currentTab = tabs.find((tab) => tab.id === activeTabId);
    const currentSession = currentTab?.mode === "ssh"
      ? activeSession
      : undefined;
    const actions: PaletteItem[] = [
      {
        id: "action:connections",
        group: "常用操作",
        label: "管理连接",
        detail: "新增、编辑或管理可信主机",
        keywords: "连接管理器 新建服务器 trusted hosts",
        icon: Folder,
        run: () => useWorkspaceStore.getState().setManagerOpen(true),
      },
      {
        id: "action:new-tab",
        group: "常用操作",
        label: "新建标签页",
        detail: "打开快速连接首页",
        keywords: "新建 tab home",
        icon: Plus,
        run: () => useWorkspaceStore.getState().addBlankTab(),
      },
      {
        id: "action:sftp-path",
        group: "常用操作",
        label: "定位当前 SFTP 路径",
        detail: currentSession?.state === "connected" ? `${currentTab?.title ?? "当前服务器"} · 聚焦远程路径输入框` : "连接 SSH 后可用",
        keywords: "文件 目录 路径 sftp remote path",
        icon: Folder,
        disabled: currentSession?.state !== "connected" || !currentSession.sessionId,
        run: () => currentTab && focusSftpPath(currentTab),
      },
      {
        id: "action:ai",
        group: "常用操作",
        label: aiOpen ? "关闭 AI 助手" : "打开 AI 助手",
        detail: "AI 建议仍需检查和确认，不会自动执行命令",
        keywords: "ai copilot 助手",
        icon: Activity,
        run: () => useWorkspaceStore.getState().toggleAi(),
      },
    ];
    return [...profileItems, ...tabItems, ...actions];
  }, [activeSession, activeTabId, aiOpen, profiles, tabs]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => !normalizedQuery || `${item.label} ${item.detail} ${item.keywords}`.toLocaleLowerCase().includes(normalizedQuery));
  const visible = normalizedQuery ? filtered.slice(0, 80) : filtered.slice(0, 30);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setActiveIndex(0);
    }
    onOpenChange(nextOpen);
  };

  const runItem = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    handleOpenChange(false);
    item.run();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && visible.length) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % visible.length);
    } else if (event.key === "ArrowUp" && visible.length) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(visible[activeIndex]);
    }
  };

  const groups = [...new Set(visible.map((item) => item.group))];
  let optionIndex = 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="top-[18%] w-[min(600px,calc(100vw-24px))] translate-y-0 gap-0 p-0 shadow-2xl">
        <DialogTitle className="sr-only">快捷搜索与操作</DialogTitle>
        <DialogDescription className="sr-only">搜索服务器、切换标签或打开常用操作。方向键浏览，Enter 执行，Esc 关闭。</DialogDescription>
        <div className="flex h-11 items-center gap-2 border-b border-border px-3">
          <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            role="combobox"
            aria-label="搜索服务器、标签和操作"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={visible[activeIndex] ? `command-palette-option-${activeIndex}` : undefined}
            placeholder="搜索服务器、切换标签或输入操作…"
            className="h-9 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div id="command-palette-results" role="listbox" aria-label="搜索结果" className="compact-scrollbar max-h-[min(62vh,520px)] overflow-auto p-1.5">
          {visible.length === 0 ? <div className="px-3 py-8 text-center text-xs text-muted-foreground">没有匹配的服务器、标签或操作。</div> : groups.map((group) => {
            const groupItems = visible.filter((item) => item.group === group);
            return <section key={group} aria-label={group}>
              <h3 className="px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">{group}</h3>
              {groupItems.map((item) => {
                const index = optionIndex++;
                const Icon = item.icon;
                return <button
                  key={item.id}
                  id={`command-palette-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  disabled={item.disabled}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors duration-150 ${index === activeIndex ? "bg-accent/12 text-foreground" : "text-foreground hover:bg-muted/70"} disabled:cursor-not-allowed disabled:opacity-45`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runItem(item)}
                >
                  <Icon size={14} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{item.label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{item.detail}</span>
                  </span>
                  {index === activeIndex && <ArrowRight size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
                </button>;
              })}
            </section>;
          })}
        </div>
        <footer className="flex h-8 items-center justify-between border-t border-border px-3 text-[10px] text-muted-foreground">
          <span>连接会复用可信指纹和现有身份验证流程</span>
          <span className="flex items-center gap-1"><Sparkles size={11} />↑↓ 浏览 <kbd className="rounded border border-border px-1">↵</kbd> 执行</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
