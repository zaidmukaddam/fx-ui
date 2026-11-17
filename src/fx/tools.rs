use crate::fx::acp::ToolCall;
use crate::fx::transcript::{Tool, Turn};
use crate::host::git::{Change, DiffLine, counts, line_diff};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash as _, Hasher as _};

pub(crate) fn failed(tool: &Tool) -> bool {
    tool.status == "failed"
}

pub(crate) fn live(tool: &Tool) -> bool {
    tool.status == "in_progress" || tool.status == "pending"
}

pub(crate) fn delegated(call: &ToolCall) -> Option<(String, String)> {
    (call.name == "subagent" && call.input["action"] == "message").then(|| {
        (
            call.input["agent"].as_str().unwrap_or("subagent").into(),
            call.input["message"].as_str().unwrap_or_default().into(),
        )
    })
}

pub(crate) fn report(tool: &Tool) -> Option<String> {
    delegated(&tool.call)?;
    let json = &tool.output[tool.output.find('{')?..];
    let report: Value = serde_json::from_str(json.trim()).ok()?;
    report["output"].as_str().map(str::to_string)
}

pub(crate) fn step(tool: &Tool) -> (String, String) {
    let (verb, detail) = summarize(&tool.call);
    let verb = if failed(tool) {
        "Failed".to_string()
    } else if live(tool) {
        present(verb)
    } else {
        verb
    };
    (verb, detail)
}

pub(crate) fn awaiting(tool: &Tool) -> (String, String) {
    let (verb, detail) = summarize(&tool.call);
    let verb = match verb.as_str() {
        "Ran" => "Waiting to run".into(),
        "Edited" => "Waiting to edit".into(),
        "Read" => "Waiting to read".into(),
        "Searched" => "Waiting to search".into(),
        "Fetched" => "Waiting to fetch".into(),
        "Deleted" => "Waiting to delete".into(),
        _ => "Waiting".into(),
    };
    (verb, detail)
}

fn present(verb: String) -> String {
    match verb.as_str() {
        "Ran" => "Running".into(),
        "Edited" => "Editing".into(),
        "Read" => "Reading".into(),
        "Searched" => "Searching".into(),
        "Fetched" => "Fetching".into(),
        "Deleted" => "Deleting".into(),
        _ => verb,
    }
}

fn edited_path(call: &ToolCall) -> Option<String> {
    field(call, "path").or_else(|| field(call, "file_path"))
}

fn edit_texts(call: &ToolCall) -> Option<(String, String)> {
    let old = field(call, "old_string").or_else(|| field(call, "old_text"))?;
    let new = field(call, "new_string")
        .or_else(|| field(call, "new_text"))
        .unwrap_or_default();
    Some((old, new))
}

thread_local! {
    static STATS: RefCell<HashMap<u64, (usize, usize)>> = RefCell::new(HashMap::new());
}

pub(crate) fn edit_stat(call: &ToolCall) -> Option<(usize, usize)> {
    let (old, new) = edit_texts(call)?;
    let mut hasher = DefaultHasher::new();
    (&old, &new).hash(&mut hasher);
    let key = hasher.finish();
    STATS.with_borrow_mut(|seen| {
        if seen.len() > 2048 {
            seen.clear();
        }
        Some(
            *seen
                .entry(key)
                .or_insert_with(|| counts(&line_diff(&old, &new, usize::MAX))),
        )
    })
}

