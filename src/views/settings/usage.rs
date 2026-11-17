use super::Section;
use super::rows::{card_rows, page_title, row};
use crate::app::FxApp;
use crate::design::*;
use crate::fx::cli::usage_report;
use crate::fx::usage::{failure as usage_failure, source as usage_source, total};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};
use serde_json::Value;

fn compact(n: f64) -> String {
    match n {
        n if n >= 1e9 => format!("{:.1}B", n / 1e9),
        n if n >= 1e6 => format!("{:.1}M", n / 1e6),
        n if n >= 1e3 => format!("{:.1}K", n / 1e3),
        n => format!("{n:.0}"),
    }
}

fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn token_parts(usage: Option<&Value>) -> [(&'static str, f64, Hsla); 5] {
    let colours = [gray_1000(), blue_700(), gray_600(), gray_500(), amber_700()];
    let tokens = crate::fx::usage::tokens(usage);
    std::array::from_fn(|i| (tokens[i].0, tokens[i].1, colours[i]))
}

fn usage_models(usage: Option<&Value>) -> Vec<(String, f64, f64)> {
    crate::fx::usage::models(usage)
        .into_iter()
        .map(|m| (crate::app::model_name(&m.model), m.requests, m.spend))
        .collect()
}

fn titled(title: &'static str, body: AnyElement) -> impl IntoElement {
    v_flex()
        .gap(px(10.))
        .child(
            div()
                .px(px(2.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .child(title),
        )
        .child(body)
}

fn period_segment(
    id: &'static str,
    label: &'static str,
    value: &'static str,
    period: &str,
    cx: &mut Context<FxApp>,
) -> impl IntoElement + use<> {
    let on = value == period;
    div()
        .id(id)
        .px(px(10.))
        .h_full()
        .flex()
        .items_center()
        .rounded(px(6.))
        .cursor_pointer()
        .text_size(px(12.))
        .text_color(if on { gray_1000() } else { gray_900() })
        .when(on, |d| d.bg(gray_300()))
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_period(value, cx)))
        .child(label)
}

fn usage_header(
    source: &'static str,
    period: &str,
    cx: &mut Context<FxApp>,
) -> impl IntoElement + use<> {
    h_flex()
        .items_end()
        .gap_4()
        .child(
            div()
                .flex_1()
                .child(page_title("Usage", format!("{source}. Days are in UTC."))),
        )
        .child(
            h_flex()
                .h(px(30.))
                .p(px(2.))
                .gap(px(2.))
                .rounded(px(8.))
                .bg(gray_100())
                .border_1()
                .border_color(alpha_300())
                .child(period_segment("p-today", "Today", "today", period, cx))
                .child(period_segment("p-7d", "7 days", "7d", period, cx))
                .child(period_segment("p-month", "Month", "month", period, cx)),
        )
}

fn usage_failed(
    source: &'static str,
    reason: &str,
    cx: &mut Context<FxApp>,
) -> impl IntoElement + use<> {
    h_flex()
        .h(px(44.))
        .px_4()
        .gap(px(10.))
        .rounded(px(12.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
        .child(dot(amber_700()))
        .child(
            div()
                .flex_1()
                .text_size(px(13.))
                .child(if reason == "refused" {
                    format!("Couldn't refresh: {source} refused this sign-in")
                } else {
                    format!("Couldn't refresh from {source} ({reason})")
                }),
        )
        .child(
            text_button("usage-fix", "Fix sign-in")
                .h(px(28.))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.settings.section = Section::Models;
                    cx.notify();
                })),
        )
}

fn tile(label: &'static str, value: String) -> AnyElement {
    v_flex()
        .flex_1()
        .gap(px(6.))
        .p_4()
        .child(div().text_size(px(13.)).text_color(gray_900()).child(label))
        .child(
            div()
                .text_size(px(24.))
                .line_height(px(30.))
                .font_weight(FontWeight::MEDIUM)
                .child(value),
        )
        .into_any_element()
}

fn tile_divider() -> AnyElement {
    div().w(px(1.)).bg(alpha_200()).into_any_element()
}

