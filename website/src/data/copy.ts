export type Locale = 'en' | 'zh-cn' | 'ja' | 'zh-tw';

export interface SiteCopy {
  htmlLang: string;
  localeName: string;
  nav: { product: string; capabilities: string; downloads: string; github: string; menu: string; primary: string; home: string };
  hero: { eyebrow: string; title: string; accent: string; description: string; download: string; source: string; releaseLabel: string; noRelease: string; screenshotAlt: string; windowTitle: string; status: string; openSource: string };
  proof: { eyebrow: string; title: string; body: string; footnote: string };
  features: { eyebrow: string; title: string; body: string; items: Array<{ number: string; title: string; description: string }> };
  workflow: { eyebrow: string; title: string; body: string; points: string[]; label: string; optional: string };
  releases: { eyebrow: string; title: string; body: string; latest: string; published: string; notes: string; empty: string; platform: Record<string, string> };
  close: { eyebrow: string; title: string; body: string; star: string; issue: string; source: string };
  footer: { made: string; license: string; repository: string; releases: string; issues: string };
}

export const supportedLocales: Locale[] = ['en', 'zh-cn', 'ja', 'zh-tw'];

export const localePaths: Record<Locale, string> = {
  en: '/',
  'zh-cn': '/zh-cn/',
  ja: '/ja/',
  'zh-tw': '/zh-tw/',
};

