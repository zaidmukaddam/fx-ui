mod about;
mod behaviour;
pub mod mcp;
mod models;
mod rows;
mod skills;
mod usage;

pub(crate) use rows::{page_title, rows_card};

use crate::app::{AgentState, FxApp};
use crate::design::*;
use crate::fx::acp::ConfigOption;
use crate::fx::cli::{
    Check, SkillWarning, Status, credits, doctor_checks, extra_folders, fx, permission_rules,
    profile, signed_in, status, usage_report,
};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};
use serde_json::Value;

#[derive(Default, Clone, Copy, PartialEq)]
pub(crate) enum Section {
    #[default]
    Models,
    Behaviour,
    Mcp,
    Skills,
    Usage,
    About,
}

const SECTIONS: [(Section, &str); 6] = [
    (Section::Models, "Models & accounts"),
    (Section::Behaviour, "Behaviour"),
    (Section::Mcp, "MCP servers"),
    (Section::Skills, "Skills"),
    (Section::Usage, "Usage"),
    (Section::About, "About"),
];

#[derive(Default)]
pub(crate) struct SettingsState {
    pub section: Section,
    pub status: Option<Status>,
    pub fx: Option<Value>,
    pub permissions: Vec<String>,
    pub usage: Option<Value>,
    pub plan: Option<(String, Value)>,
    pub period: Option<&'static str>,
    pub credits: Option<f64>,
    pub doctor: Option<Vec<Check>>,
    pub open: Option<&'static str>,
    pub skills_filter: Option<gpui_kit::Entity<gpui_kit::component::input::InputState>>,
    pub skills_all: bool,
    pub skipped: Option<(Vec<SkillWarning>, usize)>,
    pub signed_in: Vec<&'static str>,
    pub servers: mcp::Servers,
    pub account_note: Option<(&'static str, String)>,
    pub instructions: Option<gpui_kit::Entity<gpui_kit::component::input::TextareaState>>,
    pub extra: Vec<String>,
}

const ACCOUNTS: [(&str, &str, &str, &str); 3] = [
    ("codex", "Codex", "codex", "logos/codex.svg"),
    ("grok", "Grok", "grok", "logos/grok.svg"),
    ("gateway", "AI Gateway", "vercel", "logos/vercel.svg"),
];

pub(crate) fn account_logo(account: &str) -> Option<&'static str> {
    ACCOUNTS
        .iter()
        .find(|(value, ..)| *value == account)
        .map(|&(.., logo)| logo)
}

fn reveal(path: &std::path::Path) {
    let _ = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn();
}

fn unfinished(why: &str) -> String {
    if why.contains("expired") {
        "Sign-in expired before it finished. Connect to try again.".into()
    } else if why.is_empty() {
        "Sign-in didn't finish. Connect to try again.".into()
    } else {
        format!(
            "Sign-in didn't finish: {}",
            why.trim_start_matches("fx login: ")
        )
    }
}

fn in_terminal(args: &str) {
    let script =
        format!("tell application \"Terminal\"\n activate\n do script \"fx {args}\"\nend tell");
    let _ = std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn();
}

impl FxApp {
    pub(crate) fn refresh_settings(&mut self, cx: &mut Context<Self>) {
        self.refresh_mcp(cx);
        self.refresh_extra(cx);
        let period = self.settings.period.unwrap_or("7d");
        self.fetch(
            cx,
            || (status(), profile(), signed_in()),
            |s, (status, fx, signed)| {
                s.status = status;
                s.fx = fx;
                s.signed_in = signed;
            },
        );
        self.fetch(cx, permission_rules, |s, rules| s.permissions = rules);
        self.fetch(
            cx,
            move || usage_report(period, None),
            |s, usage| s.usage = usage,
        );
        self.fetch(cx, credits, |s, credits| s.credits = credits);
        self.fetch(cx, doctor_checks, |s, checks| s.doctor = Some(checks));
    }

