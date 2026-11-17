use crate::app::{
    AgentState, FX_BRAILLE, FxApp, HomeTab, Pending, Session, Status, Workspace, ago, day,
};
use crate::design::*;
use crate::host::git::Line;
use crate::views::settings::Section;
use crate::views::shell::status_mark;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, ClipboardItem, Context, Div, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _,
    Styled as _, div, px,
};
use std::path::Path;

const INSTALL: &str = "curl -fsSL https://fx.sh/setup.sh | bash";

fn signed_out(error: &str) -> bool {
    error.contains("fx login")
}

fn hero(title: impl Into<SharedString>) -> impl IntoElement {
    v_flex()
        .items_center()
        .gap(px(18.))
        .child(
            text(10., 11.)
                .font_family(MONO)
                .text_color(gray_600())
                .whitespace_nowrap()
                .children(FX_BRAILLE.lines().map(|l| div().child(l.to_string()))),
        )
        .child(
            text(28., 36.)
                .font_family(display())
                .font_weight(FontWeight::MEDIUM)
                .child(title.into()),
        )
}

fn column() -> Div {
    v_flex()
        .flex_1()
        .min_h_0()
        .items_center()
        .gap(px(28.))
        .px(px(40.))
        .pt(px(120.))
}

fn mark(mark: impl IntoElement) -> Div {
    div()
        .size(px(16.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .child(mark)
}

fn bullet() -> Div {
    div().size(px(4.)).rounded(px(2.)).bg(gray_500())
}

fn list_row(
    id: (&'static str, usize),
    status: impl IntoElement,
    title: SharedString,
    note: Option<AnyElement>,
    age: String,
) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(34.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(10.))
        .rounded(px(8.))
        .cursor_pointer()
        .hover(|d| d.bg(alpha_100()))
        .child(mark(status))
        .child(text(14., 20.).flex_1().min_w_0().truncate().child(title))
        .children(note)
        .child(
            text(12., 16.)
                .w(px(28.))
                .flex_shrink_0()
                .flex()
                .justify_end()
                .text_color(gray_700())
                .child(age),
        )
}

fn day_heading(name: &'static str, first: bool) -> Div {
    text(12., 16.)
        .h(px(if first { 32. } else { 36. }))
        .flex_shrink_0()
        .pt(px(if first { 10. } else { 14. }))
        .px(px(10.))
        .flex()
        .items_center()
        .text_color(gray_700())
        .child(name)
}

fn empty_list(tab: HomeTab) -> Div {
    let (title, detail) = match tab {
        HomeTab::Running => (
            "Nothing is running",
            "Sessions that are working show up here.",
        ),
        HomeTab::Archived => (
            "Nothing archived",
            "Sessions you remove from the list are kept here.",
        ),
        HomeTab::Recent => ("No sessions yet", "Your first prompt starts one."),
    };
    v_flex()
        .items_center()
        .gap(px(6.))
        .py(px(36.))
        .child(text(14., 20.).child(title))
        .child(text(13., 18.).text_color(gray_700()).child(detail))
}

fn archived_rows(ws: usize, w: &Workspace, cx: &mut Context<FxApp>) -> Vec<AnyElement> {
    w.archived
        .iter()
        .take(6)
        .enumerate()
        .map(|(i, s)| {
            let id = s.id.clone();
            let restore = text(12., 16.)
                .flex_shrink_0()
                .text_color(gray_900())
                .child("Restore");
            list_row(
                ("archived", i),
                bullet(),
                s.title.clone().into(),
                Some(restore.into_any_element()),
                ago(&s.updated),
            )
            .on_click(
                cx.listener(move |this, _: &ClickEvent, _, cx| this.restore_session(ws, &id, cx)),
            )
            .into_any_element()
        })
        .collect()
}

impl FxApp {
    pub(crate) fn render_home(&self, cx: &mut Context<Self>) -> AnyElement {
        let failed = match &self.agent {
            AgentState::Failed(error) => Some(error),
            _ => None,
        };
        if failed.is_some() && !crate::host::shell::has(&crate::fx::cli::binary()) {
            return column()
                .child(hero("Install fx to start"))
                .child(self.render_install(cx))
                .into_any_element();
        }
        let Some(w) = self.workspace() else {
            return self.render_first_run(cx).into_any_element();
        };
        if let Some(error) = failed {
            let heading = if signed_out(error) {
                "Connect an account to start"
            } else {
                "fx stopped"
            };
            return column()
                .child(hero(heading))
                .child(self.render_agent_down(error, cx))
                .into_any_element();
        }
        let composer = self.render_composer(cx).into_any_element();
        let ws = self.folder.unwrap_or(0);
        let any = w.listed().next().is_some() || !w.archived.is_empty();

        column()
            .child(hero(format!("What should we build in {}?", w.name)))
            .child(div().w_full().max_w(px(680.)).child(composer))
            .when(any, |d| d.child(self.home_lists(ws, w, cx)))
            .into_any_element()
    }

    fn home_lists(&self, ws: usize, w: &Workspace, cx: &mut Context<Self>) -> Div {
        let tab = self.home_tab;
        let cards: Vec<AnyElement> = w
            .sessions
            .iter()
            .enumerate()
            .filter_map(|(si, s)| Some((si, s, s.permission.as_ref()?)))
            .map(|(si, s, pending)| {
                self.approval_card((ws, si), s, pending, &w.path, cx)
                    .into_any_element()
            })
            .collect();
        let live = w
            .sessions
            .iter()
            .filter(|s| s.status() == Status::Running)
            .count();
        let rows = match tab {
            HomeTab::Archived => archived_rows(ws, w, cx),
            _ => self.session_rows(ws, w, tab, cx),
        };
        let empty = rows.is_empty();
        v_flex()
            .w_full()
            .max_w(px(680.))
            .gap(px(16.))
            .children(cards)
            .child(
                v_flex()
                    .child(self.home_tabs(live, cx))
                    .when(tab != HomeTab::Recent, |d| {
                        d.child(div().h(px(6.)).flex_shrink_0())
                    })
                    .children(rows)
                    .when(empty, |d| d.child(empty_list(tab))),
            )
    }

    fn approval_card(
        &self,
        (ws, si): (usize, usize),
        s: &Session,
        pending: &Pending,
        cwd: &Path,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (wants, detail) = crate::fx::tools::wants(&pending.call, cwd);
        let lines = pending.preview.as_ref().map(|lines| {
            let count = |kind: Line| lines.iter().filter(|l| l.0 == kind).count();
            stat(count(Line::Added), count(Line::Removed))
        });
        let allow = pending.options.iter().any(|o| o.kind == "allow_once");
        let answer = |kind: &'static str| {
            cx.listener(move |this, _: &ClickEvent, _, cx| {
                cx.stop_propagation();
                this.answer_in((ws, si), kind, cx);
            })
        };
        h_flex()
            .id(("approval", si))
            .gap(px(10.))
            .pl(px(10.))
            .pr(px(12.))
            .py(px(12.))
            .rounded(px(12.))
            .bg(gray_100())
            .border_1()
            .border_color(alpha_300())
            .cursor_pointer()
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select(ws, si, cx)))
            .children(status_mark(s.status()).map(mark))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        text(14., 20.)
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(s.label(&self.store)),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap(px(8.))
                            .child(
                                text(13., 18.)
                                    .flex_shrink_0()
                                    .text_color(gray_900())
                                    .child(wants),
                            )
                            .child(
                                text(12., 16.)
                                    .min_w_0()
                                    .truncate()
                                    .font_family(MONO)
                                    .child(detail),
                            )
                            .children(lines),
                    ),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    .gap(px(6.))
                    .child(
                        outline_button(("deny", si), "Deny", None)
                            .h(px(28.))
                            .rounded(px(6.))
                            .on_click(answer("reject_once")),
                    )
                    .when(allow, |d| {
                        let name = if pending.call.kind == "execute" {
                            "Run"
                        } else {
                            "Allow"
                        };
                        d.child(
                            primary_button(("allow", si), name, None)
                                .h(px(28.))
                                .rounded(px(6.))
                                .on_click(answer("allow_once")),
                        )
                    }),
            )
    }

    fn session_rows(
        &self,
        ws: usize,
        w: &Workspace,
        tab: HomeTab,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let running = |s: &Session| s.status() == Status::Running;
        let mut shown: Vec<(usize, &Session)> = w
            .listed()
            .filter(|(_, s)| s.status() != Status::Waiting)
            .filter(|(_, s)| tab == HomeTab::Recent || running(s))
            .collect();
        shown.sort_by_key(|(_, s)| !running(s));
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut heading = None;
        for (si, s) in shown.into_iter().take(6) {
            if tab == HomeTab::Recent {
                let name = if running(s) { "Today" } else { day(&s.updated) };
                if heading != Some(name) {
                    rows.push(day_heading(name, heading.is_none()).into_any_element());
                    heading = Some(name);
                }
            }
            rows.push(self.recent_row(ws, si, s, cx).into_any_element());
        }
        rows
    }

    fn recent_row(
        &self,
        ws: usize,
        si: usize,
        s: &Session,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (status, note, age) = match s.thread.turns.last().filter(|t| t.running()) {
            Some(turn) => (
                status_mark(Status::Running),
                Some(
                    text(12., 16.)
                        .flex_shrink_0()
                        .max_w(px(240.))
                        .truncate()
                        .text_color(gray_900())
                        .child(crate::fx::tools::doing(turn))
                        .into_any_element(),
                ),
                match turn.elapsed().as_secs() {
                    s if s < 60 => "now".into(),
                    s if s < 3_600 => format!("{}m", s / 60),
                    s => format!("{}h", s / 3_600),
                },
            ),
            None => (
                None,
                s.id.as_ref()
                    .and_then(|id| self.store.changes.get(id))
                    .map(|&(added, removed)| stat(added, removed).into_any_element()),
                ago(&s.updated),
            ),
        };
        list_row(
            ("recent", si),
            status.unwrap_or_else(|| bullet().into_any_element()),
            s.label(&self.store),
            note,
            age,
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select(ws, si, cx)))
    }

    fn home_tabs(&self, live: usize, cx: &mut Context<Self>) -> Div {
        h_flex()
            .h(px(28.))
            .flex_shrink_0()
            .px(px(2.))
            .gap(px(4.))
            .child(self.home_tab_button("tab-recent", "Recent", 0, HomeTab::Recent, cx))
            .child(self.home_tab_button("tab-running", "Running", live, HomeTab::Running, cx))
            .child(self.home_tab_button("tab-archived", "Archived", 0, HomeTab::Archived, cx))
            .child(div().flex_1())
            .child(
                text(12., 16.)
                    .id("all-sessions")
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .cursor_pointer()
                    .text_color(gray_700())
                    .hover(|d| d.text_color(gray_1000()))
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.toggle_palette(window, cx)
                    }))
                    .child("All sessions")
                    .child("⌘K"),
            )
    }

    fn home_tab_button(
        &self,
        id: &'static str,
        label: &'static str,
        count: usize,
        target: HomeTab,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let on = self.home_tab == target;
        text(13., 18.)
            .id(id)
            .h(px(26.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_color(if on { gray_1000() } else { gray_900() })
            .when(on, |d| d.bg(alpha_200()).font_weight(FontWeight::MEDIUM))
            .when(!on, |d| d.hover(|d| d.text_color(gray_1000())))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.home_tab = target;
                cx.notify();
            }))
            .child(label)
            .when(count > 0, |d| {
                d.child(
                    text(12., 16.)
                        .font_family(MONO)
                        .font_weight(FontWeight::NORMAL)
                        .text_color(gray_700())
                        .child(count.to_string()),
                )
            })
    }

    fn render_agent_down(&self, error: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let lines: Vec<&str> = error.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail: Vec<String> = lines[lines.len().saturating_sub(4)..]
            .iter()
            .map(|l| l.to_string())
            .collect();
        let (mark, title, detail) = if signed_out(error) {
            (
                amber_700(),
                "No account connected",
                "fx needs a signed-in account before it can start. Connect one, then start fx again.",
            )
        } else {
            (
                red_700(),
                "fx acp exited",
                "Your sessions are safe on disk. Start it again, or check what fx needs.",
            )
        };
        v_flex()
            .w_full()
            .max_w(px(520.))
            .gap(px(16.))
            .p(px(18.))
            .rounded(px(14.))
            .bg(gray_100())
            .border_1()
            .border_color(alpha_400())
            .child(
                v_flex()
                    .gap(px(6.))
                    .child(
                        h_flex()
                            .gap(px(10.))
                            .child(dot(mark))
                            .child(text(14., 20.).font_weight(FontWeight::MEDIUM).child(title)),
                    )
                    .child(
                        text(13., 20.)
                            .pl(px(17.))
                            .text_color(gray_900())
                            .child(detail),
                    ),
            )
            .when(!tail.is_empty(), |d| {
                d.child(
                    v_flex()
                        .px(px(12.))
                        .py(px(10.))
                        .rounded(px(8.))
                        .bg(background_200())
                        .font_family(MONO)
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(gray_900())
                        .children(tail.into_iter().map(|l| div().child(l))),
                )
            })
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(primary_button("restart", "Start fx again", None).on_click(
                        cx.listener(|this, _: &ClickEvent, _, cx| this.restart_agent(cx)),
                    ))
                    .child(
                        outline_button("fix-signin", "Fix sign-in", None).on_click(cx.listener(
                            |this, _: &ClickEvent, window, cx| {
                                this.open_section(Section::Models, window, cx)
                            },
                        )),
                    )
                    .child(div().flex_1())
                    .child(
                        text(13., 18.)
                            .id("doctor")
                            .cursor_pointer()
                            .text_color(gray_900())
                            .hover(|d| d.text_color(gray_1000()))
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.open_section(Section::About, window, cx)
                            }))
                            .child("Run fx doctor"),
                    ),
            )
    }

    fn render_install(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .w_full()
            .max_w(px(520.))
            .gap(px(16.))
            .p(px(18.))
            .rounded(px(14.))
            .bg(gray_100())
            .border_1()
            .border_color(alpha_400())
            .child(
                v_flex()
                    .gap(px(6.))
                    .child(
                        h_flex().gap(px(10.)).child(dot(amber_700())).child(
                            text(14., 20.)
                                .font_weight(FontWeight::MEDIUM)
                                .child("fx is not installed"),
                        ),
                    )
                    .child(text(13., 20.).pl(px(17.)).text_color(gray_900()).child(
                        "This app drives the fx command-line tool. Run this in Terminal, sign in with fx login, then start again.",
                    )),
            )
            .child(
                div()
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(px(8.))
                    .bg(background_200())
                    .font_family(MONO)
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(gray_1000())
                    .child(INSTALL),
            )
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(primary_button("restart", "Start again", None).on_click(
                        cx.listener(|this, _: &ClickEvent, _, cx| this.restart_agent(cx)),
                    ))
                    .child(
                        outline_button("copy-install", "Copy command", None).on_click(
                            |_: &ClickEvent, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(INSTALL.into()))
                            },
                        ),
                    )
                    .child(div().flex_1())
                    .child(
                        text(13., 18.)
                            .id("fx-docs")
                            .cursor_pointer()
                            .text_color(gray_900())
                            .hover(|d| d.text_color(gray_1000()))
                            .on_click(|_: &ClickEvent, _, cx| cx.open_url("https://fx.sh/docs"))
                            .child("fx.sh/docs"),
                    ),
            )
    }

    fn render_first_run(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let step =
            |name: &'static str, title: &'static str, detail: &'static str, button: AnyElement| {
                h_flex()
                    .gap(px(14.))
                    .min_h(px(68.))
                    .px(px(16.))
                    .child(
                        div()
                            .size(px(32.))
                            .flex_shrink_0()
                            .rounded(px(8.))
                            .bg(gray_200())
                            .border_1()
                            .border_color(alpha_300())
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(name, 16., gray_1000())),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(text(14., 20.).child(title))
                            .child(text(13., 18.).text_color(gray_900()).child(detail)),
                    )
                    .child(button)
            };
        column().child(hero("Welcome to fx")).child(
            v_flex()
                .w_full()
                .max_w(px(520.))
                .rounded(px(14.))
                .bg(gray_100())
                .border_1()
                .border_color(alpha_300())
                .child(step(
                    "folder",
                    "Open a folder",
                    "fx only reads, edits and runs inside it",
                    primary_button("choose", "Choose…", Some("⌘O"))
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.open_folder(cx)))
                        .into_any_element(),
                ))
                .child(div().h(px(1.)).flex_shrink_0().bg(alpha_200()))
                .child(step(
                    "user",
                    "Connect a model",
                    "Codex, Grok, or an AI Gateway key",
                    outline_button("connect", "Connect", None)
                        .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                            this.open_section(Section::Models, window, cx)
                        }))
                        .into_any_element(),
                )),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_a_signed_out_fx_from_a_crash() {
        let signed_out_fx = "fx needs access to Vercel AI Gateway. Run fx login to sign in, \
fx login vercel --api-key to use an API key, or set AI_GATEWAY_API_KEY.";
        assert!(signed_out(signed_out_fx));
        assert!(!signed_out("fx acp exited with status 101"));
    }
}
