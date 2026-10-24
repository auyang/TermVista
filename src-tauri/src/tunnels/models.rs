use std::{net::IpAddr, str::FromStr};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRule {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    #[serde(default)]
    pub group_name: String,
    pub local_host: String,
    pub local_port: u32,
    pub target_host: String,
    pub target_port: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ForwardRule {
    pub fn validate_and_normalize(&mut self) -> Result<(), TunnelError> {
        let invalid = |message: &str| TunnelError::new(TunnelErrorCode::InvalidRule, message);

        self.id = self.id.trim().to_owned();
        self.profile_id = self.profile_id.trim().to_owned();
        self.name = self.name.trim().to_owned();
        self.group_name = self.group_name.trim().to_owned();
        if self.id.is_empty() || self.id.len() > 128 || self.id.chars().any(char::is_control) {
            return Err(invalid("转发规则编号无效。"));
        }
        if self.profile_id.is_empty()
            || self.profile_id.len() > 128
            || self.profile_id.chars().any(char::is_control)
        {
            return Err(invalid("必须选择有效的 SSH 服务器配置。"));
        }
        if self.name.is_empty() || self.name.len() > 64 || self.name.chars().any(char::is_control) {
            return Err(invalid("规则名称必填且不能超过 64 个字符。"));
        }
        if self.group_name.chars().count() > 64 || self.group_name.chars().any(char::is_control) {
            return Err(invalid("分组名称不能超过 64 个字符。"));
        }
        if self.local_host != "127.0.0.1" {
            return Err(invalid(
                "本地监听只能使用 127.0.0.1，不能开放到局域网或公网。",
            ));
        }
        if !(1..=65_535).contains(&self.local_port) {
            return Err(invalid("本地端口必须在 1 到 65535 之间。"));
        }
        if !(1..=65_535).contains(&self.target_port) {
            return Err(invalid("远端端口必须在 1 到 65535 之间。"));
        }

        let target = self.target_host.trim();
        if target.is_empty() || target.len() > 255 || target.chars().any(char::is_control) {
            return Err(invalid("远端主机不能为空，且不能超过 255 个字符。"));
        }
        let unwrapped = target
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(target);
        self.target_host = if let Ok(address) = IpAddr::from_str(unwrapped) {
            address.to_string()
        } else {
            if unwrapped.contains(':') || unwrapped.contains('/') || unwrapped.contains('@') {
                return Err(invalid("远端主机必须是有效的域名、IPv4 或 IPv6 地址。"));
            }
            let ascii = idna::domain_to_ascii(unwrapped)
                .map_err(|_| invalid("远端主机名不是有效的域名或 IP 地址。"))?;
            let ascii = ascii.trim_end_matches('.');
            if ascii.is_empty()
                || ascii.len() > 253
                || ascii.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                })
                || (ascii
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
                    && IpAddr::from_str(ascii).is_err())
            {
                return Err(invalid("远端主机名不是有效的域名或 IP 地址。"));
            }
            ascii.to_ascii_lowercase()
        };

        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Socks5Rule {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    #[serde(default)]
    pub group_name: String,
    pub local_host: String,
    pub local_port: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Socks5Rule {
    pub fn validate_and_normalize(&mut self) -> Result<(), TunnelError> {
        let invalid = |message: &str| TunnelError::new(TunnelErrorCode::InvalidRule, message);

        self.id = self.id.trim().to_owned();
        self.profile_id = self.profile_id.trim().to_owned();
        self.name = self.name.trim().to_owned();
        self.group_name = self.group_name.trim().to_owned();
        if self.id.is_empty() || self.id.len() > 128 || self.id.chars().any(char::is_control) {
            return Err(invalid("SOCKS5 规则编号无效。"));
        }
        if self.profile_id.is_empty()
            || self.profile_id.len() > 128
            || self.profile_id.chars().any(char::is_control)
        {
            return Err(invalid("必须选择有效的 SSH 服务器配置。"));
        }
        if self.name.is_empty() || self.name.len() > 64 || self.name.chars().any(char::is_control) {
            return Err(invalid("规则名称必填且不能超过 64 个字符。"));
        }
        if self.group_name.chars().count() > 64 || self.group_name.chars().any(char::is_control) {
            return Err(invalid("分组名称不能超过 64 个字符。"));
        }
        if self.local_host != "127.0.0.1" {
            return Err(invalid("SOCKS5 只能监听本机 127.0.0.1。"));
        }
        if !(1..=65_535).contains(&self.local_port) {
            return Err(invalid("本地端口必须在 1 到 65535 之间。"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelErrorCode {
    InvalidRule,
    BindInUse,
    BindFailed,
    SessionMissing,
    SessionProfileMismatch,
    ConnectionLost,
    RemoteRejected,
    TargetUnreachable,
    RuleRunning,
    Internal,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelError {
    pub code: TunnelErrorCode,
    pub message: String,
}

impl TunnelError {
    pub fn new(code: TunnelErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TunnelError {}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRuntime {
    pub rule_id: String,
    pub profile_id: String,
    pub session_id: Option<String>,
    pub state: TunnelState,
    pub local_address: Option<String>,
    pub active_connections: u32,
    pub bytes_from_local: String,
    pub bytes_to_local: String,
    pub bytes_per_second_from_local: u64,
    pub bytes_per_second_to_local: u64,
    pub last_error_code: Option<TunnelErrorCode>,
    pub last_error_message: Option<String>,
    pub updated_at: i64,
}

impl ForwardRuntime {
    pub fn stopped(rule_id: impl Into<String>, profile_id: impl Into<String>) -> Self {
        Self {
            rule_id: rule_id.into(),
            profile_id: profile_id.into(),
            session_id: None,
            state: TunnelState::Stopped,
            local_address: None,
            active_connections: 0,
            bytes_from_local: "0".to_owned(),
            bytes_to_local: "0".to_owned(),
            bytes_per_second_from_local: 0,
            bytes_per_second_to_local: 0,
            last_error_code: None,
            last_error_message: None,
            updated_at: now_millis(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Socks5Runtime {
    pub rule_id: String,
    pub profile_id: String,
    pub session_id: Option<String>,
    pub state: TunnelState,
    pub local_address: Option<String>,
    pub active_connections: u32,
    pub bytes_from_local: String,
    pub bytes_to_local: String,
    pub bytes_per_second_from_local: u64,
    pub bytes_per_second_to_local: u64,
    pub last_error_code: Option<TunnelErrorCode>,
    pub last_error_message: Option<String>,
    pub updated_at: i64,
}

impl Socks5Runtime {
    pub fn stopped(rule_id: impl Into<String>, profile_id: impl Into<String>) -> Self {
        Self {
            rule_id: rule_id.into(),
            profile_id: profile_id.into(),
            session_id: None,
            state: TunnelState::Stopped,
            local_address: None,
            active_connections: 0,
            bytes_from_local: "0".to_owned(),
            bytes_to_local: "0".to_owned(),
            bytes_per_second_from_local: 0,
            bytes_per_second_to_local: 0,
            last_error_code: None,
            last_error_message: None,
            updated_at: now_millis(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelProtocol {
    LocalTcp,
    Socks5,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEvent {
    pub id: String,
    pub rule_id: String,
    pub profile_id: String,
    pub protocol: TunnelProtocol,
    pub occurred_at: i64,
    pub code: TunnelErrorCode,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpCheckResult {
    pub rule_id: String,
    pub profile_id: String,
    pub session_id: String,
    pub target_host: String,
    pub target_port: u32,
    pub reachable: bool,
    pub elapsed_ms: Option<u64>,
    pub checked_at: i64,
    pub error_code: Option<TunnelErrorCode>,
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{ForwardRule, Socks5Rule, TunnelErrorCode};

    fn rule() -> ForwardRule {
        ForwardRule {
            id: "rule-1".to_owned(),
            profile_id: "profile-1".to_owned(),
            name: "MySQL".to_owned(),
            group_name: String::new(),
            local_host: "127.0.0.1".to_owned(),
            local_port: 33_060,
            target_host: "127.0.0.1".to_owned(),
            target_port: 3_306,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn normalizes_idn_and_ipv6_hosts() {
        let mut idn = rule();
        idn.target_host = "BÜCHER.example".to_owned();
        idn.validate_and_normalize().unwrap();
        assert_eq!(idn.target_host, "xn--bcher-kva.example");

        let mut ipv6 = rule();
        ipv6.target_host = "[2001:db8::1]".to_owned();
        ipv6.validate_and_normalize().unwrap();
        assert_eq!(ipv6.target_host, "2001:db8::1");
    }

    #[test]
    fn rejects_external_bind_and_invalid_ports_or_hosts() {
        let mut external = rule();
        external.local_host = "0.0.0.0".to_owned();
        assert_eq!(
            external.validate_and_normalize().unwrap_err().code,
            TunnelErrorCode::InvalidRule
        );

        for port in [0, 65_536] {
            let mut invalid_port = rule();
            invalid_port.local_port = port;
            assert!(invalid_port.validate_and_normalize().is_err());
            invalid_port = rule();
            invalid_port.target_port = port;
            assert!(invalid_port.validate_and_normalize().is_err());
        }

        for host in ["", "host/name", "999.999.1.1", "-invalid.example"] {
            let mut invalid_host = rule();
            invalid_host.target_host = host.to_owned();
            assert!(
                invalid_host.validate_and_normalize().is_err(),
                "accepted {host:?}"
            );
        }
    }

    #[test]
    fn socks5_listener_rejects_non_loopback_and_invalid_ports() {
        let mut external = Socks5Rule {
            id: "socks-1".to_owned(),
            profile_id: "profile-1".to_owned(),
            name: "Local proxy".to_owned(),
            group_name: String::new(),
            local_host: "0.0.0.0".to_owned(),
            local_port: 1080,
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(
            external.validate_and_normalize().unwrap_err().code,
            TunnelErrorCode::InvalidRule
        );
        external.local_host = "127.0.0.1".to_owned();
        external.local_port = 0;
        assert_eq!(
            external.validate_and_normalize().unwrap_err().code,
            TunnelErrorCode::InvalidRule
        );
    }
}
