use crate::app::{FxApp, Pending};
use crate::design::*;
use crate::fx::tools::{question, summarize};
use crate::host::git::{DiffLine, counts};
use crate::views::diff::{diff_block, more_lines};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    ClickEvent, Context, Div, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};

impl FxApp {
    pub(super) fn render_question(
        &self,
        turn: usize,
        asks: String,
        options: Vec<String>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let row = |i: usize, label: String| {
            h_flex()
                .id(("answer", i))
                .h(px(40.))
                .flex_shrink_0()
                .px(px(12.))
                .gap(px(10.))
                .rounded(px(8.))
                .border_1()
                .border_color(alpha_300())
                .cursor_pointer()
                .hover(|d| d.bg(alpha_200()).border_color(alpha_400()))
                .child(
                    text(12., 16.)
                        .w(px(12.))
                        .flex_shrink_0()
                        .font_family(MONO)
                        .text_color(gray_700())
                        .child((i + 1).to_string()),
                )
                .child(text(13., 18.).flex_1().min_w_0().truncate().child(label))
        };
        let count = options.len();
        card()
            .gap(px(14.))
            .p(px(16.))
            .child(
                h_flex()
                    .items_start()
                    .gap(px(10.))
                    .child(dot(amber_700()).mt(px(7.)))
                    .child(text(14., 22.).font_weight(FontWeight::MEDIUM).child(asks)),
            )
            .child(
                v_flex()
                    .gap(px(6.))
                    .children(options.into_iter().enumerate().map(|(i, label)| {
                        let answer = label.clone();
                        row(i, label).on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.answer_question(answer.clone(), cx)
                        }))
                    }))
                    .child(
                        row(count, "Something else…".into())
                            .text_color(gray_700())
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.focus_composer(window, cx)
                            })),
                    ),
            )
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(
                        text(12., 16.)
                            .flex_1()
                            .text_color(gray_700())
                            .child("Press a number, or type an answer below"),
                    )
                    .child(
                        text(13., 18.)
                            .id("question-skip")
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gray_900())
                            .cursor_pointer()
                            .hover(|d| d.text_color(gray_1000()))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                if let Some(session) = this.session_mut() {
                                    session.skipped = Some(turn);
                                }
                                cx.notify();
                            }))
                            .child("Skip"),
                    ),
            )
    }

    pub(super) fn render_permission(
        &self,
        pending: &Pending,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (_, detail) = summarize(&pending.call);
        let command = pending.call.kind == "execute";
        card()
            .child(
                h_flex()
                    .gap(px(if command { 8. } else { 10. }))
                    .px(px(2.))
                    .child(dot(amber_700()))
                    .child(
                        text(14., 20.)
                            .font_weight(FontWeight::MEDIUM)
                            .child(question(&pending.call)),
                    ),
            )
            .child(match pending.preview.as_ref() {
                Some(lines) => diff_preview(detail.clone(), lines),
                None => plain_preview(detail.clone(), command),
            })
            .child(permission_buttons(pending, &detail, command, cx))
    }
}

fn diff_preview(detail: String, lines: &[DiffLine]) -> Div {
    let (added, removed) = counts(lines);
    v_flex()
        .rounded(px(8.))
        .border_1()
        .border_color(alpha_200())
        .child(
            h_flex()
                .h(px(34.))
                .flex_shrink_0()
                .px(px(12.))
                .gap(px(10.))
                .rounded_t(px(7.))
                .bg(gray_200())
                .child(
                    text(12., 16.)
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(MONO)
                        .child(detail),
                )
                .child(stat(added, removed).gap(px(10.))),
        )
        .child(
            diff_block(lines, 40)
                .rounded_b(px(7.))
                .when(lines.len() > 40, |d| {
                    d.child(more_lines("approval-more", lines.len() - 40))
                }),
        )
}

fn plain_preview(detail: String, command: bool) -> Div {
    h_flex()
        .min_h(px(40.))
        .px(px(12.))
        .py(px(10.))
        .rounded(px(8.))
        .bg(background_200())
        .font_family(MONO)
        .text_size(px(13.))
        .line_height(px(20.))
        .items_start()
        .when(command, |d| {
            d.child(div().flex_shrink_0().text_color(gray_700()).child("$ "))
        })
        .child(div().flex_1().min_w_0().child(detail))
}

fn permission_buttons(
    pending: &Pending,
    detail: &str,
    command: bool,
    cx: &mut Context<FxApp>,
) -> Div {
    let has = |kind: &str| pending.options.iter().any(|o| o.kind == kind);
    h_flex()
        .gap(px(8.))
        .when(has("allow_always"), |d| {
            let always = if command {
                let words: Vec<&str> = detail.split_whitespace().take(2).collect();
                format!("Always allow {}", words.join(" "))
            } else {
                "Always allow in this session".into()
            };
            d.child(text_button("always", always).on_click(
                cx.listener(|this, _: &ClickEvent, _, cx| this.answer_kind("allow_always", cx)),
            ))
        })
        .child(div().flex_1())
        .child(outline_button("deny", "Deny", Some("Esc")).on_click(
            cx.listener(|this, _: &ClickEvent, _, cx| this.answer_kind("reject_once", cx)),
        ))
        .when(has("allow_once"), |d| {
            d.child(
                primary_button("allow", if command { "Run" } else { "Allow" }, Some("⏎")).on_click(
                    cx.listener(|this, _: &ClickEvent, _, cx| this.answer_kind("allow_once", cx)),
                ),
            )
        })
}
