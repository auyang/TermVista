use std::sync::LazyLock;

use regex::Regex;

static REDACTORS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?is)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*",
        r#"(?i)\b(password|passwd|token|secret|api[_-]?key|authorization|client[_-]?secret|cookie)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)"#,
        r"\bAKIA[0-9A-Z]{16}\b",
        r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b",
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("固定的脱敏规则必须有效"))
    .collect()
});

pub fn redact_sensitive_text(input: &str) -> (String, bool) {
    let mut redacted = input.to_owned();
    for rule in REDACTORS.iter() {
        if rule.is_match(&redacted) {
            redacted = rule
                .replace_all(&redacted, |captures: &regex::Captures<'_>| {
                    if captures.len() > 1 && captures.get(1).is_some() {
                        let prefix = captures.get(1).map_or("", |value| value.as_str());
                        let separator = captures.get(2).map_or("", |value| value.as_str());
                        format!("{prefix}{separator}[已脱敏]")
                    } else {
                        "[已脱敏]".to_owned()
                    }
                })
                .into_owned();
        }
    }
    let changed = redacted != input;
    (redacted, changed)
}

pub fn truncate_utf8(input: &str, max_bytes: usize) -> (String, bool) {
    if input.len() <= max_bytes {
        return (input.to_owned(), false);
    }
    let mut end = max_bytes.min(input.len());
    while !input.is_char_boundary(end) {
        end -= 1;
    }
    (input[..end].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::{redact_sensitive_text, truncate_utf8};

    #[test]
    fn redacts_common_credentials_without_claiming_perfection() {
        let input = "password=hunter2 Bearer abc.def AKIA1234567890ABCDEF eyJabcdefghijk.abcdefghijk.abcdefghijk";
        let (output, changed) = redact_sensitive_text(input);
        assert!(changed);
        assert!(!output.contains("hunter2"));
        assert!(!output.contains("abc.def"));
        assert!(!output.contains("AKIA1234567890ABCDEF"));
    }

    #[test]
    fn truncates_utf8_only_at_character_boundaries() {
        let (value, truncated) = truncate_utf8("你好世界", 7);
        assert!(truncated);
        assert_eq!(value, "你好");
        assert!(value.len() <= 7);
    }
}
