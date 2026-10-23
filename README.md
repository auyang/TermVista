# TermVista

**Your remote workspace, in one place.** TermVista is a desktop SSH workspace for macOS and Windows, bringing terminals, SFTP file management, server monitoring, remote file editing, and user-authorized AI assistance together.

[简体中文](README.zh-CN.md) · [日本語](README.ja.md)

## Screenshots

The home screen images below are browser previews of the disconnected state, showing light and dark themes. They are not screenshots of the native Tauri window.

| Light theme | Dark theme |
| --- | --- |
| ![TermVista disconnected home in light theme](docs/screenshots/home-light-1440x900.png) | ![TermVista disconnected home in dark theme](docs/screenshots/home-dark-1440x900.png) |

The following images show a connected workspace and application settings.

| Connected workspace (light) | Connected workspace (dark) |
| --- | --- |
| ![TermVista connected workspace in light theme](docs/screenshots/1.png) | ![TermVista connected workspace in dark theme](docs/screenshots/2.png) |

| About TermVista | Application settings |
| --- | --- |
| ![About TermVista](docs/screenshots/3.png) | ![TermVista application settings](docs/screenshots/4.png) |

## Features

- **SSH terminals:** Password and private-key authentication, multiple session tabs, reconnect, and a command bar that shares the active PTY.
- **SFTP file management:** Browse remote directories, transfer files between local and remote panes with drag and drop, track transfer progress, and retry failed transfers.
- **SSH local port forwarding:** Configure tunnels for MySQL, PostgreSQL, Redis, or custom TCP services. Listeners bind to 127.0.0.1. A tunnel stops when its SSH session disconnects or the application exits; reconnecting does not restart it automatically.
- **Server monitoring:** View remote CPU, memory, process, network, and disk information.
- **Remote file editing:** Open remote text files in Monaco Editor, work across multiple file tabs, use language highlighting, and review unsaved changes and remote-file conflicts.
- **AI Copilot:** Get read-only explanations and troubleshooting suggestions from context you select and authorize.
- **Desktop workspace:** Use terminals and SFTP in the same split workspace, with light and dark themes.

## Security and privacy

- TermVista records a trusted SSH host fingerprint after you confirm it. Later connections verify the fingerprint; a changed fingerprint blocks the connection and prompts you to review it.
- SSH passwords and private-key passphrases can be saved in the local encrypted credential vault. TermVista does not fall back to storing them in plaintext.
- AI does not execute commands or write remote files. You choose and confirm context before sending it; diagnostic actions require individual authorization.
- Connection profiles, trusted host records, and saved credentials are stored locally and are not included in this source repository or application packages.
- Local port forwarding listens only on 127.0.0.1. Other processes on your computer can still access a forwarded service, so review the destination before starting a tunnel.

## Download

Installers are published on [GitHub Releases](https://github.com/auyang/TermVista/releases).

| Platform | Package |
| --- | --- |
| Windows x64 | NSIS installer (.exe) |
| macOS Intel | Disk image (.dmg) |
| macOS Apple Silicon | Disk image (.dmg) |

Linux installers are not currently provided. The v0.0.2 Windows installer is not code-signed. The macOS packages use ad-hoc signing and are not notarized, so your operating system may show a security warning when opening them.

## Quick start

1. Download and install TermVista for your platform.
2. Add an SSH server profile with its host, port, username, and authentication method.
3. On the first connection, compare the displayed host-key fingerprint with a trusted source before accepting it. Saving the login credential locally is optional.
4. Use the session tab to work in the terminal and SFTP panes. Double-click a remote text file to open it in the editor.
5. To use AI Copilot, configure a model provider, select the context to share, and review the authorization prompt.

## Run from source

The development environment requires Node.js 22, pnpm 10.32.1, Rust stable, and the platform dependencies required by Tauri 2.

    pnpm install --frozen-lockfile
    pnpm tauri dev

To run only the frontend preview, use <code>pnpm dev</code>. This does not open an SSH connection or display fabricated server-monitoring data.

## Checks

Run the project checks with:

    pnpm typecheck
    pnpm lint
    pnpm test:polish
    pnpm build
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --offline --manifest-path src-tauri/Cargo.toml

## License

TermVista is distributed under the [Apache License 2.0](LICENSE).

## Links

- Source code: [github.com/auyang/TermVista](https://github.com/auyang/TermVista)
- Bug reports and feature requests: [GitHub Issues](https://github.com/auyang/TermVista/issues)
- Installers and releases: [GitHub Releases](https://github.com/auyang/TermVista/releases)
