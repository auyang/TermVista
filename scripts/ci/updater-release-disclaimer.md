## 在线更新与平台签名

TermVista 在线更新包由 Tauri updater 密码学签名，并在客户端安装前验证签名和版本号。这个更新签名不等同于操作系统发行者签名。

当前 Windows 安装包没有配置 Authenticode 发行者证书；macOS 包使用 ad-hoc 签名，尚未进行 Apple 公证。首次安装时，系统可能显示相应的安全提示。请只从 TermVista 官方 GitHub Release 下载。
