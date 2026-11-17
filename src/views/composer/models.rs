use super::menu_row;
use crate::app::{FxApp, ModelSearch, model_name};
use crate::design::*;
use crate::fx::acp::{Choice, ConfigOption};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AppContext as _, ClickEvent, Context, Div, Focusable as _, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Stateful, StatefulInteractiveElement as _,
    Styled as _, Window, div, px,
};

struct ModelRow {
    account: String,
    account_name: String,
    connected: bool,
    choice: Choice,
}

fn matching(rows: Vec<ModelRow>, query: &str) -> Vec<ModelRow> {
    let query = query.to_lowercase();
    rows.into_iter()
        .filter(|r| r.connected)
        .filter(|r| {
            query.is_empty()
                || model_name(&r.choice.name).to_lowercase().contains(&query)
                || r.choice.value.to_lowercase().contains(&query)
                || r.account_name.to_lowercase().contains(&query)
        })
        .collect()
}

fn offline_accounts(rows: &[ModelRow], query: &str) -> Vec<String> {
    let mut offline: Vec<String> = Vec::new();
    if query.is_empty() {
        for r in rows {
            if !r.connected && !offline.contains(&r.account_name) {
                offline.push(r.account_name.clone());
            }
        }
    }
    offline
}

fn account_heading(name: String, logo: Option<&'static str>, first: bool) -> Div {
    h_flex()
        .h(px(28.))
        .flex_shrink_0()
        .px(px(8.))
        .gap(px(8.))
        .when(!first, |d| d.mt(px(4.)))
        .children(logo.map(|path| {
            gpui_kit::svg()
                .path(path)
                .size(px(12.))
                .flex_shrink_0()
                .text_color(gray_900())
        }))
        .child(
            text(12., 16.)
                .flex_1()
                .font_weight(FontWeight::MEDIUM)
                .text_color(gray_900())
                .child(name),
        )
}

fn model_label(name: &str, query: &str) -> Div {
    let hit = (!query.is_empty())
        .then(|| name.to_lowercase().find(&query.to_lowercase()))
        .flatten()
        .filter(|&s| name.is_char_boundary(s) && name.is_char_boundary(s + query.len()));
    h_flex()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .map(|d| match hit {
            Some(s) => d
                .child(div().flex_shrink_0().child(name[..s].to_string()))
                .child(
                    div()
                        .flex_shrink_0()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(name[s..s + query.len()].to_string()),
                )
                .child(div().truncate().child(name[s + query.len()..].to_string())),
            None => d.child(div().truncate().child(name.to_string())),
        })
}

fn model_choice(
    i: usize,
    r: &ModelRow,
    on: bool,
    aim: bool,
    query: &str,
    cx: &mut Context<FxApp>,
) -> Stateful<Div> {
    let (to, value) = (r.account.clone(), r.choice.value.clone());
    let maker = r
        .choice
        .value
        .split_once('/')
        .map(|(maker, _)| maker.to_string());
    let name = model_name(&r.choice.name);
    menu_row(("model-choice", i), aim)
        .h(px(32.))
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.pop = None;
            this.pick_model(to.clone(), value.clone(), cx);
        }))
        .gap(px(8.))
        .child(
            text(13., 20.)
                .flex_1()
                .min_w_0()
                .flex()
                .child(model_label(&name, query)),
        )
        .map(|d| {
            if on {
                d.child(icon("check", 14., gray_1000()))
            } else if aim && !query.is_empty() {
                d.child(text(12., 16.).text_color(gray_900()).child("⏎"))
            } else {
                d.children(maker.map(|maker| {
                    text(12., 16.)
                        .flex_shrink_0()
                        .text_color(gray_700())
                        .child(maker)
                }))
            }
        })
}

fn offline_account(i: usize, name: String, first: bool, cx: &mut Context<FxApp>) -> Div {
    account_heading(name, None, first).child(
        text(12., 16.)
            .id(("connect-account", i))
            .cursor_pointer()
            .text_color(blue_900())
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                this.pop = None;
                this.open_section(crate::views::settings::Section::Models, window, cx);
            }))
            .child("Sign in"),
    )
}

fn no_model_matches() -> Div {
    text(13., 18.)
        .py(px(18.))
        .flex()
        .justify_center()
        .text_color(gray_700())
        .child("No model matches")
}

fn model_footer(found: usize, total: usize, query: &str) -> Div {
    h_flex()
        .h(px(32.))
        .flex_shrink_0()
        .px(px(14.))
        .bg(background_200())
        .border_t_1()
        .border_color(alpha_400())
        .child(
            text(12., 16.)
                .flex_1()
                .text_color(gray_700())
                .child(if query.is_empty() {
                    format!("{total} model{}", if total == 1 { "" } else { "s" })
                } else {
                    format!("{found} of {total}")
                }),
        )
        .child(
            text(12., 16.)
                .text_color(gray_900())
                .child("↑↓ Navigate   ⏎ Use"),
        )
}

