use super::{FxApp, Page, Queued, Session, session_at};
use crate::fx::acp::Steered;
use gpui_kit::{AppContext as _, Context, Image, KeyDownEvent, Window};
use std::sync::Arc;

impl FxApp {
    pub(crate) fn toggle_turn(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(s) = self.session_mut()
            && !s.expanded.remove(&index)
        {
            s.expanded.insert(index);
        }
        cx.notify();
    }

    pub(crate) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        if self.submit(text, cx) {
            self.input.update(cx, |input, cx| input.clean(window, cx));
            self.picker = None;
        }
    }

    pub(super) fn submit(&mut self, text: String, cx: &mut Context<Self>) -> bool {
        let Some(at) = self.active else {
            return false;
        };
        let Some(session) = session_at(&mut self.workspaces, at) else {
            return false;
        };
        if session.id.is_none() || session.agent.is_none() {
            return false;
        }
        let running = session.thread.running();
        if text.is_empty() && self.attachments.is_empty() {
            return !running && self.send_next(at, cx);
        }
        let images = std::mem::take(&mut self.attachments);
        if !running {
            return self.start_turn(at, text, images, cx);
        }
        if images.is_empty() && !text.starts_with('/') {
            self.steer(at, text, cx);
        } else {
            session.queue.push(Queued { text, images });
        }
        cx.notify();
        true
    }

    pub(crate) fn answer_question(&mut self, answer: String, cx: &mut Context<Self>) {
        self.submit(answer, cx);
    }

    pub(super) fn question_key(
        &mut self,
        event: &KeyDownEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        let elsewhere = self.page != Page::Session
            || self.palette.is_some()
            || self.dialog.is_some()
            || self.pop.is_some();
        if elsewhere || key.modifiers.modified() || !self.input.read(cx).value().is_empty() {
            return;
        }
        let Some(number) = key.key.parse::<usize>().ok().filter(|n| *n > 0) else {
            return;
        };
        let answer = self
            .session()
            .and_then(Session::question)
            .and_then(|(_, _, options)| options.get(number - 1).cloned());
        if let Some(answer) = answer {
            cx.stop_propagation();
            self.answer_question(answer, cx);
        }
    }

    fn send_next(&mut self, at: (usize, usize), cx: &mut Context<Self>) -> bool {
        let Some(session) = session_at(&mut self.workspaces, at) else {
            return false;
        };
        if session.queue.is_empty() {
            return false;
        }
        let Queued { text, images } = session.queue.remove(0);
        self.start_turn(at, text, images, cx)
    }

    fn steer(&mut self, at: (usize, usize), text: String, cx: &mut Context<Self>) {
        let Some(session) = session_at(&mut self.workspaces, at) else {
            return;
        };
        let (Some(id), Some(agent)) = (session.id.clone(), session.agent.clone()) else {
            return;
        };
        session.steering.push(text.clone());
        cx.spawn(async move |this, cx| {
            let key = id.clone();
            let said = text.clone();
            let steered = cx
                .background_spawn(async move { agent.steer(&id, &said).await })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Some(at) = this.locate(&key) else { return };
                let session = &mut this.workspaces[at.0].sessions[at.1];
                let waiting = session.steering.iter().position(|s| *s == text);
                if let Some(waiting) = waiting {
                    session.steering.remove(waiting);
                }
                if steered != Steered::Absorbed && waiting.is_some() {
                    let images = Vec::new();
                    session.queue.insert(0, Queued { text, images });
                    if steered == Steered::Missed && !session.thread.running() {
                        this.send_next(at, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start_turn(
        &mut self,
        (ws, index): (usize, usize),
        text: String,
        images: Vec<Arc<Image>>,
        cx: &mut Context<Self>,
    ) -> bool {
        let prompt = self.expand_skill(ws, &text);
        let before = self.workspaces[ws].status.clone();
        let Some(session) = self.workspaces[ws].sessions.get_mut(index) else {
            return false;
        };
        let (Some(id), Some(agent)) = (session.id.clone(), session.agent.clone()) else {
            return false;
        };
        if session.thread.running() {
            return false;
        }
        let mut blocks = Vec::new();
        if !prompt.is_empty() {
            blocks.push(serde_json::json!({ "type": "text", "text": prompt }));
        }
        blocks.extend(
            images
                .iter()
                .map(|i| crate::fx::acp::image_block(i.format.mime_type(), &i.bytes)),
        );
        session.thread.begin(text);
        if let Some(turn) = session.thread.turns.last_mut() {
            turn.images = images;
        }
        self.snapshot(id.clone(), false, cx);
        let session = &mut self.workspaces[ws].sessions[index];
        let from = session.thread.turns.len() - 1;
        session.tally.get_or_insert((before, from));
        let current = |id: &str| session.option(id).map(|o| o.current.clone());
        if let (Some(provider), Some(model)) = (current("provider"), current("model")) {
            let ran_on = (provider, model);
            if self.store.ran_on.get(&id) != Some(&ran_on) {
                self.store.ran_on.insert(id.clone(), ran_on);
                self.store.save();
            }
        }
        self.settings.skipped = None;
        session.error = None;
        cx.spawn(async move |this, cx| {
            let key = id.clone();
            let result = cx
                .background_spawn(async move { agent.prompt(&id, blocks).await })
                .await
                .map_err(|e| format!("{e:#}"));
            let _ = this.update(cx, |this, cx| {
                let body = if result.is_err() {
                    "Stopped with an error"
                } else {
                    "Done"
                };
                this.notify(&this.title_of(&key), body, cx);
                let finished = matches!(&result, Ok(reason) if reason == "end_turn");
                if let Some(at) = this.locate(&key) {
                    let s = &mut this.workspaces[at.0].sessions[at.1];
                    s.thread.finish(result);
                    s.thread.recovery = None;
                    s.permission = None;
                    this.refresh_status(at.0, cx);
                    this.snapshot(key.clone(), true, cx);
                    if finished {
                        this.send_next(at, cx);
                    }
                }
                this.refresh_changes_if_open(cx);
                cx.notify();
            });
        })
        .detach();
        self.scroll.scroll_to_bottom();
        cx.notify();
        true
    }

    fn expand_skill(&self, ws: usize, text: &str) -> String {
        let Some(rest) = text.strip_prefix('/') else {
            return text.to_string();
        };
        let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        match self.workspaces[ws].skills.iter().find(|s| s.name == name) {
            Some(skill) => format!(
                "Use the `{name}` skill: read {} first and follow it.\n\n{}",
                skill.path.display(),
                args.trim()
            ),
            None => text.to_string(),
        }
    }

    pub(crate) fn stop(&mut self, cx: &mut Context<Self>) {
        let Some((id, agent)) = self.live() else {
            return;
        };
        cx.background_spawn(async move {
            let _ = agent.cancel(&id).await;
        })
        .detach();
    }

    pub(crate) fn answer_kind(&mut self, kind: &str, cx: &mut Context<Self>) {
        if let Some(at) = self.active {
            self.answer_in(at, kind, cx);
        }
    }

    pub(crate) fn answer_in(&mut self, at: (usize, usize), kind: &str, cx: &mut Context<Self>) {
        let Some(session) = session_at(&mut self.workspaces, at) else {
            return;
        };
        let Some(agent) = session.agent.clone() else {
            return;
        };
        let Some(pending) = session.permission.take() else {
            return;
        };
        let option = pending
            .options
            .iter()
            .find(|o| o.kind == kind)
            .map(|o| o.id.clone());
        if kind == "allow_always" && option.is_some() {
            let (_, detail) = crate::fx::tools::summarize(&pending.call);
            let grant = match pending.call.kind.as_str() {
                "execute" => {
                    let words: Vec<&str> = detail.split_whitespace().take(2).collect();
                    format!("Run {}", words.join(" "))
                }
                "edit" => "Edit files".into(),
                "delete" => "Delete files".into(),
                "fetch" => "Fetch from the web".into(),
                _ => format!("Use {}", pending.call.name),
            };
            if !session.grants.contains(&grant) {
                session.grants.push(grant);
            }
        }
        cx.background_spawn(async move {
            let _ = agent
                .answer_permission(pending.request, option.as_deref())
                .await;
        })
        .detach();
        cx.notify();
    }

    fn snapshot(&mut self, id: String, ended: bool, cx: &mut Context<Self>) {
        let Some(path) = self
            .locate(&id)
            .map(|at| self.workspaces[at.0].path.clone())
        else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let tree = cx
                .background_spawn(async move { crate::host::git::snapshot(&path) })
                .await;
            let _ = this.update(cx, |this, _| {
                let Some(at) = this.locate(&id) else { return };
                let session = &mut this.workspaces[at.0].sessions[at.1];
                match (tree, ended, session.snap.as_mut()) {
                    (Some(tree), false, _) => session.snap = Some((tree, None)),
                    (Some(tree), true, Some(snap)) => snap.1 = Some(tree),
                    (None, ..) => session.snap = None,
                    _ => {}
                }
            });
        })
        .detach();
    }

    pub(crate) fn restore_turn(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.folder else { return };
        let Some(session) = self.session() else {
            return;
        };
        let (Some(id), Some((before, Some(after)))) = (session.id.clone(), session.snap.clone())
        else {
            return;
        };
        let path = self.workspaces[ws].path.clone();
        cx.spawn(async move |this, cx| {
            let restored = cx
                .background_spawn(async move { crate::host::git::restore(&path, &before, &after) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(at) = this.locate(&id) {
                    let session = &mut this.workspaces[at.0].sessions[at.1];
                    match restored {
                        Ok(_) => session.snap = None,
                        Err(why) => session.error = Some(why),
                    }
                    this.refresh_status(at.0, cx);
                }
                this.refresh_changes_if_open(cx);
                cx.notify();
            });
        })
        .detach();
    }
}
