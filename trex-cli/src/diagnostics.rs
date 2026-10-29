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
        let numeric=usage.map(|u|json!({"input":u.get("prompt_tokens").and_then(Value::as_u64),"output":u.get("completion_tokens").and_then(Value::as_u64),"costUsd":u.get("cost").and_then(Value::as_f64).filter(|v|v.is_finite() && *v>=0.0)}));
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
    Ok(json!({"localOnly":true,"requests":rows}))
}
