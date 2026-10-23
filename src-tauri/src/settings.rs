use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::connections::ConnectionProfilesStore;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneralSettings {
    pub restore_last_tabs: bool,
    pub auto_connect_saved_hosts: bool,
    pub remember_recent_connections: bool,
    pub auto_check_updates: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            restore_last_tabs: true,
            auto_connect_saved_hosts: false,
            remember_recent_connections: true,
            auto_check_updates: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSettings {
    pub font_family: String,
    pub font_size: u8,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub color_scheme: String,
    pub scrollback: u32,
    pub paste_preview: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family: "Menlo, Monaco, 'SFMono-Regular', monospace".to_owned(),
            font_size: 14,
            line_height: 1.25,
            cursor_style: "block".to_owned(),
            cursor_blink: true,
            color_scheme: "follow".to_owned(),
            scrollback: 5000,
            paste_preview: true,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionSettings {
    pub auto_reconnect_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitoringSettings {
    pub enabled: bool,
}

impl Default for MonitoringSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceSettings {
    pub theme_mode: String,
    pub show_monitor_sidebar: bool,
    pub ai_panel_open_by_default: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme_mode: "system".to_owned(),
            show_monitor_sidebar: true,
            ai_panel_open_by_default: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicSettings {
    pub schema_version: u32,
    pub revision: u64,
    pub general: GeneralSettings,
    pub terminal: TerminalSettings,
    pub connections: ConnectionSettings,
    pub monitoring: MonitoringSettings,
    pub appearance: AppearanceSettings,
}

impl Default for PublicSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            general: GeneralSettings::default(),
            terminal: TerminalSettings::default(),
            connections: ConnectionSettings::default(),
            monitoring: MonitoringSettings::default(),
            appearance: AppearanceSettings::default(),
        }
    }
}

impl PublicSettings {
    fn validate(&self) -> Result<(), String> {
        if !(11..=24).contains(&self.terminal.font_size) {
            return Err("终端字号必须在 11 到 24 像素之间。".to_owned());
        }
        if !self.terminal.line_height.is_finite()
            || !(1.0..=2.0).contains(&self.terminal.line_height)
        {
            return Err("终端行距必须在 1.0 到 2.0 之间。".to_owned());
        }
        if !(1000..=50_000).contains(&self.terminal.scrollback) {
            return Err("终端滚动缓冲区必须在 1,000 到 50,000 行之间。".to_owned());
        }
        if !matches!(
            self.terminal.cursor_style.as_str(),
            "block" | "underline" | "bar"
        ) {
            return Err("终端光标样式无效。".to_owned());
        }
        if !matches!(self.terminal.color_scheme.as_str(), "follow" | "dark") {
            return Err("终端配色方案无效。".to_owned());
        }
        if self.terminal.font_family.is_empty()
            || self.terminal.font_family.len() > 128
            || self.terminal.font_family.chars().any(char::is_control)
        {
            return Err("终端字体名称无效。".to_owned());
        }
        if !matches!(
            self.appearance.theme_mode.as_str(),
            "system" | "light" | "dark"
        ) {
            return Err("应用主题无效。".to_owned());
        }
        self.schema_version
            .eq(&1)
            .then_some(())
            .ok_or_else(|| "不支持此版本的设置数据。".to_owned())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetadata {
    pub name: String,
    pub name_zh: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub channel: Option<String>,
    pub build_hash: Option<String>,
    pub updater_configured: bool,
    pub updater_config_reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedDiagnosticInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub updater_configured: bool,
}

#[tauri::command]
pub fn settings_get(
    profiles: State<'_, std::sync::Arc<ConnectionProfilesStore>>,
) -> Result<PublicSettings, String> {
    read_settings(profiles.inner())
}

#[tauri::command(rename_all = "camelCase")]
pub fn settings_patch(
    profiles: State<'_, std::sync::Arc<ConnectionProfilesStore>>,
    section: String,
    patch: Value,
    expected_revision: u64,
) -> Result<PublicSettings, String> {
    if !patch.is_object() {
        return Err("设置更新内容必须是对象。".to_owned());
    }
    let mut settings = read_settings(profiles.inner())?;
    if settings.revision != expected_revision {
        return Err("设置已在其他窗口更新，请重新加载后再试。".to_owned());
    }

    let mut value = serde_json::to_value(&settings).map_err(|error| error.to_string())?;
    let sections = value
        .as_object_mut()
        .ok_or_else(|| "设置数据格式错误。".to_owned())?;
    let target = match section.as_str() {
        "general" | "terminal" | "connections" | "monitoring" | "appearance" => sections
            .get_mut(&section)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "设置分组不存在。".to_owned())?,
        _ => return Err("不支持修改此设置分组。".to_owned()),
    };
    merge_object(target, patch.as_object().expect("前面已验证对象"));
    settings = serde_json::from_value(value).map_err(|error| format!("设置值无效：{error}"))?;
    settings.validate()?;
    settings.revision = expected_revision + 1;
    let settings_json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    let revision = profiles.save_settings_record(expected_revision, &settings_json)?;
    settings.revision = revision;
    Ok(settings)
}

pub fn should_remember_recent_connection(
    profiles: &ConnectionProfilesStore,
) -> Result<bool, String> {
    Ok(read_settings(profiles)?.general.remember_recent_connections)
}

#[tauri::command]
pub fn app_metadata_get(app: tauri::AppHandle) -> AppMetadata {
    let package = app.package_info();
    let (updater_configured, updater_config_reason) =
        updater_config_status(app.config().plugins.0.get("updater"));
    AppMetadata {
        name: "TermVista".to_owned(),
        name_zh: "端境".to_owned(),
        version: package.version.to_string(),
        platform: platform_name(std::env::consts::OS).to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        channel: non_empty_option(env!("CARGO_PKG_VERSION_PRE")),
        build_hash: option_env!("TERM_VISTA_BUILD_HASH").and_then(non_empty_option),
        updater_configured,
        updater_config_reason,
    }
}

fn updater_config_status(config: Option<&Value>) -> (bool, String) {
    const ENDPOINT: &str =
        "https://github.com/auyang/TermVista/releases/latest/download/latest.json";
    let Some(config) = config.and_then(Value::as_object) else {
        return (false, "尚未配置在线更新服务。".to_owned());
    };
    let has_official_endpoint = config
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|items| items.len() == 1 && items[0].as_str() == Some(ENDPOINT));
    if !has_official_endpoint {
        return (
            false,
            "更新地址未配置为 TermVista 官方 HTTPS 发布源。".to_owned(),
        );
    }
    if config
        .get("dangerousInsecureTransportProtocol")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || config
            .get("dangerousAcceptInvalidCerts")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || config
            .get("dangerousAcceptInvalidHostnames")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return (
            false,
            "更新传输安全配置不符合要求，在线更新已禁用。".to_owned(),
        );
    }
    if config
        .get("allowDowngrades")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || !config
            .get("requireSignedVersion")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return (false, "更新版本安全校验未启用，在线更新已禁用。".to_owned());
    }
    let pubkey = config
        .get("pubkey")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    use base64::Engine;
    let valid_pubkey = base64::engine::general_purpose::STANDARD
        .decode(pubkey)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .is_some_and(|key_text| minisign_verify::PublicKey::decode(&key_text).is_ok());
    if !valid_pubkey {
        return (false, "尚未配置有效的 Tauri 更新签名公钥。".to_owned());
    }
    (true, "在线更新服务已配置。".to_owned())
}

