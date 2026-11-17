use crate::fx::acp::{Agent, ConfigOption, PermissionOption, SavedSession, ToolCall};
use crate::fx::transcript::{Thread, Turn};
use crate::host::git::DiffLine;
use crate::host::pickers::Skill;
use crate::host::store::Store;
use gpui_kit::component::input::InputState;
use gpui_kit::{Entity, Image, SharedString, Subscription};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Default)]
pub(crate) struct Seen {
    pub session: Option<String>,
    pub width: f32,
    pub offset: f32,
    pub spots: Vec<(f32, f32)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Status {
    Waiting,
    Running,
    Stopped,
    Idle,
}

pub(crate) const RECENT: usize = 5;

pub(crate) enum AgentState {
    Starting,
    Ready(Arc<Agent>),
    Failed(String),
}

pub(crate) struct Session {
    pub id: Option<String>,
    pub saved_title: Option<String>,
    pub updated: String,
    pub loaded: bool,
    pub thread: Thread,
    pub stale: Option<Vec<Turn>>,
    pub options: Vec<ConfigOption>,
    pub permission: Option<Pending>,
    pub expanded: HashSet<usize>,
    pub open_steps: HashSet<(usize, usize)>,
    pub error: Option<String>,
    pub agent: Option<Arc<Agent>>,
    pub tally: Option<(Vec<crate::host::git::Change>, usize)>,
    pub steering: Vec<String>,
    pub queue: Vec<Queued>,
    pub skipped: Option<usize>,
    pub grants: Vec<String>,
    pub snap: Option<(String, Option<String>)>,
}

pub(crate) struct Queued {
    pub text: String,
    pub images: Vec<Arc<Image>>,
}

pub(crate) const MAX_IMAGES: usize = 8;
pub(super) const MAX_IMAGE_BYTES: usize = 3_932_160;

pub(crate) struct Pending {
    pub request: Value,
    pub call: ToolCall,
    pub options: Vec<PermissionOption>,
    pub preview: Option<Vec<DiffLine>>,
}

impl Session {
    pub(super) fn fresh() -> Self {
        Session {
            id: None,
            saved_title: None,
            updated: String::new(),
            loaded: true,
            thread: Thread::default(),
            stale: None,
            options: vec![],
            permission: None,
            expanded: HashSet::new(),
            open_steps: HashSet::new(),
            error: None,
            agent: None,
            tally: None,
            steering: Vec::new(),
            queue: Vec::new(),
            skipped: None,
            grants: Vec::new(),
            snap: None,
        }
    }

    pub(super) fn saved(saved: SavedSession) -> Self {
        Session {
            id: Some(saved.id),
            saved_title: Some(saved.title),
            updated: saved.updated,
            loaded: false,
            ..Session::fresh()
        }
    }

    pub fn option(&self, id: &str) -> Option<&ConfigOption> {
        self.options.iter().find(|o| o.id == id)
    }

    pub fn label(&self, store: &Store) -> SharedString {
        self.id
            .as_ref()
            .and_then(|id| store.titles.get(id).cloned())
            .or_else(|| self.thread.title.clone())
            .or_else(|| self.saved_title.clone())
            .or_else(|| self.thread.turns.first().map(|t| t.prompt.clone()))
            .unwrap_or_else(|| "New session".into())
            .into()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.thread.turns.is_empty() && self.saved_title.is_none()
    }

    pub(crate) fn turns(&self) -> &[Turn] {
        self.stale.as_deref().unwrap_or(&self.thread.turns)
    }

    pub(crate) fn status(&self) -> Status {
        if self.permission.is_some() {
            Status::Waiting
        } else if self.thread.running() {
            Status::Running
        } else if self.thread.turns.last().is_some_and(|t| t.stop.is_some()) {
            Status::Stopped
        } else {
            Status::Idle
        }
    }

    pub(crate) fn question(&self) -> Option<(usize, String, Vec<String>)> {
        let last = self.thread.turns.len().checked_sub(1)?;
        let turn = &self.thread.turns[last];
        if turn.running()
            || self.skipped == Some(last)
            || self.permission.is_some()
            || !self.queue.is_empty()
        {
            return None;
        }
        let (asks, options) = crate::fx::tools::asked(turn)?;
        Some((last, asks, options))
    }
}

pub(crate) struct Workspace {
    pub path: PathBuf,
    pub name: String,
    pub branch: Option<String>,
    pub sessions: Vec<Session>,
    pub archived: Vec<SavedSession>,
    pub show_all: bool,
    pub skills: Vec<Skill>,
    pub files: Vec<String>,
    pub status: Vec<crate::host::git::Change>,
}

impl Workspace {
    pub(super) fn new(path: PathBuf) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        Workspace {
            branch: None,
            skills: vec![],
            files: vec![],
            path,
            name,
            sessions: vec![],
            archived: vec![],
            show_all: false,
            status: vec![],
        }
    }

    pub(crate) fn listed(&self) -> impl Iterator<Item = (usize, &Session)> {
        self.sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| !s.is_empty())
    }

    pub(crate) fn session_status(&self) -> Status {
        let any = |status| self.sessions.iter().any(|s| s.status() == status);
        if any(Status::Waiting) {
            Status::Waiting
        } else if any(Status::Running) {
            Status::Running
        } else {
            Status::Idle
        }
    }
}

pub(crate) struct Account {
    pub value: String,
    pub name: String,
    pub models: Vec<crate::fx::acp::Choice>,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Pop {
    Attach,
    Mode,
    Model,
    Thinking,
    Usage,
}

pub(crate) struct ModelSearch {
    pub input: Entity<InputState>,
    pub at: usize,
    pub _subscription: Subscription,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum MenuAt {
    Row(usize, usize),
    Header,
    Folders,
    Mcp(usize),
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum HomeTab {
    Recent,
    Running,
    Archived,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Page {
    Session,
    Settings,
}

pub(crate) struct Picker {
    pub kind: char,
    pub items: Vec<(String, String, String)>,
    pub selected: usize,
    pub query: String,
}

pub(crate) enum Dialog {
    Remove {
        ws: usize,
        session: usize,
    },
    Rename {
        ws: usize,
        session: usize,
        input: Entity<InputState>,
        _subscription: Subscription,
    },
    Discard(crate::host::git::Change),
    FullAccess(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_says_where_it_stands() {
        let mut session = Session::fresh();
        assert_eq!(session.status(), Status::Idle);
        session.thread.begin("go".into());
        assert_eq!(session.status(), Status::Running);
        session.permission = Some(Pending {
            request: Value::Null,
            call: ToolCall::default(),
            options: vec![],
            preview: None,
        });
        assert_eq!(session.status(), Status::Waiting);
        session.permission = None;
        session.thread.finish(Err("fx acp exited".into()));
        assert_eq!(session.status(), Status::Stopped);
        session.thread.begin("again".into());
        session.thread.finish(Ok("end_turn".into()));
        assert_eq!(session.status(), Status::Idle);
    }
}
