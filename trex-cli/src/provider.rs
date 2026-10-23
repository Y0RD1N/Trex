//! OpenAI-compatible provider transport. Assistant messages are deliberately kept
//! as JSON so signed/opaque reasoning can be replayed without being discarded.

use std::{collections::BTreeMap, net::IpAddr, time::Duration};

use anyhow::{anyhow, bail, ensure, Context, Result};
use futures_util::StreamExt;
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION},
    Client, RequestBuilder, Url,
};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::profile::{self, Profile};

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOOL_CALLS: u64 = 4096;

#[derive(Clone, Debug)]
pub enum ProviderDelta {
    Text(String),
    Thinking(String),
}

#[derive(Debug)]
pub struct Completion {
    pub message: Value,
    pub usage: Option<Value>,
    pub finish_reason: String,
}

/// An unsuccessful response retained for durable diagnostics. Its message may
/// contain incomplete tool calls and must never be executed or replayed as a
/// successful assistant turn. Display/Debug intentionally omit provider data.
pub struct IncompleteCompletion {
    pub message: Value,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
    pub cancelled: bool,
    /// Original assistant message/delta objects in arrival order. This retains
    /// incompatible revisions that cannot share one assembled JSON field.
    pub raw_deltas: Vec<Value>,
}

impl std::fmt::Display for IncompleteCompletion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(if self.cancelled {
            "Provider completion was cancelled; no tool calls were accepted"
        } else {
            match self.finish_reason.as_deref() {
                Some("length") => "Provider reached its output limit; no tool calls were accepted",
                Some("content_filter") => {
                    "Provider content filter stopped the completion; no tool calls were accepted"
                }
                _ => "Provider completion was incomplete; no tool calls were accepted",
            }
        })
    }
}

impl std::fmt::Debug for IncompleteCompletion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IncompleteCompletion")
            .field("cancelled", &self.cancelled)
            .finish_non_exhaustive()
    }
}

impl std::error::Error for IncompleteCompletion {}

fn provider_name(profile: &Profile) -> Result<&str> {
    match profile.provider.as_str() {
        "deepseek" | "minimax" | "openrouter" | "custom" => Ok(&profile.provider),
        _ => bail!("Unsupported API provider"),
    }
}

fn endpoint(profile: &Profile, resource: &str) -> Result<Url> {
    let default = match provider_name(profile)? {
        "deepseek" => "https://api.deepseek.com",
        "minimax" => "https://api.minimax.io/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "custom" => {
            ensure!(
                !profile.base_url.trim().is_empty(),
                "A custom provider requires a base URL"
            );
            ""
        }
        _ => unreachable!(),
    };
    let base = if profile.base_url.trim().is_empty() {
        default
    } else {
        profile.base_url.trim()
    };
    ensure!(
        !base.chars().any(|character| character.is_whitespace()
            || character.is_control()
            || character == '\\'),
        "Invalid provider base URL"
    );
    let authority = base
        .split_once("://")
        .and_then(|(_, tail)| tail.split(['/', '?', '#']).next())
        .filter(|authority| !authority.is_empty() && !authority.contains('@'));
    ensure!(
        authority.is_some(),
        "Provider URL must have an authority without credentials"
    );
    // Do not attach the source parse error: it may quote credentials in a URL.
    let mut url = Url::parse(base).map_err(|_| anyhow!("Invalid provider base URL"))?;
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Provider URLs cannot contain credentials"
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "Provider URLs cannot contain a query or fragment"
    );
    ensure!(url.host_str().is_some(), "Provider URL must have a host");
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url)),
        "Provider URL must use HTTPS; HTTP is only allowed for loopback mocks"
    );
    let path = format!("{}/{}", url.path().trim_end_matches('/'), resource);
    url.set_path(&path);
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

fn client(url: &Url) -> Result<Client> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // A generation request must never be replayed by the HTTP client.
        .retry(reqwest::retry::never())
        .https_only(!is_loopback(url))
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(300));
    if is_loopback(url) {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| anyhow!("Cannot initialize provider HTTP client"))
}

fn authenticated(request: RequestBuilder, profile: &Profile, url: &Url) -> Result<RequestBuilder> {
    let key = profile::api_key(profile)?;
    let key = key.as_deref().filter(|key| !key.is_empty());
    ensure!(
        key.is_some() || is_loopback(url),
        "An API key is required for this provider; save one in the profile"
    );
    if let Some(key) = key {
        let mut header = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| anyhow!("API key cannot be used as an authorization header"))?;
        header.set_sensitive(true);
        Ok(request.header(AUTHORIZATION, header))
    } else {
        Ok(request)
    }
}

/// Normalize model metadata for the CLI/server contract without inventing
/// capabilities for models that have neither metadata nor documented levels.
pub async fn models(profile: &Profile) -> Result<Vec<Value>> {
    let url = endpoint(profile, "models")?;
    let response = authenticated(client(&url)?.get(url.clone()), profile, &url)?
        .send()
        .await
        .map_err(|_| anyhow!("Provider model request failed"))?;
    if profile.provider == "minimax"
        && matches!(response.status().as_u16(), 404 | 405)
        && !is_loopback(&url)
    {
        return normalize_models("minimax", &documented_minimax_models());
    }
    if profile.provider == "custom" && matches!(response.status().as_u16(), 404 | 405 | 501) {
        ensure!(
            !profile.model.trim().is_empty(),
            "Custom provider does not expose model discovery; configure a model manually"
        );
        return normalize_models(
            "custom",
            &[json!({"id": profile.model, "name": profile.model})],
        );
    }
    ensure!(
        response.status().is_success(),
        "Provider model request returned HTTP {}",
        response.status().as_u16()
    );
    let data = read_json(response, None).await?;
    ensure!(
        data.get("error").is_none_or(Value::is_null),
        "Provider rejected model request"
    );
    let models = data
        .get("data")
        .and_then(Value::as_array)
        .context("Provider model response has no data array")?;
    normalize_models(&profile.provider, models)
}

fn documented_efforts(provider: &str, model: &str) -> Option<&'static [&'static str]> {
    match (provider, model) {
        ("deepseek", "deepseek-flash" | "deepseek-v4-pro") => Some(&["low", "high", "max"]),
        ("minimax", "MiniMax-M3.1-Flash") => Some(&["low", "medium", "high", "xhigh", "max"]),
        _ => None,
    }
}

fn string_metadata(model: &Value, paths: &[&str]) -> Option<Vec<String>> {
    paths
        .iter()
        .find_map(|path| model.pointer(path).and_then(Value::as_array))
        .map(|values| {
            let mut strings = Vec::new();
            for value in values {
                if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
                    if !strings.iter().any(|existing| existing == value) {
                        strings.push(value.to_owned());
                    }
                }
            }
            strings
        })
}

