use std::{collections::HashSet, net::IpAddr, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::models::{AiProviderKind, ProviderConfig, ProviderModelOption};

const MAX_SSE_FRAME_BYTES: usize = 64 * 1024;
const MAX_STREAM_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_CONNECTION_TEST_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Default)]
pub struct ProviderUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub finish_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProviderError {
    pub code: &'static str,
    pub message: &'static str,
}

impl ProviderError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    async fn list_models(
        &self,
        config: &ProviderConfig,
        api_key: &str,
    ) -> Result<Vec<ProviderModelOption>, ProviderError> {
        let _ = (config, api_key);
        Err(ProviderError::new(
            "modelListUnsupported",
            "此模型服务暂不支持读取模型列表，请手动填写模型名称。",
        ))
    }

    async fn test_connection(
        &self,
        config: &ProviderConfig,
        api_key: &str,
    ) -> Result<(), ProviderError>;

    async fn stream_chat(
        &self,
        config: &ProviderConfig,
        api_key: &str,
        messages: &[ProviderMessage],
        cancellation: CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
        on_usage: &mut (dyn FnMut(ProviderUsage) + Send),
    ) -> Result<(), ProviderError>;
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    client: Client,
}

impl OpenAiCompatibleProvider {
    pub fn new() -> Result<Self, ProviderError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ProviderError::new("network", "无法初始化安全的模型网络客户端。"))?;
        Ok(Self { client })
    }

    fn endpoint(config: &ProviderConfig) -> Result<Url, ProviderError> {
        let base = Url::parse(config.base_url.trim())
            .map_err(|_| ProviderError::new("invalidProvider", "模型服务地址无效。"))?;
        if !matches!(base.scheme(), "https" | "http")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || (base.scheme() == "http" && !config.allow_insecure_http)
        {
            return Err(ProviderError::new(
                "invalidProvider",
                "模型地址必须是 HTTPS；明文 HTTP 需要单独确认，且不能包含账号、查询参数或片段。",
            ));
        }
        let path = format!("{}/chat/completions", base.path().trim_end_matches('/'));
        let mut endpoint = base;
        endpoint.set_path(&path);
        Ok(endpoint)
    }

    pub fn validate_endpoint(config: &ProviderConfig) -> Result<(), ProviderError> {
        Self::endpoint(config).map(|_| ())
    }

    fn status_error(status: StatusCode, kind: AiProviderKind) -> ProviderError {
        match status.as_u16() {
            401 | 403 if kind == AiProviderKind::Ollama => ProviderError::new(
                "accessDenied",
                "Ollama 服务拒绝了请求，请检查服务地址和访问控制。",
            ),
            401 | 403 => {
                ProviderError::new("authentication", "模型服务拒绝了凭据，请检查 API Key。")
            }
            408 | 504 => ProviderError::new("timeout", "模型服务响应超时。"),
            429 => ProviderError::new("rateLimited", "模型服务请求频率或额度受限，请稍后重试。"),
            300..=399 => ProviderError::new(
                "redirectBlocked",
                "模型服务返回重定向，出于安全考虑已阻止。",
            ),
            500..=599 => ProviderError::new("providerUnavailable", "模型服务暂时不可用。"),
            404 if kind == AiProviderKind::Ollama => ProviderError::new(
                "modelNotFound",
                "Ollama 未找到此模型；请检查模型名称或先在 Ollama 中下载模型。",
            ),
            404 => ProviderError::new(
                "endpointNotFound",
                "模型服务地址或 API 路径不存在，请检查服务商设置。",
            ),
            _ => ProviderError::new("providerRejected", "模型服务拒绝了请求，请检查服务商设置。"),
        }
    }

    fn request_error(error: &reqwest::Error) -> ProviderError {
        if error.is_timeout() {
            ProviderError::new("timeout", "模型服务响应超时。")
        } else if error.is_connect() {
            ProviderError::new("network", "无法连接到模型服务，请检查地址和网络。")
        } else {
            ProviderError::new("network", "模型网络请求失败。")
        }
    }

    fn with_optional_bearer(
        request: reqwest::RequestBuilder,
        api_key: &str,
    ) -> reqwest::RequestBuilder {
        if api_key.is_empty() {
            request
        } else {
            request.bearer_auth(api_key)
        }
    }

    async fn read_json_limited(
        response: reqwest::Response,
        max_bytes: usize,
    ) -> Result<Value, ProviderError> {
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(ProviderError::new(
                "invalidResponse",
                "模型服务返回了超出大小限制的响应。",
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| Self::request_error(&error))?;
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(ProviderError::new(
                    "invalidResponse",
                    "模型服务返回了超出大小限制的响应。",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ProviderError::new("invalidResponse", "模型服务返回了无效 JSON。"))
    }
}

#[async_trait]
impl ModelProvider for OpenAiCompatibleProvider {
    async fn list_models(
        &self,
        config: &ProviderConfig,
        api_key: &str,
    ) -> Result<Vec<ProviderModelOption>, ProviderError> {
        let endpoint = models_endpoint(config)?;
        let response = Self::with_optional_bearer(self.client.get(endpoint), api_key)
            .timeout(Duration::from_secs(config.timeout_seconds))
            .send()
            .await
            .map_err(|error| Self::request_error(&error))?;
        if !response.status().is_success() {
            return Err(Self::status_error(response.status(), config.kind));
        }
        let value = Self::read_json_limited(response, MAX_CONNECTION_TEST_BYTES).await?;
        let models = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::new("invalidResponse", "模型列表响应格式无效。"))?;
        let mut seen = HashSet::new();
        Ok(models
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .filter(|id| !id.is_empty() && seen.insert((*id).to_owned()))
            .map(|id| ProviderModelOption {
                id: id.to_owned(),
                streaming: None,
                tool_calling: None,
                structured_output: None,
            })
            .collect())
    }

    async fn test_connection(
        &self,
        config: &ProviderConfig,
        api_key: &str,
    ) -> Result<(), ProviderError> {
        let endpoint = Self::endpoint(config)?;
        let request = Self::with_optional_bearer(self.client.post(endpoint), api_key)
            .timeout(Duration::from_secs(config.timeout_seconds))
            .json(&json!({
                "model": config.model,
                "messages": [{"role": "user", "content": "Reply with OK."}],
                "stream": false,
                "max_tokens": 1
            }));
        let response = request
            .send()
            .await
            .map_err(|error| Self::request_error(&error))?;
        if !response.status().is_success() {
            return Err(Self::status_error(response.status(), config.kind));
        }
        let value = Self::read_json_limited(response, MAX_CONNECTION_TEST_BYTES).await?;
        if value
            .get("choices")
            .and_then(Value::as_array)
            .is_none_or(|choices| choices.is_empty())
        {
            return Err(ProviderError::new(
                "invalidResponse",
                "模型服务没有返回有效的连接测试结果。",
            ));
        }
        Ok(())
    }

    async fn stream_chat(
        &self,
        config: &ProviderConfig,
        api_key: &str,
        messages: &[ProviderMessage],
        cancellation: CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
        on_usage: &mut (dyn FnMut(ProviderUsage) + Send),
    ) -> Result<(), ProviderError> {
        let endpoint = Self::endpoint(config)?;
        let request = Self::with_optional_bearer(self.client.post(endpoint), api_key)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(Duration::from_secs(config.timeout_seconds))
            .json(&json!({
                "model": config.model,
                "messages": messages,
                "stream": true,
                "stream_options": { "include_usage": true }
            }));
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(ProviderError::new("cancelled", "请求已取消。")),
            result = request.send() => result.map_err(|error| Self::request_error(&error))?,
        };
        if !response.status().is_success() {
            return Err(Self::status_error(response.status(), config.kind));
        }

        let mut body = response.bytes_stream();
        let mut pending = Vec::new();
        let mut total_output = 0usize;
        let mut completion_seen = false;
        loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => return Err(ProviderError::new("cancelled", "请求已取消。")),
                value = body.next() => value,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|error| Self::request_error(&error))?;
            pending.extend_from_slice(&chunk);
            if pending.len() > MAX_SSE_FRAME_BYTES && find_frame_end(&pending).is_none() {
                return Err(ProviderError::new(
                    "responseTooLarge",
                    "模型流事件超过允许大小。",
                ));
            }
            while let Some((frame_end, consumed)) = find_frame_end(&pending) {
                if frame_end > MAX_SSE_FRAME_BYTES {
                    return Err(ProviderError::new(
                        "responseTooLarge",
                        "模型流事件超过允许大小。",
                    ));
                }
                let frame = String::from_utf8(pending[..frame_end].to_vec()).map_err(|_| {
                    ProviderError::new("invalidResponse", "模型流包含无效文本编码。")
                })?;
                pending.drain(..consumed);
                if let Some(update) = parse_sse_frame(&frame)? {
                    if let Some(delta) = update.delta {
                        total_output = total_output.saturating_add(delta.len());
                        if total_output > MAX_STREAM_OUTPUT_BYTES {
                            return Err(ProviderError::new(
                                "responseTooLarge",
                                "模型输出超过 1 MiB 上限。",
                            ));
                        }
                        on_delta(delta);
                    }
                    if update.usage.input_tokens.is_some()
                        || update.usage.output_tokens.is_some()
                        || update.usage.finish_reason.is_some()
                    {
                        on_usage(update.usage);
                    }
                    if update.done {
                        completion_seen = true;
                        break;
                    }
                }
            }
            if completion_seen {
                break;
            }
        }
        if !pending.is_empty() && !completion_seen {
            let frame = std::str::from_utf8(&pending)
                .map_err(|_| ProviderError::new("invalidResponse", "模型流包含无效文本编码。"))?;
            if let Some(update) = parse_sse_frame(frame)? {
                if let Some(delta) = update.delta {
                    total_output = total_output.saturating_add(delta.len());
                    if total_output > MAX_STREAM_OUTPUT_BYTES {
                        return Err(ProviderError::new(
                            "responseTooLarge",
                            "模型输出超过 1 MiB 上限。",
                        ));
                    }
                    on_delta(delta);
                }
                if update.usage.input_tokens.is_some()
                    || update.usage.output_tokens.is_some()
                    || update.usage.finish_reason.is_some()
                {
                    on_usage(update.usage);
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct StreamUpdate {
    delta: Option<String>,
    usage: ProviderUsage,
    done: bool,
}

fn find_frame_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let lf = bytes.windows(2).position(|window| window == b"\n\n");
    let crlf = bytes.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(lf), Some(crlf)) if crlf < lf => Some((crlf, crlf + 4)),
        (Some(lf), _) => Some((lf, lf + 2)),
        (None, Some(crlf)) => Some((crlf, crlf + 4)),
        (None, None) => None,
    }
}

