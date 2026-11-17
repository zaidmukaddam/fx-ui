mod prompts;
mod timeline;

use crate::app::{FxApp, Session};
use crate::design::*;
use crate::fx::tools::touched;
use crate::fx::transcript::{Item, Turn, duration};
use crate::host::git::Change;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Bounds, ClickEvent, ClipboardItem, Context, Div, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, Pixels, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Window, div, img, px,
};
use timeline::{chevron, entries, files_card, timeline};

const AHEAD: f32 = 1000.;

fn out_of_view(top: f32, height: f32, window: (f32, f32)) -> bool {
    top + height < window.0 - AHEAD || top > window.1 + AHEAD
}

pub fn turn(
    index: usize,
    turn: &Turn,
    session: &Session,
    files: &[Change],
    cx: &mut Context<FxApp>,
) -> impl IntoElement {
    let work: Vec<(usize, &Item)> = turn
        .work()
        .iter()
        .enumerate()
        .filter(|(_, i)| match i {
            Item::Text(t) | Item::Thought(t) => !t.trim().is_empty(),
            Item::Tool(_) => true,
        })
        .collect();
    let answer = turn.answer();
    let work_view = if turn.running() {
        Some(working(index, turn, &work, session, cx))
    } else if !work.is_empty() {
        Some(worked(index, turn, &work, session, cx))
    } else {
        None
    };
    let footer = (!turn.running() && !answer.trim().is_empty())
        .then(|| answer_footer(index, turn, session, answer.clone()));

    v_flex()
        .gap(px(20.))
        .child(
            v_flex()
                .items_end()
                .gap(px(8.))
                .when(!turn.prompt.is_empty(), |d| d.child(prompt_bubble(turn)))
                .when(!turn.images.is_empty(), |d| d.child(thumbnails(turn))),
        )
        .children(work_view)
        .when(!answer.trim().is_empty(), |d| {
            d.child(
                v_flex()
                    .gap(px(14.))
                    .child(crate::design::prose::answer(index, &answer))
                    .children(footer),
            )
        })
        .when(!files.is_empty(), |d| d.child(files_card(files, cx)))
        .when_some(turn.stop.clone(), |d, stop| {
            d.child(text(13., 18.).text_color(gray_700()).child(stop))
        })
}

fn asking(session: &Session) -> Option<&str> {
    session.permission.as_ref().map(|p| p.call.id.as_str())
}

fn action_count(turn: &Turn) -> String {
    let actions = turn.tools().count();
    format!("{actions} action{}", if actions == 1 { "" } else { "s" })
}

fn timed(turn: &Turn) -> bool {
    turn.timed && turn.elapsed().as_secs() > 0
}

fn working(
    index: usize,
    turn: &Turn,
    work: &[(usize, &Item)],
    session: &Session,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let counted = action_count(turn);
    let list = entries(index, work, &session.open_steps);
    let recent = &list[list.len().saturating_sub(6)..];
    v_flex()
        .gap(px(8.))
        .child(
            h_flex()
                .h(px(24.))
                .gap(px(8.))
                .child(spinner(14.))
                .child(text(13., 18.).child("Working"))
                .child(
                    text(13., 18.)
                        .text_color(gray_700())
                        .child(format!("{} · {counted}", duration(turn.elapsed()))),
                ),
        )
        .when(!recent.is_empty(), |d| {
            d.child(v_flex().children(timeline(index, recent, asking(session), cx)))
        })
        .into_any_element()
}

fn worked(
    index: usize,
    turn: &Turn,
    work: &[(usize, &Item)],
    session: &Session,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let open = session.expanded.contains(&index);
    let counted = action_count(turn);
    let timed = timed(turn);
    let tone = if open { gray_1000() } else { gray_900() };
    v_flex()
        .gap(px(8.))
        .child(
            h_flex()
                .id(("worked", index))
                .h(px(24.))
                .gap(px(6.))
                .cursor_pointer()
                .on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_turn(index, cx)),
                )
                .child(text(13., 18.).text_color(tone).child(if timed {
                    format!("Worked for {}", duration(turn.elapsed()))
                } else {
                    format!("Worked · {counted}")
                }))
                .child(chevron(open, tone))
                .when(open && timed, |d| {
                    d.child(
                        text(13., 18.)
                            .text_color(gray_700())
                            .child(format!("· {counted}")),
                    )
                }),
        )
        .when(open, |d| {
            let list = entries(index, work, &session.open_steps);
            d.child(v_flex().children(timeline(index, &list, asking(session), cx)))
        })
        .into_any_element()
}