fn normalize_models(provider: &str, models: &[Value]) -> Result<Vec<Value>> {
    models
        .iter()
        .map(|model| {
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .context("Provider catalog contains a model without a valid ID")?;
            let name = ["name", "displayName", "display_name"]
                .into_iter()
                .find_map(|key| {
                    model
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                })
                .unwrap_or(id);
            let mut normalized = json!({"id": id, "name": name});
            let efforts = string_metadata(
                model,
                &[
                    "/efforts",
                    "/supportedEfforts",
                    "/supported_efforts",
                    "/effort/supported_levels",
                    "/reasoning/supported_efforts",
                    "/reasoning/supportedEfforts",
                    "/capabilities/efforts",
                    "/capabilities/supportedEfforts",
                    "/capabilities/supported_efforts",
                    "/capabilities/reasoningEfforts",
                    "/capabilities/reasoning_efforts",
                    "/capabilities/reasoning/supported_efforts",
                    "/capabilities/reasoning/supportedEfforts",
                    "/capabilities/reasoning/efforts",
                    "/capabilities/effort/supported_levels",
                ],
            )
            .or_else(|| {
                documented_efforts(provider, id)
                    .map(|levels| levels.iter().map(|level| (*level).to_owned()).collect())
            });
            if let Some(efforts) = efforts {
                normalized["efforts"] = json!(efforts);
            }
            if let Some(context) = [
                "/contextWindow",
                "/context_window",
                "/context_length",
                "/contextLength",
                "/capabilities/contextWindow",
                "/capabilities/context_window",
                "/capabilities/context_length",
            ]
            .into_iter()
            .find_map(|path| {
                model
                    .pointer(path)
                    .and_then(Value::as_u64)
                    .filter(|length| *length > 0)
            }) {
                normalized["contextWindow"] = json!(context);
            }
            if let Some(modalities) = string_metadata(
                model,
                &[
                    "/inputModalities",
                    "/input_modalities",
                    "/architecture/input_modalities",
                    "/capabilities/inputModalities",
                    "/capabilities/input_modalities",
                ],
            ) {
                normalized["inputModalities"] = json!(modalities);
            }
            Ok(normalized)
        })
        .collect()
}

fn documented_minimax_models() -> Vec<Value> {
    // https://platform.minimax.io/docs/api-reference/text-openai-api
    [
        "MiniMax-M3.1-Flash",
        "MiniMax-M3",
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
    ]
    .into_iter()
    .map(|id| json!({"id": id, "name": id}))
    .collect()
}

fn request_body(
    profile: &Profile,
    model: &str,
    effort: Option<&str>,
    messages: &[Value],
    tools: &[Value],
) -> Result<Value> {
    ensure!(!model.trim().is_empty(), "A model must be selected");
    provider_name(profile)?;
    let mut body = json!({"model": model, "messages": messages, "stream": true});
    if profile.provider != "custom" {
        body["stream_options"] = json!({"include_usage": true});
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
    }
    // The caller resolves session/profile defaults. None deliberately leaves
    // the model's native effort unchanged, including after a model switch.
    let effort = effort.map(str::trim);
    if profile.provider == "minimax" {
        // Output formatting, not an invented effort control for M2.x models.
        body["reasoning_split"] = json!(true);
    }
    if let Some(effort) = effort {
        ensure!(!effort.is_empty(), "Reasoning effort cannot be empty");
        match profile.provider.as_str() {
            "deepseek" => {
                // Current native models and documented compatibility aliases.
                // https://api-docs.deepseek.com/guides/thinking_mode/
                ensure!(
                    matches!(model, "deepseek-flash" | "deepseek-v4-pro"),
                    "Effort selection is not documented for this DeepSeek model; omit effort"
                );
                if effort == "none" {
                    body["thinking"] = json!({"type": "disabled"});
                } else {
                    ensure!(
                        matches!(effort, "low" | "high" | "max"),
                        "DeepSeek supports low, high, or max reasoning effort; use none to disable thinking"
                    );
                    body["thinking"] = json!({"type": "enabled"});
                    body["reasoning_effort"] = json!(effort);
                }
            }
            "openrouter" => {
                // The gateway validates support for the selected model.
                // https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
                ensure!(
                    matches!(
                        effort,
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                    ),
                    "Unsupported OpenRouter reasoning effort"
                );
                body["reasoning"] = json!({"effort": effort});
            }
            "minimax" => match model {
                "MiniMax-M3.1-Flash" => {
                    ensure!(
                        matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"),
                        "MiniMax-M3.1-Flash supports low, medium, high, xhigh, or max effort"
                    );
                    body["reasoning_effort"] = json!(effort);
                }
                "MiniMax-M3" if effort == "none" => {
                    body["thinking"] = json!({"type": "disabled"});
                }
                _ => bail!(
                    "This MiniMax model has no documented support for that effort; omit effort"
                ),
            },
            "custom" => bail!("Reasoning effort is not defined for custom providers; omit effort"),
            _ => unreachable!(),
        }
    }
    if profile.provider == "openrouter" && (!tools.is_empty() || effort.is_some()) {
        // Require the selected endpoint to implement tools and explicit effort.
        // https://openrouter.ai/docs/guides/routing/provider-selection
        body["provider"] = json!({"require_parameters": true});
    }
    Ok(body)
}

pub async fn complete(
    profile: &Profile,
    model: &str,
    effort: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    tx: UnboundedSender<ProviderDelta>,
    cancel: CancellationToken,
) -> Result<Completion> {
    ensure!(!cancel.is_cancelled(), "Provider request cancelled");
    let body = request_body(profile, model, effort, messages, tools)?;
    let url = endpoint(profile, "chat/completions")?;
    let request = authenticated(
        client(&url)?
            .post(url.clone())
            .header(ACCEPT, "text/event-stream, application/json")
            .json(&body),
        profile,
        &url,
    )?;
    completion_request(request, tx, cancel).await
}

async fn completion_request(
    request: RequestBuilder,
    tx: UnboundedSender<ProviderDelta>,
    cancel: CancellationToken,
) -> Result<Completion> {
    ensure!(!cancel.is_cancelled(), "Provider request cancelled");
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("Provider request cancelled"),
        response = request.send() => response.map_err(|_| anyhow!("Provider completion request failed (it was not retried)"))?,
    };
    ensure!(
        response.status().is_success(),
        "Provider completion returned HTTP {} (it was not retried)",
        response.status().as_u16()
    );
    let mut chunks = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut accumulator = Accumulator::default();
    let mut prefix = Vec::new();
    let mut json_body = Vec::new();
    let mut mode = None;
    let mut json_applied = false;
    let mut received = 0usize;
    let parsed: Result<()> = async {
        loop {
            let next = tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("Provider request cancelled"),
                next = chunks.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|_| {
                anyhow!("Provider response stream failed; completion was not retried")
            })?;
            received = received
                .checked_add(chunk.len())
                .context("Provider response is too large")?;
            ensure!(
                received <= MAX_RESPONSE_BYTES,
                "Provider response is too large"
            );
            let bytes = if mode.is_none() {
                prefix.extend_from_slice(&chunk);
                let Some(json_mode) = sniff_json(&prefix) else {
                    continue;
                };
                mode = Some(json_mode);
                std::mem::take(&mut prefix)
            } else {
                chunk.to_vec()
            };
            if mode == Some(true) {
                json_body.extend_from_slice(&bytes);
            } else {
                for event in decoder.push(&bytes)? {
                    accumulator.event(&event, &tx)?;
                    if accumulator.done {
                        break;
                    }
                }
                if accumulator.done {
                    break;
                }
            }
        }
        ensure!(!cancel.is_cancelled(), "Provider request cancelled");
        if mode == Some(true) {
            let value = parse_json(&json_body)?;
            json_applied = true;
            accumulator.full_response(&value, &tx)?;
        } else if !accumulator.done {
            for event in decoder.finish()? {
                accumulator.event(&event, &tx)?;
                if accumulator.done {
                    break;
                }
            }
        }
        Ok(())
    }
    .await;
    if parsed.is_err() {
        // Recovery is diagnostics-only and can never make tools executable.
        if mode == Some(true) && !json_applied {
            if let Ok(value) = parse_json(&json_body) {
                let _ = accumulator.full_response(&value, &tx);
            }
        } else if let Some(pending) = decoder.pending_event() {
            let _ = accumulator.event(&pending, &tx);
        }
        return Err(accumulator.incomplete(cancel.is_cancelled()));
    }
    accumulator.finish()
}

