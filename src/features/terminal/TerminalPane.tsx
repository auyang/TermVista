import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, ChevronDown, ClipboardPaste, Copy, Maximize2, Search, Trash2, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { rememberManagerOpener } from "@/features/connections/managerFocus";
import { cancelAutoReconnect, connectProfile, resizeSsh, sendSshBytes } from "@/features/ssh/sshBridge";
import { registerTerminal } from "@/features/ssh/terminalRegistry";
import { classifyTerminalPaste, resolveTerminalPaste, type TerminalPastePreview } from "@/features/terminal/pasteGuard";
import { blockOsc52ClipboardWrites, safeExternalLinkTarget } from "@/features/terminal/securityHandlers";
import { useDiagnosticStore } from "@/features/diagnostics/diagnosticStore";
import { useSshSessionStore, statusLabel } from "@/stores/sshSessionStore";
import { useSftpSessionStore } from "@/stores/sftpSessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { canReconnectFromTerminalEnter } from "@/features/ssh/reconnectPolicy";

const darkTerminalTheme = {
  background: "#0d1b2a",
  foreground: "#e7edf4",
  cursor: "#37d69a",
  selectionBackground: "#35618b88",
  black: "#132235",
  red: "#e57474",
  green: "#58d49a",
  yellow: "#e8c77b",
  blue: "#76a7ea",
  magenta: "#c394e8",
  cyan: "#6fcbd1",
  white: "#d6e1ed",
  brightBlack: "#63758a",
  brightRed: "#ff8c8c",
  brightGreen: "#78e6af",
  brightYellow: "#f4d994",
  brightBlue: "#8cbaff",
  brightMagenta: "#d2a9f3",
  brightCyan: "#83e0e6",
  brightWhite: "#ffffff",
};

const lightTerminalTheme = {
  ...darkTerminalTheme,
  background: "#ffffff",
  foreground: "#0f172a",
  cursor: "#2563eb",
  selectionBackground: "#93c5fd88",
  black: "#0f172a",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#a21caf",
  cyan: "#0e7490",
  white: "#334155",
  brightBlack: "#64748b",
  brightRed: "#991b1b",
  brightGreen: "#166534",
  brightYellow: "#854d0e",
  brightBlue: "#1e40af",
  brightMagenta: "#86198f",
  brightCyan: "#155e75",
  brightWhite: "#020617",
};

function resolvedTerminalTheme(colorScheme: "follow" | "dark", appTheme: "dark" | "light") {
  return colorScheme === "dark" || appTheme === "dark" ? darkTerminalTheme : lightTerminalTheme;
}

