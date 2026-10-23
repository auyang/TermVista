# TermVista（端境）

**远程工作，尽在一处。** TermVista 是一款面向 macOS 和 Windows 的桌面 SSH 工作台，将终端、SFTP 文件管理、服务器监控、远程文件编辑和需用户授权的 AI 辅助整合在一起。

[English](README.md) · [日本語](README.ja.md)

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

## 功能

- **SSH 终端：**支持密码和私钥认证、多标签会话、断线重连，以及与当前 PTY 共用的命令栏。
- **SFTP 文件管理：**浏览远程目录，在本地与远程面板之间拖放传输文件、查看传输进度，并重试失败的传输。
- **SSH 本地端口转发：**为 MySQL、PostgreSQL、Redis 或自定义 TCP 服务配置隧道。监听地址固定为 127.0.0.1。SSH 会话断开或应用退出时隧道会停止；重连后不会自动启动。
- **服务器监控：**查看远端 CPU、内存、进程、网络和磁盘信息。
- **远程文件编辑：**在 Monaco Editor 中打开远程文本文件，使用多个文件标签和语言高亮，并查看未保存更改及远端文件冲突。
- **AI Copilot：**根据用户选择并授权的上下文提供只读解释和排查建议。
- **桌面工作区：**在同一分区工作区中使用终端和 SFTP，并支持亮色与暗色主题。

## 安全与隐私

- 首次确认 SSH 主机指纹后，TermVista 会在本机记录可信指纹。之后连接会验证该指纹；如果指纹发生变化，连接会被阻断并提示核验。
- SSH 密码和私钥口令可以保存在本机加密凭据保险库中。TermVista 不会降级为明文保存。
- AI 不会执行命令或写入远程文件。发送上下文前由用户选择并确认；诊断操作需要逐项授权。
- 连接配置、可信主机记录和已保存凭据保存在本机，不包含在源码仓库或应用安装包中。
- 本地端口转发只监听 127.0.0.1，但本机的其他进程仍可访问转发服务；启动隧道前请核对目标地址。

## 下载

安装包通过 [GitHub Releases](https://github.com/auyang/TermVista/releases) 发布。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序（.exe） |
| macOS Intel | 磁盘映像（.dmg） |
| macOS Apple Silicon | 磁盘映像（.dmg） |

目前不提供 Linux 安装包。0.0.2 版 Windows 安装程序未进行代码签名；macOS 安装包使用 ad-hoc 签名且未公证，首次打开时操作系统可能显示安全提示。

## 快速开始

1. 下载并安装适用于你平台的 TermVista。
2. 新增 SSH 服务器配置，填写主机、端口、用户名和认证方式。
3. 首次连接时，先将应用显示的主机公钥指纹与可信来源核对，再决定是否信任。是否在本机保存登录凭据由你选择。
4. 在连接标签中使用终端和 SFTP。双击远程文本文件即可在编辑器中打开。
5. 如需使用 AI Copilot，请配置模型服务，选择要共享的上下文并确认授权提示。

## 从源码运行

开发环境需要 Node.js 22、pnpm 10.32.1、Rust stable，以及 Tauri 2 所需的平台构建依赖。

    pnpm install --frozen-lockfile
    pnpm tauri dev

只运行前端预览可使用 <code>pnpm dev</code>。此模式不会建立 SSH 连接，也不会显示虚构的服务器监控数据。

## 检查

运行以下项目检查：

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
- 问题反馈与功能建议：[GitHub Issues](https://github.com/auyang/TermVista/issues)
- 安装包与版本：[GitHub Releases](https://github.com/auyang/TermVista/releases)