fn sniff_json(bytes: &[u8]) -> Option<bool> {
    let bytes = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        &bytes[3..]
    } else if [0xef, 0xbb, 0xbf].starts_with(bytes) {
        return None;
    } else {
        bytes
    };
    bytes
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        .map(|byte| matches!(byte, b'{' | b'['))
}

fn parse_json(bytes: &[u8]) -> Result<Value> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    // Parsing errors must not quote provider text, which could echo a secret.
    serde_json::from_slice(bytes).map_err(|_| anyhow!("Provider returned invalid JSON"))
}

async fn read_json(
    response: reqwest::Response,
    cancel: Option<&CancellationToken>,
) -> Result<Value> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let next = if let Some(cancel) = cancel {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("Provider request cancelled"),
                next = stream.next() => next,
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| anyhow!("Cannot read provider JSON response"))?;
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_RESPONSE_BYTES,
            "Provider response is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    parse_json(&bytes)
}

/// A byte-oriented SSE parser: UTF-8, CRLF and field names may all cross network
/// chunk boundaries. Decode UTF-8 only after a complete event has been framed.
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    skip_lf: bool,
    seen_line: bool,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.line(&mut events)?;
                    self.skip_lf = true;
                }
                b'\n' => self.line(&mut events)?,
                _ => {
                    ensure!(
                        self.line.len().saturating_add(self.data.len()) < MAX_EVENT_BYTES,
                        "Provider SSE event is too large"
                    );
                    self.line.push(byte);
                }
            }
        }
        Ok(events)
    }

    fn line(&mut self, events: &mut Vec<Vec<u8>>) -> Result<()> {
        let mut line = std::mem::take(&mut self.line);
        if !self.seen_line {
            self.seen_line = true;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        if line.is_empty() {
            self.dispatch(events);
        } else if !line.starts_with(b":") {
            let colon = line
                .iter()
                .position(|byte| *byte == b':')
                .unwrap_or(line.len());
            if &line[..colon] == b"data" {
                let mut value = if colon < line.len() {
                    &line[colon + 1..]
                } else {
                    &[]
                };
                if value.starts_with(b" ") {
                    value = &value[1..];
                }
                if self.has_data {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value);
                self.has_data = true;
                ensure!(
                    self.data.len() <= MAX_EVENT_BYTES,
                    "Provider SSE event is too large"
                );
            }
        }
        Ok(())
    }

    fn dispatch(&mut self, events: &mut Vec<Vec<u8>>) {
        if self.has_data {
            events.push(std::mem::take(&mut self.data));
            self.has_data = false;
        }
    }

    fn finish(&mut self) -> Result<Vec<Vec<u8>>> {
        ensure!(
            self.line.is_empty() && !self.has_data,
            "Provider SSE stream ended inside an event; no tool calls were accepted"
        );
        Ok(Vec::new())
    }

    fn pending_event(&self) -> Option<Vec<u8>> {
        let mut data = self.data.clone();
        let mut has_data = self.has_data;
        let mut line = self.line.as_slice();
        if !self.seen_line {
            line = line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(line);
        }
        if let Some(mut value) = line.strip_prefix(b"data:") {
            if let Some(without_space) = value.strip_prefix(b" ") {
                value = without_space;
            }
            if has_data {
                data.push(b'\n');
            }
            data.extend_from_slice(value);
            has_data = true;
        }
        has_data.then_some(data)
    }
}

struct Accumulator {
    message: Map<String, Value>,
    calls: BTreeMap<u64, Value>,
    rejected_call_fragments: Vec<Value>,
    raw_deltas: Vec<Value>,
    protocol_invalid: bool,
    usage: Option<Value>,
    finish_reason: Option<String>,
    done: bool,
}

impl Default for Accumulator {
    fn default() -> Self {
        Self {
            message: Map::from_iter([
                ("role".into(), json!("assistant")),
                ("content".into(), Value::Null),
            ]),
            calls: BTreeMap::new(),
            rejected_call_fragments: Vec::new(),
            raw_deltas: Vec::new(),
            protocol_invalid: false,
            usage: None,
            finish_reason: None,
            done: false,
        }
    }
}

