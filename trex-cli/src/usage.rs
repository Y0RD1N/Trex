//! Measured API consumption. Cache/thinking details are subsets, never extra totals.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    cached_read_tokens: Option<u64>,
    cached_write_tokens: Option<u64>,
    total_tokens: Option<u64>,
    requests: Option<u64>,
    pub cost_usd: Option<f64>,
    partial: bool,
    cost_partial: bool,
}
impl Default for UsageTotals {
    fn default() -> Self {
        Self {
            input_tokens: None,
            output_tokens: None,
            reasoning_tokens: None,
            cached_read_tokens: None,
            cached_write_tokens: None,
            total_tokens: None,
            requests: Some(0),
            cost_usd: None,
            partial: false,
            cost_partial: false,
        }
    }
}
fn sum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
    }
}
fn cost(raw: &Value) -> Option<f64> {
    raw.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
pub fn token_counts(raw: &Value) -> Option<(u64, u64)> {
    Some((
        raw["prompt_tokens"]
            .as_u64()
            .or_else(|| raw["input_tokens"].as_u64())?,
        raw["completion_tokens"]
            .as_u64()
            .or_else(|| raw["output_tokens"].as_u64())?,
    ))
}
impl UsageTotals {
    pub fn observe(&mut self, raw: Option<&Value>) {
        let raw = raw.unwrap_or(&Value::Null);
        let measured = token_counts(raw);
        let input = raw["prompt_tokens"]
            .as_u64()
            .or_else(|| raw["input_tokens"].as_u64());
        let output = raw["completion_tokens"]
            .as_u64()
            .or_else(|| raw["output_tokens"].as_u64());
        let detail = |paths: &[&str]| {
            paths
                .iter()
                .find_map(|p| raw.pointer(p).and_then(Value::as_u64))
        };
        let cache = detail(&[
            "/prompt_tokens_details/cached_tokens",
            "/input_tokens_details/cached_tokens",
            "/prompt_cache_hit_tokens",
        ])
        .filter(|n| input.is_none_or(|input| *n <= input));
        let thinking = detail(&[
            "/completion_tokens_details/reasoning_tokens",
            "/output_tokens_details/reasoning_tokens",
        ])
        .filter(|n| output.is_none_or(|output| *n <= output));
        self.merge(&Self {
            input_tokens: measured.map(|(i, _)| i),
            output_tokens: measured.map(|(_, o)| o),
            reasoning_tokens: thinking,
            cached_read_tokens: cache,
            cached_write_tokens: detail(&[
                "/prompt_tokens_details/cache_write_tokens",
                "/input_tokens_details/cache_write_tokens",
            ]),
            total_tokens: raw["total_tokens"]
                .as_u64()
                .or_else(|| measured.map(|(i, o)| i.saturating_add(o))),
            requests: Some(raw["trex_request_attempts"].as_u64().unwrap_or(1)),
            cost_usd: cost(&raw["cost"]),
            partial: measured.is_none(),
            cost_partial: cost(&raw["cost"]).is_none(),
        });
    }
    pub fn recorded(raw: &Value) -> Self {
        let v = raw.get("apiUsage").filter(|v| v.is_object());
        if let Some(v) = v {
            Self {
                input_tokens: v["inputTokens"].as_u64(),
                output_tokens: v["outputTokens"].as_u64(),
                reasoning_tokens: v["reasoningTokens"].as_u64(),
                cached_read_tokens: v["cachedReadTokens"].as_u64(),
                cached_write_tokens: v["cachedWriteTokens"].as_u64(),
                total_tokens: v["totalTokens"].as_u64(),
                requests: v["requests"].as_u64(),
                cost_usd: cost(&v["costUsd"]),
                partial: v["partial"] == true,
                cost_partial: v["costPartial"] == true,
            }
        } else {
            let input = raw["inputTokens"].as_u64();
            let output = raw["outputTokens"].as_u64();
            Self {
                input_tokens: input,
                output_tokens: output,
                total_tokens: input.zip(output).map(|(i, o)| i.saturating_add(o)),
                requests: None,
                cost_usd: cost(&raw["costUsd"]),
                partial: input.is_none() || output.is_none(),
                cost_partial: cost(&raw["costUsd"]).is_none(),
                ..Self::default()
            }
        }
    }
    pub fn merge(&mut self, other: &Self) {
        self.input_tokens = sum(self.input_tokens, other.input_tokens);
        self.output_tokens = sum(self.output_tokens, other.output_tokens);
        self.reasoning_tokens = sum(self.reasoning_tokens, other.reasoning_tokens);
        self.cached_read_tokens = sum(self.cached_read_tokens, other.cached_read_tokens);
        self.cached_write_tokens = sum(self.cached_write_tokens, other.cached_write_tokens);
        self.total_tokens = sum(self.total_tokens, other.total_tokens);
        self.requests = self
            .requests
            .zip(other.requests)
            .map(|(a, b)| a.saturating_add(b));
        self.cost_usd = match (self.cost_usd, other.cost_usd) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)).filter(|n| n.is_finite()),
        };
        self.partial |= other.partial;
        self.cost_partial |= other.cost_partial;
    }
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("finite usage counters")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn details_are_not_added_twice_and_missing_cost_is_not_free() {
        let mut total = UsageTotals::default();
        total.observe(Some(&json!({"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_cache_hit_tokens":60,"completion_tokens_details":{"reasoning_tokens":15},"cost":0.01})));
        total.observe(Some(&json!({"input_tokens":50,"output_tokens":10,"input_tokens_details":{"cached_tokens":30}})));
        let v = total.value();
        assert_eq!(v["totalTokens"], 180);
        assert_eq!(v["cachedReadTokens"], 90);
        assert_eq!(v["reasoningTokens"], 15);
        assert_eq!(v["requests"], 2);
        assert_eq!(v["costUsd"], 0.01);
        assert_eq!(v["costPartial"], true);
    }
    #[test]
    fn unknown_responses_remain_unknown_and_legacy_counts_survive() {
        let mut total = UsageTotals::default();
        total.observe(None);
        let v = total.value();
        assert!(v["totalTokens"].is_null());
        assert!(v["costUsd"].is_null());
        assert_eq!(v["partial"], true);
        total.merge(&UsageTotals::recorded(
            &json!({"inputTokens":10,"outputTokens":2,"costUsd":0.0}),
        ));
        assert_eq!(total.value()["totalTokens"], 12);
        assert!(total.value()["requests"].is_null());
        assert_eq!(total.value()["costUsd"], 0.0);
    }
}
