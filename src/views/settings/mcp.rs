use crate::app::{FxApp, MenuAt};
use crate::design::*;
use crate::fx::cli::fx_in;
use crate::fx::mcp::{Server, State, name_for, server, show, state};
use crate::views::settings::{page_title, rows_card};
use crate::views::shell::menu_item;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Div, Entity, Focusable as _, FontWeight,
    Hsla, IntoElement, ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window,
    deferred, div, px,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Default)]
pub(crate) struct Servers {
    pub list: Vec<Server>,
    pub shown: HashMap<String, Value>,
    pub adding: Option<(Entity<InputState>, Entity<InputState>)>,
    pub note: Option<(bool, String)>,
}

impl FxApp {
    fn mcp_cwd(&self) -> PathBuf {
        self.workspace()
            .map(|w| w.path.clone())
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .unwrap_or_else(|| "/".into())
    }

    pub(crate) fn refresh_mcp(&mut self, cx: &mut Context<Self>) {
        let cwd = self.mcp_cwd();
        cx.spawn(async move |this, cx| {
            let (list, shown) = cx
                .background_spawn(async move {
                    let list: Vec<Server> = fx_in(&cwd, &["mcp", "list", "--json"])
                        .ok()
                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                        .and_then(|v| v["servers"].as_array().cloned())
                        .unwrap_or_default()
                        .iter()
                        .map(server)
                        .collect();
                    let mut shown = HashMap::new();
                    for s in list
                        .iter()
                        .filter(|s| s.remote && s.status == "not_started")
                    {
                        if let Some(answer) = show(&cwd, &s.name) {
                            shown.insert(s.name.clone(), answer);
                        }
                    }
                    (list, shown)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                let servers = &mut this.settings.servers;
                servers
                    .shown
                    .retain(|name, _| list.iter().any(|s| s.name == *name));
                servers.shown.extend(shown);
                servers.list = list;
                cx.notify();
            });
        })
        .detach();
    }

    fn mcp_work<T: Send + 'static>(
        &mut self,
        doing: String,
        work: impl FnOnce(PathBuf) -> T + Send + 'static,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        self.settings.servers.note = Some((false, doing));
        let cwd = self.mcp_cwd();
        cx.spawn(async move |this, cx| {
            let out = cx.background_spawn(async move { work(cwd) }).await;
            let _ = this.update(cx, |this, cx| {
                done(this, out, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn mcp_run(&mut self, args: Vec<String>, doing: String, cx: &mut Context<Self>) {
        self.mcp_work(
            doing,
            move |cwd| {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                fx_in(&cwd, &args)
            },
            |this, ran, cx| {
                this.settings.servers.note = ran.err().map(|why| (true, why));
                this.refresh_mcp(cx);
            },
            cx,
        );
    }

    fn mcp_check(&mut self, name: String, cx: &mut Context<Self>) {
        let asked = name.clone();
        self.mcp_work(
            format!("Checking {name}…"),
            move |cwd| show(&cwd, &asked),
            |this, answer, _| {
                let servers = &mut this.settings.servers;
                servers.note = None;
                match answer {
                    Some(answer) => servers.shown.insert(name, answer),
                    None => servers.shown.remove(&name),
                };
            },
            cx,
        );
    }

    fn mcp_open_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("Name (optional)"));
        let address = cx.new(|cx| {
            InputState::new(window, cx).placeholder("https://… or the command that starts it")
        });
        address.read(cx).focus_handle(cx).focus(window, cx);
        self.settings.servers.adding = Some((name, address));
        cx.notify();
    }

    fn mcp_add(&mut self, cx: &mut Context<Self>) {
        let Some((name, address)) = self.settings.servers.adding.as_ref() else {
            return;
        };
        let address = address.read(cx).value().trim().to_string();
        let name = name.read(cx).value().trim().to_string();
        if address.is_empty() {
            return;
        }
        let name = if name.is_empty() {
            name_for(&address)
        } else {
            name
        };
        self.settings.servers.adding = None;
        self.mcp_run(add_args(&name, &address), format!("Adding {name}…"), cx);
    }

    pub(crate) fn mcp_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let note = self.settings.servers.note.as_ref();
        v_flex()
            .gap(px(32.))
            .child(page_head(cx))
            .children(note.map(|(failed, words)| note_line(*failed, words.clone())))
            .child(self.mcp_yours(cx))
            .children(self.mcp_theirs(cx))
    }

    fn mcp_yours(&self, cx: &mut Context<Self>) -> Div {
        let mut rows = self.mcp_rows(false, cx);
        if let Some((name, address)) = &self.settings.servers.adding {
            rows.insert(0, add_form(name, address, cx));
        }
        if rows.is_empty() {
            rows.push(no_servers());
        }
        v_flex()
            .gap(px(10.))
            .child(heading("Yours"))
            .child(rows_card(rows, 56.))
    }

    fn mcp_theirs(&self, cx: &mut Context<Self>) -> Option<Div> {
        let rows = self.mcp_rows(true, cx);
        (!rows.is_empty()).then(|| {
            v_flex()
                .gap(px(10.))
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(heading("From this project"))
                        .child(
                            text(12., 16.)
                                .font_family(MONO)
                                .text_color(gray_700())
                                .child(".mcp.json"),
                        ),
                )
                .child(rows_card(rows, 56.))
                .child(
                    text(12., 16.).px(px(2.)).text_color(gray_700()).child(
                        "Project servers run only after you approve them, once per project.",
                    ),
                )
        })
    }

    fn mcp_rows(&self, project: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let servers = &self.settings.servers.list;
        servers
            .iter()
            .enumerate()
            .filter(|(_, s)| s.project == project)
            .map(|(i, s)| self.mcp_row(i, s, cx))
            .collect()
    }

    fn mcp_row(&self, i: usize, s: &Server, cx: &mut Context<Self>) -> AnyElement {
        let shown = self.settings.servers.shown.get(&s.name);
        let state = state(s, shown);
        let (colour, words) = state_mark(state);
        let failed = shown.and_then(|v| v["error"].as_str()).map(str::to_string);
        let waiting = state == State::Waiting;
        let detail = match (&failed, waiting) {
            (Some(why), _) => why.clone(),
            (None, true) => "Waiting for you to approve it".into(),
            (None, false) => s.address.clone(),
        };
        h_flex()
            .gap_3()
            .min_h(px(60.))
            .px_4()
            .child(tile(s))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(text(14., 20.).child(s.name.clone()))
                    .child(
                        text(12., 18.)
                            .truncate()
                            .text_color(gray_900())
                            .when(failed.is_none() && !waiting, |d| d.font_family(MONO))
                            .child(detail),
                    ),
            )
            .when(!waiting, |d| {
                d.child(
                    h_flex()
                        .gap_2()
                        .flex_shrink_0()
                        .child(dot(colour))
                        .child(text(13., 18.).text_color(gray_900()).child(words)),
                )
            })
            .child(self.mcp_controls(i, s, state, cx))
            .into_any_element()
    }