impl Accumulator {
    fn event(&mut self, data: &[u8], tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        if self.done || data.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        if data.trim_ascii() == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value = parse_json(data)?;
        let provider_result = check_provider_error(&value);
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(usage.clone());
        }
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            provider_result?;
            ensure!(
                value.get("usage").is_some(),
                "Provider SSE event has no choices"
            );
            return Ok(());
        };
        for choice in choices {
            let invalid_index = choice.get("index").is_some_and(|index| !index.is_u64());
            if choice
                .get("index")
                .and_then(Value::as_u64)
                .is_some_and(|index| index != 0)
            {
                continue;
            }
            self.protocol_invalid |= invalid_index;
            let message_result = choice
                .get("message")
                .filter(|value| !value.is_null())
                .map_or(Ok(()), |message| self.full_message(message, tx));
            let delta_result = choice
                .get("delta")
                .filter(|value| !value.is_null())
                .map_or(Ok(()), |delta| self.delta(delta, tx));
            let reason_result = self.reason(choice.get("finish_reason"));
            message_result?;
            delta_result?;
            reason_result?;
            ensure!(!invalid_index, "Provider choice index is invalid");
        }
        provider_result
    }

    fn reason(&mut self, reason: Option<&Value>) -> Result<()> {
        if let Some(reason) = reason.filter(|value| !value.is_null()) {
            let reason = reason
                .as_str()
                .context("Provider finish reason is invalid")?;
            if let Some(previous) = &self.finish_reason {
                ensure!(
                    previous == reason,
                    "Provider returned conflicting finish reasons"
                );
            }
            self.finish_reason = Some(reason.to_owned());
        }
        Ok(())
    }

    fn delta(&mut self, delta: &Value, tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        self.raw_deltas.push(delta.clone());
        self.protocol_invalid |= !delta.is_object();
        let fields = delta
            .as_object()
            .context("Provider assistant delta is not an object")?;
        emit_delta(fields, tx);
        let mut invalid = false;
        // Keep reasoning and text even if a tool fragment is malformed.
        for (key, value) in fields {
            if key != "tool_calls" || value.is_null() {
                if merge_fragment(
                    self.message.entry(key.clone()).or_insert(Value::Null),
                    value,
                    key,
                )
                .is_err()
                {
                    // Keep the newest raw value in the assembled view; both
                    // incompatible versions remain available in raw_deltas.
                    self.message.insert(key.clone(), value.clone());
                    invalid = true;
                }
            }
        }
        if let Some(value) = fields.get("tool_calls").filter(|value| !value.is_null()) {
            let Some(calls) = value.as_array() else {
                self.rejected_call_fragments.push(value.clone());
                self.protocol_invalid = true;
                bail!("Provider tool calls are not an array");
            };
            for call in calls {
                if let Some(index) = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .filter(|index| *index < MAX_TOOL_CALLS)
                {
                    let target = self.calls.entry(index).or_insert_with(|| json!({}));
                    if merge_fragment(target, call, "tool_call").is_err() {
                        self.rejected_call_fragments.push(call.clone());
                        invalid = true;
                    }
                } else {
                    self.rejected_call_fragments.push(call.clone());
                    invalid = true;
                }
            }
        }
        self.protocol_invalid |= invalid;
        ensure!(
            !invalid,
            "Provider assistant fragments could not be assembled"
        );
        Ok(())
    }

    fn full_message(&mut self, message: &Value, tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        self.raw_deltas.push(message.clone());
        self.protocol_invalid |= !message.is_object();
        let fields = message
            .as_object()
            .cloned()
            .context("Provider assistant message is not an object")?;
        emit_delta(&fields, tx);
        self.message.extend(fields.clone());
        // An omitted tool_calls field is a partial message, not a reset. Keep
        // previous calls for both validation and incomplete diagnostics.
        if let Some(calls) = fields.get("tool_calls").filter(|value| !value.is_null()) {
            let calls = calls
                .as_array()
                .context("Provider tool calls are not an array")?;
            ensure!(
                calls.len() < MAX_TOOL_CALLS as usize,
                "Provider returned too many tool calls"
            );
            for (index, call) in calls.iter().enumerate() {
                if let Some(previous) = self.calls.get(&(index as u64)) {
                    let mut previous = previous.clone();
                    if let Some(fields) = previous.as_object_mut() {
                        fields.remove("index");
                    }
                    let mut incoming = call.clone();
                    if let Some(fields) = incoming.as_object_mut() {
                        fields.remove("index");
                    }
                    if previous != incoming {
                        self.rejected_call_fragments.push(call.clone());
                        self.protocol_invalid = true;
                    }
                } else {
                    self.calls.insert(index as u64, call.clone());
                }
            }
            if calls.is_empty() && !self.calls.is_empty() {
                self.protocol_invalid = true;
            }
        }
        if fields.get("tool_calls").is_some_and(Value::is_null) && !self.calls.is_empty() {
            self.protocol_invalid = true;
        }
        ensure!(
            !self.protocol_invalid,
            "Provider assistant messages conflict"
        );
        Ok(())
    }

    fn full_response(&mut self, value: &Value, tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        self.usage = value.get("usage").filter(|value| !value.is_null()).cloned();
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .context("Provider completion has no choices")?;
        let choice = choices
            .iter()
            .find(|choice| {
                choice
                    .get("index")
                    .is_none_or(|index| index.as_u64() == Some(0))
            })
            .or_else(|| choices.first())
            .context("Provider completion has no first choice")?;
        let invalid_index = choice
            .get("index")
            .is_some_and(|index| index.as_u64() != Some(0));
        self.protocol_invalid |= invalid_index;
        let message_result = self.full_message(
            choice
                .get("message")
                .context("Provider completion has no assistant message")?,
            tx,
        );
        let reason_result = self.reason(choice.get("finish_reason"));
        message_result?;
        reason_result?;
        ensure!(!invalid_index, "Provider choice index is invalid");
        check_provider_error(value)?;
        Ok(())
    }

    fn incomplete(&self, cancelled: bool) -> anyhow::Error {
        let mut message = self.message.clone();
        if !self.calls.is_empty() || !self.rejected_call_fragments.is_empty() {
            message.insert(
                "tool_calls".into(),
                Value::Array(
                    self.calls
                        .values()
                        .chain(self.rejected_call_fragments.iter())
                        .cloned()
                        .collect(),
                ),
            );
        }
        IncompleteCompletion {
            message: Value::Object(message),
            usage: self.usage.clone(),
            finish_reason: self.finish_reason.clone(),
            cancelled,
            raw_deltas: self.raw_deltas.clone(),
        }
        .into()
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            !self.protocol_invalid,
            "Provider assistant fragments are invalid"
        );
        let finish_reason = self.finish_reason.as_deref().context(
            "Provider stream ended without a finish reason; no tool calls were accepted",
        )?;
        validate_finish_reason(finish_reason)?;
        ensure!(
            self.message.get("role").and_then(Value::as_str) == Some("assistant"),
            "Provider returned a non-assistant message"
        );
        ensure!(
            self.rejected_call_fragments.is_empty(),
            "Provider tool call fragments are invalid"
        );
        if !self.calls.is_empty() {
            let mut ids = std::collections::HashSet::new();
            for (expected, (index, call)) in self.calls.iter().enumerate() {
                ensure!(
                    *index == expected as u64,
                    "Provider tool call indices are incomplete"
                );
                let fields = call
                    .as_object()
                    .context("Provider tool call is not an object")?;
                let id = fields
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .context("Provider tool call has no ID")?;
                ensure!(
                    ids.insert(id.to_owned()),
                    "Provider returned duplicate tool call IDs"
                );
                ensure!(
                    fields.get("type").and_then(Value::as_str) == Some("function"),
                    "Provider returned an unsupported tool call type"
                );
                let function = fields
                    .get("function")
                    .and_then(Value::as_object)
                    .context("Provider tool call has no function")?;
                ensure!(
                    function
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| !name.is_empty()),
                    "Provider tool call has no function name"
                );
                let arguments = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .context("Provider tool call arguments are missing")?;
                let arguments: Value = serde_json::from_str(arguments).map_err(|_| {
                    anyhow!("Provider tool call arguments are invalid JSON; no tools were accepted")
                })?;
                ensure!(
                    arguments.is_object(),
                    "Provider tool call arguments must be an object"
                );
            }
        } else {
            ensure!(
                finish_reason != "tool_calls",
                "Provider finished with tool_calls but supplied no calls"
            );
        }
        Ok(())
    }

    fn finish(mut self) -> Result<Completion> {
        if self.validate().is_err() {
            return Err(self.incomplete(false));
        }
        if !self.calls.is_empty() {
            let calls = self
                .calls
                .into_values()
                .map(|mut call| {
                    if let Some(fields) = call.as_object_mut() {
                        fields.remove("index");
                    }
                    call
                })
                .collect();
            self.message
                .insert("tool_calls".into(), Value::Array(calls));
        }
        Ok(Completion {
            message: Value::Object(self.message),
            usage: self.usage,
            finish_reason: self.finish_reason.unwrap(),
        })
    }
}

fn validate_finish_reason(reason: &str) -> Result<()> {
    match reason {
        "stop" | "tool_calls" => Ok(()),
        "length" => bail!("Provider reached its output limit; no tool calls were accepted"),
        "content_filter" => {
            bail!("Provider content filter stopped the completion; no tool calls were accepted")
        }
        _ => bail!("Provider completion did not finish successfully; no tool calls were accepted"),
    }
}

fn check_provider_error(value: &Value) -> Result<()> {
    ensure!(
        value.get("error").is_none_or(Value::is_null),
        "Provider reported a completion error"
    );
    if let Some(code) = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
    {
        ensure!(code == 0, "Provider reported an API error (code {code})");
    }
    Ok(())
}

/// Append textual fragments, recursively retain opaque objects, and assemble
/// indexed arrays without losing IDs,
/// signatures or encrypted data. Stable discriminator fields never concatenate.
fn merge_fragment(target: &mut Value, source: &Value, field: &str) -> Result<()> {
    if field == "reasoning_details" {
        return merge_reasoning_details(target, source);
    }
    if source.is_null() {
        return Ok(());
    }
    if target.is_null() {
        *target = source.clone();
        return Ok(());
    }
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_fragment(target.entry(key.clone()).or_insert(Value::Null), value, key)?;
            }
        }
        (Value::Array(target), Value::Array(source)) => {
            for value in source {
                let existing = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| {
                        target.iter().position(|item| {
                            item.get("index").and_then(Value::as_u64) == Some(index)
                        })
                    })
                    .or_else(|| {
                        value.get("id").and_then(Value::as_str).and_then(|id| {
                            target
                                .iter()
                                .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
                        })
                    });
                if let Some(index) = existing {
                    merge_fragment(&mut target[index], value, field)?;
                } else {
                    target.push(value.clone());
                }
            }
        }
        (Value::String(target), Value::String(source)) => {
            if matches!(field, "role" | "type" | "format") || (field == "id" && target == source) {
                ensure!(
                    target == source,
                    "Provider changed a streamed message discriminator"
                );
            } else {
                target.push_str(source);
            }
        }
        (target, source) => {
            *target = source.clone();
        }
    }
    Ok(())
}

