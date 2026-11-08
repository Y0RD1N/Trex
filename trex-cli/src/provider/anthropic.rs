//! Native Anthropic Messages API transport.
//!
//! The rest of Trex CLI keeps the conversation as OpenAI-style JSON (assistant
//! messages with `tool_calls`, `tool` results, `image_url` parts). This module
//! translates at the transport boundary only: it turns that history into a
//! Messages request and turns the Messages event stream back into the same
//! assistant message shape, so the agent loop, journal and UI are unchanged.
//!
//! Reasoning is never replayed. Anthropic binds a thinking block to the exact
//! conversation prefix that produced it, and this CLI trims and rewrites older
//! turns (image budgets, truncated tool output), which invalidates later blocks.
//! The documented fallback is to send a history without thinking blocks: the
//! model then answers each turn without the earlier reasoning, and no account
//! can get a 400 for an edited history.
//! https://platform.claude.com/docs/en/api/messages-streaming

use std::collections::{BTreeMap, HashSet};

use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::UnboundedSender;

use super::{
    parse_json, validate_finish_reason, Completion, IncompleteCompletion, ProviderDelta,
    MAX_TOOL_CALLS,
};

/// Newest documented API version for the Messages endpoint.
pub(super) const VERSION: &str = "2026-10-21";
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Tool-use IDs must match `^[a-zA-Z0-9_-]{1,64}$`. The same mapping is applied
/// to a call and to its result, so the pair stays consistent.
fn tool_id(id: &str) -> String {
    let clean: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect();
    if clean.is_empty() {
        "tool".into()
    } else {
        clean
    }
}

/// Plain text of a message `content`: a string, or the text parts of an array.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn text_block(text: &str) -> Option<Value> {
    (!text.trim().is_empty()).then(|| json!({"type": "text", "text": text}))
}

fn image_block(url: &str) -> Option<Value> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let media = meta.strip_suffix(";base64")?;
        if !matches!(media, "image/jpeg" | "image/png" | "image/gif" | "image/webp") || data.is_empty() {
            return None;
        }
        return Some(json!({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}));
    }
    url.starts_with("https://")
        .then(|| json!({"type": "image", "source": {"type": "url", "url": url}}))
}

fn user_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(text) => text_block(text).into_iter().collect(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => text_block(part.get("text").and_then(Value::as_str).unwrap_or("")),
                Some("image_url" | "input_image") => {
                    let url = part
                        .pointer("/image_url/url")
                        .or_else(|| part.get("image_url"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(image_block(url).unwrap_or_else(|| {
                        json!({"type": "text", "text": "Image attachment omitted: this image format is not supported by the Anthropic API."})
                    }))
                }
                // Already an Anthropic image block.
                Some("image") if part.get("source").is_some_and(Value::is_object) => Some(part.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn assistant_blocks(message: &Value) -> Result<Vec<Value>> {
    let mut blocks: Vec<Value> = text_block(&text_of(&message["content"])).into_iter().collect();
    for call in message["tool_calls"].as_array().into_iter().flatten() {
        let name = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .context("assistant tool call has no function name")?;
        let id = call.get("id").and_then(Value::as_str).context("assistant tool call has no ID")?;
        let input = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|arguments| !arguments.is_empty())
            .map_or(Ok(json!({})), serde_json::from_str::<Value>)
            .map_err(|_| anyhow!("assistant tool call arguments are not valid JSON"))?;
        ensure!(input.is_object(), "assistant tool call arguments must be an object");
        blocks.push(json!({"type": "tool_use", "id": tool_id(id), "name": name, "input": input}));
    }
    Ok(blocks)
}

fn push(out: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut().filter(|last| last["role"] == role) {
        if let Some(content) = last["content"].as_array_mut() {
            content.extend(blocks);
            return;
        }
    }
    out.push(json!({"role": role, "content": blocks}));
}

/// The system prompt (every `system`/`developer` message, in order) and the
/// conversation. Consecutive tool results become one user message, followed by
/// whatever user content comes next (such as image observations): Anthropic
/// requires the results first and merges consecutive turns of one role.
fn convert(messages: &[Value]) -> Result<(String, Vec<Value>)> {
    let mut system = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    for message in messages {
        let role = message["role"].as_str().unwrap_or("");
        if role == "tool" {
            let content = text_of(&message["content"]);
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": tool_id(message["tool_call_id"].as_str().context("tool message has no tool_call_id")?),
                "content": if content.trim().is_empty() { "(no output)".to_owned() } else { content },
            }));
            continue;
        }
        if role == "user" {
            let mut blocks = std::mem::take(&mut results);
            blocks.extend(user_blocks(&message["content"]));
            push(&mut out, "user", blocks);
            continue;
        }
        push(&mut out, "user", std::mem::take(&mut results));
        match role {
            "system" | "developer" => {
                let text = text_of(&message["content"]);
                if !text.trim().is_empty() {
                    system.push(text);
                }
            }
            "assistant" => push(&mut out, "assistant", assistant_blocks(message)?),
            other => bail!("unsupported message role for the Anthropic API: {other}"),
        }
    }
    push(&mut out, "user", results);
    Ok((system.join("\n\n"), out))
}

