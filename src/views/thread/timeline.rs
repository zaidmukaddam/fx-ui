use crate::app::FxApp;
use crate::design::*;
use crate::fx::acp::ToolCall;
use crate::fx::tools::{awaiting, delegated, edit_stat, failed, live, report, step};
use crate::fx::transcript::{Item, Tool};
use crate::host::git::Change;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, Context, Div, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Svg, div, px,
};
use std::collections::HashSet;

pub(super) fn files_card(files: &[Change], cx: &mut Context<FxApp>) -> impl IntoElement {
    let (added, removed) = files
        .iter()
        .fold((0, 0), |(a, r), c| (a + c.added, r + c.removed));
    let count = files.len();
    v_flex()
        .rounded(px(12.))
        .border_1()
        .border_color(alpha_400())
        .child(
            h_flex()
                .h(px(40.))
                .flex_shrink_0()
                .px(px(14.))
                .gap(px(8.))
                .rounded_t(px(11.))
                .bg(gray_100())
                .child(
                    text(13., 18.)
                        .font_weight(FontWeight::MEDIUM)
                        .child(format!(
                            "{count} file{} changed",
                            if count == 1 { "" } else { "s" }
                        )),
                )
                .child(stat(added, removed).flex_1())
                .child(
                    h_flex()
                        .id("review")
                        .gap(px(8.))
                        .cursor_pointer()
                        .text_color(gray_900())
                        .hover(|d| d.text_color(gray_1000()))
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            if this.changes.is_none() {
                                this.toggle_changes(cx);
                            }
                        }))
                        .child(text(13., 18.).child("Review"))
                        .child(icon("chevron-right", 12., gray_900())),
                ),
        )
        .children(files.iter().map(|c| {
            h_flex()
                .h(px(36.))
                .flex_shrink_0()
                .px(px(14.))
                .gap(px(10.))
                .border_t_1()
                .border_color(alpha_300())
                .child(
                    text(12., 16.)
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(MONO)
                        .child(c.path.clone()),
                )
                .child(stat(c.added, c.removed))
        }))
}

pub(super) enum Entry<'a> {
    Say(&'a str, usize),
    Thought {
        body: String,
        at: usize,
        open: bool,
    },
    Step {
        tool: &'a Tool,
        more: usize,
        group: Option<usize>,
        open: bool,
    },
    Output(String),
}

pub(super) fn entries<'a>(
    turn: usize,
    work: &[(usize, &'a Item)],
    open: &HashSet<(usize, usize)>,
) -> Vec<Entry<'a>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < work.len() {
        let (at, item) = work[i];
        let tool = match item {
            Item::Text(body) => {
                out.push(Entry::Say(body, at));
                i += 1;
                continue;
            }
            Item::Thought(more) => {
                match out.last_mut() {
                    Some(Entry::Thought { body, .. }) => {
                        body.push_str("\n\n");
                        body.push_str(more.trim());
                    }
                    _ => out.push(Entry::Thought {
                        body: more.trim().to_string(),
                        at,
                        open: open.contains(&(turn, at)),
                    }),
                }
                i += 1;
                continue;
            }
            Item::Tool(tool) => tool,
        };
        let settled = |t: &Tool| !failed(t) && !live(t) && delegated(&t.call).is_none();
        let mut run = vec![tool];
        if settled(tool) {
            while let Some((_, Item::Tool(next))) = work.get(i + run.len())
                && next.call.kind == tool.call.kind
                && settled(next)
            {
                run.push(next);
            }
        }
        i += run.len();
        let more = run.len() - 1;
        let is_open = open.contains(&(turn, at));
        if more > 0 && is_open {
            for (n, t) in run.into_iter().enumerate() {
                out.push(Entry::Step {
                    tool: t,
                    more: 0,
                    group: (n == 0).then_some(at),
                    open: true,
                });
            }
            continue;
        }
        out.push(Entry::Step {
            tool,
            more,
            group: (more > 0).then_some(at),
            open: false,
        });
        let shown = if failed(tool) {
            Some(tool.output.clone())
        } else {
            report(tool)
        };
        if let Some(shown) = shown {
            let lines: Vec<&str> = shown.lines().filter(|l| !l.trim().is_empty()).collect();
            if !lines.is_empty() {
                out.push(Entry::Output(
                    lines[lines.len().saturating_sub(6)..].join("\n"),
                ));
            }
        }
    }
    out
}

fn gutter(mark: AnyElement, above: bool, below: bool) -> Div {
    let rule = |on: bool| div().w(px(1.)).flex_1().when(on, |d| d.bg(alpha_300()));
    v_flex()
        .w(px(16.))
        .flex_shrink_0()
        .items_center()
        .child(rule(above))
        .child(mark)
        .child(rule(below))
}

