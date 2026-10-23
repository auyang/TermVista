use std::collections::HashMap;

use super::{
    delta::{CpuCounters, NetworkCounters},
    models::{DiskMetric, MemoryMetric},
};

const PROCESS_LIMIT: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessSample {
    pub pid: u32,
    pub command: String,
    pub cpu_ticks: u64,
    pub start_ticks: u64,
    pub ticks_per_second: u64,
    pub rss_bytes: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    MissingField(&'static str),
    InvalidField(&'static str),
    Overflow,
    InvalidRecord,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoadAverage {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

pub fn parse_proc_stat(input: &str) -> Result<CpuCounters, ParseError> {
    let line = input
        .lines()
        .find(|line| line.split_whitespace().next() == Some("cpu"))
        .ok_or(ParseError::MissingField("cpu"))?;
    let mut fields = line.split_whitespace();
    let _ = fields.next();
    let values = fields
        .map(|field| {
            field
                .parse::<u64>()
                .map_err(|_| ParseError::InvalidField("cpu"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() < 8 {
        return Err(ParseError::MissingField("cpu counters"));
    }
    Ok(CpuCounters {
        user: values[0],
        nice: values[1],
        system: values[2],
        idle: values[3],
        iowait: values[4],
        irq: values[5],
        softirq: values[6],
        steal: values[7],
    })
}

pub fn parse_meminfo(input: &str) -> Result<MemoryMetric, ParseError> {
    let mut values = HashMap::<&str, u64>::new();
    for line in input.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if !matches!(name, "MemTotal" | "MemAvailable" | "SwapTotal" | "SwapFree") {
            continue;
        }
        let mut fields = rest.split_whitespace();
        let Some(value) = fields.next() else {
            continue;
        };
        let value = value
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("meminfo value"))?;
        let unit = fields.next();
        if unit != Some("kB") || fields.next().is_some() {
            return Err(ParseError::InvalidField("meminfo unit"));
        }
        values.insert(name, value);
    }

    let total = mem_bytes(&values, "MemTotal")?;
    let available = mem_bytes(&values, "MemAvailable")?;
    let swap_total = mem_bytes(&values, "SwapTotal")?;
    let swap_free = mem_bytes(&values, "SwapFree")?;
    if total == 0 || available > total || swap_free > swap_total {
        return Err(ParseError::InvalidField("memory range"));
    }
    let used_percent = (total - available) as f64 * 100.0 / total as f64;
    let swap_used_percent =
        (swap_total > 0).then(|| (swap_total - swap_free) as f64 * 100.0 / swap_total as f64);
    Ok(MemoryMetric {
        total_bytes: total.to_string(),
        available_bytes: available.to_string(),
        used_percent,
        swap_total_bytes: swap_total.to_string(),
        swap_free_bytes: swap_free.to_string(),
        swap_used_percent,
    })
}

fn mem_bytes(values: &HashMap<&str, u64>, name: &'static str) -> Result<u64, ParseError> {
    values
        .get(name)
        .ok_or(ParseError::MissingField(name))?
        .checked_mul(1024)
        .ok_or(ParseError::Overflow)
}

pub fn parse_proc_net_dev(input: &str) -> Result<HashMap<String, NetworkCounters>, ParseError> {
    let mut lines = input.lines();
    let _ = lines.next();
    let _ = lines.next();
    let mut interfaces = HashMap::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let (name, counters) = line.split_once(':').ok_or(ParseError::InvalidRecord)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(ParseError::InvalidRecord);
        }
        let fields = counters
            .split_whitespace()
            .map(|field| {
                field
                    .parse::<u64>()
                    .map_err(|_| ParseError::InvalidField("network"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if fields.len() < 16 {
            return Err(ParseError::MissingField("network counters"));
        }
        if interfaces
            .insert(
                name.to_owned(),
                NetworkCounters {
                    rx_bytes: fields[0],
                    tx_bytes: fields[8],
                },
            )
            .is_some()
        {
            return Err(ParseError::InvalidRecord);
        }
    }
    if interfaces.is_empty() {
        return Err(ParseError::MissingField("network interfaces"));
    }
    Ok(interfaces)
}

pub fn parse_loadavg(input: &str) -> Result<LoadAverage, ParseError> {
    let fields = input.split_whitespace().take(3).collect::<Vec<_>>();
    if fields.len() < 3 {
        return Err(ParseError::MissingField("loadavg"));
    }
    let one = parse_finite_nonnegative(fields[0], "load1")?;
    let five = parse_finite_nonnegative(fields[1], "load5")?;
    let fifteen = parse_finite_nonnegative(fields[2], "load15")?;
    Ok(LoadAverage { one, five, fifteen })
}

pub fn parse_uptime(input: &str) -> Result<f64, ParseError> {
    let field = input
        .split_whitespace()
        .next()
        .ok_or(ParseError::MissingField("uptime"))?;
    parse_finite_nonnegative(field, "uptime")
}

fn parse_finite_nonnegative(input: &str, field: &'static str) -> Result<f64, ParseError> {
    let value = input
        .parse::<f64>()
        .map_err(|_| ParseError::InvalidField(field))?;
    if !value.is_finite() || value < 0.0 {
        return Err(ParseError::InvalidField(field));
    }
    Ok(value)
}

pub fn parse_processes(input: &str) -> Result<Vec<ProcessSample>, ParseError> {
    let mut processes = Vec::new();
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let (pid, rest) = take_field(line).ok_or(ParseError::InvalidRecord)?;
        let (ticks_per_second, rest) = take_field(rest).ok_or(ParseError::InvalidRecord)?;
        let (cpu_ticks, rest) = take_field(rest).ok_or(ParseError::InvalidRecord)?;
        let (start_ticks, rest) = take_field(rest).ok_or(ParseError::InvalidRecord)?;
        let (rss_kib, command) = take_field(rest).ok_or(ParseError::InvalidRecord)?;
        let command = command.trim().to_owned();
        let pid = pid
            .parse::<u32>()
            .map_err(|_| ParseError::InvalidField("pid"))?;
        let ticks_per_second = ticks_per_second
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("process clock ticks"))?;
        let cpu_ticks = cpu_ticks
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("process cpu ticks"))?;
        let start_ticks = start_ticks
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("process start time"))?;
        let rss_kib = rss_kib
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("process rss"))?;
        let rss_bytes = rss_kib.checked_mul(1024).ok_or(ParseError::Overflow)?;
        if pid == 0 || ticks_per_second == 0 || command.is_empty() {
            return Err(ParseError::InvalidRecord);
        }
        processes.push(ProcessSample {
            pid,
            command,
            cpu_ticks,
            start_ticks,
            ticks_per_second,
            rss_bytes: rss_bytes.to_string(),
        });
        if processes.len() == PROCESS_LIMIT {
            break;
        }
    }
    Ok(processes)
}

fn take_field(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    let end = input.find(char::is_whitespace)?;
    Some((&input[..end], input[end..].trim_start()))
}

pub fn parse_df(input: &str) -> Result<Vec<DiskMetric>, ParseError> {
    let mut disks = Vec::new();
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        if line.trim_start().starts_with("Filesystem") {
            continue;
        }
        let (filesystem, rest) = take_field(line).ok_or(ParseError::InvalidRecord)?;
        let (blocks, rest) = take_field(rest).ok_or(ParseError::MissingField("df blocks"))?;
        let (used, rest) = take_field(rest).ok_or(ParseError::MissingField("df used"))?;
        let (available, rest) = take_field(rest).ok_or(ParseError::MissingField("df available"))?;
        let (_capacity, mount_point) =
            take_field(rest).ok_or(ParseError::MissingField("df capacity"))?;
        let blocks = blocks
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("df blocks"))?;
        let _used = used
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("df used"))?;
        let available = available
            .parse::<u64>()
            .map_err(|_| ParseError::InvalidField("df available"))?;
        let mount_point = mount_point.trim();
        if mount_point.is_empty() || available > blocks {
            return Err(ParseError::InvalidRecord);
        }
        let total_bytes = blocks.checked_mul(1024).ok_or(ParseError::Overflow)?;
        let available_bytes = available.checked_mul(1024).ok_or(ParseError::Overflow)?;
        disks.push(DiskMetric {
            filesystem: filesystem.to_owned(),
            mount_point: mount_point.to_owned(),
            total_bytes: total_bytes.to_string(),
            available_bytes: available_bytes.to_string(),
        });
    }
    Ok(disks)
}