    fn mcp_controls(
        &self,
        i: usize,
        s: &Server,
        state: State,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let name = s.name.as_str();
        let waiting = state == State::Waiting;
        if waiting || state == State::Rejected {
            h_flex()
                .gap(px(6.))
                .when(waiting, |d| {
                    d.child(
                        text_button(("mcp-reject", i), "Reject").on_click(run_on_click(
                            cx,
                            &["mcp", "reject", name],
                            format!("Rejecting {name}…"),
                        )),
                    )
                })
                .child(
                    primary_button(("mcp-approve", i), "Approve", None).on_click(run_on_click(
                        cx,
                        &["mcp", "approve", name],
                        format!("Approving {name}…"),
                    )),
                )
                .into_any_element()
        } else if state == State::SignedOut {
            outline_button(("mcp-login", i), "Sign in", None)
                .on_click(run_on_click(
                    cx,
                    &["mcp", "login", name],
                    format!("Signing in to {name} in your browser…"),
                ))
                .into_any_element()
        } else {
            self.mcp_overflow(i, s, state, cx)
        }
    }

    fn mcp_overflow(
        &self,
        i: usize,
        s: &Server,
        state: State,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let at = MenuAt::Mcp(i);
        let menu_open = self.menu == Some(at);
        let menu = menu_open.then(|| self.mcp_menu(s, state, cx));
        div()
            .relative()
            .flex_shrink_0()
            .child(
                icon_button(("mcp-menu", i), "ellipsis", 16.)
                    .when(menu_open, |d| d.bg(alpha_200()))
                    .on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_menu(at, cx)),
                    ),
            )
            .when_some(menu, |d, menu| {
                d.child(deferred(menu.absolute().top(px(32.)).right(px(0.))).with_priority(1))
            })
            .into_any_element()
    }

    fn mcp_menu(&self, s: &Server, state: State, cx: &mut Context<Self>) -> Div {
        let name = s.name.as_str();
        let check = s.name.clone();
        self.menu_frame(cx)
            .child(
                menu_item("mcp-check", "search", "Check now", "", false).on_click(cx.listener(
                    move |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.mcp_check(check.clone(), cx)
                    },
                )),
            )
            .when(s.remote && matches!(state, State::Ready { .. }), |d| {
                d.child(
                    menu_item("mcp-logout", "user", "Sign out", "", false).on_click(run_on_click(
                        cx,
                        &["mcp", "logout", name],
                        format!("Signing out of {name}…"),
                    )),
                )
            })
            .child(div().h(px(1.)).my(px(4.)).bg(alpha_200()))
            .child(if s.project {
                menu_item("mcp-reject", "x", "Reject", "", true).on_click(run_on_click(
                    cx,
                    &["mcp", "reject", name],
                    format!("Rejecting {name}…"),
                ))
            } else {
                menu_item("mcp-remove", "trash", "Remove", "", true).on_click(run_on_click(
                    cx,
                    &["mcp", "remove", name],
                    format!("Removing {name}…"),
                ))
            })
    }
}

