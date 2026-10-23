import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Copy,
  FolderSync,
  Info,
  Palette,
  Settings2,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { brand } from "@/app/brand";
import { defaultSettings, getAppMetadata, getSanitizedDiagnostics, type AppMetadata, type SettingsSection } from "@/features/settings/settingsBridge";
import { CredentialVaultSettings } from "@/features/settings/CredentialVaultSettings";
import { UpdatePanel } from "@/features/updater/UpdatePanel";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const navigation: { id: SettingsSection | "about"; label: string; icon: typeof Settings2 }[] = [
  { id: "general", label: "通用", icon: Settings2 },
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "connections", label: "连接与安全", icon: ShieldCheck },
  { id: "sftp", label: "文件传输", icon: FolderSync },
  { id: "monitoring", label: "服务器监控", icon: Activity },
  { id: "aiPrivacy", label: "AI 与隐私", icon: Bot },
  { id: "appearance", label: "外观与快捷键", icon: Palette },
  { id: "about", label: "关于 TermVista", icon: Info },
];

function SettingRow({
  title,
  description,
  value,
  defaultValue,
  timing,
  control,
}: {
  title: string;
  description: string;
  value: string;
  defaultValue?: string;
  timing: string;
  control: ReactNode;
}) {
  return (
    <div className="flex min-h-[58px] items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-foreground">{title}</div>
        <p className="mt-0.5 max-w-2xl text-[10px] leading-4 text-muted-foreground">{description}</p>
        <p className="mt-1 text-[9px] text-muted-foreground/75">当前：{value}{defaultValue ? ` · 默认：${defaultValue}` : ""} · 生效：{timing}</p>
      </div>
      <div className="flex shrink-0 items-center justify-end">{control}</div>
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return <div className="mb-2 border-b border-border pb-2">
    <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</p>
  </div>;
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`inline-flex items-center gap-2 text-[10px] text-foreground ${disabled ? "opacity-60" : "cursor-pointer"}`}>
    <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
    <span aria-hidden="true" className={`relative h-[18px] w-[32px] rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${checked ? "border-primary bg-primary" : "border-input bg-muted"}`}>
      <span className={`absolute top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
    </span>
    <span>{checked ? "开" : "关"}</span>
  </label>;
}

function SelectControl({ value, label, children, onChange }: { value: string; label: string; children: ReactNode; onChange: (value: string) => void }) {
  return <select aria-label={label} className="h-7 min-w-32 rounded-sm border border-input bg-background px-2 text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>;
}

function SettingValue({ children }: { children: ReactNode }) {
  return <span className="rounded-sm border border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">{children}</span>;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSection | "about">("general");
  const settings = useSettingsStore((state) => state.settings);
  const loaded = useSettingsStore((state) => state.loaded);
  const loading = useSettingsStore((state) => state.loading);
  const savingSection = useSettingsStore((state) => state.savingSection);
  const settingsError = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);
  const update = useSettingsStore((state) => state.update);
  const [metadata, setMetadata] = useState<AppMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const setManagerOpen = useWorkspaceStore((state) => state.setManagerOpen);
  const setManagerView = useWorkspaceStore((state) => state.setManagerView);
  const setAiOpen = useWorkspaceStore((state) => state.setAiOpen);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && section === "about") setSection("general");
    onOpenChange(nextOpen);
  }, [section, onOpenChange]);
  const closeDialog = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  useEffect(() => {
    if (open && !loaded && !loading) void load().catch(() => undefined);
  }, [open, loaded, loading, load]);

  useEffect(() => {
    if (!open || section !== "about") return;
    let current = true;
    void getAppMetadata().then((value) => {
      if (current) {
        setMetadata(value);
        setMetadataError(null);
      }
    }).catch((error: unknown) => {
      if (current) setMetadataError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [open, section]);

  const updateSetting = useCallback(async <T extends "general" | "terminal" | "connections" | "monitoring" | "appearance",>(target: T, patch: Partial<typeof settings[T]>) => {
    try {
      await update(target, patch);
    } catch {
      // Store retains the original value and displays the Rust error in the dialog.
    }
  }, [update]);

  const resetCurrentSection = async () => {
    if (!(section in defaultSettings)) return;
    const confirm = window.confirm(`确定恢复“${navigation.find((item) => item.id === section)?.label}”的默认设置吗？此操作仅修改设置项。`);
    if (!confirm) return;
    const sectionDefaults = defaultSettings[section as keyof typeof defaultSettings];
    if (section === "general" || section === "terminal" || section === "connections" || section === "monitoring" || section === "appearance") {
      await updateSetting(section, sectionDefaults as never);
    }
  };

  const resetAvailable = section === "general" || section === "terminal" || section === "connections" || section === "monitoring" || section === "appearance";
  const currentLabel = navigation.find((item) => item.id === section)?.label ?? "设置";
  const copyDiagnostics = useCallback(async () => {
    try {
      const info = await getSanitizedDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      toast.success("已复制脱敏诊断信息。未包含主机、账号、路径、密钥或终端内容。");
    } catch {
      toast.error("无法复制诊断信息，请检查系统剪贴板权限。");
    }
  }, []);

  const settingsBody = useMemo(() => {
    if (!loaded) return <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">{loading ? "正在读取设置…" : "设置尚未加载。"}</div>;
    switch (section) {
      case "general":
        return <>
          <SectionHeading title="通用" description="管理启动时的工作区恢复和本机连接历史。SSH 会话、PTY 与远端进程不会随窗口重启恢复。" />
          <SettingRow title="恢复上次标签与工作区" description="仅恢复本机标签、面板布局和 SFTP 上次路径；远端进程不会恢复。" value={settings.general.restoreLastTabs ? "开启" : "关闭"} defaultValue="开启" timing="下次启动" control={<Toggle checked={settings.general.restoreLastTabs} label="恢复上次标签与工作区" onChange={(value) => void updateSetting("general", { restoreLastTabs: value })} />} />
          <SettingRow title="自动连接恢复的服务器标签" description="仅处理上次工作区内的 SSH 标签。首次主机指纹验证、缺少凭据和登录确认仍按原安全流程执行。" value={settings.general.autoConnectSavedHosts ? "开启" : "关闭"} defaultValue="关闭" timing="下次启动" control={<Toggle checked={settings.general.autoConnectSavedHosts} label="自动连接恢复的服务器标签" onChange={(value) => void updateSetting("general", { autoConnectSavedHosts: value })} />} />
          <SettingRow title="维护最近连接" description="关闭后不写入新的最近连接时间；现有连接配置、收藏、凭据和可信指纹不会被删除。" value={settings.general.rememberRecentConnections ? "开启" : "关闭"} defaultValue="开启" timing="立即" control={<Toggle checked={settings.general.rememberRecentConnections} label="维护最近连接" onChange={(value) => void updateSetting("general", { rememberRecentConnections: value })} />} />
          <SettingRow title="启动后检查更新" description="应用初始化后在后台检查；只有发现更新时显示非阻断通知，不会自动下载或安装。" value={settings.general.autoCheckUpdates ? "开启" : "关闭"} defaultValue="开启" timing="下次启动" control={<Toggle checked={settings.general.autoCheckUpdates} label="启动后检查更新" onChange={(value) => void updateSetting("general", { autoCheckUpdates: value })} />} />
          <SettingRow title="新标签页" description="当前新标签页使用快速连接首页。" value="快速连接" defaultValue="快速连接" timing="立即" control={<SettingValue>快速连接</SettingValue>} />
          <SettingRow title="界面语言" description="当前版本提供完整简体中文界面；未提供未完成的语言切换。" value="简体中文" defaultValue="简体中文" timing="当前版本" control={<SettingValue>简体中文</SettingValue>} />
        </>;
      case "terminal":
        return <>
          <SectionHeading title="终端" description="字号和光标效果实时应用到当前打开的 SSH 终端。滚动缓冲区始终保持有限大小。" />
          <SettingRow title="终端字号" description="范围 11–24 px；当前会话立即预览。" value={`${settings.terminal.fontSize} px`} defaultValue="14 px" timing="立即" control={<div className="flex items-center gap-2"><input aria-label="终端字号" type="range" min="11" max="24" value={settings.terminal.fontSize} onChange={(event) => void updateSetting("terminal", { fontSize: Number(event.target.value) })} className="w-28 accent-primary" /><span className="w-7 text-right text-[10px] tabular-nums">{settings.terminal.fontSize}</span></div>} />
          <SettingRow title="字体" description="使用系统等宽字体回退列表。" value="Menlo / Monaco" defaultValue="Menlo / Monaco" timing="新终端" control={<SettingValue>Menlo · Monaco</SettingValue>} />
          <SettingRow title="行距" description="xterm.js 行高倍率，范围 1.0–2.0。" value={`${settings.terminal.lineHeight.toFixed(2)}×`} defaultValue="1.25×" timing="立即" control={<div className="flex items-center gap-2"><input aria-label="终端行距" type="range" min="1" max="2" step="0.05" value={settings.terminal.lineHeight} onChange={(event) => void updateSetting("terminal", { lineHeight: Number(event.target.value) })} className="w-28 accent-primary" /><span className="w-8 text-right text-[10px] tabular-nums">{settings.terminal.lineHeight.toFixed(2)}</span></div>} />
          <SettingRow title="光标样式" description="终端光标类型。" value={settings.terminal.cursorStyle} defaultValue="block" timing="立即" control={<SelectControl label="光标样式" value={settings.terminal.cursorStyle} onChange={(value) => void updateSetting("terminal", { cursorStyle: value as typeof settings.terminal.cursorStyle })}><option value="block">块状</option><option value="underline">下划线</option><option value="bar">竖线</option></SelectControl>} />
          <SettingRow title="光标闪烁" description="控制当前终端光标闪烁。" value={settings.terminal.cursorBlink ? "开启" : "关闭"} defaultValue="开启" timing="立即" control={<Toggle checked={settings.terminal.cursorBlink} label="终端光标闪烁" onChange={(value) => void updateSetting("terminal", { cursorBlink: value })} />} />
          <SettingRow title="终端配色" description="终端面板保持深色配色；“跟随主题”保留应用主题下的默认终端颜色。" value={settings.terminal.colorScheme === "follow" ? "跟随主题" : "深色终端"} defaultValue="跟随主题" timing="新终端" control={<SelectControl label="终端配色" value={settings.terminal.colorScheme} onChange={(value) => void updateSetting("terminal", { colorScheme: value as typeof settings.terminal.colorScheme })}><option value="follow">跟随主题</option><option value="dark">深色终端</option></SelectControl>} />
          <SettingRow title="滚动缓冲区" description="限制每个终端会话保留的历史行数，不持久保存会话输出。" value={`${settings.terminal.scrollback.toLocaleString()} 行`} defaultValue="5,000 行" timing="新终端" control={<SelectControl label="终端滚动缓冲区" value={String(settings.terminal.scrollback)} onChange={(value) => void updateSetting("terminal", { scrollback: Number(value) })}><option value="1000">1,000 行</option><option value="5000">5,000 行</option><option value="10000">10,000 行</option><option value="20000">20,000 行</option><option value="50000">50,000 行</option></SelectControl>} />
          <SettingRow title="多行粘贴预览" description="预览包含多行或控制字符的粘贴内容；超大内容及未连接状态仍由安全检查阻止。" value={settings.terminal.pastePreview ? "开启" : "关闭"} defaultValue="开启" timing="立即" control={<Toggle checked={settings.terminal.pastePreview} label="多行粘贴预览" onChange={(value) => void updateSetting("terminal", { pastePreview: value })} />} />
          <SettingRow title="清屏与清除滚动历史" description="可通过终端控制序列分别清屏与清除滚动缓冲；设置页不提供会误删会话状态的合并动作。" value="分别处理" defaultValue="分别处理" timing="当前版本" control={<SettingValue>已区分</SettingValue>} />
        </>;
      case "connections":
        return <>
          <SectionHeading title="连接与安全" description="主机身份校验始终开启。自动重连要求全局和单条连接都开启，并且本机凭据可用。" />
          <CredentialVaultSettings />
          <SettingRow title="允许自动重连" description="指数退避最多尝试 5 次；还需在服务器连接配置中单独启用。主机指纹变化会立即停止。" value={settings.connections.autoReconnectEnabled ? "开启" : "关闭"} defaultValue="关闭" timing="立即" control={<Toggle checked={settings.connections.autoReconnectEnabled} label="允许自动重连" onChange={(value) => void updateSetting("connections", { autoReconnectEnabled: value })} />} />
          <SettingRow title="主机公钥验证" description="首次连接按用户选择保存本次或永久信任；已信任公钥变化会阻断连接。" value="始终开启" defaultValue="始终开启" timing="每次连接" control={<SettingValue>强制启用</SettingValue>} />
          <SettingRow title="可信主机与指纹" description="查看每台主机的公钥算法、SHA256 指纹和信任时间；撤销后下次连接会重新验证。" value="受连接配置管理" timing="立即" control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setManagerView("trustedHosts"); setManagerOpen(true); closeDialog(); }}>查看可信主机</Button>} />
          <SettingRow title="SSH 超时" description="使用当前 SSH 引擎的连接超时策略；本版本尚未提供独立调整项。" value="引擎默认值" timing="当前版本" control={<SettingValue>不可单独调整</SettingValue>} />
          <SettingRow title="已保存登录凭据" description="密码和私钥口令由本机加密保险库保护；设置窗口及状态接口不读取或回传秘密。" value="按连接管理" timing="每条连接" control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setManagerView("connections"); setManagerOpen(true); closeDialog(); }}>打开连接管理器</Button>} />
        </>;
      case "sftp":
        return <>
          <SectionHeading title="文件传输" description="显示当前实际实现的传输安全策略。此处不创建尚未接入后端的设置开关。" />
          <SettingRow title="并发传输数" description="每个 SSH 会话内按队列顺序执行，避免同时写入远端目标。" value="每个会话 1 个" defaultValue="每个会话 1 个" timing="当前版本" control={<SettingValue>顺序队列</SettingValue>} />
          <SettingRow title="同名文件冲突" description="传输冲突时询问用户；可对当前队列选择跳过、保留两者或覆盖。" value="询问" defaultValue="询问" timing="每个任务" control={<SettingValue>逐项确认</SettingValue>} />
          <SettingRow title="远程删除确认" description="删除操作在执行前显示目标信息和确认步骤。" value="始终开启" defaultValue="开启" timing="每次删除" control={<SettingValue>强制确认</SettingValue>} />
          <SettingRow title="本机下载位置" description="由系统文件选择器在每次下载时指定目标目录；没有持久化的固定目录。" value="每次选择" timing="每次下载" control={<SettingValue>系统文件选择器</SettingValue>} />
          <SettingRow title="远程文件编辑冲突检查" description="当前没有独立的远程文本编辑器，故不显示未实现的修改时间检查选项。" value="未提供编辑器" timing="当前版本" control={<SettingValue>未启用</SettingValue>} />
        </>;
      case "monitoring":
        return <>
          <SectionHeading title="服务器监控" description="仅连接后的真实 SSH 会话生成监控数据；暂停后停止后台采样，不显示演示指标。" />
          <SettingRow title="当前连接启用监控" description="关闭后停止所有当前会话的采样；重新开启后只监控仍然连接的会话。" value={settings.monitoring.enabled ? "开启" : "暂停"} defaultValue="开启" timing="立即" control={<Toggle checked={settings.monitoring.enabled} label="当前连接启用监控" onChange={(value) => void updateSetting("monitoring", { enabled: value })} />} />
          <SettingRow title="主机、CPU、内存与网络采样" description="活动会话 2 秒；后台会话 15 秒。" value="活动 2 秒 / 后台 15 秒" timing="当前版本" control={<SettingValue>引擎策略</SettingValue>} />
          <SettingRow title="进程采样" description="活动会话 2 秒；后台会话 15 秒。进程 CPU 使用前后样本计算。" value="活动 2 秒 / 后台 15 秒" timing="当前版本" control={<SettingValue>引擎策略</SettingValue>} />
          <SettingRow title="磁盘采样" description="磁盘数据采样间隔为 20 秒。" value="20 秒" timing="当前版本" control={<SettingValue>引擎策略</SettingValue>} />
          <SettingRow title="断开会话" description="SSH 断开后监控订阅随会话停止并将旧数据标记为过期。" value="自动停止" timing="立即" control={<SettingValue>已启用</SettingValue>} />
        </>;
      case "aiPrivacy":
        return <>
          <SectionHeading title="AI 与隐私" description="只读辅助不会自动执行命令。终端或文件上下文仅在用户逐项选择并预览后发送。" />
          <SettingRow title="模型 Provider" description="仅显示真实配置的 Provider；未配置时不会返回模拟回答。" value="连接后读取" timing="打开 AI 面板" control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setAiOpen(true); closeDialog(); }}>打开 AI 面板</Button>} />
          <SettingRow title="上下文共享" description="默认不自动附带终端或文件上下文；每次发送前单独预览并授权。" value="逐次授权" defaultValue="关闭自动附带" timing="每次请求" control={<SettingValue>需要确认</SettingValue>} />
          <SettingRow title="诊断权限" description="诊断工具使用固定只读命令白名单，用户逐项审阅并批准；日志内容不能提升权限。" value="只读白名单" defaultValue="只读" timing="每次诊断" control={<SettingValue>强制只读</SettingValue>} />
          <SettingRow title="API Key" description="密钥保存在系统凭据库，界面只读取是否已配置状态，不回填密钥。具体 Provider 设置请在 AI 面板内查看。" value="按 Provider 管理" timing="每个 Provider" control={<Button type="button" variant="outline" size="xs" className="rounded-sm" onClick={() => { setAiOpen(true); closeDialog(); }}>打开 AI 面板</Button>} />
          <SettingRow title="对话历史" description="对话上下文按 SSH 会话隔离；关闭会话时清理相应运行态。" value="按会话隔离" timing="当前会话" control={<SettingValue>已隔离</SettingValue>} />
        </>;
      case "appearance":
        return <>
          <SectionHeading title="外观与快捷键" description="更改应用主题和工作区启动偏好，不改变 FinalShell 式分区布局。" />
          <SettingRow title="应用主题" description="“跟随系统”会监听操作系统浅色/深色外观变化。" value={settings.appearance.themeMode === "system" ? "跟随系统" : settings.appearance.themeMode === "light" ? "浅色" : "深色"} defaultValue="跟随系统" timing="立即" control={<SelectControl label="应用主题" value={settings.appearance.themeMode} onChange={(value) => void updateSetting("appearance", { themeMode: value as typeof settings.appearance.themeMode })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></SelectControl>} />
          <SettingRow title="服务器监控侧栏" description="显示或隐藏工作台左侧监控区，连接状态和监控数据不会改变。" value={settings.appearance.showMonitorSidebar ? "显示" : "隐藏"} defaultValue="显示" timing="立即" control={<Toggle checked={settings.appearance.showMonitorSidebar} label="显示服务器监控侧栏" onChange={(value) => void updateSetting("appearance", { showMonitorSidebar: value })} />} />
          <SettingRow title="AI 面板默认展开" description="默认关闭。此项只决定下次启动时的初始状态，不会影响当前会话。" value={settings.appearance.aiPanelOpenByDefault ? "展开" : "隐藏"} defaultValue="隐藏" timing="下次启动" control={<Toggle checked={settings.appearance.aiPanelOpenByDefault} label="AI 面板默认展开" onChange={(value) => void updateSetting("appearance", { aiPanelOpenByDefault: value })} />} />
          <SettingRow title="面板密度" description="当前工作台沿用紧凑桌面布局。" value="紧凑" defaultValue="紧凑" timing="当前版本" control={<SettingValue>紧凑布局</SettingValue>} />
          <div className="mt-3 rounded-sm border border-border bg-muted/25 px-3 py-2">
            <div className="mb-1.5 text-[10px] font-medium text-foreground">快捷键</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] text-muted-foreground"><span>设置</span><kbd>⌘ , / Ctrl ,</kbd><span>全局搜索</span><kbd>⌘ K / Ctrl K</kbd><span>新建标签</span><kbd>⌘ T / Ctrl T</kbd><span>切换 AI 面板</span><kbd>⌘ J / Ctrl J</kbd></div>
            <p className="mt-2 text-[9px] text-muted-foreground">快捷键可查看；本版本未提供热键编辑，避免显示无效输入控件。</p>
          </div>
        </>;
      case "about":
        return <>
          <SectionHeading title={`关于 ${brand.name}`} description="产品信息与当前运行版本。" />
          <div className="flex flex-col items-center pt-3 text-center">
            <img src="/termvista-icon-v2.png" alt="TermVista 图标" className="h-20 w-20 rounded-xl border border-border bg-white p-1 shadow-sm" />
            <h2 className="mt-3 text-[18px] font-semibold tracking-tight text-foreground">{brand.name} <span className="font-normal text-muted-foreground">{brand.nameZh}</span></h2>
            <p className="mt-1 text-[10px] text-muted-foreground">{brand.englishDescription}</p>
            <p className="mt-2 max-w-[460px] text-[10px] leading-5 text-muted-foreground">{brand.description}</p>
            <p className="mt-1 text-[10px] text-primary">{brand.tagline}</p>
          </div>
          <div className="mx-auto mt-5 grid max-w-[430px] grid-cols-[108px_1fr] gap-y-2 rounded-sm border border-border bg-muted/25 p-3 text-[10px] text-foreground">
            <span className="text-muted-foreground">版本</span><span>{metadata ? metadata.version : metadataError ? "无法读取" : "正在读取…"}</span>
            <span className="text-muted-foreground">运行平台</span><span>{metadata ? `${metadata.platform} · ${metadata.arch}` : "—"}</span>
            {metadata?.channel && <><span className="text-muted-foreground">发布通道</span><span>{metadata.channel}</span></>}
            {metadata?.buildHash && <><span className="text-muted-foreground">构建标识</span><span className="font-mono">{metadata.buildHash}</span></>}
            <span className="text-muted-foreground">更新服务</span><span>{metadata?.updaterConfigured ? "已配置" : metadata?.updaterConfigReason ?? "正在检查配置…"}</span>
          </div>
          {metadataError && <p role="alert" className="mt-2 text-center text-[10px] text-destructive">应用信息读取失败：{metadataError}</p>}
          <div className="mx-auto mt-4 w-full max-w-[560px]">
            <UpdatePanel metadata={metadata} />
          </div>
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={() => void copyDiagnostics()}><Copy size={12} />复制脱敏诊断信息</Button>
          </div>
          <p className="mt-3 text-center text-[9px] text-muted-foreground">{brand.fullName} · {brand.protocols}</p>
        </>;
    }
  }, [loaded, loading, section, settings, metadata, metadataError, setManagerView, setManagerOpen, setAiOpen, closeDialog, updateSetting, copyDiagnostics]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(700px,90vh)] w-[min(980px,92vw)] flex-col gap-0 p-0">
        <DialogDescription className="sr-only">管理应用偏好与安全选项。SSH 登录凭据由本机加密保险库保护。</DialogDescription>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel-header px-4">
          <img src="/termvista-icon-v2.png" alt="" className="h-6 w-6 rounded-sm" />
          <DialogTitle>{brand.name} 设置</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="设置分类" className="flex w-[210px] shrink-0 flex-col border-r border-border bg-panel-header/60 p-2">
            <div className="grid gap-0.5">
              {navigation.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined} className={`flex h-8 items-center gap-2 rounded-sm px-2 text-left text-[10px] transition-colors ${section === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon size={13} />{label}</button>)}
            </div>
          </nav>
          <main className="compact-scrollbar min-w-0 flex-1 overflow-y-auto px-5 py-4" aria-label={section === "about" ? "关于 TermVista" : `${currentLabel}设置`}>
            {settingsError && <div role="alert" className="mb-3 rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">保存失败，界面保留原值：{settingsError}</div>}
            {settingsBody}
          </main>
        </div>
        <footer className={`flex h-12 shrink-0 items-center border-t border-border bg-panel-header/50 px-4 ${resetAvailable ? "justify-between" : "justify-end"}`}>
          {resetAvailable && <Button type="button" variant="ghost" size="sm" disabled={savingSection !== null} className="h-7 rounded-sm text-[10px]" onClick={() => void resetCurrentSection()}>恢复默认（{currentLabel}）</Button>}
          <Button type="button" variant="outline" size="sm" className="h-7 rounded-sm text-[10px]" onClick={closeDialog}>关闭</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