impl FxApp {
    pub(super) fn account(&self) -> String {
        self.session()
            .and_then(|s| s.option("provider"))
            .map(|o| o.current.clone())
            .unwrap_or_default()
    }

    fn model_rows(&self, model: &ConfigOption) -> Vec<ModelRow> {
        let account = self.account();
        if self.catalog.is_empty() {
            return model
                .choices
                .iter()
                .map(|c| ModelRow {
                    account: account.clone(),
                    account_name: "Models".into(),
                    connected: true,
                    choice: c.clone(),
                })
                .collect();
        }
        self.catalog
            .iter()
            .flat_map(|a| {
                let here = a.value == account;
                let custom = crate::views::settings::account_logo(&a.value).is_none();
                let connected =
                    here || custom || self.settings.signed_in.iter().any(|s| *s == a.value);
                let models = if here { &model.choices } else { &a.models };
                models.iter().map(move |c| ModelRow {
                    account: a.value.clone(),
                    account_name: a.name.clone(),
                    connected,
                    choice: c.clone(),
                })
            })
            .collect()
    }

    fn model_query(&self, cx: &gpui_kit::App) -> String {
        self.model_search
            .as_ref()
            .map(|s| s.input.read(cx).value().trim().to_string())
            .unwrap_or_default()
    }

    fn model_matches(&self, model: &ConfigOption, cx: &gpui_kit::App) -> Vec<ModelRow> {
        matching(self.model_rows(model), &self.model_query(cx))
    }

    pub(super) fn open_model_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        let subscription =
            cx.subscribe_in(
                &input,
                window,
                |this, _, event: &InputEvent, _, cx| match event {
                    InputEvent::Change => {
                        if let Some(search) = this.model_search.as_mut() {
                            search.at = 0;
                        }
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => this.pick_listed(cx),
                    _ => {}
                },
            );
        input.read(cx).focus_handle(cx).focus(window, cx);
        self.model_search = Some(ModelSearch {
            input,
            at: 0,
            _subscription: subscription,
        });
        let account = self.account();
        if let Some(model) = self.session().and_then(|s| s.option("model")).cloned() {
            let at = self
                .model_matches(&model, cx)
                .iter()
                .position(|r| r.account == account && r.choice.value == model.current);
            if let (Some(at), Some(search)) = (at, self.model_search.as_mut()) {
                search.at = at;
            }
        }
    }

    fn pick_listed(&mut self, cx: &mut Context<Self>) {
        let Some(model) = self.session().and_then(|s| s.option("model")).cloned() else {
            return;
        };
        let at = self.model_search.as_ref().map_or(0, |s| s.at);
        let Some(row) = self.model_matches(&model, cx).into_iter().nth(at) else {
            return;
        };
        self.pop = None;
        self.pick_model(row.account, row.choice.value, cx);
    }

    fn model_keys(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(model) = self.session().and_then(|s| s.option("model")).cloned() else {
            return;
        };
        let count = self.model_matches(&model, cx).len().max(1);
        let Some(search) = self.model_search.as_mut() else {
            return;
        };
        match event.keystroke.key.as_str() {
            "up" => search.at = (search.at + count - 1) % count,
            "down" => search.at = (search.at + 1) % count,
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn model_menu(
        &self,
        model: &ConfigOption,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let account = self.account();
        let query = self.model_query(cx);
        let all = self.model_rows(model);
        let total = all.iter().filter(|r| r.connected).count();
        let at = self.model_search.as_ref().map_or(0, |s| s.at);
        let offline = offline_accounts(&all, &query);
        let rows = matching(all, &query);
        let found = rows.len();
        let mut list = v_flex()
            .id("models")
            .max_h(px(320.))
            .overflow_y_scroll()
            .p(px(6.));
        let mut last_account = String::new();
        for (i, r) in rows.into_iter().enumerate() {
            if r.account != last_account {
                list = list.child(account_heading(
                    r.account_name.clone(),
                    crate::views::settings::account_logo(&r.account),
                    last_account.is_empty(),
                ));
                last_account = r.account.clone();
            }
            let on = r.account == account && r.choice.value == model.current;
            list = list.child(model_choice(i, &r, on, i == at, &query, cx));
        }
        for (i, name) in offline.into_iter().enumerate() {
            list = list.child(offline_account(
                i,
                name,
                last_account.is_empty() && i == 0,
                cx,
            ));
        }
        if found == 0 {
            list = list.child(no_model_matches());
        }
        v_flex()
            .capture_key_down(cx.listener(Self::model_keys))
            .child(self.model_search_row())
            .child(list)
            .child(model_footer(found, total, &query))
    }

    fn model_search_row(&self) -> Div {
        let search = self.model_search.as_ref().map(|s| s.input.clone());
        h_flex()
            .h(px(40.))
            .flex_shrink_0()
            .pl(px(12.))
            .pr(px(4.))
            .border_b_1()
            .border_color(alpha_400())
            .child(icon("search", 14., gray_900()))
            .children(search.map(|input| {
                text(13., 20.)
                    .flex_1()
                    .child(Input::new(&input).appearance(false))
            }))
    }
}
