# TermVista GitHub Actions / CLI 打包指南

## 适用工程

- Tauri 2, Rust, React + Vite, pnpm，源码在仓库根目录。
- `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`pnpm-lock.yaml` 应已存在。
- 如果项目实际使用 pnpm 9，请在 3 个 Actions workflow 中把 `pnpm/action-setup` 的 version 从 10 改为 9；优先与 `package.json > packageManager` 一致。
- 如果仓库不使用 `main`/`master` 作为主分支，请同步调整 YAML 的 `branches` 配置。
- 如果 Tauri 项目不是仓库根目录，需修改 working-directory/projectPath。

## 文件部署

将压缩包内的 `.github/workflows`、`scripts/ci`、`docs/CI_CD_GUIDE.md` 合并到 TermVista 仓库根目录。
不要覆盖现有的 package.json、tauri.conf.json、Bundle Identifier 或用户数据目录。

## 触发行为

1. PR → `.github/workflows/ci.yml`：前端构建、可用的 lint/typecheck/test:ci、Rust fmt/check/test/clippy。
2. push main/master → 除 CI 外，执行 `desktop-build.yml` 跨平台打包并上传 Actions Artifacts。
3. GitHub Actions UI → 手动触发 `desktop-build.yml`，可指定分支进行打包。
4. 推送匹配 v* 的语义化版本标签 → `release.yml`；验证版本一致后构建并上传到 **Draft** GitHub Release。只有人工审查和发布后才对公众展示为正式 Release。

## 构建产物

- macOS Apple Silicon: aarch64 `.dmg`
- macOS Intel: x86_64 `.dmg`
- Windows x64: NSIS `*-setup.exe`
- Linux 安装包未纳入当前构建范围；Ubuntu Runner 仅用于 CI 检查。

## 本地 CLI

```bash
pnpm install --frozen-lockfile
node scripts/ci/package.mjs doctor
node scripts/ci/package.mjs check
node scripts/ci/package.mjs build
# macOS Intel: rustup target add x86_64-apple-darwin (需安装构建工具)
node scripts/ci/package.mjs build --target=x86_64-apple-darwin
```

或直接调用 Tauri CLI：

```bash
pnpm tauri build --bundles dmg             # macOS
pnpm tauri build --bundles nsis            # Windows
```

**注意**：这里是各操作系统**原生打包**，不是声称能在任意单台机器上跨 OS 打包。

## GitHub CLI（gh）启动和下载 CI 产物

```bash
gh auth login
gh workflow list
gh workflow run desktop-build.yml --ref main
gh run list --workflow desktop-build.yml --limit 5
gh run watch <RUN_ID> --exit-status
gh run download <RUN_ID> --dir ./dist/actions
```

创建 Release：先同步 `package.json.version`、`src-tauri/tauri.conf.json.version` 与 `src-tauri/Cargo.toml` 中显式版本，然后：

```bash
node scripts/ci/verify-release.mjs v0.1.0
git tag -a v0.1.0 -m 'TermVista v0.1.0'
git push origin v0.1.0
# 自动进入 Actions -> Release / Cross-platform Installers
# 完成后在 GitHub Releases 检查 Draft，人工验证并发布。
```

也可用 `gh release view v0.1.0` 查看草稿（有访问权限时）。

## 权限和签名安全

- PR CI 和普通 Build 只授予 `contents: read`，不传递任何持久化凭据，也不接受来自 PR 的脚本自动升级发布权限。
- 正式发布任务只在匹配版本标签时授予 `contents: write` 用于上传 GitHub Release；推荐配合受保护标签规则与只允许可信维护者创建标签。
- `.github/workflows/release.yml` 默认采用 macOS **ad-hoc** 签名 `APPLE_SIGNING_IDENTITY='-'`；它不代表 Apple Developer ID 签名和公证。外部分发需要按 Tauri 官方指南配置 Apple 证书与 Notarization。
- Windows 默认无发布者代码签名，安装时可能出现 SmartScreen 警告。需要后续配置可信代码签名证书。
- Tauri Updater 的签名密钥和平台代码签名是**两回事**。启用 Updater 需要配置 `TAURI_SIGNING_PRIVATE_KEY` 等秘密并验证更新器配置，不能把公证或打包流程当作已完成自动更新。
- 本模板默认不声明自动更新已经可用，也不上传任何密钥。不要将 `.p12`、`.pfx`、`.key` 或密码放进仓库。
- 版本、签名、app bundle identifier、签发主体与用户数据路径的变更应受控评审；不要在配置 CI 时顺手改动它们。
- 后续生产化建议把第三方 Actions 的浮动标签固定到经过评审的完整 commit SHA，定期升级。

## 开发注意

- 如果 Rust Clippy `-D warnings` 因现有工程告警失败，应先修复告警，或经代码评审单独调整规则；不要让 CI 假装通过。
- 如果当前仓库执行 `pnpm run build` 后未自动生成前端产物，请核对 `tauri.conf.json` 中的 `build.beforeBuildCommand`、`build.frontendDist` 是否与项目实际一致。
- 如果启用了自动更新包签名而缺少密钥，CI 发布将失败，应先正确配置密钥，再启用签名产物。不要为了跑通构建而关闭已有的安全策略。
- GitHub Actions 的 macOS runner 成本通常比 Linux 高；频繁打包可调整为仅手动触发或合并后构建。

参考：
- https://v2.tauri.app/distribute/pipelines/github/
- https://github.com/tauri-apps/tauri-action
- https://v2.tauri.app/distribute/sign/macos/
- https://v2.tauri.app/distribute/

## TermVista 当前仓库配置

- 默认分支：`main`。仓库此前没有 GitHub Actions 工作流，本次新增 `ci.yml`、`desktop-build.yml` 和 `release.yml`，没有覆盖已有配置。
- 前端使用 Node.js 22、pnpm `10.32.1`；`package.json` 已固定 `packageManager`，`pnpm-lock.yaml` 为 lockfile v9 格式。
- Rust 使用 stable；`src-tauri/Cargo.lock` 存在，CI 命令使用 `--locked`。Tauri `beforeBuildCommand` 为 `pnpm build`，前端产物目录为 `dist`。
- `ci.yml` 在指向 `main` 的 PR 上执行 lint、typecheck、已有 `test:polish`、前端构建及 Rust fmt/check/test/clippy；它不申请写权限。
- `desktop-build.yml` 在 `main` 更新时打包 macOS Apple Silicon、macOS Intel 和 Windows x64，也支持 Actions 手动触发并通过 `--ref` 选择分支。版本标签工作流通过 `workflow_call` 复用相同打包矩阵。
- Actions 产物名称：`TermVista-macOS-Apple-Silicon`（DMG）、`TermVista-macOS-Intel`（DMG）、`TermVista-Windows-x64`（NSIS setup.exe）。主分支产物保留 7 天，Release 工作流的中间产物保留 2 天。
- `release.yml` 只响应 `v*` 标签；构建前校验标签、`package.json`、`tauri.conf.json` 和 `Cargo.toml` 的版本一致。安装包上传到 Draft Release；不会自动发布为正式版本，也不会自动创建或移动 Git 标签。
- Actions 依赖固定到带注释的发布版本或完整提交 SHA，避免使用浮动 `@main` / `@vN` 引用。定期评审后再更新。

### 手动触发与下载

```bash
gh auth status
gh workflow list
gh workflow run desktop-build.yml --ref main
gh run list --workflow desktop-build.yml --limit 5
gh run watch <RUN_ID> --exit-status
gh run download <RUN_ID> --pattern 'TermVista-*' --dir ./dist/actions
```

手动打包默认会生成所有支持平台的产物。如果要检查 Release 草稿：

```bash
gh release view v0.1.0
```

### 签名配置状态

- 当前 macOS 工作流使用 ad-hoc 身份 `APPLE_SIGNING_IDENTITY='-'`，不是 Developer ID 签名或公证；Windows 安装包未做发布者签名。
- 正式 macOS 签名预留 Secrets：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`KEYCHAIN_PASSWORD`。公证还需 Apple 账号或 App Store Connect API 凭据；当前均未配置或注入工作流。
- Windows 证书签名预留 Secrets：`WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD`；当前未配置。
- Tauri Updater 密钥单独预留为 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。项目当前没有开启 Updater，不生成更新签名产物。
- 上述 Secrets 只能在受信任发布作业中按需注入；PR 与普通打包作业没有持久化凭据或仓库写权限。不得把证书、密钥、密码或用户 Vault 数据写入仓库或 Actions 产物。