#[cfg(test)]
mod tests {
    use super::{
        LoadAverage, ParseError, parse_df, parse_loadavg, parse_meminfo, parse_proc_net_dev,
        parse_proc_stat, parse_processes, parse_uptime,
    };

    const STAT: &str = "cpu  100 20 30 400 10 5 8 2 3 1\ncpu0 1 2 3 4 5 6 7 8\n";
    const NET_DEV: &str = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n eth0: 300 4 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n";

    #[test]
    fn proc_stat_parses_the_eight_primary_counters_and_ignores_guest_fields() {
        let counters = parse_proc_stat(STAT).unwrap();
        assert_eq!(counters.user, 100);
        assert_eq!(counters.idle, 400);
        assert_eq!(counters.steal, 2);
    }

    #[test]
    fn proc_stat_rejects_missing_or_invalid_fields() {
        assert_eq!(
            parse_proc_stat("cpu0 1 2 3 4 5 6 7 8"),
            Err(ParseError::MissingField("cpu"))
        );
        assert_eq!(
            parse_proc_stat("cpu 1 2 nope 4 5 6 7 8"),
            Err(ParseError::InvalidField("cpu"))
        );
        assert_eq!(
            parse_proc_stat("cpu 1 2 3 4 5 6 7"),
            Err(ParseError::MissingField("cpu counters"))
        );
    }

