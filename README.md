# TermVista（端境）

**跨平台 AI SSH/SFTP 智能远程工作台**。TermVista 将 SSH 终端、SFTP 文件管理、服务器监控与需用户授权的 AI 辅助整合在 FinalShell 式桌面工作区中。

品牌口号：连接远端，尽在掌握。<br>
英文产品说明：AI-Powered SSH & SFTP Workspace。

## 开发

需要 Node.js、pnpm、Rust 和 Tauri 2 对应平台的系统构建依赖。

```sh
pnpm install
pnpm tauri dev
```

仅运行 React 界面时使用 `pnpm dev`。开发模式中的布局预览只用于 UI 调试，不发起 SSH 连接；正式构建不提供该入口，也不会自动导入示例服务器或模拟指标。

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

TermVista 保留原应用数据目录、SQLite 数据库、SSH 主机信任记录与系统凭据服务标识。未配置的官网、许可证、签名更新服务等信息不会作为产品事实展示。
