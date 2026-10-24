use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_CONFIG_FILES: usize = 32;
const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigPreview {
    pub source_path: String,
    pub entries: Vec<SshConfigPreviewEntry>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigPreviewEntry {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<String>,
    pub identities_only: Option<bool>,
    pub proxy_jump: Option<String>,
    pub local_forwards: Vec<SshConfigLocalForward>,
    pub dynamic_forwards: Vec<SshConfigDynamicForward>,
    pub importable: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigLocalForward {
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigDynamicForward {
    pub bind_host: String,
    pub bind_port: u16,
}

#[derive(Clone, Debug)]
struct Directive {
    key: String,
    value: String,
    location: String,
}

#[derive(Clone, Debug, Default)]
struct Section {
    patterns: Option<Vec<String>>,
    unsupported_match: bool,
    directives: Vec<Directive>,
}

#[derive(Default)]
struct Parser {
    sections: Vec<Section>,
    current_section: usize,
    aliases: Vec<String>,
    warnings: Vec<String>,
    seen_files: HashSet<PathBuf>,
    file_count: usize,
    total_bytes: usize,
    root_dir: PathBuf,
}

impl Parser {
    fn new(root_dir: PathBuf) -> Self {
        Self {
            sections: vec![Section::default()],
            root_dir,
            ..Self::default()
        }
    }

    fn parse_file(&mut self, path: &Path, depth: usize) -> Result<(), String> {
        if depth > MAX_INCLUDE_DEPTH {
            self.warnings.push(format!(
                "Include 嵌套超过 {MAX_INCLUDE_DEPTH} 层，已停止继续读取。"
            ));
            return Ok(());
        }
        let canonical = match fs::canonicalize(path) {
            Ok(path) => path,
            Err(error) => {
                self.warnings
                    .push(format!("无法读取 Include 文件 {}：{error}", path.display()));
                return Ok(());
            }
        };
        if !canonical.starts_with(&self.root_dir) {
            self.warnings.push(format!(
                "Include 文件 {} 位于所选配置目录之外，已跳过。",
                canonical.display()
            ));
            return Ok(());
        }
        if !self.seen_files.insert(canonical.clone()) {
            self.warnings.push(format!(
                "检测到重复或循环 Include：{}。",
                canonical.display()
            ));
            return Ok(());
        }
        self.file_count += 1;
        if self.file_count > MAX_CONFIG_FILES {
            self.warnings.push(format!(
                "Include 文件数量超过 {MAX_CONFIG_FILES} 个，已停止继续读取。"
            ));
            return Ok(());
        }
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("无法读取 SSH Config 文件：{error}"))?;
        if !metadata.is_file() {
            self.warnings
                .push(format!("配置路径 {} 不是普通文件。", canonical.display()));
            return Ok(());
        }
        let remaining = MAX_CONFIG_BYTES.saturating_sub(self.total_bytes);
        if usize::try_from(metadata.len()).unwrap_or(usize::MAX) > remaining {
            self.warnings.push(format!(
                "配置文件总大小超过 {} KiB，超出部分未读取。",
                MAX_CONFIG_BYTES / 1024
            ));
            return Ok(());
        }
        let contents = fs::read_to_string(&canonical)
            .map_err(|error| format!("无法读取 SSH Config 文件：{error}"))?;
        self.total_bytes = self.total_bytes.saturating_add(contents.len());

        for (line_number, line) in contents.lines().enumerate() {
            let location = format!("{}:{}", canonical.display(), line_number + 1);
            let mut words = parse_words(line);
            if words.is_empty() {
                continue;
            }
            if let Some((key, value)) = words[0].split_once('=') {
                let key = key.to_owned();
                let value = value.to_owned();
                words.splice(0..1, [key, value]);
            }
            let key = words[0].to_ascii_lowercase();
            let values = &words[1..];
            match key.as_str() {
                "host" => {
                    if values.is_empty() {
                        self.warnings
                            .push(format!("{location}：Host 缺少主机模式。"));
                        self.current_section = self.push_section(Section {
                            patterns: Some(Vec::new()),
                            ..Section::default()
                        });
                        continue;
                    }
                    let patterns = values.to_vec();
                    for alias in &patterns {
                        if is_static_alias(alias)
                            && !self
                                .aliases
                                .iter()
                                .any(|existing| existing.eq_ignore_ascii_case(alias))
                        {
                            self.aliases.push(alias.clone());
                        } else if !is_static_alias(alias) {
                            self.warnings.push(format!(
                                "{location}：Host 模式“{alias}”不是具体主机，不能作为连接导入。"
                            ));
                        }
                    }
                    self.current_section = self.push_section(Section {
                        patterns: Some(patterns),
                        ..Section::default()
                    });
                }
                "match" => {
                    let condition = values.join(" ");
                    self.warnings.push(format!(
                        "{location}：Match 条件“{condition}”需要运行时判断，预览中不会执行或导入该区段。"
                    ));
                    self.current_section = self.push_section(Section {
                        unsupported_match: true,
                        ..Section::default()
                    });
                }
                "include" => {
                    if values.is_empty() {
                        self.warnings
                            .push(format!("{location}：Include 缺少路径。"));
                        continue;
                    }
                    for include in values {
                        if include.contains('%') || include.starts_with('$') {
                            self.warnings
                                .push(format!("{location}：Include 路径含动态 token，未读取。"));
                            continue;
                        }
                        let Some(pattern) = expand_include_path(include, &self.root_dir) else {
                            self.warnings
                                .push(format!("{location}：Include 路径无法识别，未读取。"));
                            continue;
                        };
                        let remaining_files = MAX_CONFIG_FILES.saturating_sub(self.file_count);
                        let paths = match glob::glob(&pattern.to_string_lossy()) {
                            Ok(paths) => paths
                                .take(remaining_files.saturating_add(1))
                                .filter_map(Result::ok)
                                .collect::<Vec<_>>(),
                            Err(error) => {
                                self.warnings
                                    .push(format!("{location}：Include 模式无效：{error}。"));
                                continue;
                            }
                        };
                        let mut paths = paths;
                        if paths.len() > remaining_files {
                            self.warnings.push(format!(
                                "{location}：Include 匹配文件超过数量上限，只检查前 {} 个。",
                                remaining_files
                            ));
                            paths.truncate(remaining_files);
                        }
                        paths.sort();
                        if paths.is_empty() {
                            self.warnings
                                .push(format!("{location}：Include 模式“{include}”没有匹配文件。"));
                        }
                        for included in paths {
                            self.parse_file(&included, depth + 1)?;
                        }
                    }
                }
                _ => {
                    if !values.is_empty() {
                        self.sections[self.current_section]
                            .directives
                            .push(Directive {
                                key,
                                value: values.join(" "),
                                location,
                            });
                    } else {
                        self.warnings
                            .push(format!("{location}：配置项缺少值，已忽略。"));
                    }
                }
            }
        }
        Ok(())
    }

    fn push_section(&mut self, section: Section) -> usize {
        self.sections.push(section);
        self.sections.len() - 1
    }

    fn preview(self, source_path: String) -> SshConfigPreview {
        let mut entries = Vec::new();
        for alias in self.aliases {
            let mut hostname = None;
            let mut username = None;
            let mut port = None;
            let mut identity_files = Vec::new();
            let mut identities_only = None;
            let mut proxy_jump = None;
            let mut local_forwards = Vec::new();
            let mut dynamic_forwards = Vec::new();
            let mut entry_warnings = Vec::new();
            let mut invalid_entry = false;

            for section in &self.sections {
                if section.unsupported_match
                    || section
                        .patterns
                        .as_ref()
                        .is_some_and(|patterns| !host_patterns_match(patterns, &alias))
                {
                    continue;
                }
                for directive in &section.directives {
                    match directive.key.as_str() {
                        "hostname" if hostname.is_none() => {
                            hostname = Some(directive.value.clone())
                        }
                        "user" if username.is_none() => username = Some(directive.value.clone()),
                        "port" if port.is_none() => {
                            port = Some(
                                directive
                                    .value
                                    .parse::<u16>()
                                    .ok()
                                    .filter(|value| *value > 0),
                            );
                            if port == Some(None) {
                                invalid_entry = true;
                                entry_warnings.push(format!(
                                    "{}：Port“{}”无效。",
                                    directive.location, directive.value
                                ));
                            }
                        }
                        "identityfile" if !directive.value.eq_ignore_ascii_case("none") => {
                            identity_files.push((&directive.value, &directive.location))
                        }
                        "identityfile" => {}
                        "identitiesonly" if identities_only.is_none() => {
                            identities_only = parse_boolean(&directive.value);
                        }
                        "proxyjump" if proxy_jump.is_none() => {
                            proxy_jump = Some(directive.value.clone());
                        }
                        "localforward" => match parse_local_forward(&directive.value) {
                            Some(forward) => local_forwards.push(forward),
                            None => entry_warnings.push(format!(
                                "{}：LocalForward 格式无效或监听地址不是 127.0.0.1，已跳过。",
                                directive.location
                            )),
                        },
                        "dynamicforward" => match parse_dynamic_forward(&directive.value) {
                            Some(forward) => dynamic_forwards.push(forward),
                            None => entry_warnings.push(format!(
                                "{}：DynamicForward 格式无效或监听地址不是 127.0.0.1，已跳过。",
                                directive.location
                            )),
                        },
                        "proxycommand" => entry_warnings.push(format!(
                            "{}：ProxyCommand 已识别，但不会执行，也不会写入连接配置。",
                            directive.location
                        )),
                        "hostname" | "user" | "port" | "identitiesonly" | "proxyjump" => {}
                        _ => {
                            entry_warnings.push(format!(
                                "{}：暂不导入配置项 {}。",
                                directive.location, directive.key
                            ));
                        }
                    }
                }
            }

            let proxy_jump = proxy_jump.filter(|jump| !jump.eq_ignore_ascii_case("none"));
            if let Some(jump) = proxy_jump.as_ref()
                && !is_proxy_jump_alias(jump)
            {
                invalid_entry = true;
                entry_warnings.push(format!(
                    "ProxyJump“{jump}”不是单个静态主机别名；只支持单跳别名，不会执行 ProxyCommand。"
                ));
            }
            if identities_only.is_some() {
                entry_warnings.push(
                    "IdentitiesOnly 已识别；当前连接只使用显式选择的私钥，不保留此 SSH 选项。"
                        .to_owned(),
                );
            }
            let hostname = hostname.unwrap_or_else(|| alias.clone());
            if hostname.contains('%') || hostname.chars().any(char::is_control) {
                invalid_entry = true;
                entry_warnings
                    .push("HostName 含动态 token 或控制字符，当前无法静态导入。".to_owned());
            }
            let username = username.unwrap_or_else(|| "未设置".to_owned());
            if username.contains('%') || username.chars().any(char::is_control) {
                invalid_entry = true;
                entry_warnings.push("User 含动态 token 或控制字符，当前无法静态导入。".to_owned());
            }
            let port = port.flatten().unwrap_or(22);
            let identity_file = identity_files
                .first()
                .map(|(value, _)| expand_identity_path(value, &self.root_dir));
            if identity_files.len() > 1 {
                entry_warnings
                    .push("匹配到多个 IdentityFile；连接配置仅保留第一条路径。".to_owned());
            }
            if let Some((identity, location)) = identity_files.first()
                && (identity.contains('%')
                    || identity.contains(['*', '?'])
                    || (identity.starts_with('~') && !identity.starts_with("~/")))
            {
                entry_warnings.push(format!(
                    "{location}：IdentityFile 含当前无法静态解析的 token 或文件匹配模式。"
                ));
            }
            let importable = !invalid_entry
                && identity_files.first().is_none_or(|(identity, _)| {
                    !identity.contains(['%', '*', '?'])
                        && (!identity.starts_with('~') || identity.starts_with("~/"))
                });
            entries.push(SshConfigPreviewEntry {
                alias,
                hostname,
                port,
                username,
                identity_file,
                identities_only,
                proxy_jump,
                local_forwards,
                dynamic_forwards,
                importable,
                warnings: deduplicate_warnings(entry_warnings),
            });
        }
        SshConfigPreview {
            source_path,
            entries,
            warnings: deduplicate_warnings(self.warnings),
        }
    }
}

fn parse_local_forward(value: &str) -> Option<SshConfigLocalForward> {
    let words = parse_words(value);
    if words.len() != 2 {
        return None;
    }
    let (bind_host, bind_port) = parse_loopback_bind(&words[0])?;
    let (target_host, target_port) = parse_host_port(&words[1])?;
    let mut normalized = crate::tunnels::models::ForwardRule {
        id: "ssh-config-preview".to_owned(),
        profile_id: "ssh-config-preview".to_owned(),
        name: "SSH Config preview".to_owned(),
        group_name: String::new(),
        local_host: bind_host.clone(),
        local_port: u32::from(bind_port),
        target_host,
        target_port: u32::from(target_port),
        created_at: 0,
        updated_at: 0,
    };
    normalized.validate_and_normalize().ok()?;
    Some(SshConfigLocalForward {
        bind_host,
        bind_port,
        target_host: normalized.target_host,
        target_port,
    })
}

fn parse_dynamic_forward(value: &str) -> Option<SshConfigDynamicForward> {
    let words = parse_words(value);
    if words.len() != 1 {
        return None;
    }
    let (bind_host, bind_port) = parse_loopback_bind(&words[0])?;
    Some(SshConfigDynamicForward {
        bind_host,
        bind_port,
    })
}

fn parse_loopback_bind(value: &str) -> Option<(String, u16)> {
    if let Ok(port) = value.parse::<u16>() {
        return (port > 0).then(|| ("127.0.0.1".to_owned(), port));
    }
    let (host, port) = parse_host_port(value)?;
    if host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") {
        Some(("127.0.0.1".to_owned(), port))
    } else {
        None
    }
}

fn parse_host_port(value: &str) -> Option<(String, u16)> {
    let (host, raw_port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        let raw_port = rest.strip_prefix(':')?;
        (host, raw_port)
    } else {
        value.rsplit_once(':')?
    };
    let port = raw_port.parse::<u16>().ok().filter(|port| *port > 0)?;
    let host = host.trim();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return None;
    }
    Some((host.to_owned(), port))
}

