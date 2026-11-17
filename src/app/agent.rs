use super::{Account, AgentState, FRAME, FxApp, Pending, Session, session_at};
use crate::fx::acp::{Agent, ConfigOption, Event, Launch};
use crate::fx::cli::{binary as fx_binary, home};
use gpui_kit::{AppContext as _, Context, Task};
use smol::channel::Receiver;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

pub(super) enum Open {
    New(Vec<(String, String)>),
    Replace(String, Vec<(String, String)>),
    Reload(String),
}

impl Open {
    fn slot(&self) -> Option<String> {
        match self {
            Open::New(_) => None,
            Open::Replace(id, _) | Open::Reload(id) => Some(id.clone()),
        }
    }
}

async fn open_session(
    agent: Arc<Agent>,
    open: Open,
    path: PathBuf,
) -> anyhow::Result<(String, Vec<ConfigOption>)> {
    let defaults = match open {
        Open::Reload(id) => {
            let options = agent.load_session(&id, &path).await?;
            return Ok((id, options));
        }
        Open::New(defaults) | Open::Replace(_, defaults) => defaults,
    };
    let instructions = defaults
        .iter()
        .find(|(option, _)| option == "instructions")
        .map(|(_, text)| text.as_str());
    let (id, options) = agent.new_session(&path, instructions).await?;
    let options = apply_defaults(&agent, &id, options, &defaults).await;
    Ok((id, options))
}

async fn apply_defaults(
    agent: &Agent,
    id: &str,
    mut options: Vec<ConfigOption>,
    defaults: &[(String, String)],
) -> Vec<ConfigOption> {
    for (option, value) in defaults {
        let differs = options
            .iter()
            .any(|o| &o.id == option && &o.current != value);
        if differs && let Ok(next) = agent.set_option(id, option, value).await {
            options = next;
        }
    }
    options
}