function SshTerminalView({ attemptId, active }: { attemptId: string; active: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const reconnectInFlightRef = useRef(false);
  const activeRef = useRef(active);
  const [pendingPaste, setPendingPaste] = useState<TerminalPastePreview | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const session = useSshSessionStore((state) => state.sessions[attemptId]);
  const terminalSettings = useSettingsStore((state) => state.settings.terminal);
  const appTheme = useWorkspaceStore((state) => state.theme);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const currentSettings = useSettingsStore.getState().settings.terminal;
    const terminal = new Terminal({
      cursorBlink: currentSettings.cursorBlink,
      cursorStyle: currentSettings.cursorStyle,
      convertEol: false,
      scrollback: currentSettings.scrollback,
      fontFamily: currentSettings.fontFamily,
      fontSize: currentSettings.fontSize,
      lineHeight: currentSettings.lineHeight,
      theme: resolvedTerminalTheme(currentSettings.colorScheme, useWorkspaceStore.getState().theme),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (_event, target) => {
          const safeTarget = safeExternalLinkTarget(target);
          if (safeTarget) setPendingExternalUrl(safeTarget);
        },
      },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    let webgl: WebglAddon | null = null;
    let webglLossSubscription: { dispose: () => void } | null = null;
    try {
      webgl = new WebglAddon();
      terminal.loadAddon(webgl);
      webglLossSubscription = webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
        toast.message("终端图形加速已关闭，SSH 连接仍保持。", { duration: 2500 });
      });
    } catch {
      webgl?.dispose();
      webgl = null;
    }
    const cwdSubscription = terminal.parser.registerOscHandler(7, (data) => {
      try {
        const location = new URL(data);
        const remotePath = decodeURIComponent(location.pathname);
        if (location.protocol !== "file:" || !remotePath.startsWith("/") || remotePath.includes("\0")) return false;
        const sessionId = useSshSessionStore.getState().sessions[attemptId]?.sessionId;
        if (sessionId) useSftpSessionStore.getState().setShellPath(sessionId, remotePath);
        return true;
      } catch {
        return false;
      }
    });
    const osc52Subscription = blockOsc52ClipboardWrites(terminal.parser);
    const unregister = registerTerminal(attemptId, terminal);
    const inputSubscription = terminal.onData((data) => {
      const sessionState = useSshSessionStore.getState().sessions[attemptId];
      if (sessionState?.state === "connected") {
        void sendSshBytes(attemptId, new TextEncoder().encode(data)).catch(() => undefined);
      }
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.key !== "Enter" || event.repeat
        || event.isComposing || event.keyCode === 229
        || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
        || !activeRef.current) return true;
      const current = useSshSessionStore.getState().sessions[attemptId];
      const errorCode = current?.errorEvent?.code;
      const mayReconnect = canReconnectFromTerminalEnter(current?.state, errorCode);
      if (!mayReconnect || !current?.profile || reconnectInFlightRef.current) return true;
      event.preventDefault();
      reconnectInFlightRef.current = true;
      void connectProfile(current.profile, attemptId).finally(() => {
        reconnectInFlightRef.current = false;
      });
      return false;
    });
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      const current = useSshSessionStore.getState().sessions[attemptId];
      const decision = classifyTerminalPaste(text, current?.state === "connected" && Boolean(current.sessionId));
      if (decision === "blocked-connection") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast.message("SSH 尚未连接，粘贴内容未发送。");
        return;
      }
      if (decision === "blocked-size") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast.warning("粘贴内容超过 1 MB，已阻止发送。");
        return;
      }
      if (decision === "preview" && current?.sessionId && useSettingsStore.getState().settings.terminal.pastePreview) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPendingPaste({ text, sessionId: current.sessionId });
      }
    };
    terminal.textarea?.addEventListener("paste", onPaste, true);

    let timer = 0;
    const scheduleFit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!activeRef.current || !mount.clientWidth || !mount.clientHeight) return;
        try {
          fit.fit();
          void resizeSsh(attemptId, terminal.cols, terminal.rows).catch(() => undefined);
        } catch {
          // 隐藏标签或最小化窗口时，下一次激活会重新计算尺寸。
        }
      }, 80);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(mount);
    if (activeRef.current) scheduleFit();

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      webglLossSubscription?.dispose();
      webgl?.dispose();
      inputSubscription.dispose();
      terminal.textarea?.removeEventListener("paste", onPaste, true);
      cwdSubscription.dispose();
      osc52Subscription.dispose();
      unregister();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [attemptId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const layoutChanged = terminal.options.fontFamily !== terminalSettings.fontFamily
      || terminal.options.fontSize !== terminalSettings.fontSize
      || terminal.options.lineHeight !== terminalSettings.lineHeight;
    terminal.options.fontFamily = terminalSettings.fontFamily;
    terminal.options.fontSize = terminalSettings.fontSize;
    terminal.options.lineHeight = terminalSettings.lineHeight;
    terminal.options.cursorStyle = terminalSettings.cursorStyle;
    terminal.options.cursorBlink = terminalSettings.cursorBlink;
    terminal.options.scrollback = terminalSettings.scrollback;
    terminal.options.theme = resolvedTerminalTheme(terminalSettings.colorScheme, appTheme);
    if (layoutChanged && activeRef.current) {
      try {
        fitRef.current?.fit();
        void resizeSsh(attemptId, terminal.cols, terminal.rows).catch(() => undefined);
      } catch {
        // 容器不可见时，下一次激活会重新计算终端尺寸。
      }
    }
  }, [terminalSettings, appTheme, attemptId]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        if (terminal) void resizeSsh(attemptId, terminal.cols, terminal.rows).catch(() => undefined);
        terminal?.focus();
      } catch {
        // 尺寸为零时等待 ResizeObserver 的下一次通知。
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, attemptId, session?.state]);

  const finishPendingPaste = (choice: "cancel" | "send") => {
    const current = useSshSessionStore.getState().sessions[attemptId];
    const sent = resolveTerminalPaste(choice, pendingPaste, activeRef.current, {
      connected: current?.state === "connected",
      sessionId: current?.sessionId,
    }, (text) => terminalRef.current?.paste(text));
    if (choice === "send" && !sent) {
      toast.warning("当前终端会话已变化或未激活，粘贴内容未发送。");
    }
    setPendingPaste(null);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const current = useSshSessionStore.getState().sessions[attemptId];
      const decision = classifyTerminalPaste(text, current?.state === "connected" && Boolean(current.sessionId));
      if (decision === "blocked-connection") {
        toast.message("SSH 尚未连接，粘贴内容未发送。");
      } else if (decision === "blocked-size") {
        toast.warning("粘贴内容超过 1 MB，已阻止发送。");
      } else if (decision === "preview" && useSettingsStore.getState().settings.terminal.pastePreview) {
        setPendingPaste({ text, sessionId: current!.sessionId! });
      } else {
        terminalRef.current?.paste(text);
      }
    } catch {
      toast.error("无法读取系统剪贴板，请使用键盘粘贴。");
    }
  };

  useEffect(() => {
    if (!searchOpen || !searchQuery) return;
    searchRef.current?.findNext(searchQuery, { incremental: true });
  }, [searchOpen, searchQuery]);

  const openPendingExternalUrl = async () => {
    if (!pendingExternalUrl) return;
    try {
      await openUrl(pendingExternalUrl);
      toast.success("已在系统默认浏览器中打开链接。");
    } catch {
      toast.error("无法打开此链接，请检查系统浏览器设置。");
    }
    setPendingExternalUrl(null);
  };

  return <div className="absolute inset-0 px-5 pb-4 pt-12" style={{ display: active ? "block" : "none" }}>
    <ContextMenu>
      <ContextMenuTrigger asChild><div ref={mountRef} className="h-full w-full" /></ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => {
          const text = terminalRef.current?.getSelection() ?? "";
          if (!text) {
            toast.message("请先选中终端文本再复制。");
            return;
          }
          void navigator.clipboard.writeText(text).then(() => toast.success("已复制所选终端文本。"))
            .catch(() => toast.error("无法写入系统剪贴板。"));
        }}><Copy size={12} />复制所选文本</ContextMenuItem>
        <ContextMenuItem onSelect={() => void pasteFromClipboard()}><ClipboardPaste size={12} />粘贴</ContextMenuItem>
        <ContextMenuItem onSelect={() => { setSearchQuery(""); setSearchOpen(true); }}><Search size={12} />搜索终端内容</ContextMenuItem>
        <ContextMenuItem onSelect={() => terminalRef.current?.clear()}><Trash2 size={12} />清屏</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => {
          const text = terminalRef.current?.getSelection() ?? "";
          const sessionId = useSshSessionStore.getState().sessions[attemptId]?.sessionId;
          if (!text.trim()) {
            toast.message("请先选中需要诊断的终端文本；不会读取完整终端历史。");
            return;
          }
          if (!sessionId) {
            toast.message("当前终端还没有有效的 SSH 会话。");
            return;
          }
          useDiagnosticStore.getState().setPendingContext({ sessionId, context: { kind: "terminalSelection", text } });
          useWorkspaceStore.getState().setAiOpen(true);
        }}><Activity size={12} />交给 AI 制定只读诊断计划…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <Dialog open={searchOpen} onOpenChange={(open) => {
      setSearchOpen(open);
      if (!open) searchRef.current?.clearDecorations();
    }}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <header className="flex h-10 items-center border-b border-border bg-panel-header px-3">
          <DialogTitle>搜索终端内容</DialogTitle>
          <DialogDescription className="sr-only">仅搜索当前 SSH 标签内的终端滚动缓冲区。</DialogDescription>
        </header>
        <div className="grid gap-3 p-4">
          <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) searchRef.current?.findPrevious(searchQuery);
              else searchRef.current?.findNext(searchQuery);
            }
          }} className="h-8 rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" placeholder="输入搜索内容…" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-2" onClick={() => searchRef.current?.findPrevious(searchQuery)} disabled={!searchQuery}>上一个</Button>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm px-2" onClick={() => searchRef.current?.findNext(searchQuery)} disabled={!searchQuery}>下一个</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={pendingPaste !== null} onOpenChange={(open) => { if (!open) finishPendingPaste("cancel"); }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center border-b border-border bg-panel-header px-3">
          <DialogTitle>确认发送多行终端粘贴</DialogTitle>
          <DialogDescription className="sr-only">预览多行或包含控制字符的内容，确认后才会发送到当前 SSH 会话。</DialogDescription>
        </header>
        <div className="grid gap-3 p-4">
          <p className="text-[11px] leading-5 text-muted-foreground">该内容包含换行或控制字符。取消或按 Esc 时不会向服务器发送任何字节。</p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/40 p-2 font-mono text-[10px] leading-4 text-foreground">{pendingPaste?.text}</pre>
          <footer className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={() => finishPendingPaste("cancel")}>取消</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm px-3" onClick={() => finishPendingPaste("send")}>确认发送</Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={pendingExternalUrl !== null} onOpenChange={(open) => { if (!open) setPendingExternalUrl(null); }}>
      <DialogContent className="gap-0 p-0">
        <header className="flex h-10 items-center border-b border-border bg-panel-header px-3">
          <DialogTitle>打开终端中的外部链接？</DialogTitle>
          <DialogDescription className="sr-only">核对完整链接目标后，确认才会调用系统默认浏览器。</DialogDescription>
        </header>
        <div className="grid gap-3 p-4">
          <p className="text-[11px] leading-5 text-muted-foreground">此链接来自远程终端输出。请确认目标可信；确认后会在系统默认浏览器中打开。</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-[10px] leading-4 text-foreground">{pendingExternalUrl}</pre>
          <footer className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" className="h-7 rounded-sm px-3" onClick={() => setPendingExternalUrl(null)}>取消</Button>
            <Button type="button" size="sm" className="h-7 rounded-sm px-3" onClick={() => void openPendingExternalUrl()}>打开链接</Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

export function TerminalPane({ demo, visible = true }: { demo: boolean; visible?: boolean }) {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const tab = useWorkspaceStore((state) => state.tabs.find((item) => item.id === state.activeTabId) ?? null);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const addDemoTab = useWorkspaceStore((state) => state.addDemoTab);
  const session = useSshSessionStore((state) => tab?.mode === "ssh" ? state.sessions[tab.id] : undefined);
  const savedProfile = useWorkspaceStore((state) => tab?.profileId ? state.profiles.find((profile) => profile.id === tab.profileId) : undefined);
  const sshTabs = tabs.filter((item) => item.mode === "ssh");
  const connected = tab?.mode === "ssh" && session?.state === "connected";

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-terminal text-terminal-fg" aria-label="终端面板">
      <div className="absolute inset-x-0 top-0 z-10 flex h-9 shrink-0 items-center justify-between border-b border-terminal-border bg-terminal-toolbar-top px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${demo || connected ? "bg-success" : "bg-terminal-muted/50"}`} aria-hidden="true" />
          <span className="truncate text-[11px] font-medium">{demo ? `${tab?.title ?? "演示会话"} · 演示终端` : tab?.mode === "ssh" ? `${tab.host ?? session?.profile.host ?? "SSH"} · ${session ? statusLabel(session.state) : "待重新连接"}` : "终端未连接"}</span>
          {demo && <span className="shrink-0 rounded-sm border px-1 text-[9px] font-semibold" style={{ color: "var(--terminal-demo-fg)", borderColor: "var(--terminal-demo-border)" }}>DEMO · 未执行</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="终端字体选项（未接入）" title="字体选项（未接入）" disabled><Type size={14} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="最大化终端（未接入）" title="最大化终端（未接入）" disabled><Maximize2 size={14} /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 rounded-sm text-terminal-icon hover:bg-terminal-hover hover:text-terminal-fg" aria-label="终端选项（未接入）" title="终端选项（未接入）" disabled><ChevronDown size={14} /></Button>
        </div>
      </div>
      <div id="terminal-container" data-terminal-mount="true" className="compact-scrollbar relative min-h-0 flex-1 overflow-hidden font-mono text-[14px] leading-6">
        {sshTabs.map((sshTab) => <SshTerminalView key={sshTab.id} attemptId={sshTab.id} active={visible && activeTabId === sshTab.id} />)}
        {demo ? (
          <div className="absolute inset-0 overflow-auto px-6 pb-5 pt-14" aria-label="演示终端内容，仅用于布局预览">
            <div className="text-terminal-fg">TermVista 端境 · 终端布局预览</div>
            <div className="text-terminal-muted">此内容为静态 UI 演示；当前没有 SSH 连接，也未执行命令。</div>
            <div className="mt-1 flex items-center gap-2" style={{ color: "var(--terminal-prompt-fg)" }}><span>demo@layout-preview:~$</span><span className="inline-block h-[15px] w-[8px]" style={{ backgroundColor: "var(--terminal-cursor-bg)" }} aria-hidden="true" /></div>
          </div>
        ) : tab?.mode === "ssh" ? (
          session?.state !== "connected" && <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 px-5 text-center font-sans">
            <strong className="text-[13px] font-medium text-terminal-fg">{!session ? "需要重新连接" : session.error ? "SSH 连接未建立" : statusLabel(session.state)}</strong>
            <span className="max-w-xl text-[11px] leading-5 text-terminal-muted">{!session ? "已恢复本机服务器标签和工作区布局；SSH 会话、远端进程和过去的 PTY 不会恢复。" : session.error ?? "正在建立经过主机密钥验证的交互式 SSH 终端。"}</span>
            {session?.state === "error" && session.errorEvent?.code === "hostKeyMismatch" ? <span className="text-[10px] text-destructive">主机指纹变化已阻断连接。请先核实并管理可信主机记录。</span> : null}
            {session?.errorEvent?.code === "hostKeyMismatch" && <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm border-terminal-control-border bg-transparent px-2 text-[11px] text-terminal-fg hover:bg-terminal-hover hover:text-terminal-fg" onClick={() => {
              useWorkspaceStore.getState().setManagerView("trustedHosts");
              useWorkspaceStore.getState().setManagerOpen(true);
            }}>查看可信主机</Button>}
            {session?.autoReconnectAttempt !== undefined && <>
              <span className="text-[10px] text-terminal-muted">自动重连 {session.autoReconnectAttempt}/5{session.autoReconnectNextAt ? " · 等待中" : " · 连接中"}</span>
              <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm border-terminal-control-border bg-transparent px-2 text-[11px] text-terminal-fg hover:bg-terminal-hover hover:text-terminal-fg" onClick={() => cancelAutoReconnect(session.attemptId)}>停止自动重连</Button>
            </>}
            {((session?.state === "error" && session.profile && session.errorEvent?.code !== "hostKeyMismatch") || (!session && savedProfile)) && <Button type="button" size="sm" className="h-7 rounded-sm px-2 text-[11px]" onClick={() => {
              const profile = session?.profile ?? savedProfile;
              if (profile && tab) void connectProfile(profile, tab.id);
            }}>重新连接</Button>}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-5 text-center font-sans">
            <strong className="text-[13px] font-medium text-terminal-fg">等待连接</strong>
            <span className="text-[11px] leading-5 text-terminal-muted">打开连接管理器创建配置。SSH 终端将按真实连接状态显示。</span>
            <div className="mt-1 flex items-center gap-2">
              <Button type="button" size="sm" className="h-7 rounded-sm px-2 text-[11px]" onClick={(event) => { rememberManagerOpener(event.currentTarget); setManagerOpen(true); }}>打开连接管理器</Button>
              {import.meta.env.DEV && <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm border-terminal-control-border bg-transparent px-2 text-[11px] text-terminal-fg hover:bg-terminal-hover hover:text-terminal-fg" onClick={() => addDemoTab()}>打开布局演示</Button>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