    fn fetch<T: Send + 'static>(
        &self,
        cx: &mut Context<Self>,
        read: impl FnOnce() -> T + Send + 'static,
        keep: impl FnOnce(&mut SettingsState, T) + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            let value = cx.background_spawn(async move { read() }).await;
            let _ = this.update(cx, |this, cx| {
                keep(&mut this.settings, value);
                cx.notify();
            });
        })
        .detach();
    }

    fn account_run(&mut self, account: &'static str, cmd: String, cx: &mut Context<Self>) {
        if account == "gateway" {
            return in_terminal(&cmd);
        }
        let doing = if cmd.starts_with("logout") {
            "Signing out…"
        } else {
            "Finish signing in in your browser…"
        };
        self.settings.account_note = Some((account, doing.to_string()));
        cx.spawn(async move |this, cx| {
            let line = cmd.clone();
            let ran = cx
                .background_spawn(async move {
                    let args: Vec<&str> = line.split_whitespace().collect();
                    fx(&args)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.settings.account_note = match &ran {
                    Err(why) => Some((account, unfinished(why))),
                    Ok(_) => None,
                };
                if ran.is_ok() && matches!(this.agent, AgentState::Failed(_)) {
                    this.restart_agent(cx);
                }
                this.refresh_settings(cx);
                this.load_catalog(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn use_provider(&mut self, provider: &'static str, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_spawn(async move { fx(&["provider", provider]) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.set_option("provider".into(), provider.into(), cx);
                this.refresh_settings(cx);
            });
        })
        .detach();
    }

    fn any_options(&self) -> Option<&[ConfigOption]> {
        self.session()
            .filter(|s| !s.options.is_empty())
            .or_else(|| {
                self.workspaces
                    .iter()
                    .flat_map(|w| &w.sessions)
                    .find(|s| !s.options.is_empty())
            })
            .map(|s| s.options.as_slice())
    }

    pub(crate) fn set_section(
        &mut self,
        s: Section,
        window: &mut gpui_kit::Window,
        cx: &mut Context<Self>,
    ) {
        self.settings.section = s;
        self.settings.open = None;
        if s == Section::Skills && self.settings.skills_filter.is_none() {
            let count = self.workspace().map_or(0, |w| w.skills.len());
            let input = cx.new(|cx| {
                gpui_kit::component::input::InputState::new(window, cx)
                    .placeholder(format!("Filter {count} skills"))
            });
            cx.subscribe(
                &input,
                |_, _, _: &gpui_kit::component::input::InputEvent, cx| cx.notify(),
            )
            .detach();
            self.settings.skills_filter = Some(input);
        }
        if s == Section::Behaviour && self.settings.instructions.is_none() {
            let saved = self.store.defaults.get("instructions").cloned();
            let input = cx.new(|cx| {
                let mut field = gpui_kit::component::input::TextareaState::new(window, cx)
                    .placeholder("For example: reply briefly, and run the tests before you finish")
                    .auto_grow(3, 10);
                if let Some(saved) = saved {
                    field.set_value(saved, window, cx);
                }
                field
            });
            cx.subscribe(
                &input,
                |this, field, event: &gpui_kit::component::input::InputEvent, cx| {
                    if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                        let text = field.read(cx).value().trim().to_string();
                        if text.is_empty() {
                            this.store.defaults.remove("instructions");
                        } else {
                            this.store.defaults.insert("instructions".into(), text);
                        }
                        this.store.save();
                    }
                },
            )
            .detach();
            self.settings.instructions = Some(input);
        }
        cx.notify();
    }

    pub(crate) fn refresh_extra(&mut self, cx: &mut Context<Self>) {
        let Some(cwd) = self.workspace().map(|w| w.path.clone()) else {
            self.settings.extra.clear();
            return;
        };
        cx.spawn(async move |this, cx| {
            let extra = cx
                .background_spawn(async move { extra_folders(&cwd) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.settings.extra = extra;
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn render_settings(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let section = self.settings.section;
        let nav: Vec<AnyElement> = SECTIONS
            .iter()
            .map(|&(s, label)| {
                let on = s == section;
                div()
                    .id(label)
                    .h(px(30.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .flex_shrink_0()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .text_color(if on { gray_1000() } else { gray_900() })
                    .when(on, |d| d.bg(alpha_200()))
                    .when(!on, |d| d.hover(|d| d.bg(alpha_100())))
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.set_section(s, window, cx)
                    }))
                    .child(label)
                    .into_any_element()
            })
            .collect();

        let content: AnyElement = match section {
            Section::Models => self.models_page(cx).into_any_element(),
            Section::Behaviour => self.behaviour_page(cx).into_any_element(),
            Section::Mcp => self.mcp_page(cx).into_any_element(),
            Section::Skills => self.skills_page(cx).into_any_element(),
            Section::Usage => self.usage_page(cx).into_any_element(),
            Section::About => self.about_page(cx).into_any_element(),
        };

        h_flex()
            .flex_1()
            .min_h_0()
            .items_start()
            .child(
                v_flex()
                    .w(px(200.))
                    .flex_shrink_0()
                    .h_full()
                    .gap(px(1.))
                    .px(px(10.))
                    .py_4()
                    .children(nav),
            )
            .child(
                div()
                    .id("settings-body")
                    .flex_1()
                    .h_full()
                    .border_l_1()
                    .border_color(alpha_200())
                    .overflow_y_scroll()
                    .child(
                        h_flex()
                            .justify_center()
                            .px(px(40.))
                            .py(px(36.))
                            .child(div().w_full().max_w(px(640.)).child(content)),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_abandoned_sign_in_says_so() {
        assert_eq!(
            unfinished("fx login: authorization expired; run fx login again"),
            "Sign-in expired before it finished. Connect to try again."
        );
        assert_eq!(
            unfinished("fx login: the provider refused"),
            "Sign-in didn't finish: the provider refused"
        );
    }
}
