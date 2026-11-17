use crate::app::FxApp;
use crate::design::*;
use crate::fx::usage::plan_windows;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Div, FontWeight, IntoElement, ParentElement as _, Styled as _, div,
    px, relative,
};

impl FxApp {
    pub(super) fn load_plan(&mut self, cx: &mut Context<Self>) {
        let account = self.account();
        if self.settings.plan.as_ref().is_some_and(|p| p.0 != account) {
            self.settings.plan = None;
        }
        cx.spawn(async move |this, cx| {
            let asked = account.clone();
            let (report, profile) = cx
                .background_spawn(async move {
                    (
                        crate::fx::cli::usage_report("7d", Some(&asked)),
                        crate::fx::cli::profile(),
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.settings.fx.is_none() {
                    this.settings.fx = profile;
                }
                this.settings.plan = report.map(|r| (account, r));
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn usage_menu(&self, used: u64, size: u64) -> impl IntoElement {
        use chrono::Offset as _;
        let account = self.account();
        let report = self.settings.plan.as_ref().filter(|p| p.0 == account);
        let name = self
            .catalog
            .iter()
            .find(|a| a.value == account)
            .map_or(account.clone(), |a| a.name.clone());
        let name = name.trim_end_matches(" subscription");
        let windows = report.map(|p| plan_windows(&p.1)).unwrap_or_default();
        let now = chrono::Local::now();
        let offset = now.offset().fix().local_minus_utc();
        let compacts = self
            .settings
            .fx
            .as_ref()
            .and_then(|fx| fx["auto_compact_percent"].as_u64())
            .unwrap_or(80);
        v_flex()
            .gap(px(14.))
            .p(px(14.))
            .child(meter(
                "Context".into(),
                format!("{}k / {}k", used / 1000, size / 1000),
                used as f32 / size.max(1) as f32,
                format!("fx summarises older turns at {compacts}%."),
            ))
            .children(windows.iter().map(|&(seconds, percent, at)| {
                meter(
                    format!("{name} · {}", limit_name(seconds)),
                    format!("{}% used", percent.round()),
                    percent as f32 / 100.,
                    format!("Resets {}", resets_on(at, now.timestamp_millis(), offset)),
                )
            }))
    }
}

fn meter(label: String, value: String, fraction: f32, note: String) -> Div {
    let warn = fraction > 0.8;
    v_flex()
        .gap(px(6.))
        .child(
            h_flex()
                .items_baseline()
                .child(
                    text(13., 20.)
                        .flex_1()
                        .font_weight(FontWeight::MEDIUM)
                        .child(label),
                )
                .child(
                    text(12., 16.)
                        .font_family(MONO)
                        .text_color(if warn { amber_700() } else { gray_900() })
                        .child(value),
                ),
        )
        .child(
            div().h(px(4.)).rounded(px(2.)).bg(gray_300()).child(
                div()
                    .h_full()
                    .rounded(px(2.))
                    .w(relative(fraction.clamp(0.01, 1.)))
                    .bg(if warn { amber_700() } else { gray_1000() }),
            ),
        )
        .child(text(12., 16.).text_color(gray_700()).child(note))
}

fn limit_name(seconds: u64) -> String {
    match seconds {
        2_592_000 => "monthly limit".into(),
        604_800 => "weekly limit".into(),
        86_400 => "daily limit".into(),
        s if s > 86_400 => format!("{}-day limit", s / 86_400),
        s => format!("{}-hour limit", s / 3_600),
    }
}

fn resets_on(at_ms: i64, now_ms: i64, offset: i32) -> String {
    let zone =
        chrono::FixedOffset::east_opt(offset).unwrap_or(chrono::FixedOffset::east_opt(0).unwrap());
    let Some(at) = chrono::DateTime::from_timestamp_millis(at_ms) else {
        return "soon".into();
    };
    let at = at.with_timezone(&zone);
    match at_ms - now_ms {
        left if left < 86_400_000 => at.format("at %-I:%M %p").to_string(),
        left if left < 7 * 86_400_000 => at.format("%A").to_string(),
        _ => at.format("on %-d %B").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plan_windows_from_either_account() {
        let monday = 1_795_424_400_000;
        let codex = serde_json::json!({"grok": null, "codex": {"limits": [{
            "primary": {"used_percent": 81, "window_seconds": 604800, "resets_at_ms": monday},
            "secondary": {"used_percent": 38.4, "window_seconds": 18000, "resets_at_ms": 0},
        }]}});
        let windows = plan_windows(&codex);
        assert_eq!(windows, [(18000, 38.4, 0), (604800, 81., monday)]);
        let names: Vec<String> = windows.iter().map(|w| limit_name(w.0)).collect();
        assert_eq!(names, ["5-hour limit", "weekly limit"]);

        let grok = serde_json::json!({"codex": null, "grok": {
            "used_percent": 0, "period": "weekly", "resets_at_ms": monday,
        }});
        assert_eq!(plan_windows(&grok), [(604800, 0., monday)]);
        assert!(plan_windows(&serde_json::json!({"codex": null, "grok": null})).is_empty());

        let day = 86_400_000;
        assert_eq!(resets_on(monday, monday - 3 * day, 0), "Monday");
        assert_eq!(resets_on(monday, monday - day / 2, 19_800), "at 2:30 PM");
        assert_eq!(resets_on(monday, monday - 20 * day, 0), "on 23 November");
    }
}