fn add_args(name: &str, address: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["mcp".into(), "add".into()];
    if address.starts_with("http://") || address.starts_with("https://") {
        args.extend(["--no-login".into(), name.to_string(), address.to_string()]);
    } else {
        args.extend([name.to_string(), "--".into()]);
        args.extend(address.split_whitespace().map(str::to_string));
    }
    args
}

fn run_on_click(
    cx: &Context<FxApp>,
    args: &[&str],
    doing: String,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    cx.listener(move |this, _: &ClickEvent, _, cx| {
        cx.stop_propagation();
        this.mcp_run(args.clone(), doing.clone(), cx)
    })
}

fn page_head(cx: &Context<FxApp>) -> Div {
    h_flex()
        .items_end()
        .gap_4()
        .child(div().flex_1().child(page_title(
            "MCP servers",
            "Tools fx can reach beyond your files. fx keeps their logins.",
        )))
        .child(
            primary_button("mcp-add", "Add server", None)
                .h(px(30.))
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.mcp_open_add(window, cx)),
                ),
        )
}

fn note_line(failed: bool, words: String) -> Div {
    h_flex()
        .gap(px(10.))
        .px(px(2.))
        .mt(px(-12.))
        .child(if failed {
            dot(red_700()).into_any_element()
        } else {
            spinner(12.).into_any_element()
        })
        .child(
            text(13., 18.)
                .text_color(if failed { red_900() } else { gray_900() })
                .child(words),
        )
}

fn heading(title: &'static str) -> Div {
    text(13., 18.)
        .px(px(2.))
        .font_weight(FontWeight::MEDIUM)
        .child(title)
}

fn add_form(
    name: &Entity<InputState>,
    address: &Entity<InputState>,
    cx: &Context<FxApp>,
) -> AnyElement {
    h_flex()
        .gap(px(8.))
        .min_h(px(60.))
        .px_4()
        .child(div().w(px(160.)).flex_shrink_0().child(Input::new(name)))
        .child(div().flex_1().min_w_0().child(Input::new(address)))
        .child(
            text_button("mcp-add-cancel", "Cancel").on_click(cx.listener(
                |this, _: &ClickEvent, _, cx| {
                    this.settings.servers.adding = None;
                    cx.notify();
                },
            )),
        )
        .child(
            primary_button("mcp-add-go", "Add", None)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.mcp_add(cx))),
        )
        .into_any_element()
}

fn no_servers() -> AnyElement {
    h_flex()
        .min_h(px(60.))
        .px_4()
        .child(
            v_flex()
                .child(text(14., 20.).child("No servers yet"))
                .child(
                    text(13., 18.)
                        .text_color(gray_900())
                        .child("Add one by its URL, or the command that starts it."),
                ),
        )
        .into_any_element()
}

fn tile(s: &Server) -> Div {
    let mark = if s.remote {
        s.name
            .chars()
            .next()
            .unwrap_or('?')
            .to_uppercase()
            .to_string()
    } else {
        "›_".into()
    };
    div()
        .size(px(28.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .bg(gray_300())
        .font_family(MONO)
        .text_size(px(12.))
        .font_weight(FontWeight::BOLD)
        .child(mark)
}

fn state_mark(state: State) -> (Hsla, String) {
    match state {
        State::Ready { tools } => {
            let noun = if tools == 1 { "tool" } else { "tools" };
            (green_700(), format!("{tools} {noun}"))
        }
        State::SignedOut => (amber_700(), "Signed out".into()),
        State::Waiting => (amber_700(), "Waiting".into()),
        State::Rejected => (gray_600(), "Rejected".into()),
        State::NotChecked => (gray_600(), "Not checked".into()),
        State::Failed => (red_700(), "Failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_add_command_for_a_url_and_for_a_command() {
        assert_eq!(
            add_args("linear", "https://mcp.linear.app/mcp"),
            [
                "mcp",
                "add",
                "--no-login",
                "linear",
                "https://mcp.linear.app/mcp"
            ]
        );
        assert_eq!(
            add_args("git", "uvx  mcp-server-git"),
            ["mcp", "add", "git", "--", "uvx", "mcp-server-git"]
        );
    }
}
