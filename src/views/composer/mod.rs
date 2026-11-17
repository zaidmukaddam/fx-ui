mod menus;
mod models;
mod picker;
mod usage;

use crate::app::{FxApp, Pop, Queued, Session, choice_name, clipboard_images, model_name};
use crate::design::*;
use crate::fx::acp::{ConfigOption, Recovery};
use crate::views::shell::menu_item;
use gpui_kit::component::input::{self, Textarea};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, ClickEvent, Context, Div, Focusable as _, Image, InteractiveElement as _,
    IntoElement, MouseButton, MouseDownEvent, ObjectFit, ParentElement as _, PathBuilder, Stateful,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, canvas, deferred, div,
    img, point, px,
};
use std::sync::Arc;

fn pop_toggle(
    pop: Pop,
    cx: &mut Context<FxApp>,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    cx.listener(move |this: &mut FxApp, _: &ClickEvent, window, cx| {
        if this.just_closed.take() == Some(pop) {
            return;
        }
        this.pop = if this.pop == Some(pop) {
            None
        } else {
            Some(pop)
        };
        this.picker = None;
        if this.pop == Some(Pop::Model) {
            this.open_model_search(window, cx);
        }
        if this.pop == Some(Pop::Usage) {
            this.load_plan(cx);
        }
        cx.notify();
    })
}

fn bars(lit: usize, on: gpui_kit::Hsla) -> Div {
    h_flex()
        .size(px(14.))
        .flex_shrink_0()
        .items_end()
        .justify_between()
        .pb(px(1.))
        .children([4., 7., 10., 13.].into_iter().enumerate().map(|(i, h)| {
            div()
                .w(px(2.5))
                .h(px(h))
                .rounded(px(0.75))
                .bg(if i < lit { on } else { gray_500() })
        }))
}

pub(crate) struct Thinking {
    pub rank: usize,
    pub bars: usize,
    pub label: String,
    pub about: &'static str,
}

pub(crate) fn thinking(value: &str, name: &str) -> Thinking {
    let (rank, bars, label, about) = match value {
        "default" | "auto" => (0, 0, "Default", "What the model prefers"),
        "none" | "off" => (1, 0, "Off", "Answers straight away"),
        "minimal" => (2, 1, "Minimal", "Barely pauses"),
        "low" => (3, 1, "Low", "A brief think first"),
        "medium" => (4, 2, "Medium", "For everyday changes"),
        "high" => (5, 3, "High", "Longer on hard problems"),
        "xhigh" | "max" => (6, 4, "Max", "As long as it takes"),
        _ => {
            return Thinking {
                rank: 7,
                bars: 0,
                label: model_name(name),
                about: "",
            };
        }
    };
    Thinking {
        rank,
        bars,
        label: label.to_string(),
        about,
    }
}

fn pill(id: &'static str) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(32.))
        .flex_shrink_0()
        .gap(px(6.))
        .rounded(px(16.))
        .cursor_pointer()
        .hover(|d| d.bg(alpha_200()))
}

fn round_button(id: &'static str, stop: bool) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(32.))
        .flex_shrink_0()
        .rounded(px(16.))
        .cursor_pointer()
        .bg(gray_1000())
        .hover(|d| d.bg(gpui_kit::white()))
        .flex()
        .items_center()
        .justify_center()
        .child(if stop {
            div()
                .size(px(10.))
                .rounded(px(2.))
                .bg(background_100())
                .into_any_element()
        } else {
            icon("arrow-up", 16., background_100()).into_any_element()
        })
}