fn tool_definition(tool: &Value) -> Result<Value> {
    let function = tool.get("function").unwrap_or(tool);
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .context("tool has no name")?;
    let mut schema = function.get("parameters").cloned().unwrap_or_else(|| json!({}));
    let object = schema.as_object_mut().context("tool parameters must be a JSON Schema object")?;
    object.entry("type").or_insert_with(|| json!("object"));
    let mut definition = json!({"name": name, "input_schema": schema});
    if let Some(description) = function.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
        definition["description"] = json!(description);
    }
    Ok(definition)
}

/// Models that run adaptive thinking by default (and cannot turn it off). For
/// these the request asks for summaries so the reasoning can be shown; the
/// default would stream empty thinking blocks. Opus 4.6-4.8 and Sonnet 4.6 also
/// support it but run without when it is omitted: left that way, no thinking
/// blocks exist to be dropped from the next request.
fn adaptive_thinking(model: &str) -> bool {
    ["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5"]
        .iter()
        .any(|prefix| model.starts_with(prefix))
}

/// Largest output the model accepts, so a configured budget above it does not
/// fail the request.
fn max_output_limit(model: &str) -> u64 {
    if ["haiku-4-5", "sonnet-4-5", "opus-4-5"].iter().any(|family| model.contains(family)) {
        64_000
    } else {
        128_000
    }
}