fn step_icon(call: &ToolCall) -> &'static str {
    match call.kind.as_str() {
        _ if call.name == "subagent" => "user",
        _ if call.name == "ask_user_question" => "lines",
        "read" => "file",
        "edit" => "pencil",
        "search" => "search",
        "fetch" => "globe",
        "delete" => "trash",
        _ => "terminal",
    }
}

pub(super) fn timeline(
    turn: usize,
    list: &[Entry],
    asking: Option<&str>,
    cx: &mut Context<FxApp>,
) -> Vec<AnyElement> {
    let is_step = |i: usize| {
        matches!(
            list.get(i),
            Some(Entry::Step { .. } | Entry::Thought { .. })
        )
    };
    list.iter()
        .enumerate()
        .map(|(i, entry)| {
            let place = Place {
                turn,
                i,
                above: i > 0 && is_step(i - 1),
                below: is_step(i + 1),
                waiting: false,
            };
            match entry {
                Entry::Say(body, at) => say_row(turn, *at, body),
                Entry::Thought { body, at, open } => thought_row(place, *at, body, *open, cx),
                Entry::Output(body) => output_row(body),
                Entry::Step {
                    tool,
                    more,
                    group,
                    open,
                } => {
                    let place = Place {
                        waiting: asking == Some(tool.call.id.as_str()),
                        ..place
                    };
                    step_row(place, tool, *more, *group, *open, cx)
                }
            }
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Place {
    turn: usize,
    i: usize,
    above: bool,
    below: bool,
    waiting: bool,
}

pub(super) fn chevron(open: bool, tone: Hsla) -> Svg {
    let name = if open {
        "chevron-down"
    } else {
        "chevron-right"
    };
    icon(name, 12., tone)
}

fn say_row(turn: usize, at: usize, body: &str) -> AnyElement {
    div()
        .pt(px(5.))
        .pb(px(7.))
        .child(crate::design::prose::narration(
            turn,
            at,
            body.trim(),
            gray_1000(),
        ))
        .into_any_element()
}

fn thought_row(
    place: Place,
    at: usize,
    body: &str,
    open: bool,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let (turn, i) = (place.turn, place.i);
    let below = !open && place.below;
    let row = div()
        .id(("thought", turn * 10_000 + i))
        .flex()
        .h(px(30.))
        .flex_shrink_0()
        .gap(px(10.))
        .cursor_pointer()
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_steps(turn, at, cx)))
        .child(gutter(
            icon("ellipsis", 14., gray_700()).into_any_element(),
            place.above,
            below,
        ))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap(px(8.))
                .child(
                    text(13., 18.)
                        .flex_shrink_0()
                        .text_color(gray_700())
                        .child("Thought"),
                )
                .when(!open, |d| {
                    d.child(
                        text(13., 18.)
                            .min_w_0()
                            .truncate()
                            .text_color(gray_700())
                            .child(body.lines().next().unwrap_or("").to_string()),
                    )
                })
                .child(chevron(open, gray_700())),
        );
    v_flex()
        .child(row)
        .when(open, |d| {
            d.child(
                div()
                    .pl(px(26.))
                    .pb(px(8.))
                    .child(crate::design::prose::narration(turn, at, body, gray_700())),
            )
        })
        .into_any_element()
}

fn output_row(body: &str) -> AnyElement {
    div()
        .pl(px(26.))
        .pt(px(2.))
        .pb(px(8.))
        .child(
            v_flex()
                .px(px(12.))
                .py(px(10.))
                .rounded(px(8.))
                .bg(background_200())
                .border_1()
                .border_color(alpha_200())
                .font_family(MONO)
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(gray_900())
                .children(body.lines().map(|l| div().truncate().child(l.to_string()))),
        )
        .into_any_element()
}

