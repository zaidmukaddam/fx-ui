use crate::app::{Dialog, FxApp};
use crate::design::*;
use crate::host::git::{self, Change, DiffLine};
use crate::views::diff::{diff_block, more_lines};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, Div, ElementId, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Stateful,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use std::rc::Rc;

const DIFF_LINES: usize = 120;

#[derive(Default)]
pub(crate) struct Changes {
    pub list: Vec<Change>,
    pub error: Option<String>,
    pub open: Option<Change>,
    pub diff: Vec<DiffLine>,
    pub full: bool,
    pub hovered: Option<String>,
    pub last_commit: Option<String>,
}

fn row_button(id: impl Into<ElementId>, label: &'static str, filled: bool) -> Stateful<Div> {
    text(12., 16.)
        .id(id)
        .h(px(26.))
        .px(px(10.))
        .flex()
        .items_center()
        .flex_shrink_0()
        .rounded(px(6.))
        .cursor_pointer()
        .font_weight(FontWeight::MEDIUM)
        .map(|d| {
            if filled {
                d.bg(gray_1000())
                    .text_color(background_100())
                    .hover(|d| d.bg(gpui_kit::white()))
            } else {
                d.border_1()
                    .border_color(alpha_400())
                    .hover(|d| d.bg(alpha_200()))
            }
        })
        .child(label)
}

fn file_card() -> Div {
    v_flex()
        .rounded(px(12.))
        .overflow_hidden()
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
}

fn segment(id: &'static str, label: &'static str, on: bool) -> Stateful<Div> {
    text(12., 16.)
        .id(id)
        .px(px(10.))
        .h_full()
        .flex()
        .items_center()
        .rounded(px(6.))
        .cursor_pointer()
        .text_color(if on { gray_1000() } else { gray_900() })
        .when(on, |d| d.bg(gray_300()))
        .when(!on, |d| d.hover(|d| d.text_color(gray_1000())))
        .child(label)
}

fn changes_tabs(showing_diff: bool, cx: &mut Context<FxApp>) -> Div {
    h_flex()
        .h(px(28.))
        .flex_shrink_0()
        .p(px(2.))
        .rounded(px(8.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
        .child(
            segment("tab-files", "Files", !showing_diff)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.open_change(None, cx))),
        )
        .child(
            segment("tab-diff", "Diff", showing_diff).on_click(cx.listener(
                |this, _: &ClickEvent, _, cx| {
                    let first = this.changes.as_ref().and_then(|c| c.list.first().cloned());
                    if this.changes.as_ref().is_some_and(|c| c.open.is_none()) {
                        this.open_change(first, cx);
                    }
                },
            )),
        )
}

fn changes_header(changes: &Changes, cx: &mut Context<FxApp>) -> Div {
    let (added, removed) = changes
        .list
        .iter()
        .fold((0, 0), |(a, r), c| (a + c.added, r + c.removed));
    h_flex()
        .h(px(44.))
        .flex_shrink_0()
        .pl(px(16.))
        .pr(px(10.))
        .gap(px(10.))
        .child(text(13., 18.).text_color(gray_900()).child("Changes"))
        .child(div().flex_1().map(|d| {
            if changes.list.is_empty() {
                d.child(text(12., 16.).text_color(gray_700()).child("Clean"))
            } else {
                d.child(stat(added, removed))
            }
        }))
        .child(changes_tabs(changes.open.is_some(), cx))
        .child(
            icon_button("close-changes", "x", 14.)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_changes(cx))),
        )
}

fn group_heading(
    title: &'static str,
    action: &'static str,
    paths: Vec<String>,
    staged: bool,
    cx: &mut Context<FxApp>,
) -> Div {
    h_flex()
        .px(px(2.))
        .child(text(12., 16.).flex_1().text_color(gray_700()).child(title))
        .child(
            text(12., 16.)
                .id(title)
                .cursor_pointer()
                .text_color(gray_900())
                .hover(|d| d.text_color(gray_1000()))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    let paths = paths.clone();
                    this.git_edit(
                        move |p| {
                            paths.iter().try_for_each(|path| {
                                if staged {
                                    git::unstage(p, path)
                                } else {
                                    git::stage(p, path)
                                }
                            })
                        },
                        cx,
                    );
                }))
                .child(action),
        )
}

