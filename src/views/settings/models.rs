use super::ACCOUNTS;
use super::rows::{group, page_title};
use crate::app::{FxApp, capitalized};
use crate::design::*;
use crate::fx::acp::ConfigOption;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, Context, Div, FontWeight, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};

impl FxApp {
    pub(super) fn models_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let connected = self.default_connected() || !self.settings.signed_in.is_empty();
        let accounts: Vec<AnyElement> = ACCOUNTS
            .iter()
            .enumerate()
            .map(|(i, &account)| self.sign_in_row(i, account, cx))
            .collect();
        let rows = self.new_session_rows(cx);

        v_flex()
            .gap(px(32.))
            .child(page_title(
                "Models & accounts",
                if connected {
                    "fx answers with whichever account the chosen model belongs to."
                } else {
                    "Connect one account and fx can start answering."
                },
            ))
            .when(!connected && self.settings.status.is_some(), |d| {
                d.child(nothing_connected())
            })
            .child(group("Accounts", accounts, 56.))
            .child(group("New sessions", rows, 16.))
    }

    fn default_account(&self) -> &str {
        self.settings
            .fx
            .as_ref()
            .and_then(|f| f["provider"].as_str())
            .unwrap_or("")
    }

    fn default_connected(&self) -> bool {
        self.settings.status.as_ref().is_some_and(|s| s.connected())
    }

    fn sign_in_row(
        &self,
        i: usize,
        (value, name, login, logo): (&'static str, &'static str, &'static str, &'static str),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_default = value == self.default_account();
        let in_use = if is_default {
            self.default_connected()
        } else {
            self.settings.signed_in.contains(&value)
        };
        let action = if in_use {
            connected_actions(i, value, login, is_default, cx)
        } else {
            connect_button(i, value, login, cx)
        };
        h_flex()
            .gap_3()
            .min_h(px(60.))
            .px_4()
            .child(account_badge(logo, in_use))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(14.)).line_height(px(20.)).child(name))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(gray_900())
                            .child(self.account_detail(value, in_use, is_default)),
                    ),
            )
            .child(action)
            .into_any_element()
    }

    fn account_detail(&self, value: &str, in_use: bool, is_default: bool) -> String {
        let auth = self
            .settings
            .status
            .as_ref()
            .map_or("", |s| s.auth.as_str());
        let detail = match (in_use, is_default) {
            (true, true) => {
                format!("{} · new sessions start here", capitalized(auth))
            }
            (true, false) => "Connected".into(),
            (false, _) => "Not connected".into(),
        };
        match &self.settings.account_note {
            Some((account, doing)) if *account == value => doing.clone(),
            _ => detail,
        }
    }

    fn new_session_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mode = self.any_option("mode");
        let mode_detail = match self.default_value(mode.as_ref()).as_deref() {
            Some("auto") => "A safety review decides instead of you",
            Some("full-access") => "Nothing asks. Use in a sandbox.",
            _ => "Ask before every edit and command",
        };
        let model = self
            .any_option("model")
            .map(|m| self.model_across_accounts(m));
        vec![
            self.select_row(
                "model",
                "Model",
                "Open sessions keep the model they started on",
                model,
                cx,
            ),
            self.select_row("mode", "Permissions", mode_detail, mode, cx),
            self.notify_row(cx),
        ]
    }

    fn model_across_accounts(&self, mut m: ConfigOption) -> ConfigOption {
        if self.catalog.is_empty() {
            return m;
        }
        let account = self
            .store
            .defaults
            .get("provider")
            .cloned()
            .or_else(|| self.any_option("provider").map(|p| p.current))
            .unwrap_or_default();
        let chosen = self.default_value(Some(&m)).unwrap_or_default();
        m.current = format!("{account}\t{chosen}");
        m.choices = self
            .catalog
            .iter()
            .filter(|a| a.value == account || self.settings.signed_in.contains(&a.value.as_str()))
            .flat_map(|a| {
                a.models.iter().map(|c| crate::fx::acp::Choice {
                    value: format!("{}\t{}", a.value, c.value),
                    name: c.name.clone(),
                })
            })
            .collect();
        m
    }
}

fn connected_actions(
    i: usize,
    value: &'static str,
    login: &str,
    is_default: bool,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let (label, cmd) = if value == "gateway" {
        ("Replace key", "login vercel --api-key".to_string())
    } else {
        ("Sign out", format!("logout {login}"))
    };
    h_flex()
        .gap_1()
        .when(!is_default, |d| {
            d.child(
                text_button(("use", i), "Make default")
                    .h(px(30.))
                    .font_weight(FontWeight::NORMAL)
                    .on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.use_provider(value, cx)
                        }),
                    ),
            )
        })
        .child(
            text_button(("account-action", i), label)
                .h(px(30.))
                .font_weight(FontWeight::NORMAL)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.account_run(value, cmd.clone(), cx)
                })),
        )
        .into_any_element()
}

fn connect_button(
    i: usize,
    value: &'static str,
    login: &str,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let (label, cmd) = if value == "gateway" {
        ("Add key", "login vercel --api-key".to_string())
    } else {
        ("Connect", format!("login {login}"))
    };
    primary_button(("connect", i), label, None)
        .h(px(30.))
        .on_click(
            cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.account_run(value, cmd.clone(), cx)
            }),
        )
        .into_any_element()
}

fn account_badge(logo: &'static str, in_use: bool) -> Div {
    div()
        .size(px(28.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .bg(if in_use { gray_1000() } else { gray_300() })
        .child(
            gpui_kit::svg()
                .path(logo)
                .size(px(16.))
                .flex_shrink_0()
                .text_color(if in_use {
                    background_100()
                } else {
                    gray_1000()
                }),
        )
}

fn nothing_connected() -> Div {
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
                .child("Nothing can answer a prompt yet"),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(gray_900())
                .child("Connect any one below"),
        )
}
