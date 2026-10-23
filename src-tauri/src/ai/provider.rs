use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::models::ProviderConfig;

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

    fn status_error(status: StatusCode) -> ProviderError {
        match status.as_u16() {
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
}

#[async_trait]
impl ModelProvider for OpenAiCompatibleProvider {
    async fn test_connection(
        &self,
        config: &ProviderConfig,
        api_key: &str,
    ) -> Result<(), ProviderError> {
        let endpoint = Self::endpoint(config)?;
        let request = self
            .client
            .post(endpoint)
            .bearer_auth(api_key)
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
            return Err(Self::status_error(response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CONNECTION_TEST_BYTES as u64)
        {
            return Err(ProviderError::new(
                "invalidResponse",
                "模型连接测试返回了超出大小限制的响应。",
            ));
        }
        let mut response_stream = response.bytes_stream();
        let mut response_body = Vec::new();
        while let Some(chunk) = response_stream.next().await {
            let chunk = chunk.map_err(|error| Self::request_error(&error))?;
            if response_body.len().saturating_add(chunk.len()) > MAX_CONNECTION_TEST_BYTES {
                return Err(ProviderError::new(
                    "invalidResponse",
                    "模型连接测试返回了超出大小限制的响应。",
                ));
            }
            response_body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&response_body)
            .map_err(|_| ProviderError::new("invalidResponse", "模型服务返回了无效的测试响应。"))?;
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
        let request = self
            .client
            .post(endpoint)
            .bearer_auth(api_key)
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
            return Err(Self::status_error(response.status()));
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

#[derive(Clone, Copy)]
pub struct ReservedOllamaProvider;

impl ReservedOllamaProvider {
    pub fn unsupported(&self) -> ProviderError {
        ProviderError::new(
            "unsupportedProvider",
            "Ollama 适配器已预留，尚未在 Phase 3A 启用。",
        )
    }
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
        ModelProvider, OpenAiCompatibleProvider, ProviderConfig, ProviderMessage, ProviderUsage,
        find_frame_end, parse_sse_frame,
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

    async fn read_request(stream: &mut TcpStream) {
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
        // 请求头只用于确保测试服务完整接收请求；测试不会打印或存储 Authorization。
        assert!(String::from_utf8_lossy(&bytes).starts_with("POST /v1/chat/completions "));
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
