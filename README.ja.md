# TermVista

**リモート作業を、ひとつのワークスペースに。** TermVista は macOS と Windows 向けのデスクトップ SSH ワークスペースです。ターミナル、SFTP ファイル管理、サーバー監視、リモートファイル編集、ユーザーが許可した AI アシスタント機能をまとめて利用できます。

[English](README.md) · [简体中文](README.zh-CN.md)

## スクリーンショット

以下の未接続ホーム画面はブラウザーで表示したプレビューで、ライトテーマとダークテーマを示しています。ネイティブ Tauri ウィンドウのスクリーンショットではありません。

| ライトテーマ | ダークテーマ |
| --- | --- |
| ![TermVista 未接続ホーム画面（ライト）](docs/screenshots/home-light-1440x900.png) | ![TermVista 未接続ホーム画面（ダーク）](docs/screenshots/home-dark-1440x900.png) |

以下は接続済みワークスペースとアプリ設定の画面です。

| 接続済みワークスペース（ライト） | 接続済みワークスペース（ダーク） |
| --- | --- |
| ![TermVista 接続済みワークスペース（ライト）](docs/screenshots/1.png) | ![TermVista 接続済みワークスペース（ダーク）](docs/screenshots/2.png) |

| TermVista について | アプリ設定 |
| --- | --- |
| ![TermVista について](docs/screenshots/3.png) | ![TermVista アプリ設定](docs/screenshots/4.png) |

## 主な機能

- **SSH ターミナル：**パスワード認証と秘密鍵認証、複数のセッションタブ、再接続、接続中の PTY と共有するコマンドバーに対応。
- **SFTP ファイル管理：**リモートディレクトリの閲覧、ローカルとリモートのペイン間でのドラッグ＆ドロップ転送、転送状況の表示、失敗した転送の再試行に対応。
- **SSH ローカルポートフォワーディング：**MySQL、PostgreSQL、Redis、または任意の TCP サービス向けのトンネルを設定できます。リスナーは 127.0.0.1 にバインドされます。SSH セッションの切断またはアプリの終了時にトンネルは停止し、再接続後に自動では再開しません。
- **サーバー監視：**リモートの CPU、メモリ、プロセス、ネットワーク、ディスク情報を表示。
- **リモートファイル編集：**Monaco Editor でリモートのテキストファイルを開き、複数ファイルのタブ、言語別ハイライト、未保存変更の表示、リモート側の変更との競合確認に対応。
- **AI Copilot：**ユーザーが選択して許可したコンテキストに基づき、読み取り専用の説明やトラブルシューティング案を提示。
- **デスクトップワークスペース：**ターミナルと SFTP を同じ分割ワークスペースで利用でき、ライトテーマとダークテーマを切り替え可能。

## セキュリティとプライバシー

- SSH ホストフィンガープリントは、初回接続時にユーザーが確認した後、ローカルに信頼済み記録として保存されます。次回以降は照合され、変更が検出されると接続をブロックして確認を求めます。
- SSH パスワードと秘密鍵のパスフレーズは、ローカルの暗号化クレデンシャル保管庫に保存できます。平文での保存にはフォールバックしません。
- AI がコマンドを実行したり、リモートファイルを書き換えたりすることはありません。コンテキストの送信前にユーザーが内容を選択して確認し、診断操作にも個別の許可が必要です。
- 接続プロファイル、信頼済みホスト記録、保存した認証情報はローカルに保存され、ソースリポジトリやアプリパッケージには含まれません。
- ローカルポートフォワーディングは 127.0.0.1 のみで待ち受けます。ただし、同じコンピューター上の他のプロセスから転送先サービスへ接続できるため、トンネルを開始する前に接続先を確認してください。

## ダウンロード

インストーラーは [GitHub Releases](https://github.com/auyang/TermVista/releases) で公開します。

| プラットフォーム | パッケージ |
| --- | --- |
| Windows x64 | NSIS インストーラー（.exe） |
| macOS Intel | ディスクイメージ（.dmg） |
| macOS Apple Silicon | ディスクイメージ（.dmg） |

Linux 用インストーラーは現在提供していません。バージョン 0.0.2 の Windows インストーラーにはコード署名がありません。macOS パッケージは ad-hoc 署名で、公証も行っていないため、初回起動時に OS の警告が表示される場合があります。

## クイックスタート

1. 使用するプラットフォーム向けの TermVista をダウンロードしてインストールします。
2. SSH サーバーのプロファイルを追加し、ホスト、ポート、ユーザー名、認証方式を入力します。
3. 初回接続時は、表示されたホスト鍵のフィンガープリントを信頼できる情報源と照合してから信頼するか決めてください。ログイン認証情報をローカルに保存するかどうかは選択できます。
4. 接続タブでターミナルと SFTP を利用します。リモートのテキストファイルをダブルクリックするとエディターで開きます。
5. AI Copilot を利用する場合は、モデルプロバイダーを設定し、共有するコンテキストを選択して許可を確認します。

## ソースから実行

開発環境には Node.js 22、pnpm 10.32.1、Rust stable、および Tauri 2 のプラットフォーム別ビルド依存関係が必要です。

    pnpm install --frozen-lockfile
    pnpm tauri dev

フロントエンドだけをプレビューする場合は <code>pnpm dev</code> を実行します。このモードでは SSH 接続を確立せず、実在しないサーバー監視データも表示しません。

## チェック

以下のプロジェクトチェックを実行します。

    pnpm typecheck
    pnpm lint
    pnpm test:polish
    pnpm build
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --offline --manifest-path src-tauri/Cargo.toml

## ライセンス

TermVista は [Apache License 2.0](LICENSE) の下で配布されています。

## リンク

- ソースコード：[github.com/auyang/TermVista](https://github.com/auyang/TermVista)
- バグ報告・機能リクエスト：[GitHub Issues](https://github.com/auyang/TermVista/issues)
- インストーラー・リリース：[GitHub Releases](https://github.com/auyang/TermVista/releases)