    #[test]
    fn meminfo_converts_kib_and_handles_a_host_without_swap() {
        let input = "MemTotal: 4096 kB\nMemAvailable: 1024 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\nHugePages_Total: 0\n";
        let memory = parse_meminfo(input).unwrap();
        assert_eq!(memory.total_bytes, "4194304");
        assert_eq!(memory.available_bytes, "1048576");
        assert_eq!(memory.used_percent, 75.0);
        assert_eq!(memory.swap_used_percent, None);
    }

    #[test]
    fn meminfo_computes_swap_and_rejects_missing_units_ranges_and_overflow() {
        let swap = parse_meminfo(
            "MemTotal: 8192 kB\nMemAvailable: 4096 kB\nSwapTotal: 1024 kB\nSwapFree: 256 kB\n",
        )
        .unwrap();
        assert_eq!(swap.swap_used_percent, Some(75.0));
        assert_eq!(
            parse_meminfo("MemTotal: 1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"),
            Err(ParseError::MissingField("MemAvailable"))
        );
        assert_eq!(
            parse_meminfo(
                "MemTotal: 1 bytes\nMemAvailable: 0 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
            ),
            Err(ParseError::InvalidField("meminfo unit"))
        );
        assert_eq!(
            parse_meminfo("MemTotal: 1 kB\nMemAvailable: 2 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"),
            Err(ParseError::InvalidField("memory range"))
        );
        assert_eq!(
            parse_meminfo(
                "MemTotal: 18014398509481984 kB\nMemAvailable: 1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
            ),
            Err(ParseError::Overflow)
        );
    }

    #[test]
    fn proc_net_dev_parses_loopback_and_ethernet_counters() {
        let counters = parse_proc_net_dev(NET_DEV).unwrap();
        assert_eq!(counters["lo"].rx_bytes, 100);
        assert_eq!(counters["lo"].tx_bytes, 200);
        assert_eq!(counters["eth0"].rx_bytes, 300);
        assert_eq!(counters["eth0"].tx_bytes, 500);
    }

