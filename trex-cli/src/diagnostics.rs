//! Optional, bounded local metrics. Never stores prompts, headers, URLs or tool output.
use crate::profile::Profile;
use serde_json::{json, Value};
use std::time::Duration;
pub fn record(profile: &Profile, id: &str, elapsed: Duration, state: &str, usage: Option<&Value>) {
    if !crate::settings::Settings::load(Some(&profile.name)).is_ok_and(|s| s.diagnostics) {
        return;
    }
    let result = crate::profile::update_user_file("metrics.json", |raw| {
        let mut rows = raw
            .and_then(|r| serde_json::from_slice::<Vec<Value>>(&r).ok())
            .unwrap_or_default();
        let numeric=usage.map(|u|{
            let (hit,miss,write)=crate::usage::cache_counters(u);
            json!({"input":u.get("prompt_tokens").and_then(Value::as_u64),"output":u.get("completion_tokens").and_then(Value::as_u64),"cacheHit":hit,"cacheMiss":miss,"cacheWrite":write,"costUsd":u.get("cost").and_then(Value::as_f64).filter(|v|v.is_finite() && *v>=0.0)})
        });
        rows.push(json!({"requestId":id,"profile":profile.name,"provider":profile.provider,"elapsedMs":elapsed.as_millis() as u64,"state":state,"usage":numeric}));
        if rows.len() > 2000 {
            rows.drain(..rows.len() - 2000);
        }
        Ok(serde_json::to_vec(&rows)?)
    });
    let _ = result;
}
pub fn report() -> anyhow::Result<Value> {
    let rows = crate::profile::read_user_file("metrics.json")?
        .map(|v| serde_json::from_slice::<Value>(&v))
        .transpose()?
        .unwrap_or(json!([]));
    // Hit rate over the requests whose response reported a cache counter; a
    // provider without one must not read as 0 % hits.
    let (mut hit, mut prompt, mut measured) = (0u64, 0u64, 0u64);
    for row in rows.as_array().into_iter().flatten() {
        if let (Some(h), Some(p)) = (row["usage"]["cacheHit"].as_u64(), row["usage"]["input"].as_u64()) {
            hit = hit.saturating_add(h);
            prompt = prompt.saturating_add(p);
            measured += 1;
        }
    }
    let rate = (prompt > 0).then(|| ((hit as f64 / prompt as f64) * 10_000.0).round() / 10_000.0);
    Ok(json!({"localOnly":true,"cache":{"measuredRequests":measured,"hitTokens":hit,"promptTokens":prompt,"hitRate":rate},"requests":rows}))
}