#[tauri::command]
pub fn app_diagnostics_copyable(app: tauri::AppHandle) -> SanitizedDiagnosticInfo {
    let metadata = app_metadata_get(app);
    SanitizedDiagnosticInfo {
        name: metadata.name,
        version: metadata.version,
        platform: metadata.platform,
        arch: metadata.arch,
        updater_configured: metadata.updater_configured,
    }
}

fn read_settings(profiles: &ConnectionProfilesStore) -> Result<PublicSettings, String> {
    let Some((data, revision)) = profiles.get_settings_record()? else {
        return Ok(PublicSettings::default());
    };
    let mut settings: PublicSettings =
        serde_json::from_str(&data).map_err(|error| format!("设置数据无法读取：{error}"))?;
    settings.revision = revision;
    settings.validate()?;
    Ok(settings)
}

fn merge_object(target: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (key, value) in patch {
        if let (Some(target_child), Some(patch_child)) = (
            target.get_mut(key).and_then(Value::as_object_mut),
            value.as_object(),
        ) {
            merge_object(target_child, patch_child);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn non_empty_option(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn platform_name(os: &str) -> &'static str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        _ => "未知平台",
    }
}

#[cfg(test)]
mod tests {
    use super::{PublicSettings, merge_object, platform_name, updater_config_status};
    use serde_json::{Value, json};

    #[test]
    fn defaults_are_valid_and_security_controls_stay_closed() {
        let settings = PublicSettings::default();
        assert!(settings.validate().is_ok());
        assert!(!settings.general.auto_connect_saved_hosts);
        assert!(!settings.connections.auto_reconnect_enabled);
        assert!(settings.terminal.paste_preview);
        assert!(!settings.appearance.ai_panel_open_by_default);
    }

    #[test]
    fn validation_rejects_invalid_font_sizes_and_unbounded_scrollback() {
        let mut settings = PublicSettings::default();
        settings.terminal.font_size = 10;
        assert!(settings.validate().is_err());
        settings.terminal.font_size = 14;
        settings.terminal.scrollback = 100_000;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn older_settings_payloads_fill_new_fields_from_defaults() {
        let settings: PublicSettings = serde_json::from_str(
            r#"{"schemaVersion":1,"revision":4,"general":{"restoreLastTabs":false}}"#,
        )
        .unwrap();
        assert!(!settings.general.restore_last_tabs);
        assert_eq!(settings.terminal, super::TerminalSettings::default());
        assert!(settings.monitoring.enabled);
        assert!(settings.general.auto_check_updates);
    }

    #[test]
    fn patch_merge_only_changes_the_selected_object() {
        let mut target = serde_json::Map::from_iter([(
            "terminal".to_owned(),
            json!({ "fontSize": 14, "cursorBlink": true }),
        )]);
        let patch: Value = json!({ "fontSize": 16 });
        merge_object(
            target.get_mut("terminal").unwrap().as_object_mut().unwrap(),
            patch.as_object().unwrap(),
        );
        assert_eq!(
            target["terminal"],
            json!({ "fontSize": 16, "cursorBlink": true })
        );
    }

    #[test]
    fn platform_names_are_display_friendly() {
        assert_eq!(platform_name("macos"), "macOS");
        assert_eq!(platform_name("linux"), "Linux");
    }

    #[test]
    fn updater_stays_disabled_without_a_real_signing_public_key() {
        let config = json!({
            "pubkey": "",
            "endpoints": ["https://github.com/auyang/TermVista/releases/latest/download/latest.json"],
            "requireSignedVersion": true,
            "allowDowngrades": false
        });
        let (configured, reason) = updater_config_status(Some(&config));
        assert!(!configured);
        assert!(reason.contains("公钥"));
    }

    #[test]
    fn configured_updater_public_key_is_a_valid_minisign_key() {
        let app_config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let (configured, reason) = updater_config_status(app_config.pointer("/plugins/updater"));
        assert!(configured, "{reason}");
    }

    #[test]
    fn updater_rejects_non_official_endpoints_and_insecure_version_policy() {
        let config = json!({
            "pubkey": "",
            "endpoints": ["http://updates.example.test/latest.json"],
            "requireSignedVersion": true,
            "allowDowngrades": false
        });
        assert!(!updater_config_status(Some(&config)).0);

        let config = json!({
            "pubkey": "",
            "endpoints": ["https://github.com/auyang/TermVista/releases/latest/download/latest.json", null],
            "requireSignedVersion": true,
            "allowDowngrades": false
        });
        assert!(!updater_config_status(Some(&config)).0);

        let config = json!({
            "pubkey": "",
            "endpoints": ["https://github.com/auyang/TermVista/releases/latest/download/latest.json"],
            "requireSignedVersion": false,
            "allowDowngrades": true
        });
        assert!(!updater_config_status(Some(&config)).0);
    }
}