impl FxApp {
    pub(crate) fn refresh_changes(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.workspace().map(|w| w.path.clone()) else {
            return;
        };
        let open = self.changes.as_ref().and_then(|c| c.open.clone());
        cx.spawn(async move |this, cx| {
            let (status, diff, last) = cx
                .background_spawn(async move {
                    let status = git::status(&path);
                    let diff = open.as_ref().map(|c| git::file_diff(&path, c));
                    let last = git::last_commit(&path);
                    (status, diff, last)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Some(changes) = this.changes.as_mut() else {
                    return;
                };
                match status {
                    Ok(list) => {
                        if let Some(open) = &changes.open {
                            changes.open = list
                                .iter()
                                .find(|c| c.path == open.path && c.staged == open.staged)
                                .or_else(|| list.iter().find(|c| c.path == open.path))
                                .cloned();
                        }
                        changes.list = list;
                        changes.error = None;
                    }
                    Err(e) => changes.error = Some(e),
                }
                match diff {
                    Some(Ok(lines)) => changes.diff = lines,
                    Some(Err(e)) => changes.error = Some(e),
                    None => {}
                }
                changes.last_commit = last;
                cx.notify();
            });
            let _ = this.update(cx, |this, cx| {
                if let Some(ws) = this.folder {
                    this.refresh_status(ws, cx);
                }
            });
        })
        .detach();
    }

    fn open_change(&mut self, change: Option<Change>, cx: &mut Context<Self>) {
        if let Some(changes) = self.changes.as_mut() {
            changes.open = change;
            changes.diff.clear();
            changes.full = false;
        }
        self.refresh_changes(cx);
    }

