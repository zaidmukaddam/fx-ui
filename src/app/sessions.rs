use super::agent::Open;
use super::{FxApp, HomeTab, Page, Session, Workspace};
use crate::fx::acp::{Launch, SavedSession};
use crate::host::{git, pickers};
use gpui_kit::{AppContext as _, Context, PathPromptOptions};
use std::path::PathBuf;

const WARM: usize = 6;

impl FxApp {
    pub(super) fn refresh_sessions(&mut self, ws: usize, cx: &mut Context<Self>) {
        let Some(agent) = self.agent() else { return };
        let Some(path) = self.workspaces.get(ws).map(|w| w.path.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let listed = cx
                .background_spawn(async move { agent.list_sessions(&path).await })
                .await;
            let _ = this.update(cx, |this, cx| {
                let Ok(saved) = listed else { return };
                let hidden = this.store.hidden.clone();
                let open = this
                    .active
                    .filter(|a| a.0 == ws)
                    .and_then(|(w, s)| this.workspaces[w].sessions.get(s))
                    .map(|s| s.id.clone());
                let w = &mut this.workspaces[ws];
                let (archived, listed): (Vec<_>, Vec<_>) =
                    saved.into_iter().partition(|s| hidden.contains(&s.id));
                w.archived = archived;
                w.archived.sort_by(|a, b| b.updated.cmp(&a.updated));
                for s in listed {
                    if !w.sessions.iter().any(|x| x.id.as_deref() == Some(&*s.id)) {
                        w.sessions.push(Session::saved(s));
                    }
                }
                w.sessions.sort_by_key(|s| std::cmp::Reverse(sort_key(s)));
                if let Some(open) = open
                    && let Some(i) = this.locate_in(ws, open.as_deref())
                {
                    this.active = Some((ws, i));
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn title_of(&self, id: &str) -> String {
        self.locate(id)
            .map(|(ws, index)| {
                self.workspaces[ws].sessions[index]
                    .label(&self.store)
                    .to_string()
            })
            .unwrap_or_default()
    }

    pub(super) fn refresh_changes_if_open(&mut self, cx: &mut Context<Self>) {
        if self.changes.is_some() {
            self.refresh_changes(cx);
        }
    }

    pub(super) fn notify(&self, title: &str, body: &str, cx: &mut Context<Self>) {
        if self.store.mute || cx.active_window().is_some() {
            return;
        }
        crate::host::mac::notify(title, body);
    }

    pub(super) fn load_folder(ws: usize, path: PathBuf, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let (branch, skills, files) = cx
                .background_spawn(async move {
                    (
                        git::branch(&path),
                        pickers::skills(&path),
                        pickers::files(&path),
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(w) = this.workspaces.get_mut(ws) {
                    w.branch = branch;
                    w.skills = skills;
                    w.files = files;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn refresh_status(&mut self, ws: usize, cx: &mut Context<Self>) {
        let Some(path) = self.workspaces.get(ws).map(|w| w.path.clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let (status, branch, files) = cx
                .background_spawn(async move {
                    (
                        git::status(&path),
                        git::branch(&path),
                        pickers::files(&path),
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                let (Ok(list), Some(w)) = (status, this.workspaces.get_mut(ws)) else {
                    return;
                };
                w.status = list;
                w.branch = branch;
                w.files = files;
                let mut dirty = false;
                for s in w.sessions.iter_mut().filter(|s| !s.thread.running()) {
                    let Some((before, from)) = s.tally.take() else {
                        continue;
                    };
                    let Some(id) = s.id.clone() else { continue };
                    let turns = s.thread.turns.get(from..).unwrap_or_default();
                    let (added, removed) =
                        crate::fx::tools::delta(turns, &w.path, &before, &w.status);
                    if added + removed > 0 {
                        let total = this.store.changes.entry(id).or_default();
                        *total = (total.0 + added, total.1 + removed);
                        dirty = true;
                    }
                }
                if dirty {
                    this.store.save();
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn open_folder(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let path = path.canonicalize().unwrap_or(path);
            let _ = this.update(cx, |this, cx| {
                let ws = match this.workspaces.iter().position(|w| w.path == path) {
                    Some(i) => i,
                    None => {
                        this.store.add_workspace(path.clone());
                        this.store.save();
                        this.workspaces.push(Workspace::new(path.clone()));
                        Self::load_folder(this.workspaces.len() - 1, path, cx);
                        this.workspaces.len() - 1
                    }
                };
                this.refresh_sessions(ws, cx);
                this.refresh_status(ws, cx);
                this.new_session_in(ws, cx);
            });
        })
        .detach();
    }

    pub(crate) fn new_session(&mut self, cx: &mut Context<Self>) {
        match self.folder {
            Some(ws) => self.new_session_in(ws, cx),
            None if !self.workspaces.is_empty() => self.new_session_in(0, cx),
            None => self.open_folder(cx),
        }
    }

    pub(crate) fn new_session_in(&mut self, ws: usize, cx: &mut Context<Self>) {
        self.page = Page::Session;
        if let Some(s) = self.workspaces[ws]
            .sessions
            .iter()
            .position(Session::is_empty)
        {
            self.show(ws, Some(s));
            cx.notify();
            return;
        }
        if self.agent().is_none() {
            self.show(ws, None);
            cx.notify();
            return;
        }
        self.workspaces[ws].sessions.insert(0, Session::fresh());
        self.show(ws, Some(0));
        let mut rest = self.store.defaults.clone();
        let model = rest.remove("model");
        let provider = rest
            .remove("provider")
            .or_else(|| model.as_ref().and_then(|m| self.account_of(m)));
        let launch = match provider {
            Some(provider) => Launch {
                provider: Some(provider),
                model,
                ..Launch::default()
            },
            None => Launch::default(),
        };
        self.open_process(ws, Open::New(rest.into_iter().collect()), launch, cx);
        cx.notify();
    }

    pub(crate) fn select(&mut self, ws: usize, index: usize, cx: &mut Context<Self>) {
        let id = self.workspaces[ws]
            .sessions
            .get(index)
            .and_then(|s| s.id.clone());
        if let Some(id) = id {
            self.recent.retain(|r| *r != id);
            self.recent.insert(0, id);
            self.recent.truncate(WARM);
        }
        self.rest_idle([self.active, Some((ws, index))]);
        self.show(ws, Some(index));
        self.page = Page::Session;
        self.picker = None;
        self.scroll.scroll_to_bottom();
        if self.workspaces[ws].sessions.get(index).is_none() {
            return;
        }
        self.load(ws, index, cx);
        let opened = self.workspaces[ws].sessions[index].id.clone();
        if opened.is_some() && self.beside == opened {
            self.beside = None;
        }
        self.refresh_changes_if_open(cx);
        cx.notify();
    }

    pub(crate) fn remove_session(&mut self, ws: usize, index: usize, cx: &mut Context<Self>) {
        let title = self.workspaces[ws].sessions[index]
            .label(&self.store)
            .to_string();
        let removed = self.workspaces[ws].sessions.remove(index);
        if let Some(agent) = &removed.agent {
            agent.stop();
        }
        if let Some(id) = removed.id {
            self.workspaces[ws].archived.insert(
                0,
                SavedSession {
                    id: id.clone(),
                    title,
                    updated: removed.updated,
                },
            );
            self.store.hidden.push(id);
            self.store.save();
        }
        if self.active == Some((ws, index)) {
            self.show(ws, None);
        } else if let Some((w, s)) = self.active
            && w == ws
            && s > index
        {
            self.active = Some((w, s - 1));
        }
        self.dialog = None;
        cx.notify();
    }

    pub(crate) fn restore_session(&mut self, ws: usize, id: &str, cx: &mut Context<Self>) {
        let w = &mut self.workspaces[ws];
        let Some(at) = w.archived.iter().position(|s| s.id == id) else {
            return;
        };
        let saved = w.archived.remove(at);
        w.sessions.push(Session::saved(saved));
        w.sessions.sort_by_key(|s| std::cmp::Reverse(sort_key(s)));
        self.store.hidden.retain(|h| h != id);
        self.store.save();
        self.home_tab = HomeTab::Recent;
        if let Some(index) = self.locate_in(ws, Some(id)) {
            self.select(ws, index, cx);
        }
    }

    pub(crate) fn rename_session(
        &mut self,
        ws: usize,
        index: usize,
        name: String,
        cx: &mut Context<Self>,
    ) {
        if let Some(id) = self.workspaces[ws]
            .sessions
            .get(index)
            .and_then(|s| s.id.clone())
        {
            let name = name.trim().to_string();
            if name.is_empty() {
                self.store.titles.remove(&id);
            } else {
                self.store.titles.insert(id, name);
            }
            self.store.save();
        }
        self.dialog = None;
        cx.notify();
    }

    fn load(&mut self, ws: usize, index: usize, cx: &mut Context<Self>) {
        let Some(session) = self.workspaces[ws].sessions.get_mut(index) else {
            return;
        };
        if session.loaded {
            return;
        }
        session.loaded = true;
        if let Some(id) = session.id.clone() {
            let launch = self.launch_of(&id);
            self.open_process(ws, Open::Reload(id), launch, cx);
        }
    }

    pub(crate) fn open_beside(&mut self, ws: usize, index: usize, cx: &mut Context<Self>) {
        self.menu = None;
        if self.active == Some((ws, index)) {
            return;
        }
        let Some(id) = self.workspaces[ws].sessions[index].id.clone() else {
            return;
        };
        self.beside = Some(id);
        self.load(ws, index, cx);
        cx.notify();
    }

    pub(crate) fn swap_beside(&mut self, cx: &mut Context<Self>) {
        let Some((ws, index)) = self.beside.as_deref().and_then(|id| self.locate(id)) else {
            self.beside = None;
            return;
        };
        self.beside = self
            .session()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.id.clone());
        self.select(ws, index, cx);
    }
}

fn sort_key(s: &Session) -> String {
    if s.updated.is_empty() {
        "~".into()
    } else {
        s.updated.clone()
    }
}
