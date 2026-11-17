use super::tokens::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    BoxShadow, Div, ElementId, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, Stateful, Styled as _, Svg, Transformation, div, percentage,
    point, px, rgba, svg,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn icon(name: &'static str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(format!("fx/{name}.svg"))
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

pub fn text(size: f32, line: f32) -> Div {
    div().text_size(px(size)).line_height(px(line))
}

static SPINNING: AtomicBool = AtomicBool::new(false);

const TURN: u128 = 900;

pub fn take_spinning() -> bool {
    SPINNING.swap(false, Ordering::Relaxed)
}

pub fn spinner(size: f32) -> impl IntoElement {
    spinner_in(size, gray_1000())
}

pub fn spinner_in(size: f32, color: Hsla) -> impl IntoElement {
    SPINNING.store(true, Ordering::Relaxed);
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() % TURN);
    let turn = elapsed as f32 / TURN as f32;
    div()
        .relative()
        .size(px(size))
        .flex_shrink_0()
        .child(icon("spin-track", size, gray_400()))
        .child(
            icon("spin-arc", size, color)
                .absolute()
                .top_0()
                .left_0()
                .with_transformation(Transformation::rotate(percentage(turn))),
        )
}

pub fn dot(color: Hsla) -> Div {
    div().size(px(7.)).flex_shrink_0().rounded(px(4.)).bg(color)
}

fn drop_shadow(color: u32, y: f32, blur: f32, spread: f32) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: rgba(color).into(),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
    }]
}

pub fn shadow_panel() -> Vec<BoxShadow> {
    drop_shadow(0x00000052, 1., 2., 0.)
}
pub fn shadow_composer() -> Vec<BoxShadow> {
    drop_shadow(0x00000080, 8., 24., -8.)
}
fn layered(near: (f32, f32, f32), far: (f32, f32, f32)) -> Vec<BoxShadow> {
    [
        (0x00000005, (1., 1., 0.)),
        (0x0000000a, near),
        (0x0000000f, far),
    ]
    .into_iter()
    .flat_map(|(color, (y, blur, spread))| drop_shadow(color, y, blur, spread))
    .collect()
}
pub fn shadow_pop() -> Vec<BoxShadow> {
    layered((4., 8., -4.), (16., 24., -8.))
}
pub fn shadow_modal() -> Vec<BoxShadow> {
    layered((8., 16., -4.), (24., 32., -8.))
}

fn button(id: impl Into<ElementId>) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(32.))
        .px(px(12.))
        .gap(px(8.))
        .flex_shrink_0()
        .rounded(px(8.))
        .cursor_pointer()
}

fn label(text_: impl Into<SharedString>) -> Div {
    text(13., 18.)
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .child(text_.into())
}

pub fn text_button(id: impl Into<ElementId>, name: impl Into<SharedString>) -> Stateful<Div> {
    button(id)
        .px(px(10.))
        .text_color(gray_900())
        .hover(|d| d.bg(alpha_200()).text_color(gray_1000()))
        .child(label(name))
}

pub fn outline_button(
    id: impl Into<ElementId>,
    name: impl Into<SharedString>,
    keys: Option<&'static str>,
) -> Stateful<Div> {
    button(id)
        .border_1()
        .border_color(alpha_400())
        .hover(|d| d.bg(alpha_200()))
        .child(label(name))
        .when_some(keys, |d, k| {
            d.child(text(12., 16.).text_color(gray_700()).child(k))
        })
}

pub fn primary_button(
    id: impl Into<ElementId>,
    name: impl Into<SharedString>,
    keys: Option<&'static str>,
) -> Stateful<Div> {
    button(id)
        .bg(gray_1000())
        .text_color(background_100())
        .hover(|d| d.bg(gpui_kit::white()))
        .child(label(name))
        .when_some(keys, |d, k| {
            d.child(text(12., 16.).text_color(gray_600()).child(k))
        })
}

pub fn danger_button(id: impl Into<ElementId>, name: impl Into<SharedString>) -> Stateful<Div> {
    button(id)
        .px(px(14.))
        .bg(red_700())
        .text_color(gpui_kit::white())
        .child(label(name))
        .child(text(12., 16.).text_color(rgba(0xffffffb3)).child("⏎"))
}

pub fn card() -> Div {
    v_flex()
        .gap(px(12.))
        .p(px(14.))
        .rounded(px(12.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_400())
}

pub fn error_card(message: impl Into<SharedString>) -> Div {
    h_flex()
        .items_start()
        .gap(px(12.))
        .py(px(14.))
        .pl(px(16.))
        .pr(px(14.))
        .rounded(px(12.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_400())
        .child(
            div()
                .size(px(28.))
                .flex_shrink_0()
                .rounded(px(8.))
                .bg(red_700().opacity(0.14))
                .flex()
                .items_center()
                .justify_center()
                .child(icon("alert", 14., red_900())),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.))
                .pt(px(3.))
                .child(
                    text(14., 20.)
                        .font_weight(FontWeight::MEDIUM)
                        .child("The turn stopped"),
                )
                .child(text(13., 20.).text_color(gray_900()).child(message.into())),
        )
}

pub fn stat(added: usize, removed: usize) -> Div {
    h_flex()
        .gap(px(7.))
        .flex_shrink_0()
        .font_family(MONO)
        .text_size(px(12.))
        .line_height(px(16.))
        .when(added > 0 || removed == 0, |d| {
            d.child(div().text_color(green_900()).child(format!("+{added}")))
        })
        .when(removed > 0, |d| {
            d.child(div().text_color(red_900()).child(format!("−{removed}")))
        })
}

pub fn switch(id: impl Into<ElementId>, on: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .w(px(34.))
        .h(px(20.))
        .p(px(2.))
        .flex_shrink_0()
        .rounded(px(10.))
        .cursor_pointer()
        .bg(if on { blue_700() } else { gray_400() })
        .when(on, |d| d.justify_end())
        .child(div().size(px(16.)).rounded(px(8.)).bg(gpui_kit::white()))
}

pub fn small_switch(on: bool) -> Div {
    h_flex()
        .w(px(30.))
        .h(px(18.))
        .p(px(2.))
        .flex_shrink_0()
        .rounded(px(9.))
        .bg(if on { gray_1000() } else { gray_400() })
        .when(on, |d| d.justify_end())
        .child(div().size(px(14.)).rounded(px(7.)).bg(if on {
            background_100()
        } else {
            gray_1000()
        }))
}

pub fn select_button(id: impl Into<ElementId>, value: impl Into<SharedString>) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(30.))
        .px(px(10.))
        .gap(px(6.))
        .flex_shrink_0()
        .rounded(px(8.))
        .cursor_pointer()
        .bg(gray_200())
        .border_1()
        .border_color(alpha_300())
        .hover(|d| d.bg(gray_300()))
        .child(text(13., 18.).child(value.into()))
        .child(icon("chevron-down", 12., gray_900()))
}

pub fn icon_button(id: impl Into<ElementId>, name: &'static str, size: f32) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(28.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .hover(|d| d.bg(alpha_200()))
        .child(icon(name, size, gray_900()))
}
