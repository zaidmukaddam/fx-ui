use crate::fx::acp::{Recovery, ToolCall, Update, image_bytes};
use gpui_kit::{Image, ImageFormat};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct Thread {
    pub turns: Vec<Turn>,
    pub title: Option<String>,
    pub usage: Option<(u64, u64)>,
    pub recovery: Option<Recovery>,
}

#[derive(Debug)]
pub struct Turn {
    pub prompt: String,
    pub images: Vec<Arc<Image>>,
    pub items: Vec<Item>,
    pub started: Instant,
    pub ended: Option<Instant>,
    pub stop: Option<String>,
    pub timed: bool,
}

#[derive(Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Item {
    Text(String),
    Thought(String),
    Tool(Tool),
}

#[derive(Debug, PartialEq)]
pub struct Tool {
    pub call: ToolCall,
    pub status: String,
    pub output: String,
}

impl Turn {
    fn new(prompt: String, timed: bool) -> Self {
        Turn {
            timed,
            prompt,
            images: Vec::new(),
            items: Vec::new(),
            started: Instant::now(),
            ended: None,
            stop: None,
        }
    }

    pub fn running(&self) -> bool {
        self.ended.is_none()
    }

    pub fn elapsed(&self) -> Duration {
        self.ended.unwrap_or_else(Instant::now) - self.started
    }

    pub fn tools(&self) -> impl Iterator<Item = &Tool> {
        self.items.iter().filter_map(|i| match i {
            Item::Tool(t) => Some(t),
            _ => None,
        })
    }

    fn answer_start(&self) -> usize {
        self.items
            .iter()
            .rposition(|i| matches!(i, Item::Tool(_)))
            .map_or(0, |i| i + 1)
    }

    pub fn work(&self) -> &[Item] {
        &self.items[..self.answer_start()]
    }

    pub fn answer(&self) -> String {
        self.items[self.answer_start()..]
            .iter()
            .filter_map(|i| match i {
                Item::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<String>()
    }
}

impl Thread {
    pub fn begin(&mut self, prompt: String) {
        self.turns.push(Turn::new(prompt, true));
    }

    pub fn finish(&mut self, stop: Result<String, String>) {
        if let Some(turn) = self.turns.last_mut() {
            turn.ended.get_or_insert_with(Instant::now);
            turn.stop = match stop {
                Ok(reason) if reason == "end_turn" => None,
                Ok(reason) => Some(match reason.as_str() {
                    "cancelled" => "Stopped".into(),
                    "max_tokens" => "Stopped at the output limit".into(),
                    "refusal" => "The model declined to answer".into(),
                    other => other.replace('_', " "),
                }),
                Err(error) => Some(error),
            };
        }
    }

    pub fn apply(&mut self, update: Update) {
        match update {
            Update::UserText(text) => match self.turns.last_mut() {
                _ if text.contains("[Image #") => {
                    let said: Vec<&str> = text.lines().filter(|l| !is_image_mark(l)).collect();
                    self.apply(Update::UserText(said.join("\n")));
                }
                Some(turn) if turn.items.is_empty() && turn.ended.is_none() => {
                    if turn.timed && !turn.prompt.is_empty() {
                        turn.prompt.push_str("\n\n");
                    }
                    turn.prompt.push_str(&text)
                }
                _ => self.open_turn(text),
            },
            Update::UserImage { mime, data } => {
                let image = ImageFormat::from_mime_type(&mime)
                    .zip(image_bytes(&data))
                    .map(|(format, bytes)| Arc::new(Image::from_bytes(format, bytes)));
                let fresh = self
                    .turns
                    .last()
                    .is_some_and(|t| t.items.is_empty() && t.ended.is_none());
                if !fresh {
                    self.open_turn(String::new());
                }
                if let (Some(image), Some(turn)) = (image, self.turns.last_mut()) {
                    turn.images.push(image);
                }
            }
            Update::Recovery(recovery) => self.recovery = recovery,
            Update::Text(text) => self.push_text(text, false),
            Update::Thought(text) => self.push_text(text, true),
            Update::ToolCall(call) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.items.push(Item::Tool(Tool {
                        status: call.status.clone(),
                        call,
                        output: String::new(),
                    }));
                }
            }
            Update::ToolChange { id, status, output } => {
                let tool = self.turns.iter_mut().rev().find_map(|turn| {
                    turn.items.iter_mut().rev().find_map(|i| match i {
                        Item::Tool(t) if t.call.id == id => Some(t),
                        _ => None,
                    })
                });
                if let Some(tool) = tool {
                    if let Some(status) = status {
                        tool.status = status;
                    }
                    if let Some(output) = output {
                        tool.output = output;
                    }
                }
            }
            Update::Title(title) => self.title = Some(title),
            Update::Usage { used, size } => self.usage = Some((used, size)),
            Update::Notice(_) | Update::Other => {}
        }
    }

    fn open_turn(&mut self, prompt: String) {
        let live = self.turns.last_mut().is_some_and(|turn| {
            let live = turn.timed && turn.ended.is_none();
            turn.ended.get_or_insert_with(Instant::now);
            live
        });
        self.turns.push(Turn::new(prompt, live));
    }