pub fn preview(path: &Path) -> Result<SshConfigPreview, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("无法打开 SSH Config 文件：{error}"))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("无法读取 SSH Config 文件：{error}"))?;
    if !metadata.is_file() {
        return Err("所选 SSH Config 路径不是普通文件。".to_owned());
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err("SSH Config 文件不能超过 1 MiB。".to_owned());
    }
    let root_dir = canonical
        .parent()
        .ok_or_else(|| "无法识别 SSH Config 所在目录。".to_owned())?
        .to_path_buf();
    let mut parser = Parser::new(root_dir);
    parser.parse_file(&canonical, 0)?;
    Ok(parser.preview(canonical.display().to_string()))
}

fn parse_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;
    for character in line.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            started = true;
            continue;
        }
        match (quote, character) {
            (Some(_), '\\') => escaped = true,
            (Some(expected), actual) if expected == actual => quote = None,
            (Some(_), value) => current.push(value),
            (None, '\\') => escaped = true,
            (None, '\'' | '"') => {
                quote = Some(character);
                started = true;
            }
            (None, '#') => break,
            (None, value) if value.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, value) => {
                current.push(value);
                started = true;
            }
        }
    }
    if escaped {
        current.push('\\');
    }
    if started {
        words.push(current);
    }
    words
}

