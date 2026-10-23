use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetricState {
    Pending,
    Fresh,
    Stale,
    Error,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitored<T> {
    pub state: MetricState,
    pub value: Option<T>,
    pub sampled_at: Option<String>,
    pub reason: Option<String>,
}

impl<T> Monitored<T> {
    pub fn pending() -> Self {
        Self {
            state: MetricState::Pending,
            value: None,
            sampled_at: None,
            reason: None,
        }
    }

    pub fn fresh(value: T, sampled_at: String) -> Self {
        Self {
            state: MetricState::Fresh,
            value: Some(value),
            sampled_at: Some(sampled_at),
            reason: None,
        }
    }

    pub fn unavailable(state: MetricState, reason: impl Into<String>) -> Self {
        Self {
            state,
            value: None,
            sampled_at: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostMetric {
    pub hostname: String,
    pub display_ip: String,
    pub uptime_seconds: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetric {
    pub busy_percent: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetric {
    /// 字节计数以十进制字符串传输，避免 JavaScript number 丢失大整数精度。
    pub total_bytes: String,
    pub available_bytes: String,
    pub used_percent: f64,
    pub swap_total_bytes: String,
    pub swap_free_bytes: String,
    pub swap_used_percent: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetric {
    pub pid: u32,
    pub command: String,
    pub cpu_percent: f64,
    /// 字节计数以十进制字符串传输，避免 JavaScript number 丢失大整数精度。
    pub rss_bytes: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceMetric {
    pub name: String,
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetric {
    pub interfaces: Vec<NetworkInterfaceMetric>,
    pub selected_interface: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatencyMetric {
    pub ssh_round_trip_ms: f64,
    pub kind: LatencyKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LatencyKind {
    SshExecRoundTrip,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetric {
    pub filesystem: String,
    pub mount_point: String,
    /// 字节计数以十进制字符串传输，避免 JavaScript number 丢失大整数精度。
    pub total_bytes: String,
    pub available_bytes: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub collected_at: String,
    pub host: Monitored<HostMetric>,
    pub cpu: Monitored<CpuMetric>,
    pub memory: Monitored<MemoryMetric>,
    pub processes: Monitored<Vec<ProcessMetric>>,
    pub network: Monitored<NetworkMetric>,
    pub latency: Monitored<LatencyMetric>,
    pub disks: Monitored<Vec<DiskMetric>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSubscriptionId {
    pub subscription_id: String,
}

impl MonitorSnapshot {
    pub fn pending(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            sequence: 0,
            collected_at: utc_now_iso8601(),
            host: Monitored::pending(),
            cpu: Monitored::pending(),
            memory: Monitored::pending(),
            processes: Monitored::pending(),
            network: Monitored::pending(),
            latency: Monitored::pending(),
            disks: Monitored::pending(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MonitorStatus {
    Started,
    Stopped,
    Disconnected,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MonitorEvent {
    Snapshot {
        subscription_id: String,
        data: Box<MonitorSnapshot>,
    },
    Status {
        subscription_id: String,
        session_id: String,
        status: MonitorStatus,
        message: Option<String>,
    },
}

pub fn utc_now_iso8601() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let days = (now.as_secs() / 86_400) as i64;
    let second_of_day = now.as_secs() % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = second_of_day / 3_600;
    let minute = second_of_day % 3_600 / 60;
    let second = second_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        now.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::{MetricState, MonitorEvent, MonitorSnapshot, Monitored, utc_now_iso8601};

    #[test]
    fn snapshot_starts_without_fabricated_metric_values() {
        let snapshot = MonitorSnapshot::pending("session-a");
        assert_eq!(snapshot.session_id, "session-a");
        assert_eq!(snapshot.cpu.state, MetricState::Pending);
        assert!(snapshot.cpu.value.is_none());
        assert!(snapshot.memory.value.is_none());
    }

    #[test]
    fn timestamps_are_utc_iso8601() {
        let timestamp = utc_now_iso8601();
        assert!(timestamp.ends_with('Z'));
        assert_eq!(timestamp.len(), 24);
        assert_eq!(&timestamp[4..5], "-");
        assert_eq!(&timestamp[10..11], "T");
    }

    #[test]
    fn monitor_events_use_the_ipc_camel_case_contract() {
        let event = MonitorEvent::Snapshot {
            subscription_id: "sub-1".to_owned(),
            data: Box::new(MonitorSnapshot::pending("session-a")),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "snapshot");
        assert_eq!(json["subscriptionId"], "sub-1");
        assert_eq!(json["data"]["sessionId"], "session-a");

        let metric: Monitored<()> =
            Monitored::unavailable(MetricState::Unsupported, "非 Linux 系统");
        assert_eq!(
            serde_json::to_value(metric).unwrap()["state"],
            "unsupported"
        );
    }
}
