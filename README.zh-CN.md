# TermVista（端境）

**远程工作，尽在一处。** TermVista 是一款面向 macOS 和 Windows 的桌面 SSH 工作台，将终端、SFTP 文件管理、服务器监控、远程文件编辑和需用户授权的 AI 辅助整合在一起。

**当前应用版本：0.10.24**

[官方网站](https://auyang.github.io/TermVista/) · [English](README.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## 界面截图

以下未连接首页截图来自浏览器预览，展示亮色和暗色主题，并非原生 Tauri 窗口截图。

| 亮色主题 | 暗色主题 |
| --- | --- |
| ![TermVista 未连接首页（亮色）](docs/screenshots/home-light-1440x900.png) | ![TermVista 未连接首页（暗色）](docs/screenshots/home-dark-1440x900.png) |

以下图片展示已连接工作区和应用设置。

| 已连接工作区（亮色） | 已连接工作区（暗色） |
| --- | --- |
| ![TermVista 已连接工作区（亮色）](docs/screenshots/1.png) | ![TermVista 已连接工作区（暗色）](docs/screenshots/2.png) |

| 关于 TermVista | 应用设置 |
| --- | --- |
| ![关于 TermVista](docs/screenshots/3.png) | ![TermVista 应用设置](docs/screenshots/4.png) |

## 0.10.24 新亮点

- **四语言界面：**支持 English、简体中文、日本語、繁體中文，也可跟随系统语言；切换后立即生效。
- **AI Copilot 2.0：**可接入本地 Ollama 模型或兼容 OpenAI API 的服务。经用户授权后，可使用选定的终端、编辑器、SFTP 和监控上下文进行解释与带证据引用的诊断。AI 可以生成 Shell 命令草案和 Monaco 代码差异建议；命令只会填入命令栏供用户检查和手动执行，代码建议只修改本地编辑缓冲区，应用和保存均由用户操作。
- **签名在线更新：**可从“关于”检查更新，也可选择启动时检查；查看版本说明和实际下载进度。更新包必须通过签名校验。存在未保存编辑、文件传输、诊断、AI 请求或其他维护任务时会阻止安装；如果仍有 SSH 会话或隧道，则需要确认后才会中断并安装。
- **更快回到工作状态：**连接配置支持搜索、收藏和最近连接。重启后可恢复本机服务器标签、面板布局和各服务器上次使用的 SFTP 路径；是否自动重连可选，并仍会执行正常的主机指纹验证和身份认证。远端 Shell 与进程不会恢复。

## 工作台功能

- **SSH 终端：**支持密码和私钥认证、多标签隔离会话、交互式 PTY、重连操作，以及与当前 PTY 共用的命令栏。
- **SFTP 文件管理：**以目录树和文件列表浏览远程文件，可切换到本地与远程双栏模式，并通过拖放传输。传输队列显示进度，支持取消、重试和同名冲突处理。
- **远程文件编辑：**在 Monaco Editor 中打开远程文本文件，使用多个服务器和文件标签、语法高亮，并在保存前查看未保存更改和远端文件冲突。
- **服务器监控与端口转发：**查看远端 CPU、内存、进程、网络和磁盘信息。为 MySQL、PostgreSQL、Redis 或自定义 TCP 服务配置 SSH 本地转发。隧道只监听 127.0.0.1，并会在 SSH 会话断开或应用退出时停止。
- **工作区外观：**支持亮色和暗色主题，可调整监控区、终端、编辑器及 SFTP 的布局。

## 安全与隐私

- 首次确认 SSH 主机指纹后，TermVista 会在本机记录可信指纹。之后连接会验证该指纹；如果指纹发生变化，连接会被阻断并提示核验。
- SSH 密码和私钥口令可以保存在本机安全凭据存储中。TermVista 不会降级为明文保存。
- AI 不会执行 SSH 命令或写入远程文件。发送前由用户选择并检查上下文；诊断操作需要逐项授权。生成的命令必须由用户检查并手动执行，代码建议也必须由用户应用和保存。
- 连接配置、可信主机记录和已保存凭据保存在本机，不包含在源码仓库或应用安装包中。
- 本地端口转发只监听 127.0.0.1，但本机的其他进程仍可访问转发服务；启动隧道前请核对目标地址。

## 下载

安装包通过 [GitHub Releases](https://github.com/auyang/TermVista/releases) 发布。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（.exe） |
| macOS Intel | 磁盘映像（.dmg） |
| macOS Apple Silicon | 磁盘映像（.dmg） |

目前不提供 Linux 安装包。Windows 安装程序未进行代码签名；macOS 安装包使用 ad-hoc 签名且未公证，首次打开时操作系统可能显示安全提示。

## 快速开始

1. 下载并安装适用于你平台的 TermVista。
2. 新增 SSH 服务器配置，填写主机、端口、用户名和认证方式。
3. 首次连接时，先将应用显示的主机公钥指纹与可信来源核对，再决定是否信任。是否在本机保存登录凭据由你选择。
4. 在连接标签中使用终端和 SFTP。双击远程文本文件即可在编辑器中打开。
5. 如需使用 AI Copilot，请配置 Ollama 或兼容 OpenAI API 的服务，选择要共享的上下文并检查授权预览。

## 从源码运行

开发环境需要 Node.js 22、pnpm 10.32.1、Rust stable，以及 Tauri 2 所需的平台构建依赖。

    pnpm install --frozen-lockfile
    pnpm tauri dev

只运行前端预览可使用 pnpm dev。此模式不会建立 SSH 连接，也不会显示虚构的服务器监控数据。

## 检查

运行以下项目检查：

    pnpm i18n:check
    pnpm typecheck
    pnpm lint
    pnpm test:polish
    pnpm build
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --offline --manifest-path src-tauri/Cargo.toml

## 许可证

TermVista 按 [Apache License 2.0](LICENSE) 发布。

## 项目链接

- 源码：[github.com/auyang/TermVista](https://github.com/auyang/TermVista)
- 官方网站：[auyang.github.io/TermVista](https://auyang.github.io/TermVista/)
- 问题反馈与功能建议：[GitHub Issues](https://github.com/auyang/TermVista/issues)
- 安装包与版本：[GitHub Releases](https://github.com/auyang/TermVista/releases)