fn usage_totals(usage: Option<&Value>, credits: Option<f64>) -> AnyElement {
    if usage.is_none() {
        return div()
            .text_size(px(13.))
            .text_color(gray_700())
            .child("Loading…")
            .into_any_element();
    }
    let mut tiles = vec![
        tile("Spend", format!("${:.2}", total(usage, "spend"))),
        tile_divider(),
        tile("Requests", grouped(total(usage, "request_count") as u64)),
        tile_divider(),
        tile("Tokens", compact(total(usage, "total_tokens"))),
    ];
    if let Some(credits) = credits {
        tiles.push(tile_divider());
        tiles.push(tile("Credits left", format!("${credits:.2}")));
    }
    h_flex()
        .items_stretch()
        .rounded(px(12.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
        .children(tiles)
        .into_any_element()
}

fn token_breakdown(parts: &[(&'static str, f64, Hsla)], sum: f64) -> AnyElement {
    let bar = h_flex().h(px(8.)).gap(px(2.)).children(
        parts
            .iter()
            .filter(|p| p.1 > 0.)
            .map(|p| {
                div()
                    .h_full()
                    .rounded(px(2.))
                    .w(gpui_kit::relative((p.1 / sum.max(1.)) as f32))
                    .bg(p.2)
            })
            .collect::<Vec<_>>(),
    );
    let legend = h_flex()
        .flex_wrap()
        .gap_x(px(24.))
        .gap_y(px(10.))
        .children(parts.iter().map(|p| {
            h_flex()
                .gap_2()
                .child(div().size(px(8.)).rounded(px(2.)).bg(p.2))
                .child(div().text_size(px(13.)).text_color(gray_900()).child(p.0))
                .child(div().text_size(px(13.)).child(compact(p.1)))
        }));
    v_flex()
        .gap(px(14.))
        .p_4()
        .rounded(px(12.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
        .child(bar)
        .child(legend)
        .into_any_element()
}

fn model_row(name: &str, requests: f64, spend: f64, top: f64) -> AnyElement {
    h_flex()
        .h(px(52.))
        .px_4()
        .gap_3()
        .child(
            v_flex()
                .flex_1()
                .gap(px(6.))
                .child(div().text_size(px(14.)).child(name.to_string()))
                .child(
                    div().h(px(4.)).rounded(px(2.)).bg(gray_300()).child(
                        div()
                            .h_full()
                            .rounded(px(2.))
                            .w(gpui_kit::relative((spend / top) as f32))
                            .bg(gray_1000()),
                    ),
                ),
        )
        .child(
            div()
                .w(px(80.))
                .text_right()
                .text_size(px(13.))
                .text_color(gray_900())
                .child(format!("{} req", grouped(requests as u64))),
        )
        .child(
            div()
                .w(px(64.))
                .text_right()
                .text_size(px(13.))
                .child(format!("${spend:.2}")),
        )
        .into_any_element()
}

fn model_rows(models: &[(String, f64, f64)]) -> Vec<AnyElement> {
    if models.is_empty() {
        return vec![row("No requests", "Nothing was sent in this period", None)];
    }
    let top = models.iter().map(|m| m.2).fold(0., f64::max).max(1e-9);
    models
        .iter()
        .map(|(name, requests, spend)| model_row(name, *requests, *spend, top))
        .collect()
}

impl FxApp {
    fn set_period(&mut self, period: &'static str, cx: &mut Context<Self>) {
        self.settings.period = Some(period);
        self.settings.usage = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let usage = cx
                .background_spawn(async move { usage_report(period, None) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.settings.usage = usage;
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn usage_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let period = self.settings.period.unwrap_or("7d");
        let usage = self.settings.usage.as_ref();
        let source = usage_source(usage);
        let parts = token_parts(usage);
        let sum: f64 = parts.iter().map(|p| p.1).sum();
        v_flex()
            .gap(px(28.))
            .child(usage_header(source, period, cx))
            .when_some(usage_failure(usage), |d, reason| {
                d.child(usage_failed(source, &reason, cx))
            })
            .child(usage_totals(usage, self.settings.credits))
            .when(sum > 0., |d| {
                d.child(titled(
                    "Where the tokens went",
                    token_breakdown(&parts, sum),
                ))
            })
            .when(usage.is_some(), |d| {
                d.child(titled(
                    "By model",
                    card_rows(model_rows(&usage_models(usage))).into_any_element(),
                ))
            })
    }
}