export const copy: Record<Locale, SiteCopy> = {
  en: {
    htmlLang: 'en-US', localeName: 'English',
    nav: { product: 'Product', capabilities: 'Capabilities', downloads: 'Downloads', github: 'GitHub', menu: 'Open menu', primary: 'Primary navigation', home: 'TermVista home' },
    hero: { eyebrow: 'An open-source remote workspace', title: 'Your remote work,', accent: 'in one focused workspace.', description: 'Connect over SSH, move files with SFTP, understand server health, manage tunnels, and bring AI into operations when you choose.', download: 'Get the latest release', source: 'Explore the source', releaseLabel: 'Latest stable release', noRelease: 'View GitHub releases', screenshotAlt: 'TermVista connected workspace showing an SSH terminal, server monitoring and remote files', windowTitle: 'TermVista · Remote workspace', status: 'Connected workspace', openSource: 'Open source' },
    proof: { eyebrow: 'Made for long sessions', title: 'The shell is only the beginning.', body: 'Keep the terminal, remote files and the signals around your server in view together. TermVista brings everyday SSH work into a calm desktop surface.', footnote: 'Real TermVista interface · connected workspace' },
    features: { eyebrow: 'One tool, connected workflows', title: 'Everything around your SSH session.', body: 'Move between access, files and operations without losing the context of the machine you are working on.', items: [
      { number: '01', title: 'SSH sessions', description: 'Keep multiple hosts in tabs, verify host identity, and work in a real interactive terminal.' },
      { number: '02', title: 'SFTP & remote editing', description: 'Browse remote directories, transfer files, and edit text files in the workspace.' },
      { number: '03', title: 'Server monitoring', description: 'See resource usage, processes, network activity and disks alongside the active session.' },
      { number: '04', title: 'SSH tunnels', description: 'Manage local forwarding rules from the same desktop environment as your SSH connections.' },
    ] },
    workflow: { eyebrow: 'AI, on your terms', title: 'Useful context. Explicit control.', body: 'Ask for help understanding terminal output or operational signals. Review the context before it is shared, and keep command execution in your hands.', points: ['Review context before sending', 'Suggestions stay separate from execution', 'Use the AI provider you configure'], label: 'AI Copilot', optional: 'Optional' },
    releases: { eyebrow: 'Ready for your desktop', title: 'Download TermVista.', body: 'Choose a package published with the latest stable GitHub Release. Read the release notes on GitHub.', latest: 'Latest stable', published: 'Published', notes: 'Release notes', empty: 'The latest release could not be loaded right now. Open GitHub to see published versions.', platform: { apple: 'macOS · Apple silicon', intel: 'macOS · Intel', windows: 'Windows · x64', other: 'Download' } },
    close: { eyebrow: 'Open source, built in the open', title: 'Make remote work feel closer.', body: 'Try TermVista, inspect the code, or tell us what would make your workflow better.', star: 'Star on GitHub', issue: 'Report an issue', source: 'Browse source code' },
    footer: { made: 'A desktop workspace for SSH operations.', license: 'Apache-2.0 license', repository: 'Repository', releases: 'Releases', issues: 'Issues' },
  },
  'zh-cn': {
    htmlLang: 'zh-CN', localeName: '简体中文',
    nav: { product: '产品', capabilities: '功能', downloads: '下载', github: 'GitHub', menu: '打开菜单', primary: '主导航', home: 'TermVista 首页' },
    hero: { eyebrow: '开源远程工作台', title: '把远程工作，', accent: '放进一个专注的工作区。', description: '通过 SSH 连接服务器，用 SFTP 管理文件，查看服务器状态、管理隧道，并按需使用 AI 辅助运维。', download: '获取最新版本', source: '查看源代码', releaseLabel: '最新正式版本', noRelease: '查看 GitHub Releases', screenshotAlt: 'TermVista 已连接工作台，展示 SSH 终端、服务器监控和远程文件', windowTitle: 'TermVista · 远程工作台', status: '已连接工作区', openSource: '开源软件' },
    proof: { eyebrow: '为长时间工作而设计', title: '终端只是起点。', body: '让终端、远程文件和服务器运行状态同时可见。TermVista 将日常 SSH 工作整理在清晰的桌面工作区里。', footnote: 'TermVista 真实界面 · 已连接工作区' },
    features: { eyebrow: '连接起来的工作流程', title: 'SSH 会话周边，一处完成。', body: '在连接、文件和运维操作之间切换，同时保留当前服务器上下文。', items: [
      { number: '01', title: 'SSH 会话', description: '通过标签管理多个主机，验证主机身份，并使用真实交互式终端。' },
      { number: '02', title: 'SFTP 与远程编辑', description: '浏览远程目录、传输文件，并在工作区中编辑文本文件。' },
      { number: '03', title: '服务器监控', description: '在当前会话旁查看资源、进程、网络活动和磁盘信息。' },
      { number: '04', title: 'SSH 隧道', description: '在 SSH 桌面工作区中管理本地端口转发规则。' },
    ] },
    workflow: { eyebrow: '由你掌控的 AI', title: '提供上下文，也保留控制权。', body: '让 AI 帮助理解终端输出和运维信号。发送前先检查上下文，命令执行始终由你决定。', points: ['发送前检查上下文', '建议与命令执行相互独立', '使用你配置的 AI 服务'], label: 'AI Copilot', optional: '按需使用' },
    releases: { eyebrow: '安装到你的桌面', title: '下载 TermVista。', body: '选择最新正式 GitHub Release 中发布的下载包。版本说明可在 GitHub 查看。', latest: '最新正式版', published: '发布日期', notes: '版本说明', empty: '暂时无法加载最新版本，请前往 GitHub 查看已发布版本。', platform: { apple: 'macOS · Apple 芯片', intel: 'macOS · Intel 芯片', windows: 'Windows · x64', other: '下载' } },
    close: { eyebrow: '开源协作，共同改进', title: '让远程工作更顺手。', body: '试用 TermVista、查看代码，或告诉我们怎样改进你的工作流程。', star: '在 GitHub 点 Star', issue: '反馈问题', source: '浏览源代码' },
    footer: { made: '面向 SSH 运维的桌面工作台。', license: 'Apache-2.0 许可证', repository: '代码仓库', releases: '版本发布', issues: '问题反馈' },
  },
  ja: {
    htmlLang: 'ja-JP', localeName: '日本語',
    nav: { product: '製品', capabilities: '機能', downloads: 'ダウンロード', github: 'GitHub', menu: 'メニューを開く', primary: 'メインナビゲーション', home: 'TermVista ホーム' },
    hero: { eyebrow: 'オープンソースのリモートワークスペース', title: 'リモート作業を、', accent: 'ひとつのワークスペースに。', description: 'SSH 接続、SFTP ファイル管理、サーバー監視、トンネル管理をまとめ、必要なときに AI を運用に活用できます。', download: '最新リリースを入手', source: 'ソースコードを見る', releaseLabel: '最新の安定版', noRelease: 'GitHub Releases を見る', screenshotAlt: 'SSH ターミナル、サーバー監視、リモートファイルを表示した TermVista の接続済み画面', windowTitle: 'TermVista · リモートワークスペース', status: '接続済みワークスペース', openSource: 'オープンソース' },
    proof: { eyebrow: '長時間の作業のために', title: 'ターミナルだけではありません。', body: 'ターミナル、リモートファイル、サーバーの状態をひとつの画面で確認できます。TermVista は SSH の日常作業をデスクトップにまとめます。', footnote: 'TermVista 実画面 · 接続済みワークスペース' },
    features: { eyebrow: 'つながるワークフロー', title: 'SSH セッションの周辺作業も。', body: '接続、ファイル、運用作業を切り替えても、作業中のサーバーとのコンテキストを保ちます。', items: [
      { number: '01', title: 'SSH セッション', description: '複数ホストをタブで管理し、ホストの識別情報を確認して対話型ターミナルを使えます。' },
      { number: '02', title: 'SFTP とリモート編集', description: 'リモートディレクトリの閲覧、ファイル転送、ワークスペース内でのテキスト編集に対応します。' },
      { number: '03', title: 'サーバー監視', description: 'リソース、プロセス、ネットワーク、ディスクの情報をセッションと並べて確認できます。' },
      { number: '04', title: 'SSH トンネル', description: 'SSH 接続と同じデスクトップ環境でローカルポートフォワードを管理できます。' },
    ] },
    workflow: { eyebrow: 'AI は必要なときに', title: 'コンテキストも操作権限も、あなたが管理。', body: 'ターミナル出力や運用状況の理解を AI に相談できます。送信前にコンテキストを確認し、コマンド実行は自分で判断できます。', points: ['送信前にコンテキストを確認', '提案とコマンド実行を分離', '設定した AI プロバイダーを利用'], label: 'AI Copilot', optional: '任意' },
    releases: { eyebrow: 'デスクトップで使う', title: 'TermVista をダウンロード。', body: '最新の安定版 GitHub Release に公開された配布パッケージを選べます。変更内容は GitHub で確認できます。', latest: '最新安定版', published: '公開日', notes: 'リリースノート', empty: '最新リリースを読み込めませんでした。GitHub で公開済みバージョンを確認してください。', platform: { apple: 'macOS · Apple silicon', intel: 'macOS · Intel', windows: 'Windows · x64', other: 'ダウンロード' } },
    close: { eyebrow: 'オープンソースで開発', title: 'リモート作業をもっと身近に。', body: 'TermVista を試し、コードを確認し、ワークフロー改善のアイデアをお寄せください。', star: 'GitHub で Star', issue: '問題を報告', source: 'ソースコードを見る' },
    footer: { made: 'SSH 運用のためのデスクトップワークスペース。', license: 'Apache-2.0 ライセンス', repository: 'リポジトリ', releases: 'リリース', issues: '課題' },
  },
  'zh-tw': {
    htmlLang: 'zh-TW', localeName: '繁體中文',
    nav: { product: '產品', capabilities: '功能', downloads: '下載', github: 'GitHub', menu: '開啟選單', primary: '主要導覽', home: 'TermVista 首頁' },
    hero: { eyebrow: '開源遠端工作台', title: '把遠端工作，', accent: '放進一個專注的工作區。', description: '透過 SSH 連線伺服器、用 SFTP 管理檔案、查看伺服器狀態、管理通道，並可依需求使用 AI 輔助維運。', download: '取得最新版本', source: '查看原始碼', releaseLabel: '最新正式版本', noRelease: '查看 GitHub Releases', screenshotAlt: 'TermVista 已連線工作區，顯示 SSH 終端機、伺服器監控和遠端檔案', windowTitle: 'TermVista · 遠端工作區', status: '已連線工作區', openSource: '開源軟體' },
    proof: { eyebrow: '為長時間工作而設計', title: '終端機只是起點。', body: '讓終端機、遠端檔案和伺服器狀態同時顯示。TermVista 將日常 SSH 工作整理在清晰的桌面工作區中。', footnote: 'TermVista 實際介面 · 已連線工作區' },
    features: { eyebrow: '串連工作流程', title: 'SSH 工作周邊，一處完成。', body: '在連線、檔案與維運操作間切換，同時保留目前伺服器的工作脈絡。', items: [
      { number: '01', title: 'SSH 工作階段', description: '以分頁管理多台主機、驗證主機身分，並使用真正的互動式終端機。' },
      { number: '02', title: 'SFTP 與遠端編輯', description: '瀏覽遠端目錄、傳輸檔案，並在工作區內編輯文字檔。' },
      { number: '03', title: '伺服器監控', description: '在目前工作階段旁查看資源、程序、網路活動與磁碟資訊。' },
      { number: '04', title: 'SSH 通道', description: '在 SSH 桌面工作區中管理本機連接埠轉送規則。' },
    ] },
    workflow: { eyebrow: '由你掌控的 AI', title: '提供脈絡，也保留控制權。', body: '請 AI 協助理解終端輸出與維運資訊。傳送前先檢查脈絡，命令執行仍由你決定。', points: ['傳送前檢查脈絡', '建議與命令執行分開', '使用你設定的 AI 服務'], label: 'AI Copilot', optional: '依需求使用' },
    releases: { eyebrow: '安裝到你的桌面', title: '下載 TermVista。', body: '選擇最新正式 GitHub Release 中發布的下載套件。版本說明可在 GitHub 查看。', latest: '最新正式版', published: '發布日期', notes: '版本說明', empty: '目前無法載入最新版本，請前往 GitHub 查看已發布版本。', platform: { apple: 'macOS · Apple 晶片', intel: 'macOS · Intel 晶片', windows: 'Windows · x64', other: '下載' } },
    close: { eyebrow: '開源協作，一起改進', title: '讓遠端工作更順手。', body: '試用 TermVista、查看程式碼，或告訴我們如何改善你的工作流程。', star: '在 GitHub 按 Star', issue: '回報問題', source: '瀏覽原始碼' },
    footer: { made: '為 SSH 維運打造的桌面工作區。', license: 'Apache-2.0 授權', repository: '程式碼儲存庫', releases: '版本發布', issues: '問題回報' },
  },
};