pub(super) fn request_body(
    model: &str,
    effort: Option<&str>,
    messages: &[Value],
    tools: &[Value],
    max_output: u64,
) -> Result<Value> {
    ensure!(!model.trim().is_empty(), "A model must be selected");
    let (system, mut conversation) = convert(messages)?;
    ensure!(!conversation.is_empty(), "The Anthropic API needs at least one user message");
    if conversation[0]["role"] != "user" {
        // The API requires the first turn to be the user's (a history trimmed
        // from the front can start with an assistant turn).
        conversation.insert(0, json!({"role": "user", "content": [{"type": "text", "text": "(earlier conversation omitted)"}]}));
    }
    let mut body = json!({
        "model": model,
        "max_tokens": max_output.clamp(1, max_output_limit(model)),
        "stream": true,
        "messages": conversation,
        // Automatic caching: the breakpoint follows the last block as the tool loop grows.
        "cache_control": {"type": "ephemeral"},
    });
    if !system.is_empty() {
        // A second breakpoint on the stable system prompt, which survives a compaction.
        body["system"] = json!([{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(tool_definition).collect::<Result<_>>()?);
    }
    if let Some(effort) = effort.map(str::trim) {
        ensure!(
            EFFORTS.contains(&effort),
            "Anthropic supports low, medium, high, xhigh, or max reasoning effort"
        );
        body["output_config"] = json!({"effort": effort});
    }
    if adaptive_thinking(model) {
        body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
    }
    Ok(body)
}

#[derive(Default, Clone)]
struct Usage {
    input: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
}

impl Usage {
    /// Each event reports what it knows; later values replace earlier ones.
    fn merge(&mut self, raw: &Value) {
        for (slot, key) in [
            (&mut self.input, "input_tokens"),
            (&mut self.cache_read, "cache_read_input_tokens"),
            (&mut self.cache_write, "cache_creation_input_tokens"),
            (&mut self.output, "output_tokens"),
        ] {
            if let Some(value) = raw.get(key).and_then(Value::as_u64) {
                *slot = Some(value);
            }
        }
    }

    /// OpenAI-style usage, which is what the rest of the CLI reads. Anthropic's
    /// `input_tokens` excludes cached tokens, the OpenAI `prompt_tokens` include them.
    fn normalized(&self) -> Option<Value> {
        if self.input.is_none() && self.output.is_none() && self.cache_read.is_none() && self.cache_write.is_none() {
            return None;
        }
        let (read, write) = (self.cache_read.unwrap_or(0), self.cache_write.unwrap_or(0));
        let prompt = self.input.unwrap_or(0).saturating_add(read).saturating_add(write);
        let output = self.output.unwrap_or(0);
        Some(json!({
            "prompt_tokens": prompt,
            "completion_tokens": output,
            "total_tokens": prompt.saturating_add(output),
            "prompt_tokens_details": {"cached_tokens": read, "cache_write_tokens": write},
        }))
    }
}

enum Block {
    Text(String),
    Tool { id: String, name: String, arguments: String },
    Thinking(String),
    /// Anything the CLI never asked for (server tools, redacted thinking): ignored.
    Other,
}

#[derive(Default)]
pub(super) struct Accumulator {
    blocks: BTreeMap<u64, Block>,
    usage: Usage,
    stop_reason: Option<String>,
    raw: Vec<Value>,
    invalid: bool,
    pub(super) done: bool,
}

fn send(tx: &UnboundedSender<ProviderDelta>, delta: ProviderDelta) {
    let _ = tx.send(delta);
}

impl Accumulator {
    pub(super) fn event(&mut self, data: &[u8], tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        if self.done || data.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let value = parse_json(data)?;
        self.apply(&value, tx)
    }

    fn apply(&mut self, value: &Value, tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        let index = value.get("index").and_then(Value::as_u64);
        match value.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.usage.merge(usage);
                }
            }
            Some("content_block_start") => {
                let Some(index) = index else {
                    self.invalid = true;
                    bail!("Provider content block has no index");
                };
                let block = &value["content_block"];
                let started = match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            send(tx, ProviderDelta::Text(text.to_owned()));
                        }
                        Block::Text(text.to_owned())
                    }
                    Some("tool_use") => {
                        ensure!((self.blocks.len() as u64) < MAX_TOOL_CALLS, "Provider returned too many content blocks");
                        Block::Tool {
                            id: block.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                            name: block.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                            arguments: String::new(),
                        }
                    }
                    Some("thinking") => {
                        let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            send(tx, ProviderDelta::Thinking(text.to_owned()));
                        }
                        Block::Thinking(text.to_owned())
                    }
                    _ => Block::Other,
                };
                self.invalid |= self.blocks.insert(index, started).is_some();
            }
            Some("content_block_delta") => {
                let (Some(index), Some(delta)) = (index, value.get("delta")) else {
                    self.invalid = true;
                    bail!("Provider content delta is malformed");
                };
                match (self.blocks.get_mut(&index), delta.get("type").and_then(Value::as_str)) {
                    (Some(Block::Text(text)), Some("text_delta")) => {
                        let part = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        text.push_str(part);
                        if !part.is_empty() {
                            send(tx, ProviderDelta::Text(part.to_owned()));
                        }
                    }
                    (Some(Block::Tool { arguments, .. }), Some("input_json_delta")) => {
                        arguments.push_str(delta.get("partial_json").and_then(Value::as_str).unwrap_or(""));
                    }
                    (Some(Block::Thinking(text)), Some("thinking_delta")) => {
                        let part = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                        text.push_str(part);
                        if !part.is_empty() {
                            send(tx, ProviderDelta::Thinking(part.to_owned()));
                        }
                    }
                    // Signatures and citations are not kept (see the module notes).
                    (Some(_), _) => {}
                    (None, _) => {
                        self.invalid = true;
                        bail!("Provider content delta has no open block");
                    }
                }
            }
            Some("message_delta") => {
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_owned());
                }
                if let Some(usage) = value.get("usage") {
                    self.usage.merge(usage);
                }
            }
            Some("message_stop") => self.done = true,
            Some("error") => {
                // Never quote provider text, which could echo request data.
                self.raw.push(json!({"type": "error", "kind": value.pointer("/error/type")}));
                bail!("Provider reported a completion error");
            }
            // ping, content_block_stop and event types added later.
            _ => {}
        }
        Ok(())
    }

    /// A non-streaming reply (`{"type":"message","content":[...]}`), for a server
    /// that answers with plain JSON.
    pub(super) fn full_response(&mut self, value: &Value, tx: &UnboundedSender<ProviderDelta>) -> Result<()> {
        if value.get("type").and_then(Value::as_str) == Some("error") {
            bail!("Provider reported a completion error");
        }
        if let Some(usage) = value.get("usage") {
            self.usage.merge(usage);
        }
        for (index, block) in value.get("content").and_then(Value::as_array).context("Provider message has no content")?.iter().enumerate() {
            let index = index as u64;
            self.apply(&json!({"type": "content_block_start", "index": index, "content_block": block}), tx)?;
            // A tool call arrives complete: its input is the whole argument object.
            if let (Some(Block::Tool { arguments, .. }), Some(input)) = (self.blocks.get_mut(&index), block.get("input")) {
                *arguments = input.to_string();
            }
        }
        self.stop_reason = value.get("stop_reason").and_then(Value::as_str).map(str::to_owned);
        self.done = true;
        Ok(())
    }

    fn message(&self, tolerant: bool) -> Result<(Map<String, Value>, Vec<Value>)> {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut calls = Vec::new();
        let mut ids = HashSet::new();
        for block in self.blocks.values() {
            match block {
                Block::Text(part) => text.push_str(part),
                Block::Thinking(part) => reasoning.push_str(part),
                Block::Tool { id, name, arguments } => {
                    let parsed = if arguments.trim().is_empty() {
                        Some(json!({}))
                    } else {
                        serde_json::from_str::<Value>(arguments).ok()
                    };
                    if !tolerant {
                        ensure!(!id.is_empty() && ids.insert(id.clone()), "Provider returned a tool call without a unique ID");
                        ensure!(!name.is_empty(), "Provider tool call has no function name");
                        ensure!(parsed.as_ref().is_some_and(Value::is_object), "Provider tool call arguments are invalid JSON; no tools were accepted");
                    }
                    let arguments = parsed.filter(Value::is_object).map_or_else(|| arguments.clone(), |input| input.to_string());
                    calls.push(json!({"id": id, "type": "function", "function": {"name": name, "arguments": arguments}}));
                }
                Block::Other => {}
            }
        }
        let mut message = Map::from_iter([("role".to_owned(), json!("assistant"))]);
        message.insert("content".into(), if text.is_empty() { Value::Null } else { json!(text) });
        if !reasoning.is_empty() {
            // For display only: it is never sent back to the API.
            message.insert("reasoning_content".into(), json!(reasoning));
        }
        Ok((message, calls))
    }

    fn finish_reason(&self) -> Option<&'static str> {
        Some(match self.stop_reason.as_deref()? {
            "end_turn" | "stop_sequence" => "stop",
            "tool_use" => "tool_calls",
            "max_tokens" | "model_context_window_exceeded" => "length",
            "refusal" => "content_filter",
            _ => "incomplete",
        })
    }

    pub(super) fn incomplete(&self, cancelled: bool) -> anyhow::Error {
        let (mut message, calls) = self.message(true).unwrap_or_default();
        if !calls.is_empty() {
            message.insert("tool_calls".into(), Value::Array(calls));
        }
        IncompleteCompletion {
            request_id: None,
            message: Value::Object(message),
            usage: self.usage.normalized(),
            finish_reason: self.finish_reason().map(str::to_owned),
            cancelled,
            raw_deltas: self.raw.clone(),
        }
        .into()
    }

    pub(super) fn finish(self) -> Result<Completion> {
        let reason = match (self.invalid, self.finish_reason()) {
            (false, Some(reason)) => reason,
            _ => return Err(self.incomplete(false)),
        };
        if validate_finish_reason(reason).is_err() {
            return Err(self.incomplete(false));
        }
        let Ok((mut message, calls)) = self.message(false) else {
            return Err(self.incomplete(false));
        };
        if calls.is_empty() && reason == "tool_calls" {
            // A tool_use stop that carries no call.
            return Err(self.incomplete(false));
        }
        if !calls.is_empty() {
            message.insert("tool_calls".into(), Value::Array(calls));
        }
        Ok(Completion { message: Value::Object(message), usage: self.usage.normalized(), finish_reason: reason.to_owned() })
    }
}