fn merge_reasoning_details(target: &mut Value, source: &Value) -> Result<()> {
    if source.is_null() {
        return Ok(());
    }
    let details = source
        .as_array()
        .context("Provider reasoning details are not an array")?;
    if target.is_null() {
        *target = json!([]);
    }
    let target = target
        .as_array_mut()
        .context("Provider changed reasoning detail shape")?;
    for detail in details {
        let kind = detail.get("type").and_then(Value::as_str);
        // OpenRouter's streaming indices may all be zero. Opaque encrypted
        // entries are whole, distinct blobs, never text fragments. Only merge
        // consecutive compatible text/summary fragments across their boundary.
        // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/520
        let compatible = matches!(kind, Some("reasoning.text" | "reasoning.summary"))
            && target.last().is_some_and(|last| {
                last.get("type").and_then(Value::as_str) == kind
                    && ["id", "format", "index"].into_iter().all(|key| {
                        match (
                            last.get(key).filter(|v| !v.is_null()),
                            detail.get(key).filter(|v| !v.is_null()),
                        ) {
                            (Some(left), Some(right)) => left == right,
                            _ => true,
                        }
                    })
            });
        if compatible {
            merge_fragment(target.last_mut().unwrap(), detail, "reasoning_detail")?;
        } else {
            target.push(detail.clone());
        }
    }
    Ok(())
}