    fn push_text(&mut self, text: String, thought: bool) {
        let Some(turn) = self.turns.last_mut() else {
            return;
        };
        match (turn.items.last_mut(), thought) {
            (Some(Item::Text(t)), false) | (Some(Item::Thought(t)), true) => t.push_str(&text),
            _ => turn.items.push(if thought {
                Item::Thought(text)
            } else {
                Item::Text(text)
            }),
        }
    }

    pub fn running(&self) -> bool {
        self.turns.last().is_some_and(Turn::running)
    }

    pub fn settle(&mut self) {
        let now = Instant::now();
        for turn in &mut self.turns {
            turn.ended.get_or_insert(now);
        }
    }
}

fn is_image_mark(line: &str) -> bool {
    line.trim()
        .strip_prefix("[Image #")
        .and_then(|rest| rest.strip_suffix(']'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn duration(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 60 {
        format!("{}m {}s", s / 60, s % 60)
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "shell".into(),
            title: "Running".into(),
            kind: "execute".into(),
            status: "pending".into(),
            input: json!({ "command": "ls" }),
        }
    }

    #[test]
    fn a_turn_folds_chunks_tools_and_the_answer() {
        let mut thread = Thread::default();
        thread.begin("list files".into());
        thread.apply(Update::Thought("let me ".into()));
        thread.apply(Update::Thought("look".into()));
        thread.apply(Update::Text("Listing.".into()));
        thread.apply(Update::ToolCall(call("c1")));
        thread.apply(Update::ToolChange {
            id: "c1".into(),
            status: Some("completed".into()),
            output: Some("a.txt\n".into()),
        });
        thread.apply(Update::Text("One file: ".into()));
        thread.apply(Update::Text("a.txt".into()));
        thread.apply(Update::Usage {
            used: 10,
            size: 100,
        });
        assert!(thread.running());
        thread.finish(Ok("end_turn".into()));

        let turn = &thread.turns[0];
        assert!(!turn.running() && turn.stop.is_none());
        assert_eq!(turn.items[0], Item::Thought("let me look".into()));
        let tools: Vec<_> = turn.tools().collect();
        assert_eq!(
            (tools[0].status.as_str(), tools[0].output.as_str()),
            ("completed", "a.txt\n")
        );
        assert_eq!(turn.answer(), "One file: a.txt");
        assert_eq!(turn.work().len(), 3);
        assert_eq!(turn.work()[1], Item::Text("Listing.".into()));
        assert_eq!(thread.usage, Some((10, 100)));
    }

    #[test]
    fn steering_a_live_turn_folds_the_work_so_far() {
        let mut thread = Thread::default();
        thread.begin("fix the bug".into());
        thread.apply(Update::ToolCall(call("c1")));
        thread.apply(Update::UserText("keep the old name".into()));
        thread.apply(Update::Text("Done.".into()));
        let prompts: Vec<_> = thread.turns.iter().map(|t| t.prompt.as_str()).collect();
        assert_eq!(prompts, ["fix the bug", "keep the old name"]);
        assert!(!thread.turns[0].running());
        assert!(thread.turns[1].running() && thread.turns[1].timed);
        thread.finish(Ok("end_turn".into()));
        assert!(!thread.running());

        let mut thread = Thread::default();
        thread.begin("fix the bug".into());
        thread.apply(Update::UserText("and add a test".into()));
        assert_eq!(thread.turns.len(), 1);
        assert_eq!(thread.turns[0].prompt, "fix the bug\n\nand add a test");
    }

    #[test]
    fn replayed_images_stay_with_their_prompt() {
        let png = crate::fx::acp::image_block("image/png", b"not really a png");
        let image = || Update::UserImage {
            mime: "image/png".into(),
            data: png["data"].as_str().unwrap().into(),
        };
        let mut thread = Thread::default();
        thread.apply(Update::UserText("match this\n[Image #1]".into()));
        assert_eq!(thread.turns[0].prompt, "match this");
        thread.apply(image());
        thread.apply(Update::Text("ok".into()));
        thread.apply(image());
        assert_eq!(thread.turns.len(), 2);
        assert_eq!(thread.turns[0].images.len(), 1);
        assert_eq!(thread.turns[0].images[0].bytes, b"not really a png");
        assert_eq!(thread.turns[1].prompt, "");
        assert_eq!(thread.turns[1].images.len(), 1);
    }

    #[test]
    fn replayed_history_splits_into_turns() {
        let mut thread = Thread::default();
        thread.apply(Update::UserText("first".into()));
        thread.apply(Update::Text("one".into()));
        thread.apply(Update::UserText("second".into()));
        thread.apply(Update::Text("two".into()));
        let prompts: Vec<_> = thread.turns.iter().map(|t| t.prompt.as_str()).collect();
        assert_eq!(prompts, ["first", "second"]);
        assert!(!thread.turns[0].running());
        thread.settle();
        assert!(!thread.running());
    }

    #[test]
    fn a_cancelled_turn_says_so() {
        let mut thread = Thread::default();
        thread.begin("x".into());
        thread.finish(Ok("cancelled".into()));
        assert_eq!(thread.turns[0].stop.as_deref(), Some("Stopped"));
        assert_eq!(duration(Duration::from_secs(72)), "1m 12s");
    }
}