/// Anthropic's `GET /v1/models` entry in the shape the shared catalog code reads:
/// context window, supported efforts, input modalities and output limit.
/// https://platform.claude.com/docs/en/api/models/list
pub(super) fn catalog_view(model: &Value) -> Value {
    let mut view = Map::new();
    for key in ["id", "display_name"] {
        if let Some(value) = model.get(key) {
            view.insert(key.into(), value.clone());
        }
    }
    if let Some(context) = model.get("max_input_tokens").and_then(Value::as_u64) {
        view.insert("context_length".into(), json!(context));
    }
    if let Some(output) = model.get("max_tokens").and_then(Value::as_u64) {
        view.insert("top_provider".into(), json!({"max_completion_tokens": output}));
    }
    let capabilities = &model["capabilities"];
    let efforts: Vec<&str> = EFFORTS
        .iter()
        .copied()
        .filter(|level| capabilities.pointer(&format!("/effort/{level}/supported")) == Some(&json!(true)))
        .collect();
    if capabilities.pointer("/effort/supported") == Some(&json!(true)) || !efforts.is_empty() {
        view.insert("efforts".into(), json!(efforts));
    }
    if let Some(image) = capabilities.pointer("/image_input/supported").and_then(Value::as_bool) {
        view.insert("input_modalities".into(), if image { json!(["text", "image"]) } else { json!(["text"]) });
    }
    Value::Object(view)
}