fn parse_sse_frame(frame: &str) -> Result<Option<StreamUpdate>, ProviderError> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Ok(Some(StreamUpdate {
            done: true,
            ..StreamUpdate::default()
        }));
    }
    let value: Value = serde_json::from_str(&data)
        .map_err(|_| ProviderError::new("invalidResponse", "模型服务返回了无效的流式数据。"))?;
    if value.get("error").is_some() {
        return Err(ProviderError::new(
            "providerRejected",
            "模型服务在流式响应中返回了错误。",
        ));
    }
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let delta = choice
        .and_then(|item| item.get("delta"))
        .and_then(|value| value.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let finish_reason = choice
        .and_then(|item| item.get("finish_reason"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let usage = value.get("usage");
    Ok(Some(StreamUpdate {
        delta,
        usage: ProviderUsage {
            input_tokens: usage
                .and_then(|value| value.get("prompt_tokens"))
                .and_then(Value::as_u64),
            output_tokens: usage
                .and_then(|value| value.get("completion_tokens"))
                .and_then(Value::as_u64),
            finish_reason,
        },
        done: false,
    }))
}

#[derive(Clone)]
pub struct OllamaProvider {
    compatible: OpenAiCompatibleProvider,
}

impl OllamaProvider {
    pub fn new() -> Result<Self, ProviderError> {
        Ok(Self {
            compatible: OpenAiCompatibleProvider::new()?,
        })
    }

    pub fn validate_endpoint(config: &ProviderConfig) -> Result<(), ProviderError> {
        let normalized = Self::normalized_config(config)?;
        OpenAiCompatibleProvider::validate_endpoint(&normalized)
    }

    fn normalized_config(config: &ProviderConfig) -> Result<ProviderConfig, ProviderError> {
        let mut normalized = config.clone();
        let mut base = Url::parse(config.base_url.trim())
            .map_err(|_| ProviderError::new("invalidProvider", "Ollama 服务地址无效。"))?;
        if !matches!(base.scheme(), "https" | "http")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(ProviderError::new(
                "invalidProvider",
                "Ollama 地址需为有效 HTTP(S) URL，且不能包含账号、查询参数或片段。",
            ));
        }
        let loopback = is_loopback_host(base.host_str().unwrap_or_default());
        if base.scheme() == "http" && !loopback && !config.allow_insecure_http {
            return Err(ProviderError::new(
                "invalidProvider",
                "本机 Ollama 可使用回环 HTTP；远程 Ollama 的 HTTP 必须明确确认，建议改用 HTTPS。",
            ));
        }
        let path = base.path().trim_end_matches('/');
        if path.is_empty() {
            base.set_path("/v1");
        } else if !path.ends_with("/v1") {
            base.set_path(&format!("{path}/v1"));
        }
        normalized.base_url = base.to_string().trim_end_matches('/').to_owned();
        normalized.allow_insecure_http =
            base.scheme() == "http" && (loopback || config.allow_insecure_http);
        Ok(normalized)
    }

    fn native_api_endpoint(config: &ProviderConfig, route: &str) -> Result<Url, ProviderError> {
        let normalized = Self::normalized_config(config)?;
        let mut base = Url::parse(&normalized.base_url)
            .map_err(|_| ProviderError::new("invalidProvider", "Ollama 服务地址无效。"))?;
        let path = base.path().trim_end_matches("/v1").trim_end_matches('/');
        base.set_path(&format!("{path}{route}"));
        Ok(base)
    }

    async fn show_model_capabilities(
        &self,
        config: &ProviderConfig,
        model: &str,
    ) -> Option<HashSet<String>> {
        let endpoint = Self::native_api_endpoint(config, "/api/show").ok()?;
        let response = self
            .compatible
            .client
            .post(endpoint)
            .timeout(Duration::from_secs(config.timeout_seconds))
            .json(&json!({ "model": model, "verbose": false }))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let value =
            OpenAiCompatibleProvider::read_json_limited(response, MAX_CONNECTION_TEST_BYTES)
                .await
                .ok()?;
        value
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
    }
}

#[async_trait]
impl ModelProvider for OllamaProvider {
    async fn list_models(
        &self,
        config: &ProviderConfig,
        _api_key: &str,
    ) -> Result<Vec<ProviderModelOption>, ProviderError> {
        let normalized = Self::normalized_config(config)?;
        let endpoint = Self::native_api_endpoint(&normalized, "/api/tags")?;
        let response = self
            .compatible
            .client
            .get(endpoint)
            .timeout(Duration::from_secs(config.timeout_seconds))
            .send()
            .await
            .map_err(|error| OpenAiCompatibleProvider::request_error(&error))?;
        if !response.status().is_success() {
            return Err(OpenAiCompatibleProvider::status_error(
                response.status(),
                AiProviderKind::Ollama,
            ));
        }
        let value =
            OpenAiCompatibleProvider::read_json_limited(response, MAX_CONNECTION_TEST_BYTES)
                .await?;
        let models = value
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProviderError::new("invalidResponse", "Ollama 模型列表响应格式无效。")
            })?;
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        for item in models.iter().take(100) {
            let name = item
                .get("model")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str);
            if let Some(name) =
                name.filter(|name| !name.is_empty() && seen.insert((*name).to_owned()))
            {
                names.push(name.to_owned());
            }
        }

        let mut options = Vec::with_capacity(names.len());
        for id in names {
            let capabilities = self.show_model_capabilities(&normalized, &id).await;
            options.push(ProviderModelOption {
                id,
                streaming: Some(true),
                tool_calling: capabilities.map(|items| items.contains("tools")),
                structured_output: None,
            });
        }
        Ok(options)
    }

    async fn test_connection(
        &self,
        config: &ProviderConfig,
        _api_key: &str,
    ) -> Result<(), ProviderError> {
        let normalized = Self::normalized_config(config)?;
        self.compatible.test_connection(&normalized, "").await
    }

    async fn stream_chat(
        &self,
        config: &ProviderConfig,
        _api_key: &str,
        messages: &[ProviderMessage],
        cancellation: CancellationToken,
        on_delta: &mut (dyn FnMut(String) + Send),
        on_usage: &mut (dyn FnMut(ProviderUsage) + Send),
    ) -> Result<(), ProviderError> {
        let normalized = Self::normalized_config(config)?;
        self.compatible
            .stream_chat(&normalized, "", messages, cancellation, on_delta, on_usage)
            .await
    }
}