fn expand_include_path(value: &str, root_dir: &Path) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    if let Some(suffix) = value.strip_prefix("~/") {
        return Some(home_dir()?.join(suffix));
    }
    if value.starts_with('~') {
        return None;
    }
    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        root_dir.join(path)
    })
}

fn expand_identity_path(value: &str, root_dir: &Path) -> String {
    if value == "~" {
        return home_dir()
            .map(|home| home.display().to_string())
            .unwrap_or_else(|| value.to_owned());
    }
    if let Some(suffix) = value.strip_prefix("~/") {
        return home_dir()
            .map(|home| home.join(suffix).display().to_string())
            .unwrap_or_else(|| value.to_owned());
    }
    if value.contains('%') {
        return value.to_owned();
    }
    if value.starts_with('~') && !value.starts_with("~/") {
        return value.to_owned();
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return root_dir.join(path).display().to_string();
    }
    value.to_owned()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn is_static_alias(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('!')
        && !value.contains(['*', '?', '%', '/', '\\'])
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn is_proxy_jump_alias(value: &str) -> bool {
    is_static_alias(value) && !value.contains(['@', ':', ','])
}

fn host_patterns_match(patterns: &[String], host: &str) -> bool {
    let mut has_positive = false;
    let mut positive_match = false;
    let mut negative_match = false;
    for pattern in patterns {
        if let Some(negative) = pattern.strip_prefix('!') {
            if wildcard_match(negative, host) {
                negative_match = true;
            }
        } else {
            has_positive = true;
            if wildcard_match(pattern, host) {
                positive_match = true;
            }
        }
    }
    !negative_match && if has_positive { positive_match } else { true }
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase().chars().collect::<Vec<_>>();
    let value = value.to_ascii_lowercase().chars().collect::<Vec<_>>();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for pattern_character in pattern {
        let mut next = vec![false; value.len() + 1];
        if pattern_character == '*' {
            next[0] = previous[0];
            for index in 1..=value.len() {
                next[index] = previous[index] || next[index - 1];
            }
        } else {
            for index in 1..=value.len() {
                next[index] = previous[index - 1]
                    && (pattern_character == '?' || pattern_character == value[index - 1]);
            }
        }
        previous = next;
    }
    previous[value.len()]
}

fn parse_boolean(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" => Some(true),
        "no" | "false" | "0" => Some(false),
        _ => None,
    }
}

fn deduplicate_warnings(warnings: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    warnings
        .into_iter()
        .filter(|warning| seen.insert(warning.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use uuid::Uuid;

    use super::{host_patterns_match, parse_words, preview};

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("termvista-ssh-config-{}", Uuid::new_v4()))
    }

    #[test]
    fn parses_host_include_identityfile_match_and_ignores_commands() {
        let directory = temp_dir();
        fs::create_dir_all(directory.join("config.d")).unwrap();
        let command_target = directory.join("should-not-run");
        fs::write(
            directory.join("config"),
            format!("User default-user\nInclude config.d/*\nHost *.corp\n  User corp-user\n  ProxyCommand touch {}\nHost app.corp\n  HostName 10.0.0.8\n  IdentityFile \"~/.ssh/team key\"\n  IdentitiesOnly yes\nMatch exec \"true\"\n  User ignored\n", command_target.display()),
        )
        .unwrap();
        fs::write(
            directory.join("config.d/extra"),
            "Host app.corp\n  Port 2202\nHost *.corp\n  IdentityFile ~/.ssh/default_key\n",
        )
        .unwrap();

        let result = preview(&directory.join("config")).unwrap();
        assert_eq!(result.entries.len(), 1);
        let app = &result.entries[0];
        assert_eq!(app.alias, "app.corp");
        assert_eq!(app.hostname, "10.0.0.8");
        assert_eq!(app.username, "default-user");
        assert_eq!(app.port, 2202);
        assert!(
            app.identity_file
                .as_deref()
                .unwrap()
                .ends_with("default_key")
        );
        assert!(
            app.warnings
                .iter()
                .any(|warning| warning.contains("多个 IdentityFile"))
        );
        assert_eq!(app.identities_only, Some(true));
        assert!(
            app.warnings
                .iter()
                .any(|warning| warning.contains("ProxyCommand"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("Match"))
        );
        assert!(!command_target.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn skips_wildcard_alias_and_external_include() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).unwrap();
        let outside = directory.with_extension("outside");
        fs::write(&outside, "Host outside\n HostName 192.0.2.1\n").unwrap();
        fs::write(
            directory.join("config"),
            format!(
                "Include {}\nHost *.corp\n User corp\nHost build-1\n HostName build.example\n",
                outside.display()
            ),
        )
        .unwrap();
        let result = preview(&directory.join("config")).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].alias, "build-1");
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("目录之外"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("不是具体主机"))
        );
        fs::remove_dir_all(directory).unwrap();
        fs::remove_file(outside).unwrap();
    }

    #[test]
    fn parses_quoted_values_and_applies_negative_host_patterns() {
        assert_eq!(
            parse_words("IdentityFile \"~/.ssh/a b\" # comment"),
            ["IdentityFile", "~/.ssh/a b"]
        );
        assert!(host_patterns_match(
            &["*.corp".to_owned(), "!bad.corp".to_owned()],
            "app.corp"
        ));
        assert!(!host_patterns_match(
            &["*.corp".to_owned(), "!bad.corp".to_owned()],
            "bad.corp"
        ));
        assert!(host_patterns_match(&["!bad.corp".to_owned()], "good.corp"));
    }

    #[test]
    fn parses_equals_syntax_without_modifying_source_config() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).unwrap();
        let config_path = directory.join("config");
        let config = "Host=web\nHostName=web.example.test\nUser=deploy\nPort=2222\n";
        fs::write(&config_path, config).unwrap();
        let result = preview(&config_path).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].hostname, "web.example.test");
        assert_eq!(result.entries[0].username, "deploy");
        assert_eq!(result.entries[0].port, 2222);
        assert_eq!(fs::read_to_string(&config_path).unwrap(), config);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn imports_only_one_static_proxyjump_alias_and_rejects_multi_hop() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).unwrap();
        let config_path = directory.join("config");
        fs::write(
            &config_path,
            "Host gateway\n HostName gateway.example.test\nHost app\n HostName app.internal\n ProxyJump gateway\nHost multi\n HostName multi.internal\n ProxyJump gateway,backup\n",
        )
        .unwrap();
        let result = preview(&config_path).unwrap();
        let app = result
            .entries
            .iter()
            .find(|entry| entry.alias == "app")
            .unwrap();
        assert_eq!(app.proxy_jump.as_deref(), Some("gateway"));
        assert!(app.importable);
        let multi = result
            .entries
            .iter()
            .find(|entry| entry.alias == "multi")
            .unwrap();
        assert!(!multi.importable);
        assert!(
            multi
                .warnings
                .iter()
                .any(|warning| warning.contains("單跳") || warning.contains("单跳"))
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn imports_loopback_localforward_and_dynamicforward_but_skips_external_binds() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).unwrap();
        let config_path = directory.join("config");
        fs::write(
            &config_path,
            "Host app\n HostName app.example.test\n LocalForward 127.0.0.1:13306 127.0.0.1:3306\n LocalForward 0.0.0.0:9000 app.internal:9000\n DynamicForward 1080\n DynamicForward 0.0.0.0:1081\n",
        )
        .unwrap();

        let preview = preview(&config_path).unwrap();
        let entry = &preview.entries[0];
        assert_eq!(entry.local_forwards.len(), 1);
        assert_eq!(entry.local_forwards[0].bind_host, "127.0.0.1");
        assert_eq!(entry.local_forwards[0].bind_port, 13_306);
        assert_eq!(entry.local_forwards[0].target_host, "127.0.0.1");
        assert_eq!(entry.local_forwards[0].target_port, 3_306);
        assert_eq!(entry.dynamic_forwards.len(), 1);
        assert_eq!(entry.dynamic_forwards[0].bind_port, 1_080);
        assert_eq!(entry.warnings.len(), 2);
        fs::remove_dir_all(directory).unwrap();
    }
}