fn answer_footer(index: usize, turn: &Turn, session: &Session, copy: String) -> impl IntoElement {
    let model = session
        .option("model")
        .map(|o| crate::app::model_name(&crate::app::choice_name(Some(o))));
    let note = match (model, turn.timed) {
        (Some(m), true) if timed(turn) => format!("{m} · {}", duration(turn.elapsed())),
        (Some(m), true) => m,
        _ => String::new(),
    };
    h_flex()
        .h(px(28.))
        .gap(px(2.))
        .child(
            div()
                .id(("copy-answer", index))
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .cursor_pointer()
                .hover(|d| d.bg(alpha_200()))
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))
                })
                .child(icon("copy", 14., gray_700())),
        )
        .child(text(12., 16.).pl(px(6.)).text_color(gray_700()).child(note))
}

fn prompt_bubble(turn: &Turn) -> impl IntoElement {
    text(14., 22.)
        .max_w(px(520.))
        .px(px(16.))
        .py(px(10.))
        .rounded(px(18.))
        .bg(gray_200())
        .child(turn.prompt.clone())
}

fn thumbnails(turn: &Turn) -> impl IntoElement {
    h_flex()
        .gap(px(8.))
        .flex_wrap()
        .justify_end()
        .children(turn.images.iter().map(|image| {
            div()
                .relative()
                .w(px(96.))
                .h(px(72.))
                .flex_shrink_0()
                .child(
                    img(image.clone())
                        .w(px(96.))
                        .h(px(72.))
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
        }))
}

fn column(turns: Vec<AnyElement>) -> Div {
    v_flex()
        .w_full()
        .max_w(COLUMN)
        .gap(px(20.))
        .when(turns.is_empty(), |d| {
            d.child(text(13., 18.).text_color(gray_700()).child("Loading…"))
        })
        .children(turns)
}

fn bottom_aligned(bottom: f32, column: Div) -> Div {
    v_flex()
        .w_full()
        .min_h_full()
        .justify_end()
        .items_center()
        .px(px(40.))
        .pt(px(24.))
        .pb(px(bottom))
        .child(column)
}

impl FxApp {
    pub(crate) fn toggle_steps(&mut self, turn: usize, at: usize, cx: &mut Context<Self>) {
        if let Some(s) = self.session_mut()
            && !s.open_steps.remove(&(turn, at))
        {
            s.open_steps.insert((turn, at));
        }
        cx.notify();
    }

    fn spaces(&self, session: &Session) -> Vec<Option<f32>> {
        let shown = session.turns();
        let view = self.scroll.bounds();
        let window = (f32::from(view.top()), f32::from(view.bottom()));
        let seen = self.seen.borrow();
        let furthest = f32::from(self.scroll.max_offset().y);
        let now = f32::from(self.scroll.offset().y).clamp(-furthest, 0.);
        let moved = now - seen.offset;
        let known = seen.session == session.id && seen.width == f32::from(view.size.width);
        shown
            .iter()
            .enumerate()
            .map(|(i, turn)| {
                let (top, height) = *seen.spots.get(i)?;
                (known
                    && i + 2 < shown.len()
                    && !turn.running()
                    && out_of_view(top + moved, height, window))
                .then_some(height)
            })
            .collect()
    }

    pub(crate) fn render_thread(
        &self,
        session: &Session,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let shown = session.turns();
        let mut turns = Vec::with_capacity(shown.len());
        let (cwd, status) = self
            .workspace()
            .map(|w| (w.path.clone(), w.status.as_slice()))
            .unwrap_or_default();
        let spaces = self.spaces(session);
        for (i, t) in shown.iter().enumerate() {
            if let Some(height) = spaces[i] {
                turns.push(div().h(px(height)).flex_shrink_0().into_any_element());
                continue;
            }
            let last = i + 1 == shown.len();
            let files = if last {
                touched(t, &cwd, status)
            } else {
                vec![]
            };
            turns.push(turn(i, t, session, &files, cx).into_any_element());
        }
        let (seen, scroll, id) = (self.seen.clone(), self.scroll.clone(), session.id.clone());
        let skipped: Vec<bool> = spaces.iter().map(Option::is_some).collect();
        let measure = move |bounds: Vec<Bounds<Pixels>>, window: &mut Window, _: &mut App| {
            let view = scroll.bounds();
            let width = f32::from(view.size.width);
            let mut seen = seen.borrow_mut();
            let resized = seen.session == id && seen.width != width && !seen.spots.is_empty();
            let showing = bounds
                .iter()
                .zip(&skipped)
                .any(|(b, skipped)| *skipped && b.bottom() > view.top() && b.top() < view.bottom());
            seen.session = id.clone();
            seen.width = width;
            seen.offset = f32::from(scroll.offset().y);
            seen.spots = if resized {
                vec![]
            } else {
                bounds
                    .iter()
                    .map(|b| (f32::from(b.origin.y), f32::from(b.size.height)))
                    .collect()
            };
            if resized || showing {
                window.refresh();
            }
        };
        let waiting = session.steering.len()
            + session.queue.len()
            + usize::from(session.thread.recovery.is_some());
        let above = match waiting {
            0 => 0.,
            rows => 6. + 30. * rows as f32,
        } + if self.attachments.is_empty() { 0. } else { 60. };
        let question = session.question();
        div()
            .id("thread")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(bottom_aligned(
                146. + above,
                column(turns)
                    .on_children_prepainted(measure)
                    .when_some(session.permission.as_ref(), |d, p| {
                        d.child(self.render_permission(p, cx))
                    })
                    .when_some(question, |d, (turn, asks, options)| {
                        d.child(self.render_question(turn, asks, options, cx))
                    })
                    .when_some(session.error.clone(), |d, e| {
                        d.child(error_card(e).child(
                            icon_button("error-dismiss", "x", 14.).on_click(cx.listener(
                                |this, _: &ClickEvent, _, cx| {
                                    if let Some(session) = this.session_mut() {
                                        session.error = None;
                                    }
                                    cx.notify();
                                },
                            )),
                        ))
                    }),
            ))
    }

    pub(crate) fn render_beside(
        &self,
        ws: usize,
        index: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let session = &self.workspaces[ws].sessions[index];
        let turns: Vec<AnyElement> = session
            .turns()
            .iter()
            .enumerate()
            .map(|(i, t)| turn(i, t, session, &[], cx).into_any_element())
            .collect();
        let status: Option<AnyElement> = if session.permission.is_some() {
            Some(dot(amber_700()).into_any_element())
        } else if session.thread.running() {
            Some(spinner(12.).into_any_element())
        } else {
            None
        };
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .h(px(44.))
                    .flex_shrink_0()
                    .pl(px(20.))
                    .pr(px(10.))
                    .gap(px(8.))
                    .child(
                        text(13., 18.)
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(gray_900())
                            .child(session.label(&self.store)),
                    )
                    .children(status)
                    .child(icon_button("beside-close", "x", 14.).on_click(cx.listener(
                        |this, _: &ClickEvent, _, cx| {
                            this.beside = None;
                            cx.notify();
                        },
                    ))),
            )
            .child(
                div()
                    .id("beside-thread")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .opacity(0.6)
                    .capture_any_mouse_down(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.swap_beside(cx);
                    }))
                    .child(bottom_aligned(
                        24.,
                        column(turns).when(session.permission.is_some(), |d| {
                            d.child(
                                text(13., 18.)
                                    .text_color(amber_700())
                                    .child("Waiting on your answer. Click to work in this one."),
                            )
                        }),
                    )),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_is_skipped_only_a_screen_beyond_the_window() {
        let window = (0., 800.);
        assert!(!out_of_view(100., 300., window));
        assert!(!out_of_view(-900., 300., window));
        assert!(!out_of_view(1700., 300., window));
        assert!(out_of_view(-1400., 300., window));
        assert!(out_of_view(1900., 300., window));
        assert!(!out_of_view(-5000., 6000., window));
    }
}