pub fn touched(turn: &Turn, cwd: &std::path::Path, status: &[Change]) -> Vec<Change> {
    if turn.running() {
        return vec![];
    }
    let mut seen: Vec<Change> = Vec::new();
    for tool in turn.tools() {
        if !matches!(tool.call.kind.as_str(), "edit" | "delete") {
            continue;
        }
        let Some(path) = edited_path(&tool.call) else {
            continue;
        };
        let path = std::path::Path::new(&path);
        let rel = path
            .strip_prefix(cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        if let Some(c) = status.iter().find(|c| c.path == rel)
            && !seen.iter().any(|s| s.path == c.path)
        {
            seen.push(c.clone());
        }
    }
    seen
}

pub fn delta(
    turns: &[Turn],
    cwd: &std::path::Path,
    before: &[Change],
    after: &[Change],
) -> (usize, usize) {
    let mut files: Vec<Change> = Vec::new();
    for change in turns.iter().flat_map(|t| touched(t, cwd, after)) {
        if !files.iter().any(|f| f.path == change.path) {
            files.push(change);
        }
    }
    files.iter().fold((0, 0), |(a, r), now| {
        let (was_a, was_r) = before
            .iter()
            .find(|b| b.path == now.path)
            .map_or((0, 0), |b| (b.added, b.removed));
        (
            a + now.added.saturating_sub(was_a),
            r + now.removed.saturating_sub(was_r),
        )
    })
}

pub fn asked(turn: &Turn) -> Option<(String, Vec<String>)> {
    let tool = turn
        .tools()
        .filter(|t| t.call.name == "ask_user_question")
        .last()?;
    let question = tool.call.input["questions"].get(0)?;
    let options: Vec<String> = question["options"]
        .as_array()?
        .iter()
        .filter_map(|o| o["label"].as_str().or(o.as_str()))
        .map(str::to_string)
        .collect();
    let asks = question["question"].as_str().unwrap_or_default();
    (!options.is_empty()).then(|| (asks.to_string(), options))
}

pub fn doing(turn: &Turn) -> String {
    let Some(tool) = turn.tools().last().filter(|t| live(t)) else {
        return "Working".into();
    };
    let (verb, detail) = step(tool);
    let short = match tool.call.kind.as_str() {
        "read" | "edit" | "delete" => detail.rsplit('/').next().unwrap_or(&detail),
        _ => detail.lines().next().unwrap_or(&detail),
    };
    format!("{verb} {short}")
}

pub(crate) fn field(call: &ToolCall, key: &str) -> Option<String> {
    call.input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn summarize(call: &ToolCall) -> (String, String) {
    if call.name == "ask_user_question" {
        let asks = call.input["questions"][0]["question"].as_str();
        return ("Asked".into(), asks.unwrap_or("a question").into());
    }
    if let Some((agent, task)) = delegated(call) {
        return (agent, task.lines().next().unwrap_or_default().into());
    }
    if call.name == "subagent" {
        return ("Subagents".into(), call.title.clone());
    }
    let detail = ["command", "path", "file_path", "pattern", "query", "url"]
        .iter()
        .find_map(|k| field(call, k))
        .unwrap_or_else(|| call.title.clone());
    let verb = match call.kind.as_str() {
        "execute" => "Ran",
        "edit" => "Edited",
        "read" => "Read",
        "search" => "Searched",
        "fetch" => "Fetched",
        "delete" => "Deleted",
        _ => call.name.as_str(),
    };
    (verb.to_string(), detail)
}

pub fn wants(call: &ToolCall, cwd: &std::path::Path) -> (&'static str, String) {
    let (_, detail) = summarize(call);
    let detail = detail.lines().next().unwrap_or_default();
    let detail = detail
        .strip_prefix(&format!("{}/", cwd.display()))
        .unwrap_or(detail)
        .to_string();
    let wants = match call.kind.as_str() {
        "execute" => "Wants to run",
        "edit" => "Wants to edit",
        "delete" => "Wants to delete",
        "fetch" => "Wants to fetch",
        "read" => "Wants to read",
        _ => "Wants to use",
    };
    (wants, detail)
}

pub fn question(call: &ToolCall) -> &'static str {
    match call.kind.as_str() {
        "execute" => "Run this command?",
        "edit" | "delete" => "Make this change?",
        "fetch" => "Fetch this?",
        _ => "Allow this?",
    }
}

pub fn edit_preview(call: &ToolCall, cwd: &std::path::Path) -> Option<Vec<DiffLine>> {
    if let (Some(path), Some(content)) = (edited_path(call), field(call, "content")) {
        let old = std::fs::read_to_string(cwd.join(path)).unwrap_or_default();
        return Some(line_diff(&old, &content, 3));
    }
    let (old, new) = edit_texts(call)?;
    Some(line_diff(&old, &new, usize::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::transcript::{Item, Tool};

    #[test]
    fn a_turn_counts_only_what_it_moved() {
        let change = |path: &str, added, removed| Change {
            path: path.into(),
            code: 'M',
            staged: false,
            added,
            removed,
        };
        let mut thread = crate::fx::transcript::Thread::default();
        thread.begin("go".into());
        thread.turns[0].items.push(Item::Tool(Tool {
            call: ToolCall {
                kind: "edit".into(),
                input: serde_json::json!({ "path": "/ws/main.py" }),
                ..ToolCall::default()
            },
            status: "completed".into(),
            output: String::new(),
        }));
        thread.finish(Ok("end_turn".into()));
        let before = [change("main.py", 6, 0), change("other.py", 1, 1)];
        let after = [change("main.py", 7, 2), change("other.py", 9, 9)];
        let cwd = std::path::Path::new("/ws");
        assert_eq!(delta(&thread.turns, cwd, &before, &after), (1, 2));
        assert_eq!(delta(&thread.turns, cwd, &[], &after), (7, 2));
    }

    #[test]
    fn reads_the_question_the_model_meant_to_ask() {
        let call: ToolCall = ToolCall {
            name: "ask_user_question".into(),
            kind: "other".into(),
            input: serde_json::json!({ "questions": [{
                "question": "Which colour do you prefer?",
                "options": [{ "label": "Red" }, { "label": "Blue" }],
            }] }),
            ..ToolCall::default()
        };
        assert_eq!(
            summarize(&call),
            ("Asked".into(), "Which colour do you prefer?".into())
        );
        let mut thread = crate::fx::transcript::Thread::default();
        thread.begin("go".into());
        assert_eq!(asked(&thread.turns[0]), None);
        thread.turns[0].items.push(Item::Tool(Tool {
            call,
            status: "completed".into(),
            output: String::new(),
        }));
        assert_eq!(
            asked(&thread.turns[0]),
            Some((
                "Which colour do you prefer?".into(),
                vec!["Red".into(), "Blue".into()]
            ))
        );
    }

    #[test]
    fn a_row_says_what_the_turn_is_on() {
        let call = |kind: &str, key: &str, value: &str, status: &str| {
            Item::Tool(Tool {
                call: ToolCall {
                    kind: kind.into(),
                    input: serde_json::json!({ key: value }),
                    ..ToolCall::default()
                },
                status: status.into(),
                output: String::new(),
            })
        };
        let mut thread = crate::fx::transcript::Thread::default();
        thread.begin("go".into());
        let turn = &mut thread.turns[0];
        assert_eq!(doing(turn), "Working");
        turn.items
            .push(call("read", "path", "src/shell.rs", "in_progress"));
        assert_eq!(doing(turn), "Reading shell.rs");
        turn.items.push(call(
            "execute",
            "command",
            "cargo check\necho done",
            "pending",
        ));
        assert_eq!(doing(turn), "Running cargo check");
        turn.items
            .push(call("read", "path", "src/app.rs", "completed"));
        assert_eq!(doing(turn), "Working");
    }

    #[test]
    fn an_approval_says_what_the_call_wants() {
        let call = |kind: &str, key: &str, value: &str| ToolCall {
            kind: kind.into(),
            input: serde_json::json!({ key: value }),
            ..ToolCall::default()
        };
        let cwd = std::path::Path::new("/ws");
        assert_eq!(
            wants(&call("execute", "command", "cargo check\necho done"), cwd),
            ("Wants to run", "cargo check".into())
        );
        assert_eq!(
            wants(&call("edit", "path", "/ws/src/main.rs"), cwd),
            ("Wants to edit", "src/main.rs".into())
        );
        assert_eq!(
            wants(&call("read", "path", "/elsewhere/a.rs"), cwd),
            ("Wants to read", "/elsewhere/a.rs".into())
        );
        assert_eq!(
            wants(&call("search", "query", "status"), cwd),
            ("Wants to use", "status".into())
        );
    }

    #[test]
    fn a_call_waiting_for_approval_does_not_say_it_is_running() {
        let tool = Tool {
            call: ToolCall {
                kind: "execute".into(),
                input: serde_json::json!({ "command": "ls -la" }),
                ..ToolCall::default()
            },
            status: "pending".into(),
            output: String::new(),
        };
        assert_eq!(step(&tool).0, "Running");
        assert_eq!(awaiting(&tool), ("Waiting to run".into(), "ls -la".into()));
    }
}
