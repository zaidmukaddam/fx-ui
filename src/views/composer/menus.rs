use super::{bars, menu_row, thinking};
use crate::app::FxApp;
use crate::design::*;
use crate::fx::acp::{Choice, ConfigOption};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    ClickEvent, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, px,
};

impl FxApp {
    pub(super) fn mode_menu(
        &self,
        mode: &ConfigOption,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut choices: Vec<&Choice> = mode.choices.iter().collect();
        choices.sort_by_key(|c| {
            ["ask", "auto", "full-access"]
                .iter()
                .position(|v| *v == c.value)
        });
        let rows = choices.into_iter().enumerate().map(|(i, c)| {
            let on = c.value == mode.current;
            let (id, value) = (mode.id.clone(), c.value.clone());
            let detail = match c.value.as_str() {
                "ask" => "Every edit and command asks",
                "auto" => "A safety review decides instead of you",
                "full-access" => "Accept all permissions",
                _ => "",
            };
            menu_row(("mode-choice", i), on)
                .py(px(8.))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.pop = None;
                    if value == "full-access" && !on {
                        this.dialog = Some(crate::app::Dialog::FullAccess(id.clone()));
                        cx.notify();
                    } else {
                        this.set_option(id.clone(), value.clone(), cx);
                    }
                }))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            text(13., 20.)
                                .font_weight(FontWeight::MEDIUM)
                                .child(c.name.clone()),
                        )
                        .when(!detail.is_empty(), |d| {
                            d.child(text(12., 16.).text_color(gray_900()).child(detail))
                        }),
                )
                .when(on, |d| d.child(icon("check", 14., gray_1000())))
        });
        let grants = self.session().map(|s| s.grants.clone()).unwrap_or_default();
        v_flex()
            .child(v_flex().p(px(6.)).children(rows))
            .when(!grants.is_empty(), |d| {
                d.child(
                    v_flex()
                        .pt(px(8.))
                        .px(px(6.))
                        .pb(px(6.))
                        .bg(background_200())
                        .border_t_1()
                        .border_color(alpha_400())
                        .child(
                            h_flex()
                                .px(px(8.))
                                .pb(px(6.))
                                .child(
                                    text(12., 16.)
                                        .flex_1()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(gray_900())
                                        .child("Allowed in this session"),
                                )
                                .child(
                                    text(12., 16.)
                                        .id("forget-grants")
                                        .cursor_pointer()
                                        .hover(|d| d.text_color(gpui_kit::white()))
                                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                            this.forget_grants(cx)
                                        }))
                                        .child("Forget all"),
                                ),
                        )
                        .children(grants.into_iter().map(|g| {
                            h_flex().h(px(32.)).flex_shrink_0().px(px(8.)).child(
                                text(12., 16.)
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .font_family(MONO)
                                    .child(g),
                            )
                        })),
                )
            })
    }

    pub(super) fn thinking_menu(
        &self,
        effort: &ConfigOption,
        fast: Option<&ConfigOption>,
        ultrafast: Option<&ConfigOption>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut levels: Vec<&Choice> = effort.choices.iter().collect();
        levels.sort_by_key(|c| thinking(&c.value, &c.name).rank);
        let rows = levels.into_iter().enumerate().map(|(i, c)| {
            let on = c.value == effort.current;
            let super::Thinking {
                bars: lit,
                label,
                about,
                ..
            } = thinking(&c.value, &c.name);
            let (id, value) = (effort.id.clone(), c.value.clone());
            menu_row(("thinking-choice", i), on)
                .h(px(34.))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.pop = None;
                    this.set_option(id.clone(), value.clone(), cx);
                }))
                .child(bars(lit, gray_1000()))
                .child(text(13., 18.).w(px(64.)).flex_shrink_0().child(label))
                .child(
                    text(12., 16.)
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(if on { gray_900() } else { gray_700() })
                        .child(about),
                )
                .when(on, |d| d.child(icon("check", 14., gray_1000())))
        });
        let first = fast.or(ultrafast).map(|o| o.id.clone());
        let speed = |option: Option<&ConfigOption>, name: &'static str, about: &'static str| {
            let f = option?;
            let on = crate::fx::acp::is_on(&f.current);
            let next = f
                .choices
                .iter()
                .find(|c| c.value != f.current)
                .map(|c| c.value.clone())
                .unwrap_or_default();
            let id = f.id.clone();
            let leads = first.as_ref() == Some(&f.id);
            Some(
                h_flex()
                    .id(name)
                    .gap(px(10.))
                    .px(px(16.))
                    .pb(px(12.))
                    .when(leads, |d| {
                        d.pt(px(10.)).border_t_1().border_color(alpha_300())
                    })
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.set_option(id.clone(), next.clone(), cx);
                    }))
                    .child(icon("bolt", 14., gray_1000()))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(text(13., 18.).child(name))
                            .child(text(12., 16.).text_color(gray_700()).child(about)),
                    )
                    .child(small_switch(on)),
            )
        };
        let fast_row = speed(fast, "Fast mode", "Quicker, where the model offers it");
        let ultrafast_row = speed(ultrafast, "Ultrafast", "Quickest, on a higher-priced tier");
        v_flex()
            .child(
                v_flex()
                    .p(px(6.))
                    .child(
                        text(12., 16.)
                            .px(px(10.))
                            .pt(px(8.))
                            .pb(px(6.))
                            .text_color(gray_700())
                            .child("Thinking"),
                    )
                    .children(rows),
            )
            .children(fast_row)
            .children(ultrafast_row)
    }
}
