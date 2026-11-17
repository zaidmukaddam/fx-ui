use serde_json::Value;

pub(crate) fn source(usage: Option<&Value>) -> &'static str {
    match usage.and_then(|u| u["source"].as_str()) {
        Some("ai_gateway") => "AI Gateway",
        Some("codex") => "Codex",
        Some("grok") => "Grok",
        _ => "Your provider",
    }
}

pub(crate) fn failure(usage: Option<&Value>) -> Option<String> {
    usage.and_then(|u| {
        (u["status"].as_str() == Some("failed"))
            .then(|| u["reason"].as_str().unwrap_or("unknown").to_string())
    })
}

pub(crate) fn total(usage: Option<&Value>, key: &str) -> f64 {
    usage.and_then(|u| u["totals"][key].as_f64()).unwrap_or(0.)
}

pub(crate) fn tokens(usage: Option<&Value>) -> [(&'static str, f64); 5] {
    [
        ("Input", total(usage, "input_tokens")),
        ("Output", total(usage, "output_tokens")),
        ("Cache read", total(usage, "cache_read_tokens")),
        ("Cache write", total(usage, "cache_write_tokens")),
        ("Reasoning", total(usage, "reasoning_tokens")),
    ]
}

pub(crate) struct ModelUse {
    pub model: String,
    pub requests: f64,
    pub spend: f64,
}

pub(crate) fn models(usage: Option<&Value>) -> Vec<ModelUse> {
    usage
        .and_then(|u| u["models"].as_array())
        .map(|list| {
            list.iter()
                .map(|m| ModelUse {
                    model: m["model"]
                        .as_str()
                        .or_else(|| m["name"].as_str())
                        .unwrap_or("model")
                        .to_string(),
                    requests: m["request_count"]
                        .as_f64()
                        .or_else(|| m["requests"].as_f64())
                        .unwrap_or(0.),
                    spend: m["spend"].as_f64().unwrap_or(0.),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn plan_windows(report: &Value) -> Vec<(u64, f64, i64)> {
    let window = |w: &Value, seconds: u64| {
        Some((
            w["window_seconds"].as_u64().unwrap_or(seconds),
            w["used_percent"].as_f64()?,
            w["resets_at_ms"].as_i64().unwrap_or(0),
        ))
    };
    let mut out: Vec<_> = report["codex"]["limits"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|limit| [window(&limit["primary"], 0), window(&limit["secondary"], 0)])
        .flatten()
        .collect();
    let grok = &report["grok"];
    out.extend(window(
        grok,
        match grok["period"].as_str() {
            Some("daily") => 86_400,
            Some("monthly") => 2_592_000,
            _ => 604_800,
        },
    ));
    out.sort_by_key(|w| w.0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_totals_models_and_a_failure() {
        let report = serde_json::json!({
            "source": "grok",
            "status": "failed",
            "reason": "rate limited",
            "totals": { "input_tokens": 1200, "spend": 0.5 },
            "models": [
                { "model": "grok-4.7", "request_count": 3, "spend": 0.4 },
                { "name": "older", "requests": 1 },
            ],
        });
        let usage = Some(&report);
        assert_eq!(source(usage), "Grok");
        assert_eq!(source(None), "Your provider");
        assert_eq!(failure(usage), Some("rate limited".into()));
        assert_eq!(total(usage, "input_tokens"), 1200.);
        assert_eq!(total(usage, "output_tokens"), 0.);
        assert_eq!(tokens(usage)[0], ("Input", 1200.));
        let models = models(usage);
        assert_eq!(
            (
                models[0].model.as_str(),
                models[0].requests,
                models[0].spend
            ),
            ("grok-4.7", 3., 0.4)
        );
        assert_eq!(
            (
                models[1].model.as_str(),
                models[1].requests,
                models[1].spend
            ),
            ("older", 1., 0.)
        );
    }
}