impl FxApp {
    pub(super) fn start_agent(cx: &mut Context<Self>) -> Task<()> {
        let (binary, home) = (fx_binary(), home());
        cx.spawn(async move |this, cx| {
            let started = cx
                .background_spawn(
                    async move { Agent::start(&binary, &home, &Launch::default()).await },
                )
                .await;
            let (agent, events) = match started {
                Ok(started) => started,
                Err(e) => {
                    let _ = this.update(cx, |this, cx| {
                        this.agent = AgentState::Failed(format!("{e:#}"));
                        cx.notify();
                    });
                    return;
                }
            };
            let _ = this.update(cx, |this, cx| {
                this.agent = AgentState::Ready(agent);
                this.load_catalog(cx);
                this.check_update(cx);
                for ws in 0..this.workspaces.len() {
                    this.refresh_sessions(ws, cx);
                    this.refresh_status(ws, cx);
                }
                if let Some(ws) = this.folder {
                    this.new_session_in(ws, cx);
                }
            });
            while let Ok(event) = events.recv().await {
                if this
                    .update(cx, |this, cx| this.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
    }

    pub(crate) fn restart_agent(&mut self, cx: &mut Context<Self>) {
        self.agent = AgentState::Starting;
        let task = Self::start_agent(cx);
        self._tasks.push(task);
        cx.notify();
    }

    fn on_event(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Update { session, update } => {
                if let crate::fx::acp::Update::Notice(text) = &update
                    && let Some(skipped) = crate::fx::cli::skill_warnings(text)
                {
                    self.settings.skipped = Some(skipped);
                }
                if let Some((s, _)) = self.find(&session) {
                    if let crate::fx::acp::Update::UserText(text) = &update
                        && !s.steering.is_empty()
                    {
                        let read = s.steering.iter().position(|said| said == text);
                        s.steering.remove(read.unwrap_or(0));
                    }
                    s.thread.apply(update);
                    self.scroll.scroll_to_bottom();
                }
                if self.drawn.elapsed() < FRAME {
                    self.unseen = true;
                    return;
                }
                self.drawn = Instant::now();
            }
            Event::Permission {
                request,
                session,
                call,
                options,
            } => {
                self.notify(
                    &self.title_of(&session),
                    crate::fx::tools::question(&call),
                    cx,
                );
                if let Some((s, cwd)) = self.find(&session) {
                    let preview = crate::fx::tools::edit_preview(&call, &cwd);
                    s.permission = Some(Pending {
                        request,
                        call,
                        options,
                        preview,
                    });
                    self.scroll.scroll_to_bottom();
                }
            }
            Event::Exited(reason) => self.agent = AgentState::Failed(reason),
        }
        cx.notify();
    }

    fn listen(&mut self, events: Receiver<Event>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if matches!(event, Event::Exited(_)) {
                    break;
                }
                if this
                    .update(cx, |this, cx| this.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn open_process(
        &mut self,
        ws: usize,
        mut open: Open,
        mut launch: Launch,
        cx: &mut Context<Self>,
    ) {
        launch.mode = self.store.defaults.get("mode").cloned();
        if let Open::New(defaults) | Open::Replace(_, defaults) = &mut open {
            defaults.retain(|(option, _)| option != "mode");
        }
        let path = self.workspaces[ws].path.clone();
        let (binary, home) = (fx_binary(), home());
        let slot = open.slot();
        let replayed = matches!(open, Open::Reload(_));
        cx.spawn(async move |this, cx| {
            let started = cx
                .background_spawn(async move { Agent::start(&binary, &home, &launch).await })
                .await;
            let wired = this.update(cx, |this, cx| this.wire(ws, slot.as_deref(), started, cx));
            let Ok(Some(agent)) = wired else {
                return;
            };
            let opened = cx.background_spawn(open_session(agent, open, path)).await;
            let _ = this.update(cx, |this, cx| {
                this.adopt(ws, slot.as_deref(), replayed, opened);
                if !replayed {
                    this.send_first_prompt(cx);
                }
                this.scroll.scroll_to_bottom();
                cx.notify();
            });
        })
        .detach();
    }

    fn opening(&mut self, ws: usize, slot: Option<&str>) -> Option<&mut Session> {
        let index = self.locate_in(ws, slot)?;
        session_at(&mut self.workspaces, (ws, index))
    }

    fn wire(
        &mut self,
        ws: usize,
        slot: Option<&str>,
        started: anyhow::Result<(Arc<Agent>, Receiver<Event>)>,
        cx: &mut Context<Self>,
    ) -> Option<Arc<Agent>> {
        match started {
            Ok((agent, events)) => {
                self.listen(events, cx);
                if let Some(s) = self.opening(ws, slot) {
                    s.agent = Some(agent.clone());
                }
                Some(agent)
            }
            Err(e) => {
                if let Some(s) = self.opening(ws, slot) {
                    s.error = Some(format!("{e:#}"));
                }
                cx.notify();
                None
            }
        }
    }

    fn adopt(
        &mut self,
        ws: usize,
        slot: Option<&str>,
        replayed: bool,
        opened: anyhow::Result<(String, Vec<ConfigOption>)>,
    ) {
        let Some(s) = self.opening(ws, slot) else {
            return;
        };
        match opened {
            Ok((id, options)) => {
                s.id = Some(id);
                s.options = options;
                if replayed {
                    s.thread.settle();
                    s.stale = None;
                }
            }
            Err(e) => s.error = Some(format!("{e:#}")),
        }
    }

    fn send_first_prompt(&mut self, cx: &mut Context<Self>) {
        if let Some(prompt) = self.first_prompt.take() {
            self.submit(prompt, cx);
        }
    }

    pub(super) fn stop_idle(&mut self) {
        let sessions = self.workspaces.iter_mut().flat_map(|w| &mut w.sessions);
        for session in sessions.filter(|s| !s.thread.running()) {
            if let Some(agent) = session.agent.take() {
                agent.stop();
            }
        }
    }

    pub(super) fn rest_idle(&mut self, keep: [Option<(usize, usize)>; 2]) {
        for (wi, w) in self.workspaces.iter_mut().enumerate() {
            for (si, s) in w.sessions.iter_mut().enumerate() {
                let busy = s.thread.running() || s.permission.is_some() || s.tally.is_some();
                let beside = s.id.is_some() && s.id == self.beside;
                let recent = s.id.as_ref().is_some_and(|id| self.recent.contains(id));
                if keep.contains(&Some((wi, si)))
                    || recent
                    || busy
                    || beside
                    || s.is_empty()
                    || s.id.is_none()
                {
                    continue;
                }
                let Some(agent) = s.agent.take() else {
                    continue;
                };
                agent.stop();
                s.saved_title = Some(s.label(&self.store).to_string());
                s.stale = Some(std::mem::take(&mut s.thread).turns);
                s.loaded = false;
            }
        }
    }

    pub(crate) fn load_catalog(&mut self, cx: &mut Context<Self>) {
        if self.agent().is_none() {
            return;
        }
        let cwd = self
            .workspaces
            .first()
            .map(|w| w.path.clone())
            .unwrap_or_else(home);
        let binary = fx_binary();
        cx.spawn(async move |this, cx| {
            let loaded = cx
                .background_spawn(async move {
                    let models = |options: Vec<ConfigOption>| {
                        options
                            .into_iter()
                            .find(|o| o.id == "model")
                            .map(|o| (o.current, o.choices))
                            .unwrap_or_default()
                    };
                    let (fx, _events) = Agent::start(&binary, &cwd, &Launch::default()).await?;
                    let (_, options) = fx.new_session(&cwd, None).await?;
                    let Some(accounts) = options.iter().find(|o| o.id == "provider").cloned()
                    else {
                        return anyhow::Ok((vec![], vec![]));
                    };
                    let (default_model, default_models) = models(options);
                    let saved = crate::fx::cli::saved_models();
                    let others: Vec<_> = accounts
                        .choices
                        .iter()
                        .map(|choice| {
                            if choice.value == accounts.current {
                                return None;
                            }
                            let model = saved.get(&choice.value).cloned();
                            let named = model.is_some();
                            let launch = Launch {
                                provider: Some(choice.value.clone()),
                                model,
                                ..Launch::default()
                            };
                            let (binary, cwd) = (binary.clone(), cwd.clone());
                            let listing = smol::spawn(async move {
                                let (other, _events) = Agent::start(&binary, &cwd, &launch).await?;
                                let listed = other.new_session(&cwd, None).await;
                                other.stop();
                                anyhow::Ok(listed?.1)
                            });
                            Some((named, listing))
                        })
                        .collect();
                    let mut catalog = Vec::new();
                    for (choice, other) in accounts.choices.iter().zip(others) {
                        let own = match other {
                            None => default_models.clone(),
                            Some((named, listing)) => {
                                let (_, mut own) = models(listing.await?);
                                if !named {
                                    own.retain(|c| c.value != default_model);
                                }
                                own
                            }
                        };
                        catalog.push(Account {
                            value: choice.value.clone(),
                            name: choice.name.clone(),
                            models: own,
                        });
                    }
                    fx.stop();
                    Ok((catalog, crate::fx::cli::signed_in()))
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Ok((catalog, signed_in)) = loaded {
                    this.catalog = catalog;
                    this.settings.signed_in = signed_in;
                    if !this.store.defaults.contains_key("provider")
                        && let Some(account) = this
                            .store
                            .defaults
                            .get("model")
                            .and_then(|model| this.account_of(model))
                    {
                        this.store.defaults.insert("provider".into(), account);
                        this.store.save();
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn pick_model(&mut self, account: String, model: String, cx: &mut Context<Self>) {
        let Some((ws, index)) = self.active else {
            return;
        };
        let Some(session) = self.workspaces[ws].sessions.get_mut(index) else {
            return;
        };
        if session
            .option("provider")
            .is_none_or(|o| o.current == account)
        {
            return self.set_option("model".into(), model, cx);
        }
        if session.thread.running() {
            session.error = Some("Stop this turn before switching to another account.".into());
            cx.notify();
            return;
        }
        let Some(id) = session.id.clone() else { return };
        let launch = Launch {
            provider: Some(account),
            model: Some(model),
            ..Launch::default()
        };
        if let Some(old) = session.agent.take() {
            old.stop();
        }
        session.error = None;
        if session.is_empty() {
            let mut rest = self.store.defaults.clone();
            rest.remove("provider");
            rest.remove("model");
            let defaults = rest.into_iter().collect();
            self.open_process(ws, Open::Replace(id, defaults), launch, cx);
        } else {
            self.reload_session((ws, index), launch, cx);
        }
        cx.notify();
    }

    fn reload_session(
        &mut self,
        (ws, index): (usize, usize),
        launch: Launch,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = self.workspaces[ws].sessions.get_mut(index) else {
            return;
        };
        let Some(id) = session.id.clone() else { return };
        if let Some(old) = session.agent.take() {
            old.stop();
        }
        session.stale = Some(std::mem::take(&mut session.thread.turns));
        session.grants.clear();
        session.steering.clear();
        session.skipped = None;
        self.open_process(ws, Open::Reload(id), launch, cx);
    }

    pub(super) fn account_of(&self, model: &str) -> Option<String> {
        self.catalog
            .iter()
            .find(|a| a.models.iter().any(|c| c.value == model))
            .map(|a| a.value.clone())
    }

    pub(super) fn launch_of(&self, id: &str) -> Launch {
        match self.store.ran_on.get(id) {
            Some((provider, model)) => Launch {
                provider: Some(provider.clone()),
                model: Some(model.clone()),
                ..Launch::default()
            },
            None => Launch::default(),
        }
    }

    pub(crate) fn forget_grants(&mut self, cx: &mut Context<Self>) {
        self.pop = None;
        let Some(at) = self.active else { return };
        let Some(session) = self.session_mut() else {
            return;
        };
        if session.thread.running() {
            session.error = Some("Stop this turn before forgetting what it may do.".into());
        } else if let Some(id) = session.id.clone() {
            let launch = self.launch_of(&id);
            self.reload_session(at, launch, cx);
        }
        cx.notify();
    }

    pub(crate) fn set_option(&mut self, option: String, value: String, cx: &mut Context<Self>) {
        let Some((id, agent)) = self.live() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let key = id.clone();
            let result = cx
                .background_spawn(async move { agent.set_option(&id, &option, &value).await })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some((s, _)) = this.find(&key) {
                    match result {
                        Ok(options) => s.options = options,
                        Err(e) => s.error = Some(format!("{e:#}")),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}