    #[test]
    fn proc_net_dev_rejects_incomplete_or_corrupt_rows() {
        assert_eq!(
            parse_proc_net_dev("Inter-| Receive | Transmit\n face |header\n"),
            Err(ParseError::MissingField("network interfaces"))
        );
        assert_eq!(
            parse_proc_net_dev("a\nb\neth0: 1 2\n"),
            Err(ParseError::MissingField("network counters"))
        );
        assert_eq!(
            parse_proc_net_dev("a\nb\neth0: 1 2 3 4 5 6 7 8 x 2 3 4 5 6 7 8\n"),
            Err(ParseError::InvalidField("network"))
        );
    }

    #[test]
    fn loadavg_and_uptime_parse_finite_nonnegative_values() {
        assert_eq!(
            parse_loadavg("0.11 0.22 0.33 1/200 1234").unwrap(),
            LoadAverage {
                one: 0.11,
                five: 0.22,
                fifteen: 0.33
            }
        );
        assert_eq!(
            parse_loadavg("0.1 0.2"),
            Err(ParseError::MissingField("loadavg"))
        );
        assert_eq!(
            parse_loadavg("NaN 0.2 0.3"),
            Err(ParseError::InvalidField("load1"))
        );
        assert_eq!(
            parse_loadavg("-1 0.2 0.3"),
            Err(ParseError::InvalidField("load1"))
        );
        assert_eq!(
            parse_uptime("3155760000000.5 1.0").unwrap(),
            3_155_760_000_000.5
        );
        assert_eq!(
            parse_uptime("inf 1"),
            Err(ParseError::InvalidField("uptime"))
        );
    }

    #[test]
    fn process_counters_parse_commands_with_spaces() {
        assert!(parse_processes("").unwrap().is_empty());
        let processes = parse_processes(
            "  42  100  125  999  512  worker process with spaces\n  7 100 0 100 0 systemd\n",
        )
        .unwrap();
        assert_eq!(processes[0].pid, 42);
        assert_eq!(processes[0].command, "worker process with spaces");
        assert_eq!(processes[0].cpu_ticks, 125);
        assert_eq!(processes[0].start_ticks, 999);
        assert_eq!(processes[0].ticks_per_second, 100);
        assert_eq!(processes[0].rss_bytes, "524288");
        assert_eq!(processes[1].rss_bytes, "0");
    }

    #[test]
    fn process_counters_reject_bad_values_and_bound_the_display_list() {
        assert_eq!(
            parse_processes("1 100 not-a-number 4 4 init"),
            Err(ParseError::InvalidField("process cpu ticks"))
        );
        let input = (1..=60)
            .map(|pid| format!("{pid} 100 0 100 1 process-{pid}\n"))
            .collect::<String>();
        assert_eq!(parse_processes(&input).unwrap().len(), 50);
    }

    #[test]
    fn df_converts_kib_and_preserves_mount_points_with_spaces() {
        let disks = parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 250 750 25% /\n/dev/data 2048 100 1948 5% /mnt/long mount path\n").unwrap();
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[1].mount_point, "/mnt/long mount path");
        assert_eq!(disks[1].total_bytes, "2097152");
        assert_eq!(disks[1].available_bytes, "1994752");
    }

    #[test]
    fn df_rejects_invalid_or_overflowed_capacity() {
        assert_eq!(
            parse_df(
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 10 4 11 110% /\n"
            ),
            Err(ParseError::InvalidRecord)
        );
        assert_eq!(
            parse_df("/dev/root nope 1 1 1% /\n"),
            Err(ParseError::InvalidField("df blocks"))
        );
        assert_eq!(
            parse_df("/dev/root 18014398509481984 1 1 1% /\n"),
            Err(ParseError::Overflow)
        );
    }
}
