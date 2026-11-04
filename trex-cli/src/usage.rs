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
    /// Some cost was computed locally from configured/catalog prices because
    /// the provider reported none (DeepSeek, MiniMax). Not a provider bill.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cost_estimated: bool,
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
            cost_estimated: false,
        }
    }
}
fn price(pricing: &Value, key: &str) -> Option<f64> {
    pricing[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
}
/// Local cost of one response: uncached input at the input price, cache hits
/// and writes at their own prices (input price when unknown), output at the
/// output price. None without both base prices or measured token counts.
pub fn estimate_cost(raw: &Value, pricing: &Value) -> Option<f64> {
    let (input, output) = token_counts(raw)?;
    let (input_price, output_price) = (
        price(pricing, "inputUsdPerMillion")?,
        price(pricing, "outputUsdPerMillion")?,
    );
    let cached = cache_read(raw).unwrap_or(0).min(input);
    let written = cache_write(raw).unwrap_or(0).min(input - cached);
    let fresh = input - cached - written;
    let cost = fresh as f64 * input_price
        + cached as f64 * price(pricing, "cachedInputUsdPerMillion").unwrap_or(input_price)
        + written as f64 * price(pricing, "cacheWriteUsdPerMillion").unwrap_or(input_price)
        + output as f64 * output_price;
    Some(cost / 1_000_000.0).filter(|n| n.is_finite())
}
fn detail(raw: &Value, paths: &[&str]) -> Option<u64> {
    paths
        .iter()
        .find_map(|p| raw.pointer(p).and_then(Value::as_u64))
}
fn cache_read(raw: &Value) -> Option<u64> {
    detail(
        raw,
        &[
            "/prompt_tokens_details/cached_tokens",
            "/input_tokens_details/cached_tokens",
            "/prompt_cache_hit_tokens",
        ],
    )
}
fn cache_write(raw: &Value) -> Option<u64> {
    detail(
        raw,
        &[
            "/prompt_tokens_details/cache_write_tokens",
            "/input_tokens_details/cache_write_tokens",
        ],
    )
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
        self.observe_priced(raw, None)
    }
    /// Like observe; when the provider reports no cost, `pricing` (camelCase
    /// provider.pricing or catalog pricing) yields a local estimate.
    pub fn observe_priced(&mut self, raw: Option<&Value>, pricing: Option<&Value>) {
        let raw = raw.unwrap_or(&Value::Null);
        let measured = token_counts(raw);
        let input = raw["prompt_tokens"]
            .as_u64()
            .or_else(|| raw["input_tokens"].as_u64());
        let output = raw["completion_tokens"]
            .as_u64()
            .or_else(|| raw["output_tokens"].as_u64());
        let cache = cache_read(raw).filter(|n| input.is_none_or(|input| *n <= input));
        let thinking = detail(
            raw,
            &[
                "/completion_tokens_details/reasoning_tokens",
                "/output_tokens_details/reasoning_tokens",
            ],
        )
        .filter(|n| output.is_none_or(|output| *n <= output));
        let reported = cost(&raw["cost"]);
        let estimated = reported
            .is_none()
            .then(|| pricing.and_then(|pricing| estimate_cost(raw, pricing)))
            .flatten();
        self.merge(&Self {
            input_tokens: measured.map(|(i, _)| i),
            output_tokens: measured.map(|(_, o)| o),
            reasoning_tokens: thinking,
            cached_read_tokens: cache,
            cached_write_tokens: cache_write(raw),
            total_tokens: raw["total_tokens"]
                .as_u64()
                .or_else(|| measured.map(|(i, o)| i.saturating_add(o))),
            requests: Some(raw["trex_request_attempts"].as_u64().unwrap_or(1)),
            cost_usd: reported.or(estimated),
            partial: measured.is_none(),
            cost_partial: reported.or(estimated).is_none(),
            cost_estimated: estimated.is_some(),
        });
    }
    /// Tokens the provider had to process anew: input not served from its
    /// cache, plus output. None until a response is measured.
    pub fn new_tokens(value: &Value) -> Option<u64> {
        let total = value["totalTokens"].as_u64()?;
        Some(total.saturating_sub(value["cachedReadTokens"].as_u64().unwrap_or(0)))
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
                cost_estimated: v["costEstimated"] == true,
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
        self.cost_estimated |= other.cost_estimated;
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
    fn missing_provider_cost_is_estimated_with_cache_prices_and_new_tokens_exclude_hits() {
        let pricing = json!({"inputUsdPerMillion":1.0,"outputUsdPerMillion":4.0,"cachedInputUsdPerMillion":0.1});
        // DeepSeek-style counters: 1M prompt tokens, 900k cache hits.
        let raw = json!({"prompt_tokens":1_000_000,"completion_tokens":1000,"prompt_cache_hit_tokens":900_000,"prompt_cache_miss_tokens":100_000});
        let expected = 100_000.0 * 1.0 / 1e6 + 900_000.0 * 0.1 / 1e6 + 1000.0 * 4.0 / 1e6;
        assert!((estimate_cost(&raw, &pricing).unwrap() - expected).abs() < 1e-9);
        // Cache writes default to the input price.
        let write = json!({"prompt_tokens":100,"completion_tokens":0,"prompt_tokens_details":{"cache_write_tokens":100}});
        assert!((estimate_cost(&write, &json!({"inputUsdPerMillion":2.0,"outputUsdPerMillion":0.0,"cacheWriteUsdPerMillion":2.5})).unwrap() - 0.00025).abs() < 1e-12);
        assert!(estimate_cost(&json!({}), &pricing).is_none());
        assert!(estimate_cost(&raw, &json!({"inputUsdPerMillion":1.0})).is_none());
        let mut total = UsageTotals::default();
        total.observe_priced(Some(&raw), Some(&pricing));
        let v = total.value();
        assert!((v["costUsd"].as_f64().unwrap() - expected).abs() < 1e-9);
        assert_eq!(v["costPartial"], false);
        assert_eq!(v["costEstimated"], true);
        assert_eq!(UsageTotals::new_tokens(&v), Some(101_000));
        // A reported provider cost always wins and is not marked estimated.
        let mut reported = UsageTotals::default();
        reported.observe_priced(Some(&json!({"prompt_tokens":10,"completion_tokens":1,"cost":0.5})), Some(&pricing));
        assert_eq!(reported.value()["costUsd"], 0.5);
        assert!(reported.value().get("costEstimated").is_none());
        let restored = UsageTotals::recorded(&json!({"apiUsage":v}));
        assert_eq!(restored.value()["costEstimated"], true);
        assert_eq!(UsageTotals::new_tokens(&UsageTotals::default().value()), None);
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
