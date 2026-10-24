# TermVista（端境）

**遠端工作，盡在一處。** TermVista 是一款適用於 macOS 和 Windows 的桌面 SSH 工作台，整合終端機、SFTP 檔案管理、伺服器監控、遠端檔案編輯，以及需經使用者授權的 AI 輔助功能。

**目前應用程式版本：0.10.24**

[官方網站](https://auyang.github.io/TermVista/) · [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

## 畫面截圖

以下未連線首頁截圖是瀏覽器預覽，展示淺色和深色主題，並非原生 Tauri 視窗截圖。

| 淺色主題 | 深色主題 |
| --- | --- |
| ![TermVista 未連線首頁（淺色）](docs/screenshots/home-light-1440x900.png) | ![TermVista 未連線首頁（深色）](docs/screenshots/home-dark-1440x900.png) |

以下圖片展示已連線工作區和應用程式設定。

| 已連線工作區（淺色） | 已連線工作區（深色） |
| --- | --- |
| ![TermVista 已連線工作區（淺色）](docs/screenshots/1.png) | ![TermVista 已連線工作區（深色）](docs/screenshots/2.png) |

| 關於 TermVista | 應用程式設定 |
| --- | --- |
| ![關於 TermVista](docs/screenshots/3.png) | ![TermVista 應用程式設定](docs/screenshots/4.png) |

## 0.10.24 版本亮點

- **四語介面：**支援 English、简体中文、日本語、繁體中文，也可跟隨系統語言；切換後立即生效。
- **AI Copilot 2.0：**可連接本機 Ollama 模型或相容 OpenAI API 的服務。經使用者授權後，Copilot 可使用選定的終端機、編輯器、SFTP 和監控資料進行說明及附有證據引用的診斷。也可草擬 Shell 命令和 Monaco 程式碼差異；命令只會放入命令列供使用者檢查及手動執行，程式碼建議則會保留在本機，直到使用者套用並儲存。
- **簽章驗證的應用程式內更新：**可從「關於」檢查更新，也可選擇在啟動時檢查，並查看版本說明和實際下載進度。更新套件必須通過簽章驗證。尚有未儲存編輯、檔案傳輸、診斷、AI 請求或其他維護工作時，安裝會等待；若 SSH 工作階段或隧道仍在執行，則會先徵求確認再中斷。
- **更快回到工作狀態：**可搜尋連線設定、加入最愛及查看最近連線。重新啟動後可還原本機伺服器分頁、面板配置及各伺服器上次使用的 SFTP 路徑。是否自動重新連線由使用者選擇，且仍會執行正常的主機金鑰驗證和身分驗證；遠端 Shell 和程序不會還原。

## 工作區功能

- **SSH 終端機：**支援密碼和私鑰驗證、多個彼此隔離的工作階段分頁、互動式 PTY、重新連線，以及與目前 PTY 共用的命令列。
- **SFTP 檔案管理：**透過目錄樹和檔案清單瀏覽遠端資料夾，可切換成本機／遠端雙欄瀏覽，並以拖放傳輸檔案。傳輸佇列會顯示進度，並支援取消、重試及同名檔案衝突處理。
- **遠端檔案編輯：**在 Monaco Editor 開啟遠端文字檔，使用多個伺服器及檔案分頁、語法醒目提示，並在儲存前檢查未儲存變更和遠端檔案衝突。
- **伺服器監控與連接埠轉送：**查看遠端 CPU、記憶體、程序、網路和磁碟資訊。可為 MySQL、PostgreSQL、Redis 或自訂 TCP 服務設定 SSH 本機轉送。隧道僅監聽 127.0.0.1，SSH 工作階段中斷或應用程式結束時會停止。
- **工作區外觀：**支援淺色和深色主題，並可調整監控區、終端機、編輯器和 SFTP 的配置。

## 安全與隱私

- 使用者首次確認 SSH 主機指紋後，TermVista 會在本機記錄為可信指紋。後續連線會驗證指紋；若指紋變更，連線會遭到阻止並提示重新核對。
- SSH 密碼和私鑰口令可儲存在本機安全憑證儲存區；TermVista 不會改用明文儲存。
- AI 不會執行 SSH 命令或寫入遠端檔案。分享前由使用者選擇並檢查上下文；診斷操作需逐項授權。產生的命令必須由使用者檢查並手動執行，程式碼建議也必須由使用者套用及儲存。
- 連線設定、可信主機記錄和已儲存憑證留在本機，不會包含於原始碼儲存庫或應用程式安裝套件。
- 本機連接埠轉送僅監聽 127.0.0.1，但本機其他程序仍可連接轉送服務；啟動隧道前請確認目標位址。

## 下載

安裝套件發布於 [GitHub Releases](https://github.com/auyang/TermVista/releases)。

| 平台 | 套件 |
| --- | --- |
| Windows x64 | NSIS 安裝程式（.exe） |
| macOS Intel | 磁碟映像檔（.dmg） |
| macOS Apple Silicon | 磁碟映像檔（.dmg） |

目前不提供 Linux 安裝套件。Windows 安裝程式未經程式碼簽章；macOS 套件使用 ad-hoc 簽章且未經公證，首次開啟時作業系統可能會顯示安全性提示。

## 快速開始

1. 下載並安裝適用於你平台的 TermVista。
2. 新增 SSH 伺服器設定，填入主機、連接埠、使用者名稱和驗證方式。
3. 首次連線時，先將畫面顯示的主機金鑰指紋與可信來源核對，再決定是否信任。是否在本機儲存登入憑證可自行選擇。
4. 在工作階段分頁中使用終端機和 SFTP。連按兩下遠端文字檔即可在編輯器中開啟。
5. 若要使用 AI Copilot，請設定 Ollama 或相容 OpenAI 的服務，選擇要分享的上下文，並檢查授權預覽。

## 從原始碼執行

開發環境需要 Node.js 22、pnpm 10.32.1、Rust stable，以及 Tauri 2 所需的平台建置相依套件。

    pnpm install --frozen-lockfile
    pnpm tauri dev

若只要預覽前端，請執行 pnpm dev。此模式不會建立 SSH 連線，也不會顯示虛構的伺服器監控資料。

## 檢查

執行以下專案檢查：

    pnpm i18n:check
    pnpm typecheck
    pnpm lint
    pnpm test:polish
    pnpm build
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --offline --manifest-path src-tauri/Cargo.toml

## 授權條款

TermVista 依據 [Apache License 2.0](LICENSE) 發布。

## 相關連結

- 原始碼：[github.com/auyang/TermVista](https://github.com/auyang/TermVista)
- 官方網站：[auyang.github.io/TermVista](https://auyang.github.io/TermVista/)
- 問題回報與功能建議：[GitHub Issues](https://github.com/auyang/TermVista/issues)
- 安裝套件與版本：[GitHub Releases](https://github.com/auyang/TermVista/releases)