fn models_endpoint(config: &ProviderConfig) -> Result<Url, ProviderError> {
    let mut endpoint = Url::parse(config.base_url.trim())
        .map_err(|_| ProviderError::new("invalidProvider", "模型服务地址无效。"))?;
    let path = format!("{}/models", endpoint.path().trim_end_matches('/'));
    endpoint.set_path(&path);
    Ok(endpoint)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    use tokio_util::sync::CancellationToken;

    use super::{
        ModelProvider, OllamaProvider, OpenAiCompatibleProvider, ProviderConfig, ProviderMessage,
        ProviderUsage, find_frame_end, parse_sse_frame,
    };
    use crate::ai::models::AiProviderKind;

    fn local_config(address: std::net::SocketAddr) -> ProviderConfig {
        ProviderConfig {
            id: "local-test".to_owned(),
            name: "本地 SSE 测试".to_owned(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: format!("http://{address}/v1"),
            model: "test-model".to_owned(),
            timeout_seconds: 10,
            allow_insecure_http: true,
        }
    }

    async fn read_http_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 2048];
        loop {
            let count =
                tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                    .await
                    .expect("本地客户端连接及时")
                    .expect("读取本地请求成功");
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            let Some(header_end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or_default();
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    async fn read_request(stream: &mut TcpStream) {
        // 请求头只用于确保测试服务完整接收请求；测试不会打印或存储 Authorization。
        assert!(
            read_http_request(stream)
                .await
                .starts_with("POST /v1/chat/completions ")
        );
    }

    async fn accept_request(listener: &TcpListener) -> TcpStream {
        let (mut stream, _) = listener.accept().await.expect("接受本地测试连接");
        read_request(&mut stream).await;
        stream
    }

    #[test]
    fn parses_openai_sse_delta_usage_and_done_frames() {
        let text = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n";
        let (end, consumed) = find_frame_end(text.as_bytes()).expect("有 SSE 帧分隔符");
        let update = parse_sse_frame(&text[..end])
            .expect("帧有效")
            .expect("有数据");
        assert_eq!(update.delta.as_deref(), Some("你好"));
        assert_eq!(consumed, text.len());

        let usage = parse_sse_frame(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}",
        )
        .expect("usage 帧有效")
        .expect("有数据");
        assert_eq!(usage.usage.input_tokens, Some(2));
        assert_eq!(usage.usage.output_tokens, Some(3));
        assert!(
            parse_sse_frame("data: [DONE]")
                .expect("结束帧有效")
                .unwrap()
                .done
        );
    }

    #[test]
    fn recognizes_crlf_sse_boundaries() {
        assert_eq!(find_frame_end(b"data: x\r\n\r\nrest"), Some((7, 11)));
    }

    #[tokio::test]
    async fn streams_real_sse_deltas_from_a_local_http_mock() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 loopback mock");
        let address = listener.local_addr().expect("取得 mock 地址");
        let server = tokio::spawn(async move {
            let mut stream = accept_request(&listener).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("写入流式响应头");
            for frame in [
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                "data: [DONE]\n\n",
            ] {
                stream
                    .write_all(format!("{:X}\r\n{frame}\r\n", frame.len()).as_bytes())
                    .await
                    .expect("写入一个 SSE 分块");
                stream.flush().await.expect("刷新 SSE 分块");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            stream.write_all(b"0\r\n\r\n").await.expect("结束分块响应");
        });

        let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
        let config = local_config(address);
        let messages = vec![ProviderMessage {
            role: "user".to_owned(),
            content: "test".to_owned(),
        }];
        let output = Arc::new(Mutex::new(String::new()));
        let observed_usage = Arc::new(Mutex::new(ProviderUsage::default()));
        let output_for_delta = Arc::clone(&output);
        let usage_for_callback = Arc::clone(&observed_usage);
        let mut on_delta = move |text: String| output_for_delta.lock().unwrap().push_str(&text);
        let mut on_usage = move |usage: ProviderUsage| *usage_for_callback.lock().unwrap() = usage;
        provider
            .stream_chat(
                &config,
                "local-test-key",
                &messages,
                CancellationToken::new(),
                &mut on_delta,
                &mut on_usage,
            )
            .await
            .expect("本地 SSE 流式请求成功");
        server.await.expect("mock 服务完成");
        assert_eq!(output.lock().unwrap().as_str(), "hello world");
        let usage = observed_usage.lock().unwrap();
        assert_eq!(usage.input_tokens, Some(5));
        assert_eq!(usage.output_tokens, Some(2));
        assert_eq!(usage.finish_reason.as_deref(), Some("stop"));
    }

    #[tokio::test]
    async fn cancellation_drops_an_open_http_stream() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 loopback mock");
        let address = listener.local_addr().expect("取得 mock 地址");
        let server = tokio::spawn(async move {
            let mut stream = accept_request(&listener).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("写入响应头");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        });
        let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
        let config = local_config(address);
        let messages = vec![ProviderMessage {
            role: "user".to_owned(),
            content: "test".to_owned(),
        }];
        let cancellation = CancellationToken::new();
        let cancellation_for_timer = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            cancellation_for_timer.cancel();
        });
        let mut on_delta = |_| {};
        let mut on_usage = |_| {};
        let result = provider
            .stream_chat(
                &config,
                "local-test-key",
                &messages,
                cancellation,
                &mut on_delta,
                &mut on_usage,
            )
            .await;
        assert_eq!(result.unwrap_err().code, "cancelled");
        server.abort();
    }

    #[tokio::test]
    async fn maps_authentication_and_rate_limit_responses_without_body_details() {
        for (status, expected_code) in [(401, "authentication"), (429, "rateLimited")] {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("绑定 loopback mock");
            let address = listener.local_addr().expect("取得 mock 地址");
            let server = tokio::spawn(async move {
                let mut stream = accept_request(&listener).await;
                let status_text = if status == 401 {
                    "Unauthorized"
                } else {
                    "Too Many Requests"
                };
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} {status_text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("写入状态响应");
            });
            let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
            let error = provider
                .test_connection(&local_config(address), "local-test-key")
                .await
                .expect_err("错误状态应被分类");
            assert_eq!(error.code, expected_code);
            assert!(!error.message.contains("local-test-key"));
            server.await.expect("mock 服务完成");
        }
    }

    #[tokio::test]
    async fn connection_test_validates_a_real_model_response() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 loopback mock");
        let address = listener.local_addr().expect("取得 mock 地址");
        let server = tokio::spawn(async move {
            let mut stream = accept_request(&listener).await;
            let body = br#"{"choices":[{"message":{"content":"OK"}}]}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .expect("写入连接测试响应头");
            stream.write_all(body).await.expect("写入连接测试 JSON");
        });
        let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
        provider
            .test_connection(&local_config(address), "local-test-key")
            .await
            .expect("有效的 OpenAI 兼容响应通过连接测试");
        server.await.expect("mock 服务完成");
    }

    #[tokio::test]
    async fn ollama_model_discovery_reads_installed_models_and_capabilities_without_api_key() {
        use super::OllamaProvider;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 Ollama 协议测试服务");
        let address = listener.local_addr().expect("取得测试服务地址");
        let server = tokio::spawn(async move {
            let (mut tags_stream, _) = listener.accept().await.expect("接收模型列表请求");
            let tags_request = read_http_request(&mut tags_stream).await;
            assert!(tags_request.starts_with("GET /api/tags "));
            assert!(!tags_request.to_ascii_lowercase().contains("authorization:"));
            let tags = br#"{"models":[{"name":"qwen2.5:3b","model":"qwen2.5:3b"}] }"#;
            tags_stream
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", tags.len()).as_bytes())
                .await
                .expect("写入模型列表响应头");
            tags_stream.write_all(tags).await.expect("写入模型列表响应");

            let (mut show_stream, _) = listener.accept().await.expect("接收模型能力请求");
            let show_request = read_http_request(&mut show_stream).await;
            assert!(show_request.starts_with("POST /api/show "));
            assert!(show_request.contains("qwen2.5:3b"));
            assert!(!show_request.to_ascii_lowercase().contains("authorization:"));
            let capabilities = br#"{"capabilities":["completion","tools"]}"#;
            show_stream
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", capabilities.len()).as_bytes())
                .await
                .expect("写入能力响应头");
            show_stream
                .write_all(capabilities)
                .await
                .expect("写入能力响应");
        });

        let provider = OllamaProvider::new().expect("构造 Ollama provider");
        let config = ProviderConfig {
            id: "ollama-local-test".to_owned(),
            name: "Ollama loopback 测试".to_owned(),
            kind: AiProviderKind::Ollama,
            base_url: format!("http://{address}"),
            model: "qwen2.5:3b".to_owned(),
            timeout_seconds: 10,
            allow_insecure_http: false,
        };
        let models = provider
            .list_models(&config, "must-not-be-sent")
            .await
            .expect("读取 Ollama 模型");
        server.await.expect("协议服务完成");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen2.5:3b");
        assert_eq!(models[0].streaming, Some(true));
        assert_eq!(models[0].tool_calling, Some(true));
    }

    #[tokio::test]
    async fn unavailable_local_ollama_returns_a_clear_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定临时回环端口");
        let address = listener.local_addr().expect("读取临时端口");
        drop(listener);
        let mut config = local_config(address);
        config.kind = AiProviderKind::Ollama;
        config.base_url = format!("http://{address}");
        let provider = OllamaProvider::new().expect("构造 Ollama provider");

        let error = provider
            .list_models(&config, "")
            .await
            .expect_err("没有监听服务时不能返回模型列表");

        assert_eq!(error.code, "network");
        assert!(error.message.contains("无法连接到模型服务"));
    }

    #[tokio::test]
    async fn redirect_responses_are_rejected_without_following_them() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 loopback mock");
        let address = listener.local_addr().expect("取得 mock 地址");
        let server = tokio::spawn(async move {
            let mut stream = accept_request(&listener).await;
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/collect\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("写入重定向响应");
        });
        let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
        let error = provider
            .test_connection(&local_config(address), "local-test-key")
            .await
            .expect_err("重定向必须拒绝");
        assert_eq!(error.code, "redirectBlocked");
        server.await.expect("mock 服务完成");
    }

    #[tokio::test]
    async fn connection_test_reports_body_timeouts() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 loopback mock");
        let address = listener.local_addr().expect("取得 mock 地址");
        let server = tokio::spawn(async move {
            let mut stream = accept_request(&listener).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 40\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("写入响应头");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        });
        let provider = OpenAiCompatibleProvider::new().expect("构造 Provider");
        let mut config = local_config(address);
        config.timeout_seconds = 3;
        let error = provider
            .test_connection(&config, "local-test-key")
            .await
            .expect_err("响应体读取应受总超时约束");
        assert_eq!(error.code, "timeout");
        server.abort();
    }
}