/// Published per-million-token prices (https://platform.claude.com/docs/en/about-claude/pricing,
/// checked 2026-11-08), with 5-minute cache writes, which is what the automatic
/// breakpoint uses. Only models whose price is a single flat rate are listed:
/// a guessed or tiered price would make cost and budgets wrong without saying so.
pub(super) fn documented_pricing(model: &str) -> Option<Value> {
    let (input, cached, write, output) = match model {
        "claude-fable-5-1" => (10.0, 0.25, 12.5, 50.0),
        "claude-opus-5-5" => (4.0, 0.20, 5.0, 20.0),
        "claude-opus-5" => (5.0, 0.50, 6.25, 25.0),
        "claude-sonnet-5-5" => (2.0, 0.10, 2.5, 10.0),
        _ => return None,
    };
    Some(json!({
        "inputUsdPerMillion": input,
        "outputUsdPerMillion": output,
        "cachedInputUsdPerMillion": cached,
        "cacheWriteUsdPerMillion": write,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn sse(events: &[Value]) -> Vec<Vec<u8>> {
        events.iter().map(|event| event.to_string().into_bytes()).collect()
    }

    fn run(events: &[Value]) -> (Result<Completion>, Vec<ProviderDelta>) {
        let (tx, mut rx) = unbounded_channel();
        let mut accumulator = Accumulator::default();
        let mut outcome = Ok(());
        for data in sse(events) {
            if let Err(error) = accumulator.event(&data, &tx) {
                outcome = Err(error);
                break;
            }
        }
        let deltas = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        (outcome.and_then(|()| accumulator.finish()), deltas)
    }

    fn start(usage: Value) -> Value {
        json!({"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "usage": usage}})
    }

    #[test]
    fn history_becomes_messages_with_grouped_tool_results() {
        let messages = vec![
            json!({"role": "system", "content": "Be brief."}),
            json!({"role": "user", "content": "Lee a.txt y b.txt"}),
            json!({"role": "assistant", "content": "Leo.", "tool_calls": [
                {"id": "call.1", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"a.txt\"}"}},
                {"id": "call.2", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"b.txt\"}"}},
            ]}),
            json!({"role": "tool", "tool_call_id": "call.1", "content": "AAA"}),
            json!({"role": "tool", "tool_call_id": "call.2", "content": ""}),
            json!({"role": "user", "content": [{"type": "text", "text": "Imagen"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}]}),
        ];
        let tools = vec![json!({"type": "function", "function": {"name": "read", "description": "Lee", "parameters": {"properties": {"path": {"type": "string"}}}}})];
        let body = request_body("claude-sonnet-5-5", Some("high"), &messages, &tools, 4096).unwrap();
        assert_eq!(body["system"][0]["text"], "Be brief.");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["cache_control"]["type"], "ephemeral");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["thinking"], json!({"type": "adaptive", "display": "summarized"}));
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["tools"][0]["name"], "read");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object", "a schema without a type is completed");
        let turns = body["messages"].as_array().unwrap();
        assert_eq!(turns.len(), 3, "user, assistant, and ONE user turn with results and the image");
        assert_eq!(turns[1]["content"][0], json!({"type": "text", "text": "Leo."}));
        assert_eq!(turns[1]["content"][1], json!({"type": "tool_use", "id": "call_1", "name": "read", "input": {"path": "a.txt"}}));
        let last = turns[2]["content"].as_array().unwrap();
        assert_eq!(last[0], json!({"type": "tool_result", "tool_use_id": "call_1", "content": "AAA"}));
        assert_eq!(last[1]["tool_use_id"], "call_2");
        assert_eq!(last[1]["content"], "(no output)", "an empty result is not sent empty");
        assert_eq!(last[2], json!({"type": "text", "text": "Imagen"}));
        assert_eq!(last[3]["source"], json!({"type": "base64", "media_type": "image/png", "data": "QUJD"}));
    }

    #[test]
    fn thinking_is_never_replayed_and_old_models_get_no_thinking_field() {
        let messages = vec![
            json!({"role": "user", "content": "hola"}),
            json!({"role": "assistant", "content": "hey", "reasoning_content": "secreto", "reasoning_details": [{"signature": "x"}]}),
            json!({"role": "user", "content": "otra"}),
        ];
        let body = request_body("claude-opus-4-8", None, &messages, &[], 1000).unwrap();
        let text = body.to_string();
        assert!(!text.contains("secreto") && !text.contains("signature"), "{text}");
        assert!(body.get("thinking").is_none() && body.get("output_config").is_none() && body.get("tools").is_none());
        assert!(request_body("claude-haiku-5-5", None, &messages, &[], 1000).unwrap().get("thinking").is_some());
    }

    #[test]
    fn a_history_that_starts_with_the_assistant_gets_a_leading_user_turn() {
        let messages = vec![
            json!({"role": "assistant", "content": "resumen"}),
            json!({"role": "user", "content": "sigue"}),
        ];
        let turns = request_body("claude-opus-5-5", None, &messages, &[], 100).unwrap()["messages"].clone();
        assert_eq!(turns.as_array().unwrap().len(), 3);
        assert_eq!(turns[0]["role"], "user");
        assert_eq!(turns[1]["role"], "assistant");
        assert_eq!(turns[2]["content"][0]["text"], "sigue");
    }

    #[test]
    fn effort_and_output_limits_are_validated_or_clamped() {
        let messages = vec![json!({"role": "user", "content": "hola"})];
        assert!(request_body("claude-opus-5-5", Some("none"), &messages, &[], 10).is_err());
        assert!(request_body("claude-opus-5-5", Some("minimal"), &messages, &[], 10).is_err());
        assert!(request_body("claude-opus-5-5", Some("xhigh"), &messages, &[], 10).is_ok());
        assert_eq!(request_body("claude-opus-5-5", None, &messages, &[], 1_000_000).unwrap()["max_tokens"], 128_000);
        assert_eq!(request_body("claude-haiku-4-5", None, &messages, &[], 1_000_000).unwrap()["max_tokens"], 64_000);
        assert!(request_body("claude-opus-5-5", None, &[], &[], 10).is_err(), "a request needs a user message");
    }

    #[test]
    fn unsupported_images_become_text_not_errors() {
        let messages = vec![json!({"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/bmp;base64,AAAA"}},
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
            {"type": "image_url", "image_url": {"url": "file:///etc/passwd"}},
        ]})];
        let blocks = request_body("claude-opus-5-5", None, &messages, &[], 10).unwrap()["messages"][0]["content"].clone();
        assert!(blocks[0]["text"].as_str().unwrap().contains("not supported"));
        assert_eq!(blocks[1]["source"]["type"], "url");
        assert!(blocks[2]["text"].as_str().unwrap().contains("not supported"), "a local path is never sent");
    }

    #[test]
    fn a_text_stream_becomes_an_assistant_message_with_openai_style_usage() {
        let (result, deltas) = run(&[
            start(json!({"input_tokens": 100, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 50, "output_tokens": 1})),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "pienso"}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Hola"}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": " mundo"}}),
            json!({"type": "ping"}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 42}}),
            json!({"type": "message_stop"}),
        ]);
        let done = result.unwrap();
        assert_eq!(done.finish_reason, "stop");
        assert_eq!(done.message["content"], "Hola mundo");
        assert_eq!(done.message["reasoning_content"], "pienso");
        assert!(done.message.get("tool_calls").is_none());
        let usage = done.usage.unwrap();
        assert_eq!(usage["prompt_tokens"], 1050, "input + cache read + cache write");
        assert_eq!(usage["completion_tokens"], 42, "the cumulative count of message_delta wins");
        assert_eq!(usage["prompt_tokens_details"]["cached_tokens"], 900);
        assert_eq!(usage["prompt_tokens_details"]["cache_write_tokens"], 50);
        let streamed: Vec<String> = deltas.iter().map(|d| format!("{d:?}")).collect();
        assert_eq!(streamed, [r#"Thinking("pienso")"#, r#"Text("Hola")"#, r#"Text(" mundo")"#]);
    }

    #[test]
    fn tool_calls_are_assembled_from_partial_json() {
        let (result, _) = run(&[
            start(json!({"input_tokens": 10, "output_tokens": 1})),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Leo"}}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {}}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"pa"}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "th\":\"a.txt\"}"}}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "list", "input": {}}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}}),
            json!({"type": "message_stop"}),
        ]);
        let done = result.unwrap();
        assert_eq!(done.finish_reason, "tool_calls");
        let calls = done.message["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], json!({"id": "toolu_1", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"a.txt\"}"}}));
        assert_eq!(calls[1]["function"]["arguments"], "{}", "a call without arguments gets an empty object");
    }

    #[test]
    fn broken_streams_never_yield_a_completion_or_executable_tools() {
        let tool = |arguments: &str| {
            vec![
                json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "run", "input": {}}}),
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": arguments}}),
                json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 1}}),
                json!({"type": "message_stop"}),
            ]
        };
        assert!(run(&tool("{\"cmd\":\"ls\"}")).0.is_ok());
        assert!(run(&tool("{\"cmd\":")).0.is_err(), "truncated arguments");
        assert!(run(&tool("[1]")).0.is_err(), "arguments must be an object");
        // No stop reason: the stream was cut.
        assert!(run(&[json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "x"}})]).0.is_err());
        // Output limit, refusal and a paused turn are not successes.
        for reason in ["max_tokens", "refusal", "pause_turn"] {
            let result = run(&[json!({"type": "message_delta", "delta": {"stop_reason": reason}, "usage": {"output_tokens": 1}}), json!({"type": "message_stop"})]).0;
            assert!(result.is_err(), "{reason}");
            assert!(result.unwrap_err().downcast_ref::<IncompleteCompletion>().is_some(), "{reason} keeps what arrived for diagnostics");
        }
        // tool_use stop with no call.
        assert!(run(&[json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 1}}), json!({"type": "message_stop"})]).0.is_err());
        // A mid-stream error event.
        let (result, _) = run(&[json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded: secret-token"}})]);
        let message = format!("{:#}", result.unwrap_err());
        assert!(!message.contains("secret-token"), "provider text is never quoted: {message}");
        // A delta for a block that never started.
        assert!(run(&[json!({"type": "content_block_delta", "index": 5, "delta": {"type": "text_delta", "text": "x"}})]).0.is_err());
    }

    #[test]
    fn duplicate_tool_call_ids_are_rejected() {
        let call = |index: u64| json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "run", "input": {}}});
        let (result, _) = run(&[call(0), call(1), json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 1}}), json!({"type": "message_stop"})]);
        assert!(result.is_err());
    }

    #[test]
    fn a_plain_json_reply_is_accepted_too() {
        let (tx, _rx) = unbounded_channel();
        let mut accumulator = Accumulator::default();
        accumulator
            .full_response(&json!({"type": "message", "content": [
                {"type": "text", "text": "Hecho"},
                {"type": "tool_use", "id": "toolu_9", "name": "write", "input": {"path": "x"}},
            ], "stop_reason": "tool_use", "usage": {"input_tokens": 5, "output_tokens": 3}}), &tx)
            .unwrap();
        let done = accumulator.finish().unwrap();
        assert_eq!(done.message["content"], "Hecho");
        assert_eq!(done.message["tool_calls"][0]["function"]["arguments"], "{\"path\":\"x\"}");
        assert_eq!(done.usage.unwrap()["prompt_tokens"], 5);
        assert!(Accumulator::default().full_response(&json!({"type": "error", "error": {}}), &tx).is_err());
    }

    #[test]
    fn the_catalog_entry_exposes_context_efforts_images_and_output_limit() {
        let view = catalog_view(&json!({
            "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1_000_000, "max_tokens": 128_000,
            "capabilities": {"image_input": {"supported": true}, "effort": {"supported": true, "low": {"supported": true}, "medium": {"supported": true}, "high": {"supported": true}, "xhigh": {"supported": true}, "max": {"supported": false}}},
        }));
        assert_eq!(view["context_length"], 1_000_000);
        assert_eq!(view["top_provider"]["max_completion_tokens"], 128_000);
        assert_eq!(view["efforts"], json!(["low", "medium", "high", "xhigh"]));
        assert_eq!(view["input_modalities"], json!(["text", "image"]));
        let plain = catalog_view(&json!({"id": "claude-x", "capabilities": {"image_input": {"supported": false}, "effort": {"supported": false}}}));
        assert!(plain.get("efforts").is_none());
        assert_eq!(plain["input_modalities"], json!(["text"]));
    }

    #[test]
    fn only_verified_flat_prices_are_documented() {
        let price = documented_pricing("claude-opus-5-5").unwrap();
        assert_eq!(price["inputUsdPerMillion"], 4.0);
        assert_eq!(price["cachedInputUsdPerMillion"], 0.20);
        assert!(documented_pricing("claude-haiku-5-5").is_none(), "tiered by prompt size: not guessed");
        assert!(documented_pricing("claude-unknown").is_none());
    }
}