    fn git_edit(
        &mut self,
        edit: impl FnOnce(&std::path::Path) -> Result<(), String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = self.workspace().map(|w| w.path.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let result = cx.background_spawn(async move { edit(&path) }).await;
            let _ = this.update(cx, |this, cx| {
                if let (Err(e), Some(c)) = (result, this.changes.as_mut()) {
                    c.error = Some(e);
                }
                this.refresh_changes(cx);
            });
        })
        .detach();
    }

    fn stage_toggle(&mut self, change: &Change, cx: &mut Context<Self>) {
        let path = change.path.clone();
        if change.staged {
            self.git_edit(move |p| git::unstage(p, &path), cx);
        } else {
            self.git_edit(move |p| git::stage(p, &path), cx);
        }
    }

    pub(crate) fn discard(&mut self, change: Change, cx: &mut Context<Self>) {
        self.dialog = None;
        if self
            .changes
            .as_ref()
            .and_then(|c| c.open.as_ref())
            .is_some_and(|o| o.path == change.path)
            && let Some(c) = self.changes.as_mut()
        {
            c.open = None;
        }
        self.git_edit(move |p| git::discard(p, &change), cx);
    }

    pub(crate) fn render_changes(
        &self,
        changes: &Changes,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let header = changes_header(changes, cx);
        let body = self.changes_body(changes, cx);
        v_flex().size_full().child(header).child(
            div()
                .id("changes-body")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(
                    v_flex()
                        .min_h_full()
                        .px(px(16.))
                        .pt(px(8.))
                        .pb(px(16.))
                        .child(body),
                ),
        )
    }

    fn changes_body(&self, changes: &Changes, cx: &mut Context<Self>) -> AnyElement {
        if let Some(open) = &changes.open {
            self.diff_view(changes, open, cx).into_any_element()
        } else if let Some(error) = changes.error.clone().filter(|_| changes.list.is_empty()) {
            text(13., 20.)
                .px(px(2.))
                .py(px(8.))
                .text_color(gray_700())
                .child(error)
                .into_any_element()
        } else if changes.list.is_empty() {
            self.clean_view(changes).into_any_element()
        } else {
            let staged: Vec<&Change> = changes.list.iter().filter(|c| c.staged).collect();
            let unstaged: Vec<&Change> = changes.list.iter().filter(|c| !c.staged).collect();
            v_flex()
                .gap(px(20.))
                .when(!staged.is_empty(), |d| {
                    d.child(self.group("Staged", "Unstage all", &staged, cx))
                })
                .when(!unstaged.is_empty(), |d| {
                    d.child(self.group("Not staged", "Stage all", &unstaged, cx))
                })
                .into_any_element()
        }
    }

    fn clean_view(&self, changes: &Changes) -> impl IntoElement {
        let branch = self
            .workspace()
            .and_then(|w| w.branch.clone())
            .unwrap_or_else(|| "HEAD".into());
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .pb(px(80.))
            .child(
                div()
                    .size(px(40.))
                    .rounded(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gray_100())
                    .border_1()
                    .border_color(alpha_300())
                    .child(icon("check", 18., green_900())),
            )
            .child(
                v_flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        text(14., 20.)
                            .font_weight(FontWeight::MEDIUM)
                            .child("Nothing to commit"),
                    )
                    .child(
                        h_flex()
                            .items_baseline()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(gray_900())
                            .child("The working tree matches ")
                            .child(div().font_family(MONO).text_size(px(12.)).child(branch))
                            .child("."),
                    ),
            )
            .when_some(changes.last_commit.clone(), |d, last| {
                d.child(
                    text(12., 16.)
                        .text_color(gray_700())
                        .child(format!("Last commit {last}")),
                )
            })
    }

    fn diff_view(
        &self,
        changes: &Changes,
        open: &Change,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let limit = if changes.full { usize::MAX } else { DIFF_LINES };
        let hidden = changes.diff.len().saturating_sub(limit);
        let stage = {
            let c = open.clone();
            row_button(
                "diff-stage",
                if open.staged { "Unstage" } else { "Stage" },
                false,
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.stage_toggle(&c, cx)))
        };
        let card = file_card()
            .child(
                file_row(open)
                    .pr(px(8.))
                    .border_b_1()
                    .border_color(alpha_200())
                    .child(div().pr(px(6.)).child(stat(open.added, open.removed)))
                    .child(stage),
            )
            .child(diff_block(&changes.diff, limit).when(hidden > 0, |d| {
                d.child(more_lines("diff-more", hidden).on_click(cx.listener(
                    |this, _: &ClickEvent, _, cx| {
                        if let Some(c) = this.changes.as_mut() {
                            c.full = true;
                        }
                        cx.notify();
                    },
                )))
            }));
        let folded = changes
            .list
            .iter()
            .enumerate()
            .filter(|(_, c)| !(c.path == open.path && c.staged == open.staged))
            .map(|(i, c)| {
                let change = c.clone();
                file_card().child(
                    file_row(c)
                        .id(("folded", i))
                        .cursor_pointer()
                        .hover(|d| d.bg(alpha_100()))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.open_change(Some(change.clone()), cx)
                        }))
                        .child(stat(c.added, c.removed))
                        .child(icon("chevron-down", 12., gray_900())),
                )
            });
        v_flex().gap(px(12.)).child(card).children(folded)
    }

    fn group(
        &self,
        title: &'static str,
        action: &'static str,
        items: &[&Change],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let staged = items.first().is_some_and(|c| c.staged);
        let paths: Vec<String> = items.iter().map(|c| c.path.clone()).collect();
        let rows: Vec<AnyElement> = items
            .iter()
            .enumerate()
            .map(|(i, c)| self.group_row(i, c, staged, cx))
            .collect();
        v_flex()
            .gap(px(8.))
            .child(group_heading(title, action, paths, staged, cx))
            .child(file_card().children(rows))
    }

    fn group_row(
        &self,
        i: usize,
        change: &Change,
        staged: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = Rc::new(change.clone());
        let discard = open.clone();
        let toggle = open.clone();
        let key = format!("{}:{}", change.staged, change.path);
        let hovered = self
            .changes
            .as_ref()
            .is_some_and(|c| c.hovered.as_deref() == Some(key.as_str()));
        let id = if staged { "staged-row" } else { "unstaged-row" };
        file_row(change)
            .id((id, i))
            .cursor_pointer()
            .when(i > 0, |d| d.border_t_1().border_color(alpha_200()))
            .when(hovered, |d| d.bg(alpha_100()).pr(px(8.)))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                if let Some(c) = this.changes.as_mut() {
                    if *over {
                        c.hovered = Some(key.clone());
                    } else if c.hovered.as_deref() == Some(key.as_str()) {
                        c.hovered = None;
                    }
                }
                cx.notify();
            }))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.open_change(Some(Change::clone(&open)), cx)
            }))
            .when(!hovered, |d| d.child(stat(change.added, change.removed)))
            .when(hovered && !staged, |d| {
                d.child(
                    text(12., 16.)
                        .id(("discard", i))
                        .px(px(6.))
                        .cursor_pointer()
                        .text_color(gray_900())
                        .hover(|d| d.text_color(red_900()))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            cx.stop_propagation();
                            this.dialog = Some(Dialog::Discard(Change::clone(&discard)));
                            cx.notify();
                        }))
                        .child("Discard"),
                )
            })
            .when(hovered, |d| {
                d.child(
                    row_button(
                        ("stage", i),
                        if staged { "Unstage" } else { "Stage" },
                        !staged,
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            cx.stop_propagation();
                            this.stage_toggle(&toggle, cx);
                        },
                    )),
                )
            })
            .into_any_element()
    }
}

fn file_row(change: &Change) -> Div {
    let (dir, name) = change
        .path
        .rsplit_once('/')
        .map(|(d, n)| (d.to_string(), n.to_string()))
        .unwrap_or_else(|| (String::new(), change.path.clone()));
    let fresh = matches!(change.code, '?' | 'A');
    let detail = match (dir.is_empty(), fresh) {
        (true, true) => "new file".to_string(),
        (false, true) => format!("{dir} · new file"),
        _ => dir,
    };
    h_flex()
        .h(px(40.))
        .flex_shrink_0()
        .px(px(12.))
        .gap(px(10.))
        .child(status_dot(change.code))
        .child(text(13., 18.).flex_shrink_0().child(name))
        .child(
            text(12., 16.)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(gray_700())
                .child(detail),
        )
}

fn code_color(code: char) -> Hsla {
    match code {
        'A' => green_700(),
        '?' => blue_700(),
        'D' => red_700(),
        _ => amber_700(),
    }
}

pub(crate) fn status_dot(code: char) -> Div {
    div()
        .size(px(6.))
        .flex_shrink_0()
        .rounded(px(3.))
        .bg(code_color(code))
}