fn ring(fraction: f32) -> impl IntoElement {
    let fraction = fraction.clamp(0.02, 0.999);
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let c = bounds.center();
            let r = px(6.3);
            let top = point(c.x, c.y - r);
            let mut track = PathBuilder::stroke(px(1.8));
            track.move_to(top);
            track.arc_to(point(r, r), px(0.), false, true, point(c.x, c.y + r));
            track.arc_to(point(r, r), px(0.), false, true, top);
            if let Ok(path) = track.build() {
                window.paint_path(path, gray_400());
            }
            let angle = fraction * std::f32::consts::TAU;
            let end = point(c.x + r * angle.sin(), c.y - r * angle.cos());
            let mut arc = PathBuilder::stroke(px(1.8));
            arc.move_to(top);
            arc.arc_to(point(r, r), px(0.), fraction > 0.5, true, end);
            if let Ok(path) = arc.build() {
                window.paint_path(
                    path,
                    if fraction > 0.8 {
                        amber_700()
                    } else {
                        gray_900()
                    },
                );
            }
        },
    )
    .size(px(18.))
}

fn menu_row(id: (&'static str, usize), on: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .flex_shrink_0()
        .px(px(8.))
        .gap(px(10.))
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |d| d.bg(alpha_200()))
        .hover(|d| d.bg(alpha_200()))
}

fn branch_label(branch: String) -> Div {
    h_flex()
        .h(px(32.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(6.))
        .child(icon("branch", 14., gray_900()))
        .child(
            text(12., 16.)
                .font_family(MONO)
                .text_color(gray_900())
                .child(branch),
        )
}

fn shot(i: usize, image: &Arc<Image>, cx: &mut Context<FxApp>) -> Stateful<Div> {
    div()
        .id(("shot", i))
        .group("shot")
        .relative()
        .size(px(56.))
        .flex_shrink_0()
        .child(
            img(image.clone())
                .size(px(56.))
                .rounded(px(10.))
                .object_fit(ObjectFit::Cover),
        )
        .child(
            div()
                .absolute()
                .size_full()
                .top_0()
                .left_0()
                .rounded(px(10.))
                .border_1()
                .border_color(alpha_300()),
        )
        .child(
            div()
                .id(("shot-remove", i))
                .absolute()
                .top(px(-8.))
                .right(px(-8.))
                .size(px(22.))
                .rounded(px(11.))
                .bg(gray_100())
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .invisible()
                .group_hover("shot", |s| s.visible())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    if i < this.attachments.len() {
                        this.attachments.remove(i);
                    }
                    cx.notify();
                }))
                .child(
                    div()
                        .size(px(18.))
                        .rounded(px(9.))
                        .bg(gray_1000())
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("x", 10., background_100())),
                ),
        )
}

