use super::rows::{group, page_title, row, section_title};
use crate::app::FxApp;
use crate::design::*;
use crate::fx::acp::{Choice, ConfigOption};
use crate::fx::cli::fx_in;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, Div, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, div, px,
};

impl FxApp {
    fn extra_run(&mut self, action: &'static str, path: String, cx: &mut Context<Self>) {
        let Some(cwd) = self.workspace().map(|w| w.path.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_spawn(async move { fx_in(&cwd, &["workspace", action, &path]) })
                .await;
            let _ = this.update(cx, |this, cx| this.refresh_extra(cx));
        })
        .detach();
    }

    fn extra_add(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: true,
            prompt: Some("Add".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                for path in paths {
                    this.extra_run("add", path.display().to_string(), cx);
                }
            });
        })
        .detach();
    }

    pub(super) fn behaviour_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap(px(32.))
            .child(page_title(
                "Behaviour",
                "How new sessions think, and what they may do without asking.",
            ))
            .child(group("New sessions", self.default_rows(cx), 16.))
            .children(self.settings.instructions.as_ref().map(instructions_field))
            .children(self.workspace().map(|w| self.extra_folders(&w.name, cx)))
            .child(always_allowed(&self.settings.permissions))
    }

    fn default_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut rows = vec![self.thinking_row(cx)];
        rows.extend(self.any_option("fast").map(|fast| self.fast_row(&fast, cx)));
        rows.push(self.notify_row(cx));
        rows
    }

    fn thinking_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(effort) = self.any_option("effort") else {
            return row("Thinking", &self.choices_wait("levels"), None);
        };
        let chosen = self.default_value(Some(&effort)).unwrap_or_default();
        let mut levels: Vec<_> = effort.choices.iter().collect();
        levels.sort_by_key(|c| crate::views::composer::thinking(&c.value, &c.name).rank);
        let segments: Vec<AnyElement> = levels
            .into_iter()
            .enumerate()
            .map(|(i, c)| thinking_segment(i, c, c.value == chosen, cx))
            .collect();
        v_flex()
            .gap(px(14.))
            .p_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .child("Thinking"),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(gray_900())
                            .child("More thinking is slower and costs more, and catches more."),
                    ),
            )
            .child(
                h_flex()
                    .h(px(32.))
                    .p(px(2.))
                    .gap(px(2.))
                    .rounded(px(9.))
                    .bg(background_100())
                    .border_1()
                    .border_color(alpha_300())
                    .children(segments),
            )
            .into_any_element()
    }

    fn fast_row(&self, fast: &ConfigOption, cx: &mut Context<Self>) -> AnyElement {
        let chosen = self.default_value(Some(fast)).unwrap_or_default();
        let on = crate::fx::acp::is_on(&chosen);
        let next = fast
            .choices
            .iter()
            .find(|c| c.value != chosen)
            .map(|c| c.value.clone())
            .unwrap_or_default();
        row(
            "Fast mode",
            "Quicker answers on models that offer it",
            Some(
                switch("fast-default", on)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.store.defaults.insert("fast".into(), next.clone());
                        this.store.save();
                        cx.notify();
                    }))
                    .into_any_element(),
            ),
        )
    }

    fn extra_folders(&self, workspace: &str, cx: &mut Context<Self>) -> AnyElement {
        let mut rows: Vec<AnyElement> = self
            .settings
            .extra
            .iter()
            .enumerate()
            .map(|(i, path)| extra_folder_row(i, path, cx))
            .collect();
        rows.push(row(
            if rows.is_empty() {
                "Only this folder"
            } else {
                "Add another"
            },
            &format!("fx reaches these as well as {workspace}"),
            Some(
                outline_button("extra-add", "Add folder…", None)
                    .h(px(30.))
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.extra_add(cx)))
                    .into_any_element(),
            ),
        ));
        group("Extra folders", rows, 16.).into_any_element()
    }
}

fn thinking_segment(i: usize, c: &Choice, on: bool, cx: &mut Context<FxApp>) -> AnyElement {
    let value = c.value.clone();
    div()
        .id(("thinking", i))
        .flex_1()
        .h_full()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .cursor_pointer()
        .text_size(px(13.))
        .text_color(if on { gray_1000() } else { gray_900() })
        .when(on, |d| d.bg(gray_300()).font_weight(FontWeight::MEDIUM))
        .when(!on, |d| d.hover(|d| d.text_color(gray_1000())))
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.store.defaults.insert("effort".into(), value.clone());
            this.store.save();
            cx.notify();
        }))
        .child(crate::views::composer::thinking(&c.value, &c.name).label)
        .into_any_element()
}

fn instructions_field(field: &Entity<TextareaState>) -> Div {
    v_flex()
        .gap(px(10.))
        .child(section_title("Instructions"))
        .child(
            div()
                .rounded(px(12.))
                .bg(gray_100())
                .border_1()
                .border_color(alpha_300())
                .px(px(6.))
                .py(px(4.))
                .child(Textarea::new(field).appearance(false)),
        )
        .child(footnote(
            "Added to every new session, after fx's own instructions.",
        ))
}

fn extra_folder_row(i: usize, path: &str, cx: &mut Context<FxApp>) -> AnyElement {
    let remove = path.to_string();
    h_flex()
        .h(px(48.))
        .px_4()
        .gap_3()
        .child(icon("folder", 16., gray_900()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(MONO)
                .text_size(px(13.))
                .child(path.to_string()),
        )
        .child(
            text_button(("extra-remove", i), "Remove")
                .h(px(30.))
                .font_weight(FontWeight::NORMAL)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.extra_run("remove", remove.clone(), cx)
                })),
        )
        .into_any_element()
}

fn always_allowed(rules: &[String]) -> Div {
    v_flex()
        .gap(px(10.))
        .child(group("Always allowed", rule_rows(rules), 52.))
        .child(footnote(
            "Added when you choose Always allow on an approval.",
        ))
}

fn rule_rows(rules: &[String]) -> Vec<AnyElement> {
    if rules.is_empty() {
        return vec![row(
            "Nothing is always allowed yet",
            "Choose Always allow on an approval to add a rule here",
            None,
        )];
    }
    rules.iter().map(|r| rule_row(r)).collect()
}

fn rule_row(rule: &str) -> AnyElement {
    h_flex()
        .h(px(48.))
        .px_4()
        .gap_3()
        .child(
            div()
                .size(px(24.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .bg(gray_200())
                .font_family(MONO)
                .text_size(px(12.))
                .text_color(gray_900())
                .child("$"),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(MONO)
                .text_size(px(13.))
                .child(rule.to_string()),
        )
        .into_any_element()
}

fn footnote(text: &'static str) -> Div {
    div()
        .px(px(2.))
        .text_size(px(12.))
        .text_color(gray_700())
        .child(text)
}
