use super::menu_row;
use crate::app::FxApp;
use crate::design::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    ClickEvent, Context, Div, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Stateful, StatefulInteractiveElement as _, Styled as _, deferred, div, px,
};

fn matched(label: &str, query: &str) -> impl IntoElement {
    let split = if !query.is_empty()
        && label.len() >= query.len()
        && label.is_char_boundary(query.len())
        && label[..query.len()].eq_ignore_ascii_case(query)
    {
        query.len()
    } else {
        0
    };
    h_flex()
        .flex_shrink_0()
        .font_family(MONO)
        .text_size(px(13.))
        .line_height(px(20.))
        .when(split > 0, |d| {
            d.child(
                div()
                    .text_color(blue_900())
                    .child(label[..split].to_string()),
            )
        })
        .child(label[split..].to_string())
}

fn skill_row(row: Stateful<Div>, name: impl IntoElement, detail: &str) -> Stateful<Div> {
    row.h(px(44.))
        .gap(px(12.))
        .child(
            div()
                .w(px(112.))
                .flex_shrink_0()
                .overflow_hidden()
                .child(name),
        )
        .child(
            text(13., 18.)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(gray_900())
                .child(detail.to_string()),
        )
}

fn file_row(
    row: Stateful<Div>,
    name: impl IntoElement,
    detail: &str,
    insert: &str,
    on: bool,
) -> Stateful<Div> {
    let folder = insert.trim_end().ends_with('/');
    row.h(px(36.))
        .child(icon(
            if folder { "folder" } else { "file" },
            14.,
            if on { gray_1000() } else { gray_900() },
        ))
        .child(name)
        .child(
            text(12., 16.)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_right()
                .font_family(MONO)
                .text_color(gray_700())
                .child(detail.to_string()),
        )
}

impl FxApp {
    pub(super) fn render_picker(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let p = self.picker.as_ref()?;
        let skills = p.kind == '/';
        let rows = p
            .items
            .iter()
            .enumerate()
            .map(|(i, (label, detail, insert))| {
                let on = i == p.selected;
                let row = menu_row(("pick", i), on).on_click(cx.listener(
                    move |this, _: &ClickEvent, window, cx| {
                        if let Some(p) = this.picker.as_mut() {
                            p.selected = i;
                        }
                        this.accept_pick(window, cx);
                    },
                ));
                let name = matched(label, &p.query);
                if skills {
                    skill_row(row, name, detail)
                } else {
                    file_row(row, name, detail, insert, on)
                }
            });
        let heading = self.picker_heading(skills);
        let footer = self.picker_footer(skills);
        Some(
            deferred(
                div()
                    .absolute()
                    .left_0()
                    .bottom_full()
                    .pb(px(8.))
                    .w(px(if skills { 520. } else { 460. }))
                    .child(
                        v_flex()
                            .w_full()
                            .p(px(6.))
                            .rounded(px(12.))
                            .bg(background_100())
                            .border_1()
                            .border_color(alpha_400())
                            .shadow(shadow_pop())
                            .occlude()
                            .child(heading)
                            .children(rows)
                            .child(footer),
                    ),
            )
            .with_priority(1),
        )
    }

    fn picker_heading(&self, skills: bool) -> Div {
        let heading = match self.workspace() {
            _ if skills => "Skills".to_string(),
            Some(w) => format!("Files in {}", w.name),
            None => "Files".to_string(),
        };
        text(12., 16.)
            .px(px(8.))
            .py(px(6.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(gray_900())
            .child(heading)
    }

    fn picker_footer(&self, skills: bool) -> Div {
        let hint = |keys: &'static str| text(12., 16.).text_color(gray_900()).child(keys);
        let footer = h_flex()
            .h(px(32.))
            .flex_shrink_0()
            .px(px(8.))
            .gap(px(16.))
            .border_t_1()
            .border_color(alpha_400());
        if skills {
            let count = self.workspace().map_or(0, |w| w.skills.len());
            footer.child(hint("⏎ Use skill")).child(
                text(12., 16.)
                    .flex_1()
                    .text_right()
                    .text_color(gray_700())
                    .child(format!(
                        "{count} skill{}",
                        if count == 1 { "" } else { "s" }
                    )),
            )
        } else {
            footer
                .child(hint("⏎ Attach"))
                .child(hint("Tab Complete path"))
        }
    }
}
