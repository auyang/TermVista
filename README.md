# TermVista（端境）

**连接远端，尽在掌握。** TermVista 是面向 macOS 与 Windows 的 SSH 工作台，把终端、SFTP 文件管理、服务器监控、远程文件编辑和需用户授权的 AI 辅助放在同一桌面应用中。

[查看 0.0.2 发布说明](RELEASE_NOTES_0.0.2.md) · [浏览 GitHub Releases](https://github.com/auyang/TermVista/releases)

## 功能

- **SSH 终端**：支持密码和 SSH 私钥认证、多标签会话、终端重连，以及与当前 PTY 共用的命令输入栏。
- **SFTP 文件管理**：浏览远程目录；在本地与远程文件栏之间拖放、上传和下载；查看传输进度，并在失败时重试。
- **服务器监控**：查看 CPU、内存、进程、网络和磁盘等远端状态。
- **远程文件编辑**：在 Monaco 编辑器中打开远程文本文件，支持多文件标签、常见语言语法高亮、未保存提示和保存冲突检查。
- **AI Copilot**：基于用户选择的终端输出、监控或文件内容提供只读解释和排查建议。
- **桌面工作区**：保留终端与 SFTP 的分区工作台，支持亮色和暗色主题。

## 安全说明

- SSH 主机指纹经过确认后记录；再次连接会校验指纹，指纹变化时会阻断连接并提示核验。
- 可将密码和私钥口令保存到本机加密凭据保险库；保存的秘密不会作为普通连接配置显示。
- AI 不会自动执行命令或写入远程文件。发送上下文前由用户选择内容并确认，诊断操作也需要逐项授权。
- 连接配置、可信主机记录及凭据保存在本机，不会随仓库或安装包上传。

## 下载与安装

当前提供以下安装包：

- **Windows x64**：NSIS 安装程序（`.exe`）
- **macOS Apple Silicon**：`.dmg`
- **macOS Intel**：`.dmg`

Linux 安装包目前不提供。安装包会通过 [GitHub Releases](https://github.com/auyang/TermVista/releases) 发布。

首次连接 SSH 主机时，请核对应用显示的主机公钥指纹，再决定是否信任。v0.0.2 的 Windows 安装包未做代码签名；macOS 构建使用 ad-hoc 签名且未公证，操作系统可能显示安全提示。

## 快速开始

1. 安装并启动 TermVista。
2. 添加 SSH 服务器，填写主机、端口、用户名及认证方式。
3. 首次连接时核对主机指纹；可按需选择是否在本机安全保存登录凭据。
4. 在连接标签中使用终端和 SFTP；双击远程文本文件可在编辑器中打开。
5. 如需使用 AI Copilot，先配置模型服务，再选择要发送的上下文并确认。

## 从源码运行

开发环境需要 Node.js 22、pnpm 10.32.1、Rust stable，以及 Tauri 2 对应操作系统的构建依赖。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

仅启动前端界面可运行 `pnpm dev`。该模式不建立 SSH 连接，也不提供虚构的服务器监控数据。

## 检查

```sh
pnpm typecheck
pnpm lint
pnpm test:polish
pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

## 许可证

TermVista 按 [Apache License 2.0](LICENSE) 发布。

## 项目链接

- 源码：[github.com/auyang/TermVista](https://github.com/auyang/TermVista)
- 问题反馈：[GitHub Issues](https://github.com/auyang/TermVista/issues)
- 版本与安装包：[GitHub Releases](https://github.com/auyang/TermVista/releases)
