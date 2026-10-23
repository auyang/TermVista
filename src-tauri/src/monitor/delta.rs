use std::collections::HashMap;
use std::time::Duration;

use super::models::NetworkInterfaceMetric;

const MAX_NETWORK_DELTA_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuCounters {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

pub fn cpu_busy_percent(previous: CpuCounters, current: CpuCounters) -> Option<f64> {
    let deltas = [
        current.user.checked_sub(previous.user)?,
        current.nice.checked_sub(previous.nice)?,
        current.system.checked_sub(previous.system)?,
        current.idle.checked_sub(previous.idle)?,
        current.iowait.checked_sub(previous.iowait)?,
        current.irq.checked_sub(previous.irq)?,
        current.softirq.checked_sub(previous.softirq)?,
        current.steal.checked_sub(previous.steal)?,
    ];
    let total = deltas
        .iter()
        .try_fold(0_u64, |sum, delta| sum.checked_add(*delta))?;
    let idle = deltas[3].checked_add(deltas[4])?;
    if total == 0 || idle > total {
        return None;
    }
    let busy = (total - idle) as f64 * 100.0 / total as f64;
    (busy.is_finite() && (0.0..=100.0).contains(&busy)).then_some(busy)
}

pub fn network_rates(
    previous: &HashMap<String, NetworkCounters>,
    current: &HashMap<String, NetworkCounters>,
    elapsed: Duration,
) -> Vec<NetworkInterfaceMetric> {
    let elapsed_seconds = elapsed.as_secs_f64();
    let valid_interval = elapsed_seconds.is_finite()
        && elapsed_seconds > 0.0
        && elapsed <= MAX_NETWORK_DELTA_INTERVAL;
    let mut names = current.keys().cloned().collect::<Vec<_>>();
    names.sort_unstable();
    names
        .into_iter()
        .filter_map(|name| {
            let counters = current.get(&name)?;
            let rates = previous.get(&name).and_then(|old| {
                if !valid_interval {
                    return None;
                }
                let rx = counters.rx_bytes.checked_sub(old.rx_bytes)? as f64 / elapsed_seconds;
                let tx = counters.tx_bytes.checked_sub(old.tx_bytes)? as f64 / elapsed_seconds;
                (rx.is_finite() && tx.is_finite()).then_some((rx, tx))
            });
            Some(NetworkInterfaceMetric {
                name,
                rx_bytes_per_sec: rates.map(|(rx, _)| rx),
                tx_bytes_per_sec: rates.map(|(_, tx)| tx),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{CpuCounters, NetworkCounters, cpu_busy_percent, network_rates};
    use std::{collections::HashMap, time::Duration};

    #[test]
    fn cpu_delta_uses_eight_main_counters() {
        let previous = CpuCounters::default();
        let current = CpuCounters {
            user: 20,
            nice: 0,
            system: 20,
            idle: 40,
            iowait: 10,
            irq: 5,
            softirq: 5,
            steal: 0,
        };
        assert_eq!(cpu_busy_percent(previous, current), Some(50.0));
    }

    #[test]
    fn cpu_delta_rejects_zero_total_and_counter_rollback() {
        let sample = CpuCounters {
            user: 1,
            ..CpuCounters::default()
        };
        assert_eq!(cpu_busy_percent(sample, sample), None);
        assert_eq!(
            cpu_busy_percent(
                CpuCounters {
                    user: 2,
                    ..CpuCounters::default()
                },
                CpuCounters {
                    user: 1,
                    ..CpuCounters::default()
                }
            ),
            None
        );
    }

    #[test]
    fn network_first_sample_waits_and_later_rates_use_monotonic_duration() {
        let current = HashMap::from([(
            "eth0".to_owned(),
            NetworkCounters {
                rx_bytes: 2_000,
                tx_bytes: 4_000,
            },
        )]);
        assert_eq!(
            network_rates(&HashMap::new(), &current, Duration::from_secs(2))[0].rx_bytes_per_sec,
            None
        );
        let previous = HashMap::from([(
            "eth0".to_owned(),
            NetworkCounters {
                rx_bytes: 1_000,
                tx_bytes: 2_000,
            },
        )]);
        let result = network_rates(&previous, &current, Duration::from_secs(2));
        assert_eq!(result[0].rx_bytes_per_sec, Some(500.0));
        assert_eq!(result[0].tx_bytes_per_sec, Some(1_000.0));
    }

    #[test]
    fn network_counter_rollback_new_interface_and_zero_interval_have_no_rate() {
        let previous = HashMap::from([(
            "eth0".to_owned(),
            NetworkCounters {
                rx_bytes: 100,
                tx_bytes: 100,
            },
        )]);
        let current = HashMap::from([
            (
                "eth0".to_owned(),
                NetworkCounters {
                    rx_bytes: 1,
                    tx_bytes: 200,
                },
            ),
            (
                "ens5".to_owned(),
                NetworkCounters {
                    rx_bytes: 100,
                    tx_bytes: 100,
                },
            ),
        ]);
        let result = network_rates(&previous, &current, Duration::from_secs(1));
        assert!(
            result
                .iter()
                .all(|metric| metric.rx_bytes_per_sec.is_none())
        );
        assert!(
            result
                .iter()
                .all(|metric| metric.tx_bytes_per_sec.is_none())
        );

        let unchanged = network_rates(&previous, &current, Duration::ZERO);
        assert!(
            unchanged
                .iter()
                .all(|metric| metric.rx_bytes_per_sec.is_none())
        );
    }

    #[test]
    fn network_gap_over_sixty_seconds_discards_the_rate_baseline() {
        let previous = HashMap::from([(
            "eth0".to_owned(),
            NetworkCounters {
                rx_bytes: 100,
                tx_bytes: 200,
            },
        )]);
        let current = HashMap::from([(
            "eth0".to_owned(),
            NetworkCounters {
                rx_bytes: 1_100,
                tx_bytes: 2_200,
            },
        )]);
        let result = network_rates(&previous, &current, Duration::from_secs(61));
        assert_eq!(result[0].rx_bytes_per_sec, None);
        assert_eq!(result[0].tx_bytes_per_sec, None);
    }
}