fn emit_delta(fields: &Map<String, Value>, tx: &UnboundedSender<ProviderDelta>) {
    if let Some(content) = fields.get("content") {
        if let Some(text) = content.as_str().filter(|text| !text.is_empty()) {
            let _ = tx.send(ProviderDelta::Text(text.to_owned()));
        } else if let Some(parts) = content.as_array() {
            for text in parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
            {
                let _ = tx.send(ProviderDelta::Text(text.to_owned()));
            }
        }
    }
    let reasoning = ["reasoning_content", "reasoning", "thinking"]
        .into_iter()
        .filter_map(|key| fields.get(key).and_then(Value::as_str))
        .find(|text| !text.is_empty());
    if let Some(reasoning) = reasoning {
        let _ = tx.send(ProviderDelta::Thinking(reasoning.to_owned()));
    } else if let Some(details) = fields.get("reasoning_details").and_then(Value::as_array) {
        for detail in details {
            for field in ["text", "summary"] {
                if let Some(text) = detail
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    let _ = tx.send(ProviderDelta::Thinking(text.to_owned()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_mock_request(socket: &mut tokio::net::TcpStream) {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0u8; 1024];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0, "mock request ended before headers");
            request.extend_from_slice(&chunk[..count]);
            assert!(request.len() < 64 * 1024);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
    }

    async fn mock_response(response: Vec<u8>) -> (RequestBuilder, tokio::task::JoinHandle<usize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/chat/completions",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let request = client(&url).unwrap().post(url).body("{}");
        let server = tokio::spawn(async move {
            let mut count = 0;
            for _ in 0..3 {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
                let Ok(Ok((mut socket, _))) = accepted else {
                    break;
                };
                count += 1;
                read_mock_request(&mut socket).await;
                socket.write_all(&response).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            count
        });
        (request, server)
    }

    fn profile(provider: &str) -> Profile {
        Profile {
            name: "test".into(),
            provider: provider.into(),
            base_url: String::new(),
            model: "test".into(),
            effort: None,
        }
    }

    fn replay(bytes: &[u8], chunk_size: usize) -> Result<Completion> {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut decoder = SseDecoder::default();
        let mut accumulator = Accumulator::default();
        for chunk in bytes.chunks(chunk_size) {
            for event in decoder.push(chunk)? {
                accumulator.event(&event, &tx)?;
            }
        }
        for event in decoder.finish()? {
            accumulator.event(&event, &tx)?;
        }
        accumulator.finish()
    }

    #[test]
    fn sse_replay_preserves_reasoning_and_interleaved_tool_fragments_at_every_boundary() {
        let events = [
            json!({"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"piénsalo ","reasoning_details":[{"index":0,"type":"reasoning.text","id":"r1","format":"anthropic-claude-v1","text":"think ","signature":null}]} }]}),
            json!({"choices":[{"delta":{"reasoning_content":"🦖","reasoning_details":[{"index":0,"type":"reasoning.text","id":"r1","format":"anthropic-claude-v1","text":"carefully","signature":"sig"},{"index":1,"type":"reasoning.encrypted","data":"opaque-"}],"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_","arguments":"{\"path\":"}},{"index":0,"id":"call_a","type":"function","function":{"name":"list","arguments":"{"}}]}}]}),
            json!({"choices":[{"delta":{"content":"héllo 🦖","reasoning_details":[{"index":1,"type":"reasoning.encrypted","data":"cipher"}],"tool_calls":[{"index":0,"function":{"name":"_files","arguments":"}"}},{"index":1,"function":{"name":"file","arguments":"\"x\"}"}}]}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":9}}),
        ];
        let mut bytes = b"\xef\xbb\xbf: heartbeat\r\n\r\n".to_vec();
        for event in events {
            bytes.extend_from_slice(format!("event: message\r\ndata: {event}\r\n\r\n").as_bytes());
        }
        bytes.extend_from_slice(b"data: [DONE]\r\n\r\n");
        let expected = replay(&bytes, bytes.len()).unwrap();
        for size in 1..=bytes.len() {
            let result = replay(&bytes, size).unwrap();
            assert_eq!(result.message, expected.message, "chunk size {size}");
            assert_eq!(result.usage, expected.usage);
        }
        assert_eq!(expected.message["reasoning_content"], "piénsalo 🦖");
        assert_eq!(
            expected.message["reasoning_details"][0]["text"],
            "think carefully"
        );
        assert_eq!(expected.message["reasoning_details"][0]["signature"], "sig");
        assert_eq!(expected.message["reasoning_details"][1]["data"], "opaque-");
        assert_eq!(expected.message["reasoning_details"][2]["data"], "cipher");
        assert_eq!(
            expected.message["tool_calls"][0]["function"]["name"],
            "list_files"
        );
        assert_eq!(
            expected.message["tool_calls"][1]["function"]["arguments"],
            "{\"path\":\"x\"}"
        );
        assert!(expected.message["tool_calls"][0].get("index").is_none());
    }

    #[test]
    fn sse_accepts_multiline_data_and_cr_only_with_complete_framing() {
        let bytes = b":comment\rdata: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\rdata: \"finish_reason\":\"stop\"}]}\r\r";
        assert_eq!(replay(bytes, 1).unwrap().message["content"], "ok");
    }

    #[test]
    fn reasoning_details_keep_block_boundaries_when_streaming_indices_repeat() {
        let details = [
            json!({"type":"reasoning.summary","index":0,"id":"summary-a","summary":"read "}),
            json!({"type":"reasoning.summary","index":0,"id":"summary-a","summary":"carefully"}),
            json!({"type":"reasoning.encrypted","index":0,"id":"encrypted-a","data":"opaque-a"}),
            json!({"type":"reasoning.summary","index":0,"id":"summary-b","summary":"next"}),
            json!({"type":"reasoning.encrypted","index":0,"id":"encrypted-b","data":"opaque-b"}),
            json!({"type":"reasoning.text","index":0,"id":"text-a","text":"one"}),
            json!({"type":"reasoning.text","index":0,"id":"text-b","text":"two"}),
        ];
        let mut stream = String::new();
        for detail in &details {
            let event = json!({"choices":[{"delta":{"reasoning_details":[detail]}}]});
            stream.push_str(&format!("data: {event}\n\n"));
        }
        stream.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");
        let result = replay(stream.as_bytes(), 1).unwrap();
        let blocks = result.message["reasoning_details"].as_array().unwrap();
        assert_eq!(blocks.len(), 6);
        assert_eq!(blocks[0]["summary"], "read carefully");
        assert_eq!(blocks[1], details[2]);
        assert_eq!(blocks[2], details[3]);
        assert_eq!(blocks[3], details[4]);
        assert_eq!(blocks[4], details[5]);
        assert_eq!(blocks[5], details[6]);
    }

    #[test]
    fn incomplete_filtered_and_malformed_tool_streams_never_return_calls() {
        for reason in ["length", "content_filter", "error"] {
            let bytes = format!("data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"call\",\"type\":\"function\",\"function\":{{\"name\":\"write_file\",\"arguments\":\"{{}}\"}}}}]}},\"finish_reason\":\"{reason}\"}}]}}\n\n");
            assert!(replay(bytes.as_bytes(), 1).is_err());
        }
        assert!(replay(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: [DONE]\n\n",
            1
        )
        .is_err());
        let bad = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"write_file","arguments":"{partial"}}]},"finish_reason":"tool_calls"}]});
        assert!(replay(format!("data: {bad}\n\n").as_bytes(), 3).is_err());
        let complete_call = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"write_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]});
        for ending in ["", "\n", "\r\n"] {
            assert!(replay(format!("data: {complete_call}{ending}").as_bytes(), 1).is_err());
        }
        assert!(replay(b"data: {\"error\":{\"message\":\"secret\"}}\n\n", 1)
            .unwrap_err()
            .to_string()
            .find("secret")
            .is_none());
    }

    #[test]
    fn nonstream_json_keeps_every_assistant_field_and_rejects_length() {
        let message = json!({"role":"assistant","content":"ok","reasoning_content":"r","reasoning_details":[{"type":"reasoning.encrypted","data":"blob","signature":"sig"}],"provider_extra":{"nested":{"reasoning":"keep"}}});
        let value = json!({"choices":[{"message":message,"finish_reason":"stop"}],"usage":{"total_tokens":3}});
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut accumulator = Accumulator::default();
        accumulator.full_response(&value, &tx).unwrap();
        assert_eq!(accumulator.finish().unwrap().message, message);
        assert!(matches!(rx.try_recv().unwrap(), ProviderDelta::Text(text) if text == "ok"));
        let mut bad = value;
        bad["choices"][0]["finish_reason"] = json!("length");
        let mut accumulator = Accumulator::default();
        accumulator.full_response(&bad, &tx).unwrap();
        let error = accumulator.finish().unwrap_err();
        let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
        assert_eq!(incomplete.message, message);
        assert_eq!(incomplete.usage, Some(json!({"total_tokens":3})));
        assert_eq!(incomplete.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn later_partial_message_cannot_erase_rejected_tools_or_raw_revisions() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let first = json!({"role":"assistant","content":"partial","reasoning_content":"keep-thought","tool_calls":[{"id":"call","type":"function","function":{"name":"write_file","arguments":"{unfinished"},"vendor_field":"keep-call"}]});
        let second = json!({"content":"answer","opaque_reasoning":{"signature":"keep-signature"}});
        let mut accumulator = Accumulator::default();
        accumulator
            .event(
                json!({"choices":[{"message":first}]})
                    .to_string()
                    .as_bytes(),
                &tx,
            )
            .unwrap();
        accumulator
            .event(
                json!({"choices":[{"message":second,"finish_reason":"stop"}]})
                    .to_string()
                    .as_bytes(),
                &tx,
            )
            .unwrap();
        let error = accumulator.finish().unwrap_err();
        let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
        assert_eq!(incomplete.message["tool_calls"], first["tool_calls"]);
        assert_eq!(incomplete.message["reasoning_content"], "keep-thought");
        assert_eq!(
            incomplete.message["opaque_reasoning"],
            second["opaque_reasoning"]
        );
        assert_eq!(incomplete.raw_deltas, vec![first, second]);
    }

    #[test]
    fn malformed_reasoning_and_discriminators_retain_other_fields_and_tools() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let first = json!({"role":"assistant","reasoning_content":"previous-thought","reasoning_details":[{"type":"reasoning.encrypted","data":"previous-cipher"}]});
        for (field, invalid) in [
            ("reasoning_details", json!("malformed-array")),
            ("role", json!("user")),
        ] {
            let mut next = json!({"content":"visible","opaque_reasoning":{"signature":"new-signature"},"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{}"},"opaque_tool":"keep"}]});
            next[field] = invalid.clone();
            let mut accumulator = Accumulator::default();
            accumulator.delta(&first, &tx).unwrap();
            assert!(accumulator.delta(&next, &tx).is_err());
            let error = accumulator.finish().unwrap_err();
            let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
            assert_eq!(incomplete.message[field], invalid);
            assert_eq!(incomplete.message["reasoning_content"], "previous-thought");
            assert_eq!(
                incomplete.message["opaque_reasoning"],
                next["opaque_reasoning"]
            );
            assert_eq!(incomplete.message["tool_calls"], next["tool_calls"]);
            assert_eq!(incomplete.raw_deltas, vec![first.clone(), next]);
        }
    }

    #[test]
    fn invalid_choice_indices_retain_sse_and_json_assistant_diagnostics() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let message = json!({"role":"assistant","content":"visible","reasoning_content":"thought","reasoning_details":[{"type":"reasoning.encrypted","data":"cipher"}],"opaque_reasoning":{"signature":"signature"},"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read_file","arguments":"{}"}}]});
        for streamed in [true, false] {
            let choice = if streamed {
                json!({"index":"0","delta":message,"finish_reason":"stop"})
            } else {
                json!({"index":"0","message":message,"finish_reason":"stop"})
            };
            let value = json!({"choices":[choice],"usage":{"total_tokens":7}});
            let mut accumulator = Accumulator::default();
            let result = if streamed {
                accumulator.event(value.to_string().as_bytes(), &tx)
            } else {
                accumulator.full_response(&value, &tx)
            };
            assert!(result.is_err());
            let error = accumulator.finish().unwrap_err();
            let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
            assert_eq!(incomplete.message, message);
            assert_eq!(incomplete.raw_deltas, vec![message.clone()]);
            assert_eq!(incomplete.usage, Some(json!({"total_tokens":7})));
            assert_eq!(incomplete.finish_reason.as_deref(), Some("stop"));
        }
    }

    #[test]
    fn native_efforts_do_not_claim_unsupported_model_capabilities() {
        for effort in ["low", "high", "max"] {
            let deepseek = request_body(
                &profile("deepseek"),
                "deepseek-flash",
                Some(effort),
                &[],
                &[],
            )
            .unwrap();
            assert_eq!(deepseek["thinking"]["type"], "enabled");
            assert_eq!(deepseek["reasoning_effort"], effort);
        }
        for effort in ["minimal", "medium", "xhigh", "ultra", "invalid"] {
            assert!(request_body(
                &profile("deepseek"),
                "deepseek-flash",
                Some(effort),
                &[],
                &[]
            )
            .is_err());
        }
        let disabled = request_body(
            &profile("deepseek"),
            "deepseek-flash",
            Some("none"),
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(disabled["thinking"]["type"], "disabled");
        assert!(disabled.get("reasoning_effort").is_none());
        let mut saved = profile("deepseek");
        saved.effort = Some("medium".into());
        let native_default = request_body(&saved, "deepseek-flash", None, &[], &[]).unwrap();
        assert!(native_default.get("reasoning_effort").is_none());
        assert!(native_default.get("thinking").is_none());
        assert!(request_body(
            &profile("deepseek"),
            "unlisted-model",
            Some("high"),
            &[],
            &[]
        )
        .is_err());
        let openrouter = request_body(
            &profile("openrouter"),
            "vendor/model",
            Some("high"),
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(openrouter["reasoning"]["effort"], "high");
        assert_eq!(openrouter["provider"]["require_parameters"], true);
        let minimax = request_body(&profile("minimax"), "MiniMax-M2.5", None, &[], &[]).unwrap();
        assert_eq!(minimax["reasoning_split"], true);
        assert!(minimax.get("reasoning_effort").is_none());
        for model in ["MiniMax-M2.5", "MiniMax-M3", "MiniMax-M3.1-Flash-unknown"] {
            assert!(request_body(&profile("minimax"), model, Some("high"), &[], &[]).is_err());
        }
        assert!(request_body(
            &profile("minimax"),
            "MiniMax-M3.1-Flash",
            Some("none"),
            &[],
            &[]
        )
        .is_err());
        assert_eq!(
            request_body(
                &profile("minimax"),
                "MiniMax-M3.1-Flash",
                Some("max"),
                &[],
                &[]
            )
            .unwrap()["reasoning_effort"],
            "max"
        );
    }

    #[test]
    fn openrouter_requires_tool_and_reasoning_parameter_support() {
        let tool = json!({"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}});
        for (effort, tools) in [
            (None, vec![tool.clone()]),
            (Some("high"), vec![]),
            (Some("none"), vec![]),
            (Some("high"), vec![tool]),
        ] {
            let body =
                request_body(&profile("openrouter"), "vendor/model", effort, &[], &tools).unwrap();
            assert_eq!(body["provider"]["require_parameters"], true);
        }
        let body = request_body(&profile("openrouter"), "vendor/model", None, &[], &[]).unwrap();
        assert!(body.get("provider").is_none());
        let mut saved = profile("openrouter");
        saved.effort = Some("medium".into());
        let native_default = request_body(&saved, "vendor/model", None, &[], &[]).unwrap();
        assert!(native_default.get("provider").is_none());
        assert!(native_default.get("reasoning").is_none());
        let resolved = request_body(&saved, "vendor/model", Some("medium"), &[], &[]).unwrap();
        assert_eq!(resolved["provider"]["require_parameters"], true);
        assert_eq!(resolved["reasoning"]["effort"], "medium");
    }

    #[test]
    fn absent_resolved_effort_never_reuses_profile_default_after_model_switch() {
        let mut saved = profile("minimax");
        saved.model = "MiniMax-M3.1-Flash".into();
        saved.effort = Some("max".into());
        for model in ["MiniMax-M3.1-Flash", "MiniMax-M3"] {
            let body = request_body(&saved, model, None, &[], &[]).unwrap();
            assert!(body.get("reasoning_effort").is_none());
            assert!(body.get("thinking").is_none());
            assert_eq!(body["reasoning_split"], true);
        }
        assert!(request_body(&saved, "MiniMax-M3", Some("max"), &[], &[]).is_err());
    }

    #[test]
    fn request_replays_opaque_assistant_reasoning_unchanged() {
        let history = vec![
            json!({"role":"assistant","content":null,"reasoning_content":"chain","reasoning_details":[{"index":0,"type":"reasoning.encrypted","data":"opaque","signature":"signed"}],"vendor_reasoning":{"state":["keep",{"token":"verbatim"}]},"tool_calls":[{"id":"call","type":"function","function":{"name":"read_file","arguments":"{}"}}]}),
        ];
        let body =
            request_body(&profile("openrouter"), "vendor/model", None, &history, &[]).unwrap();
        assert_eq!(body["messages"], json!(history));
    }

    #[test]
    fn custom_adapter_requires_url_and_sends_no_provider_reasoning_options() {
        let mut custom = profile("custom");
        assert!(endpoint(&custom, "models").is_err());
        custom.base_url = "https://example.org/v1".into();
        assert_eq!(
            endpoint(&custom, "chat/completions").unwrap().as_str(),
            "https://example.org/v1/chat/completions"
        );
        let body = request_body(&custom, "manual-model", None, &[], &[]).unwrap();
        assert_eq!(
            body,
            json!({"model":"manual-model","messages":[],"stream":true})
        );
        assert!(request_body(&custom, "manual-model", Some("high"), &[], &[]).is_err());
    }

    #[test]
    fn deepseek_catalog_normalizes_native_metadata_without_alias_efforts() {
        let catalog = json!([
            {"id":"deepseek-flash","name":"DeepSeek Flash","context_window":1048576,"input_modalities":["text","image"],"effort":{"supported_levels":["low","high","max"],"default_level":"high"}},
            {"id":"deepseek-v4-pro","context_window":1048576,"input_modalities":["text"]},
            {"id":"deepseek-unknown","context_window":32768},
            {"id":"deepseek-v4-flash"}
        ]);
        let result = normalize_models("deepseek", catalog.as_array().unwrap()).unwrap();
        assert_eq!(
            result[0],
            json!({"id":"deepseek-flash","name":"DeepSeek Flash","efforts":["low","high","max"],"contextWindow":1048576,"inputModalities":["text","image"]})
        );
        assert_eq!(result[1]["efforts"], json!(["low", "high", "max"]));
        assert_eq!(result[1]["name"], "deepseek-v4-pro");
        assert!(result[2].get("efforts").is_none());
        assert!(result[3].get("efforts").is_none());
        assert!(result[0].get("context_window").is_none());
        assert!(result[0].get("effort").is_none());
    }

    #[test]
    fn openrouter_catalog_uses_actual_reasoning_and_architecture_metadata() {
        let catalog = json!([
            {"id":"vendor/thinking","name":"Thinking","context_length":200000,"architecture":{"input_modalities":["text","image"]},"reasoning":{"supported_efforts":["xhigh","high","medium","low"]},"supported_parameters":["tools","reasoning"]},
            {"id":"vendor/no-effort","context_length":8192,"supported_parameters":["reasoning"]},
            {"id":"vendor/no-selection","reasoning":{"supported_efforts":null}}
        ]);
        let result = normalize_models("openrouter", catalog.as_array().unwrap()).unwrap();
        assert_eq!(
            result[0],
            json!({"id":"vendor/thinking","name":"Thinking","efforts":["xhigh","high","medium","low"],"contextWindow":200000,"inputModalities":["text","image"]})
        );
        assert_eq!(
            result[1],
            json!({"id":"vendor/no-effort","name":"vendor/no-effort","contextWindow":8192})
        );
        assert!(result[2].get("efforts").is_none());
    }

    #[test]
    fn catalog_uses_supplied_capabilities_and_only_exact_documented_minimax_efforts() {
        let catalog = json!([
            {"id":"custom-one","display_name":"One","supportedEfforts":["low","high","high",null],"contextWindow":64000,"inputModalities":["text"]},
            {"id":"custom-two","capabilities":{"supportedEfforts":["medium","max"],"context_window":32000,"input_modalities":["text","audio"]}},
            {"id":"custom-three","capabilities":{"reasoning":{"supported_efforts":["low"]}}},
            {"id":"custom-four"}
        ]);
        let result = normalize_models("custom", catalog.as_array().unwrap()).unwrap();
        assert_eq!(
            result[0],
            json!({"id":"custom-one","name":"One","efforts":["low","high"],"contextWindow":64000,"inputModalities":["text"]})
        );
        assert_eq!(
            result[1],
            json!({"id":"custom-two","name":"custom-two","efforts":["medium","max"],"contextWindow":32000,"inputModalities":["text","audio"]})
        );
        assert_eq!(result[2]["efforts"], json!(["low"]));
        assert_eq!(result[3], json!({"id":"custom-four","name":"custom-four"}));
        let minimax = normalize_models("minimax", &documented_minimax_models()).unwrap();
        assert_eq!(
            minimax[0]["efforts"],
            json!(["low", "medium", "high", "xhigh", "max"])
        );
        for model in &minimax[1..] {
            assert!(model.get("efforts").is_none());
        }
        let unknown =
            normalize_models("minimax", &[json!({"id":"MiniMax-M3.1-Flash-new"})]).unwrap();
        assert!(unknown[0].get("efforts").is_none());
    }

    #[test]
    fn transport_urls_only_allow_https_or_literal_loopback() {
        for url in [
            "http://api.deepseek.com",
            "https://user:secret@example.org",
            "https://@example.org",
            "https:example.org",
            "https://example.org\\@localhost",
            "https://example.org?key=secret",
            "https://example.org#secret",
            "http://localhost.example.org",
        ] {
            let mut profile = profile("deepseek");
            profile.base_url = url.into();
            let error = endpoint(&profile, "models").unwrap_err().to_string();
            assert!(!error.contains("secret"));
        }
        for url in [
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234",
            "http://localhost:1234",
            "https://api.deepseek.com",
        ] {
            let mut profile = profile("deepseek");
            profile.base_url = url.into();
            assert!(endpoint(&profile, "models").is_ok());
        }
        assert_eq!(
            endpoint(&profile("openrouter"), "models").unwrap().as_str(),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[tokio::test]
    async fn transport_accepts_nonstream_json_even_with_event_stream_content_type() {
        let message = json!({"role":"assistant","content":"answer 🦖","reasoning_content":"reason","reasoning_details":[{"type":"reasoning.encrypted","data":"opaque"}],"custom_reasoning":{"signature":"keep"}});
        let body = json!({"choices":[{"index":0,"message":message,"finish_reason":"stop"}],"usage":{"total_tokens":8}}).to_string();
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (request, server) = mock_response(response.into_bytes()).await;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = completion_request(request, tx, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.message, message);
        assert_eq!(result.usage, Some(json!({"total_tokens":8})));
        assert_eq!(server.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn unsafe_nonstream_finish_returns_complete_raw_message_and_safe_diagnostics() {
        let message = json!({"role":"assistant","content":"private-visible-text","reasoning_content":"private-reasoning","reasoning_details":[{"type":"reasoning.encrypted","data":"private-cipher","signature":"private-signature"}],"custom_reasoning":{"state":"private-state"},"tool_calls":[{"id":"call","type":"function","function":{"name":"write_file","arguments":"{unfinished"},"vendor_field":"preserve"}]});
        for reason in ["length", "content_filter"] {
            let body = json!({"choices":[{"message":message,"finish_reason":reason}],"usage":{"total_tokens":17}}).to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let (request, server) = mock_response(response.into_bytes()).await;
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            let error = completion_request(request, tx, CancellationToken::new())
                .await
                .unwrap_err();
            let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
            assert_eq!(incomplete.message, message);
            assert_eq!(incomplete.usage, Some(json!({"total_tokens":17})));
            assert_eq!(incomplete.finish_reason.as_deref(), Some(reason));
            assert!(!incomplete.cancelled);
            for diagnostic in [
                format!("{error}"),
                format!("{error:?}"),
                format!("{incomplete:?}"),
            ] {
                assert!(!diagnostic.contains("private-"));
                assert!(!diagnostic.contains("unfinished"));
            }
            assert_eq!(server.await.unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn unsafe_stream_retains_reasoning_tool_fragments_and_usage_after_finish() {
        let first = json!({"choices":[{"delta":{"content":"visible","reasoning_content":"think ","reasoning_details":[{"type":"reasoning.encrypted","data":"opaque"}],"vendor_reasoning":{"state":"keep"},"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"write_file","arguments":"{unfinished"},"vendor_field":"keep-call"}]}}]});
        let last =
            json!({"choices":[{"delta":{"reasoning_content":"more"},"finish_reason":"length"}]});
        let usage = json!({"choices":[],"usage":{"total_tokens":21}});
        let body = format!("data: {first}\n\ndata: {last}\n\ndata: {usage}\n\ndata: [DONE]\n\n");
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (request, server) = mock_response(response.into_bytes()).await;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let error = completion_request(request, tx, CancellationToken::new())
            .await
            .unwrap_err();
        let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
        assert_eq!(incomplete.message["reasoning_content"], "think more");
        assert_eq!(incomplete.message["reasoning_details"][0]["data"], "opaque");
        assert_eq!(incomplete.message["vendor_reasoning"]["state"], "keep");
        assert_eq!(
            incomplete.message["tool_calls"][0],
            first["choices"][0]["delta"]["tool_calls"][0]
        );
        assert_eq!(incomplete.usage, Some(json!({"total_tokens":21})));
        assert_eq!(incomplete.finish_reason.as_deref(), Some("length"));
        assert_eq!(server.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn unterminated_sse_keeps_diagnostic_fields_but_never_succeeds() {
        let delta = json!({"role":"assistant","content":"last text","reasoning_content":"last thought","tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"write_file","arguments":"{}"}}]});
        let event = json!({"choices":[{"delta":delta,"finish_reason":"tool_calls"}],"usage":{"total_tokens":5}});
        let body = format!("data: {event}");
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (request, server) = mock_response(response.into_bytes()).await;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let error = completion_request(request, tx, CancellationToken::new())
            .await
            .unwrap_err();
        let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
        assert_eq!(incomplete.message, delta);
        assert_eq!(incomplete.usage, Some(json!({"total_tokens":5})));
        assert_eq!(incomplete.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(server.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn transport_does_not_retry_posts_or_follow_redirects() {
        for status in ["500 Internal Server Error", "307 Temporary Redirect"] {
            let response = format!("HTTP/1.1 {status}\r\nLocation: /duplicate\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let (request, server) = mock_response(response.into_bytes()).await;
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            assert!(completion_request(request, tx, CancellationToken::new())
                .await
                .is_err());
            assert_eq!(server.await.unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_open_stream_without_a_finish_reason() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/chat/completions",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_mock_request(&mut socket).await;
            let delta = json!({"choices":[{"delta":{"content":"partial","reasoning_content":"thinking","reasoning_details":[{"type":"reasoning.encrypted","data":"cipher"}],"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"write_file","arguments":"{"}}]}}]});
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {delta}\n\n").as_bytes()).await.unwrap();
            ready_tx.send(()).unwrap();
            server_cancel.cancelled().await;
        });
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            completion_request(client(&url).unwrap().post(url).body("{}"), tx, task_cancel).await
        });
        tokio::time::timeout(Duration::from_secs(5), ready_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap(), ProviderDelta::Text(text) if text == "partial")
        );
        assert!(
            matches!(tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap(), ProviderDelta::Thinking(text) if text == "thinking")
        );
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        let incomplete = error.downcast_ref::<IncompleteCompletion>().unwrap();
        assert!(incomplete.cancelled);
        assert_eq!(incomplete.message["content"], "partial");
        assert_eq!(incomplete.message["reasoning_content"], "thinking");
        assert_eq!(incomplete.message["reasoning_details"][0]["data"], "cipher");
        assert_eq!(
            incomplete.message["tool_calls"][0]["function"]["arguments"],
            "{"
        );
        assert_eq!(incomplete.finish_reason, None);
        server.await.unwrap();
    }
}