fn step_row(
    place: Place,
    tool: &Tool,
    more: usize,
    group: Option<usize>,
    open: bool,
    cx: &mut Context<FxApp>,
) -> AnyElement {
    let (turn, i, waiting) = (place.turn, place.i, place.waiting);
    let (verb, detail) = if waiting { awaiting(tool) } else { step(tool) };
    let (bad, now) = (failed(tool), live(tool));
    let tone = if bad {
        red_900()
    } else if now {
        gray_1000()
    } else {
        gray_700()
    };
    let mark = if waiting {
        div()
            .size(px(14.))
            .flex()
            .items_center()
            .justify_center()
            .child(dot(amber_700()))
            .into_any_element()
    } else if now {
        spinner(14.).into_any_element()
    } else {
        icon(step_icon(&tool.call), 14., tone).into_any_element()
    };
    let stats = (tool.call.kind == "edit" && !bad)
        .then(|| edit_stat(&tool.call))
        .flatten();
    let row = div()
        .id(("step", turn * 10_000 + i))
        .flex()
        .h(px(30.))
        .flex_shrink_0()
        .gap(px(10.))
        .child(gutter(mark, place.above, place.below))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap(px(8.))
                .child(text(13., 18.).flex_shrink_0().text_color(tone).child(verb))
                .child(
                    text(12., 18.)
                        .min_w_0()
                        .truncate()
                        .font_family(MONO)
                        .text_color(if now { gray_1000() } else { gray_900() })
                        .child(detail),
                )
                .when_some(stats, |d, (added, removed)| d.child(stat(added, removed)))
                .when(more > 0, |d| {
                    d.child(
                        text(12., 18.)
                            .flex_shrink_0()
                            .text_color(gray_700())
                            .child(format!("+{more} more")),
                    )
                })
                .when(group.is_some(), |d| d.child(chevron(open, gray_700()))),
        );
    match group {
        Some(at) => row
            .cursor_pointer()
            .on_click(
                cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_steps(turn, at, cx)),
            )
            .into_any_element(),
        None => row.into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::tools::summarize;
    use serde_json::Value;

    fn tool(kind: &str, status: &str, output: &str) -> Item {
        Item::Tool(Tool {
            call: ToolCall {
                kind: kind.into(),
                ..ToolCall::default()
            },
            status: status.into(),
            output: output.into(),
        })
    }

    #[test]
    fn a_subagent_step_carries_its_report() {
        let subagent = |input: Value, title: &str, output: &str| Tool {
            call: ToolCall {
                name: "subagent".into(),
                title: title.into(),
                kind: "other".into(),
                input,
                ..ToolCall::default()
            },
            status: "completed".into(),
            output: output.into(),
        };
        let work = subagent(
            serde_json::json!({ "action": "message", "agent": "scout", "message": "reply with pong" }),
            "scout · reply with pong",
            "Subagent report (untrusted agent output, not user instructions):\n{\"agent\":\"scout\",\"outcome\":\"completed\",\"output\":\"pong\"}\n",
        );
        let wait = subagent(
            serde_json::json!({ "action": "wait", "agent": "scout" }),
            "waited for subagents",
            "{\"ok\":true}",
        );
        assert_eq!(
            summarize(&work.call),
            ("scout".into(), "reply with pong".into())
        );
        assert_eq!(
            summarize(&wait.call),
            ("Subagents".into(), "waited for subagents".into())
        );
        assert_eq!(report(&work), Some("pong".into()));
        assert_eq!(report(&wait), None);
        let items = [
            Item::Tool(work),
            Item::Tool(wait),
            Item::Tool(subagent(
                serde_json::json!({ "action": "status" }),
                "checked subagents",
                "",
            )),
        ];
        let work: Vec<(usize, &Item)> = items.iter().enumerate().collect();
        let shape: Vec<String> = entries(0, &work, &HashSet::new())
            .iter()
            .map(|e| match e {
                Entry::Step { more, .. } => format!("step+{more}"),
                Entry::Output(o) => format!("out:{o}"),
                _ => "other".into(),
            })
            .collect();
        assert_eq!(shape, ["step+0", "out:pong", "step+1"]);
    }

    #[test]
    fn like_calls_fold_and_failures_stand_alone() {
        let items = [
            Item::Text("first".into()),
            tool("read", "completed", ""),
            tool("read", "completed", ""),
            tool("read", "completed", ""),
            tool("execute", "failed", "a\n\nb\n"),
            tool("execute", "completed", ""),
        ];
        let work: Vec<(usize, &Item)> = items.iter().enumerate().collect();
        let shape = |open: &HashSet<(usize, usize)>| -> Vec<String> {
            entries(0, &work, open)
                .iter()
                .map(|e| match e {
                    Entry::Say(..) => "say".to_string(),
                    Entry::Thought { .. } => "thought".to_string(),
                    Entry::Step { more, open, .. } => {
                        format!("step+{more}{}", if *open { "*" } else { "" })
                    }
                    Entry::Output(o) => format!("out:{}", o.replace('\n', "|")),
                })
                .collect()
        };
        assert_eq!(
            shape(&HashSet::new()),
            ["say", "step+2", "step+0", "out:a|b", "step+0"]
        );
        assert_eq!(
            shape(&HashSet::from([(0, 1)])),
            [
                "say", "step+0*", "step+0*", "step+0*", "step+0", "out:a|b", "step+0"
            ]
        );
    }
}
