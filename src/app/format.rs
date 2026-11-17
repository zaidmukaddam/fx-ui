use crate::fx::acp::ConfigOption;

pub(crate) fn model_name(name: &str) -> String {
    if !name.contains('/') && name.contains(' ') {
        return name.to_string();
    }
    let base = name.rsplit('/').next().unwrap_or(name);
    base.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            if matches!(w, "gpt" | "glm" | "ai" | "llm" | "oss") {
                return w.to_uppercase();
            }
            capitalized(w)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

pub(crate) fn choice_name(option: Option<&ConfigOption>) -> String {
    option
        .and_then(|o| o.choices.iter().find(|c| c.value == o.current))
        .map(|c| c.name.clone())
        .unwrap_or_else(|| "…".into())
}

pub(crate) fn ago(updated: &str) -> String {
    let Some(secs) = age(updated) else {
        return "now".into();
    };
    match secs {
        s if s < 60 => "now".into(),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3_600),
        s => format!("{}d", s / 86_400),
    }
}

pub(crate) fn day(updated: &str) -> &'static str {
    use chrono::Offset as _;
    let offset = chrono::Local::now().offset().fix().local_minus_utc() as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    day_between(epoch(updated).unwrap_or(now), now, offset)
}

fn day_between(then: i64, now: i64, offset: i64) -> &'static str {
    let day = |t: i64| (t + offset).div_euclid(86_400);
    match day(now) - day(then) {
        i64::MIN..=0 => "Today",
        1 => "Yesterday",
        _ => "Earlier",
    }
}

fn age(updated: &str) -> Option<u64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((now - epoch(updated)?).max(0) as u64)
}

fn epoch(updated: &str) -> Option<i64> {
    let stamp = updated.get(..19)?;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .map(|at| at.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fx_timestamps() {
        let one_day = age("1970-01-02T00:00:00Z").unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(now - one_day, 86_400);
        assert_eq!(ago(""), "now");
    }

    #[test]
    fn days_turn_over_at_local_midnight() {
        let (offset, hour) = (19_800, 3_600);
        let now = 10 * 86_400 + hour - offset;
        assert_eq!(day_between(now - 1_800, now, offset), "Today");
        assert_eq!(day_between(now - 2 * hour, now, offset), "Yesterday");
        assert_eq!(day_between(now - 26 * hour, now, offset), "Earlier");
        assert_eq!(day_between(now + 86_400, now, offset), "Today");
    }

    #[test]
    fn names_models_for_people() {
        assert_eq!(
            model_name("deepseek/deepseek-v4.1-flash"),
            "Deepseek V4.1 Flash"
        );
        assert_eq!(model_name("openai/gpt-6-astra"), "GPT 6 Astra");
        assert_eq!(model_name("GPT-6 Astra"), "GPT-6 Astra");
    }

    #[test]
    fn capitalizes_the_first_letter() {
        assert_eq!(capitalized("stable"), "Stable");
        assert_eq!(
            capitalized("stored API key (macOS Keychain)"),
            "Stored API key (macOS Keychain)"
        );
        assert_eq!(capitalized("/Users/z was skipped"), "/Users/z was skipped");
        assert_eq!(capitalized(""), "");
    }
}