fn dock_row(label: &'static str, said: String) -> Div {
    h_flex()
        .h(px(30.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(10.))
        .rounded(px(8.))
        .child(
            text(12., 16.)
                .w(px(56.))
                .flex_shrink_0()
                .text_color(gray_700())
                .child(label),
        )
        .child(text(13., 18.).flex_1().min_w_0().truncate().child(said))
}

fn retry_row(retry: &Recovery) -> Div {
    let attempt = match retry.attempt {
        0 | 1 => "Retrying".to_string(),
        n => format!("Retrying · attempt {n}"),
    };
    h_flex()
        .h(px(30.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(10.))
        .child(spinner_in(12., amber_700()))
        .child(text(13., 18.).flex_shrink_0().child(attempt))
        .child(
            text(13., 18.)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(gray_700())
                .child(retry.message.clone()),
        )
}

fn queued_row(
    i: usize,
    queued: &Queued,
    at: (usize, usize),
    cx: &mut Context<FxApp>,
) -> Stateful<Div> {
    let said = match queued.text.lines().next() {
        Some(line) => line.to_string(),
        None => "Images".into(),
    };
    let count = match queued.images.len() {
        0 => None,
        1 => Some("1 image".to_string()),
        n => Some(format!("{n} images")),
    };
    dock_row(if i == 0 { "Next" } else { "Then" }, said)
        .id(("queued", i))
        .group("queued")
        .hover(|d| d.bg(alpha_100()))
        .children(count.map(|count| {
            text(12., 16.)
                .flex_shrink_0()
                .text_color(gray_700())
                .child(count)
        }))
        .child(
            div()
                .id(("queued-remove", i))
                .size(px(20.))
                .flex_shrink_0()
                .rounded(px(5.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .invisible()
                .group_hover("queued", |s| s.visible())
                .hover(|d| d.bg(alpha_300()))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    let queue = this
                        .workspaces
                        .get_mut(at.0)
                        .and_then(|w| w.sessions.get_mut(at.1))
                        .map(|s| &mut s.queue);
                    if let Some(queue) = queue.filter(|q| i < q.len()) {
                        queue.remove(i);
                    }
                    cx.notify();
                }))
                .child(icon("x", 12., gray_900())),
        )
}

struct Controls {
    running: bool,
    home: bool,
    mode: Option<ConfigOption>,
    model: Option<ConfigOption>,
    effort: Option<ConfigOption>,
    fast: Option<ConfigOption>,
    ultrafast: Option<ConfigOption>,
    usage: Option<(u64, u64)>,
}

impl FxApp {
    pub(crate) fn render_composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let controls = self.composer_controls();
        let toolbar = self.composer_toolbar(&controls, cx);
        let popover = self.composer_popover(&controls, cx);
        let images = self.attachments_row(cx);
        let field = self.draft_field(cx);
        let composer = div()
            .relative()
            .w_full()
            .children(self.render_picker(cx))
            .children(popover.map(|p| deferred(p).with_priority(1)))
            .child(
                self.composer_card(cx)
                    .children(images)
                    .child(div().mx(px(-4.)).mt(px(-8.)).mb(px(-4.)).child(field))
                    .child(toolbar),
            );
        v_flex()
            .w_full()
            .gap(px(6.))
            .children(self.dock(cx))
            .child(composer)
    }

    fn composer_controls(&self) -> Controls {
        let session = self.session();
        let home = session.is_none_or(Session::is_empty);
        Controls {
            running: session.is_some_and(|s| s.thread.running()),
            home,
            mode: session.and_then(|s| s.option("mode")).cloned(),
            model: session.and_then(|s| s.option("model")).cloned(),
            effort: session.and_then(|s| s.option("effort")).cloned(),
            fast: session.and_then(|s| s.option("fast")).cloned(),
            ultrafast: session.and_then(|s| s.option("ultrafast")).cloned(),
            usage: session.and_then(|s| s.thread.usage).filter(|_| !home),
        }
    }

    fn composer_toolbar(&self, controls: &Controls, cx: &mut Context<Self>) -> Div {
        let fast_on = [&controls.fast, &controls.ultrafast]
            .into_iter()
            .flatten()
            .any(|f| crate::fx::acp::is_on(&f.current));
        let branch = self
            .workspace()
            .and_then(|w| w.branch.clone())
            .filter(|_| controls.home)
            .map(branch_label);
        h_flex()
            .gap(px(4.))
            .child(self.attach_pill(cx))
            .child(self.mode_pill(controls.mode.as_ref(), cx))
            .child(div().flex_1())
            .child(self.model_pill(controls.model.as_ref(), cx))
            .children(
                controls
                    .effort
                    .as_ref()
                    .map(|e| self.thinking_pill(e, fast_on, cx)),
            )
            .children(branch)
            .children(
                controls
                    .usage
                    .map(|(used, size)| self.usage_pill(used, size, cx)),
            )
            .child(self.send_button(controls.running, cx))
    }

    fn attach_pill(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        pill("attach")
            .w(px(32.))
            .justify_center()
            .border_1()
            .border_color(alpha_400())
            .when(self.pop == Some(Pop::Attach), |d| d.bg(alpha_200()))
            .on_click(pop_toggle(Pop::Attach, cx))
            .child(icon("plus-lg", 16., gray_1000()))
    }

    fn mode_pill(&self, mode: Option<&ConfigOption>, cx: &mut Context<Self>) -> Stateful<Div> {
        pill("mode-pill")
            .px(px(12.))
            .border_1()
            .border_color(alpha_400())
            .when(self.pop == Some(Pop::Mode), |d| d.bg(alpha_200()))
            .on_click(pop_toggle(Pop::Mode, cx))
            .child(icon("shield", 14., gray_1000()))
            .child(text(13., 18.).child(choice_name(mode)))
    }

    fn model_pill(&self, model: Option<&ConfigOption>, cx: &mut Context<Self>) -> Stateful<Div> {
        let logo = self
            .session()
            .and_then(|s| s.option("provider"))
            .and_then(|o| crate::views::settings::account_logo(&o.current));
        pill("model-pill")
            .px(px(10.))
            .gap(px(7.))
            .when(self.pop == Some(Pop::Model), |d| d.bg(alpha_200()))
            .on_click(pop_toggle(Pop::Model, cx))
            .children(logo.map(|path| {
                gpui_kit::svg()
                    .path(path)
                    .size(px(14.))
                    .flex_shrink_0()
                    .text_color(gray_900())
            }))
            .child(
                text(13., 18.)
                    .text_color(gray_900())
                    .child(model_name(&choice_name(model))),
            )
            .child(icon("chevron-down", 12., gray_900()))
    }

    fn thinking_pill(
        &self,
        effort: &ConfigOption,
        fast_on: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let Thinking {
            bars: lit, label, ..
        } = thinking(&effort.current, &choice_name(Some(effort)));
        pill("thinking-pill")
            .px(px(10.))
            .gap(px(7.))
            .when(self.pop == Some(Pop::Thinking), |d| d.bg(alpha_200()))
            .on_click(pop_toggle(Pop::Thinking, cx))
            .child(bars(lit, gray_900()))
            .child(text(13., 18.).text_color(gray_900()).child(label))
            .when(fast_on, |d| d.child(icon("bolt", 12., gray_900())))
    }

    fn usage_pill(&self, used: u64, size: u64, cx: &mut Context<Self>) -> Stateful<Div> {
        pill("usage")
            .w(px(32.))
            .justify_center()
            .when(self.pop == Some(Pop::Usage), |d| d.bg(alpha_200()))
            .on_click(pop_toggle(Pop::Usage, cx))
            .child(ring(used as f32 / size.max(1) as f32))
    }

    fn send_button(&self, running: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let drafted =
            !self.input.read(cx).value().trim().is_empty() || !self.attachments.is_empty();
        if running && !drafted {
            round_button("stop", true)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.stop(cx)))
        } else {
            round_button("send", false)
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.send(window, cx)))
        }
    }

    fn composer_popover(&self, controls: &Controls, cx: &mut Context<Self>) -> Option<AnyElement> {
        match self.pop {
            Some(Pop::Attach) => Some(self.attach_menu(cx).into_any_element()),
            Some(Pop::Mode) => controls.mode.as_ref().map(|m| {
                self.pop_card(cx)
                    .left(px(40.))
                    .w(px(340.))
                    .child(self.mode_menu(m, cx))
                    .into_any_element()
            }),
            Some(Pop::Model) => controls.model.as_ref().map(|m| {
                self.pop_card(cx)
                    .right_0()
                    .w(px(360.))
                    .child(self.model_menu(m, cx))
                    .into_any_element()
            }),
            Some(Pop::Thinking) => controls.effort.as_ref().map(|e| {
                self.pop_card(cx)
                    .right(px(if controls.home { 0. } else { 72. }))
                    .w(px(300.))
                    .child(self.thinking_menu(
                        e,
                        controls.fast.as_ref(),
                        controls.ultrafast.as_ref(),
                        cx,
                    ))
                    .into_any_element()
            }),
            Some(Pop::Usage) => controls.usage.map(|(used, size)| {
                self.pop_card(cx)
                    .right_0()
                    .w(px(300.))
                    .child(self.usage_menu(used, size))
                    .into_any_element()
            }),
            None => None,
        }
    }

    fn attach_menu(&self, cx: &mut Context<Self>) -> Div {
        self.pop_card(cx)
            .left_0()
            .w(px(220.))
            .p(px(6.))
            .rounded(px(12.))
            .child(
                menu_item("attach-file", "file", "Mention a file", "@", false).on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.pop = None;
                        this.attach(window, cx);
                    }),
                ),
            )
            .child(
                menu_item("attach-choose", "image", "Choose images…", "", false)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.choose_images(cx))),
            )
            .child(
                menu_item("attach-paste", "copy", "Paste image", "⌘V", false)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.paste_images(cx))),
            )
    }

    fn attachments_row(&self, cx: &mut Context<Self>) -> Option<Div> {
        (!self.attachments.is_empty()).then(|| {
            h_flex().gap(px(8.)).pb(px(4.)).children(
                self.attachments
                    .iter()
                    .enumerate()
                    .map(|(i, image)| shot(i, image, cx)),
            )
        })
    }

    fn draft_field(&self, cx: &mut Context<Self>) -> Textarea {
        let app = cx.entity().downgrade();
        Textarea::new(&self.input)
            .appearance(false)
            .on_paste(move |item, _, cx| {
                let images = clipboard_images(item, false);
                !images.is_empty()
                    && app
                        .update(cx, |this, cx| this.attach_images(images, cx))
                        .is_ok()
            })
    }

    fn composer_card(&self, cx: &mut Context<Self>) -> Div {
        v_flex()
            .w_full()
            .gap(px(8.))
            .pt(px(if self.attachments.is_empty() {
                14.
            } else {
                10.
            }))
            .px(px(10.))
            .pb(px(10.))
            .rounded(px(20.))
            .bg(gray_100().opacity(0.94))
            .border_1()
            .border_color(alpha_400())
            .shadow(shadow_composer())
            .cursor_text()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    let handle = this.input.read(cx).focus_handle(cx);
                    if !handle.is_focused(window) {
                        handle.focus(window, cx);
                    }
                }),
            )
            .capture_action(cx.listener(|this, _: &input::MoveUp, _, cx| {
                let count = this.picker.as_ref().map_or(1, |p| p.items.len().max(1));
                this.picker_step(count - 1, cx)
            }))
            .capture_action(cx.listener(|this, _: &input::MoveDown, _, cx| this.picker_step(1, cx)))
            .capture_action(cx.listener(|this, _: &input::IndentInline, window, cx| {
                if this.picker.is_some() {
                    this.accept_pick(window, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &input::Escape, _, cx| {
                if this.picker.take().is_some() {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
    }

    fn dock(&self, cx: &mut Context<Self>) -> Option<Div> {
        let session = self.session()?;
        let at = self.active?;
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(retry) = &session.thread.recovery {
            rows.push(retry_row(retry).into_any_element());
        }
        for said in &session.steering {
            rows.push(
                dock_row("Steering", said.clone())
                    .child(spinner(12.))
                    .into_any_element(),
            );
        }
        for (i, queued) in session.queue.iter().enumerate() {
            rows.push(queued_row(i, queued, at, cx).into_any_element());
        }
        (!rows.is_empty()).then(|| v_flex().px(px(6.)).children(rows))
    }

    fn pop_card(&self, cx: &mut Context<Self>) -> Div {
        v_flex()
            .absolute()
            .bottom(px(48.))
            .rounded(px(12.))
            .overflow_hidden()
            .bg(background_100())
            .border_1()
            .border_color(alpha_400())
            .shadow(shadow_pop())
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, _, cx| {
                this.just_closed = this.pop.take();
                cx.notify();
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_levels_go_by_meaning_not_list_order() {
        let listed = ["default", "xhigh", "high", "medium", "low"];
        let bars = |v: &str| thinking(v, v).bars;
        assert_eq!(listed.map(bars), [0, 4, 3, 2, 1]);
        let mut sorted = listed;
        sorted.sort_by_key(|v| thinking(v, v).rank);
        assert_eq!(sorted, ["default", "low", "medium", "high", "xhigh"]);
        assert_eq!(thinking("xhigh", "xhigh").label, "Max");
        assert_eq!(thinking("none", "none").about, "Answers straight away");
        let unknown = thinking("ultra", "ultra");
        assert_eq!(
            (unknown.rank, unknown.bars, unknown.label.as_str()),
            (7, 0, "Ultra")
        );
    }
}
