use crate::app::{AgentState, FxApp};
use crate::design::*;
use crate::fx::acp::{Choice, ConfigOption};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, Context, Div, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Stateful, StatefulInteractiveElement as _, Styled as _, div, px,
};

impl FxApp {
    pub(super) fn default_value(&self, option: Option<&ConfigOption>) -> Option<String> {
        let option = option?;
        self.store
            .defaults
            .get(&option.id)
            .cloned()
            .or_else(|| Some(option.current.clone()))
    }

    pub(super) fn any_option(&self, id: &str) -> Option<ConfigOption> {
        self.any_options()
            .and_then(|o| o.iter().find(|o| o.id == id))
            .cloned()
    }

    pub(super) fn choices_wait(&self, what: &str) -> String {
        if matches!(self.agent, AgentState::Failed(_)) {
            format!("fx is not running; its {what} show once it starts")
        } else if self.workspace().is_none() {
            format!("Open a folder first; fx lists the {what} per session")
        } else {
            format!("Waiting for fx to list the {what}")
        }
    }

    pub(super) fn select_row(
        &self,
        id: &'static str,
        title: &str,
        detail: &str,
        option: Option<ConfigOption>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(option) = option else {
            return row(title, &self.choices_wait("choices"), None);
        };
        let chosen = if option.current.contains('\t') {
            option.current.clone()
        } else {
            self.default_value(Some(&option)).unwrap_or_default()
        };
        let label = option
            .choices
            .iter()
            .find(|c| c.value == chosen)
            .map(|c| crate::app::model_name(&c.name))
            .unwrap_or_else(|| "…".into());
        let open = self.settings.open == Some(id);
        let menu = open.then(|| self.select_menu(id, &option, &chosen, cx));
        let control = div()
            .relative()
            .child(select_trigger(id, label, open, cx))
            .children(menu)
            .into_any_element();
        row(title, detail, Some(control))
    }

    fn select_menu(
        &self,
        id: &'static str,
        option: &ConfigOption,
        chosen: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let rows: Vec<AnyElement> = option
            .choices
            .iter()
            .enumerate()
            .map(|(i, c)| self.select_option(id, i, c, c.value == chosen, cx))
            .collect();
        gpui_kit::deferred(
            div()
                .absolute()
                .top_full()
                .right_0()
                .pt_1()
                .w(px(260.))
                .child(
                    v_flex()
                        .id("select-menu")
                        .max_h(px(320.))
                        .overflow_y_scroll()
                        .p(px(6.))
                        .rounded(px(12.))
                        .bg(gray_100())
                        .border_1()
                        .border_color(alpha_400())
                        .shadow(shadow_pop())
                        .occlude()
                        .on_mouse_down_out(cx.listener(
                            |this, _: &gpui_kit::MouseDownEvent, _, cx| {
                                this.settings.open = None;
                                cx.notify();
                            },
                        ))
                        .children(rows),
                ),
        )
        .with_priority(1)
        .into_any_element()
    }

    fn select_option(
        &self,
        id: &'static str,
        i: usize,
        c: &Choice,
        on: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let value = c.value.clone();
        h_flex()
            .id((id, i))
            .h(px(34.))
            .px(px(10.))
            .gap(px(10.))
            .rounded(px(8.))
            .cursor_pointer()
            .when(on, |d| d.bg(alpha_200()))
            .hover(|d| d.bg(alpha_200()))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                match value.split_once('\t') {
                    Some((account, model)) => {
                        this.store
                            .defaults
                            .insert("provider".into(), account.to_string());
                        this.store
                            .defaults
                            .insert(id.to_string(), model.to_string());
                    }
                    None => {
                        this.store.defaults.insert(id.to_string(), value.clone());
                    }
                }
                this.store.save();
                this.settings.open = None;
                cx.notify();
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .child(crate::app::model_name(&c.name)),
            )
            .when(on, |d| d.child(icon("check", 14., gray_1000())))
            .when(!on, |d| {
                d.children(c.value.split_once('\t').and_then(|(account, _)| {
                    let name = self
                        .catalog
                        .iter()
                        .find(|a| a.value == account)?
                        .name
                        .clone();
                    Some(
                        div()
                            .flex_shrink_0()
                            .text_size(px(12.))
                            .text_color(gray_700())
                            .child(name),
                    )
                }))
            })
            .into_any_element()
    }

    pub(super) fn notify_row(&self, cx: &mut Context<Self>) -> AnyElement {
        row(
            "Notify me",
            "When a turn needs you or finishes in the background",
            Some(
                switch("notify", !self.store.mute)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.store.mute = !this.store.mute;
                        this.store.save();
                        cx.notify();
                    }))
                    .into_any_element(),
            ),
        )
    }
}

fn select_trigger(
    id: &'static str,
    label: String,
    open: bool,
    cx: &mut Context<FxApp>,
) -> Stateful<Div> {
    select_button(id, label)
        .when(open, |d| d.bg(gray_300()))
        .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
            cx.stop_propagation()
        })
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.settings.open = if this.settings.open == Some(id) {
                None
            } else {
                Some(id)
            };
            cx.notify();
        }))
}

pub(crate) fn page_title(
    title: &'static str,
    detail: impl Into<gpui_kit::SharedString>,
) -> impl IntoElement {
    v_flex()
        .gap_1()
        .child(
            div()
                .font_family(display())
                .text_size(px(22.))
                .line_height(px(30.))
                .font_weight(FontWeight::MEDIUM)
                .child(title),
        )
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(20.))
                .text_color(gray_900())
                .child(detail.into()),
        )
}

pub(super) fn row(title: &str, detail: &str, control: Option<AnyElement>) -> AnyElement {
    h_flex()
        .gap_3()
        .min_h(px(60.))
        .px_4()
        .py_2()
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .child(title.to_string()),
                )
                .when(!detail.is_empty(), |d| {
                    d.child(
                        div()
                            .truncate()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(gray_900())
                            .child(detail.to_string()),
                    )
                }),
        )
        .children(control)
        .into_any_element()
}

pub(super) fn card_rows(rows: Vec<AnyElement>) -> gpui_kit::Div {
    rows_card(rows, 16.)
}

pub(crate) fn rows_card(rows: Vec<AnyElement>, inset: f32) -> gpui_kit::Div {
    let count = rows.len();
    let mut card = v_flex()
        .rounded(px(12.))
        .overflow_hidden()
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300());
    for (i, r) in rows.into_iter().enumerate() {
        card = card.child(r);
        if i + 1 < count {
            card = card.child(
                div()
                    .h(px(1.))
                    .ml(px(inset))
                    .when(inset <= 16., |d| d.mr(px(inset)))
                    .bg(alpha_200()),
            );
        }
    }
    card
}

pub(super) fn section_title(title: &'static str) -> Div {
    div()
        .px(px(2.))
        .text_size(px(13.))
        .line_height(px(18.))
        .font_weight(FontWeight::MEDIUM)
        .child(title)
}

pub(super) fn group(title: &'static str, rows: Vec<AnyElement>, inset: f32) -> impl IntoElement {
    let card = rows_card(rows, inset);
    v_flex()
        .gap(px(10.))
        .when(!title.is_empty(), |d| d.child(section_title(title)))
        .child(card)
}
