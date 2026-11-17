use crate::design::*;
use crate::host::git::{DiffLine, Line};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Div, ElementId, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    Stateful, Styled as _, div, px, rgba,
};

pub fn diff_block(lines: &[DiffLine], limit: usize) -> Div {
    let shown = lines.len().min(limit);
    let rows: Vec<AnyElement> = lines[..shown]
        .iter()
        .map(|(kind, old, new, body)| {
            if *kind == Line::Hunk {
                return h_flex()
                    .h(px(26.))
                    .flex_shrink_0()
                    .px(px(14.))
                    .font_family(MONO)
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(gray_700())
                    .child(div().truncate().child(body.clone()))
                    .into_any_element();
            }
            let (ground, number_color, number): (Option<Hsla>, Hsla, Option<usize>) = match kind {
                Line::Added => (Some(rgba(0x45a5571f).into()), green_900(), *new),
                Line::Removed => (Some(rgba(0xe5484d1a).into()), red_900(), *old),
                _ => (None, gray_600(), *new),
            };
            h_flex()
                .h(px(22.))
                .flex_shrink_0()
                .font_family(MONO)
                .text_size(px(12.))
                .line_height(px(22.))
                .when_some(ground, |d, ground| d.bg(ground))
                .child(
                    div()
                        .w(px(40.))
                        .flex_shrink_0()
                        .pr(px(12.))
                        .text_right()
                        .text_color(number_color)
                        .child(number.map(|n| n.to_string()).unwrap_or_default()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .pr(px(12.))
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_color(if *kind == Line::Context {
                            gray_900()
                        } else {
                            gray_1000()
                        })
                        .child(body.clone()),
                )
                .into_any_element()
        })
        .collect();
    v_flex().py(px(6.)).bg(background_200()).children(rows)
}

pub fn more_lines(id: impl Into<ElementId>, hidden: usize) -> Stateful<Div> {
    text(12., 16.)
        .id(id)
        .h(px(30.))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_color(gray_700())
        .hover(|d| d.text_color(gray_1000()))
        .child(format!(
            "Show {hidden} more line{}",
            if hidden == 1 { "" } else { "s" }
        ))
}
