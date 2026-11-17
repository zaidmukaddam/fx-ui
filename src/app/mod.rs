mod agent;
mod draft;
mod format;
mod sessions;
mod state;
mod turns;
mod window;

pub(crate) use draft::clipboard_images;
pub(crate) use format::{ago, capitalized, choice_name, day, model_name};
pub(crate) use state::{
    Account, AgentState, Dialog, HomeTab, MAX_IMAGES, MenuAt, ModelSearch, Page, Pending, Picker,
    Pop, Queued, RECENT, Seen, Session, Status, Workspace,
};

use crate::design::*;
use crate::fx::acp::Agent;
use crate::host::store::Store;
use gpui_kit::component::input::TextareaState;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnimationExt as _, AnyElement, AppContext as _, Context, Div, Entity, FocusHandle,
    Focusable as _, Image, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _,
    Render, ScrollHandle, Styled as _, Subscription, Task, Window, div, px,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

gpui_kit::actions!(
    fx,
    [
        NewSession,
        TogglePalette,
        OpenSettings,
        ToggleChanges,
        ToggleSidebar,
        OpenFolder
    ]
);

pub fn bind_keys(cx: &mut gpui_kit::App) {
    cx.bind_keys([
        KeyBinding::new("cmd-n", NewSession, None),
        KeyBinding::new("cmd-k", TogglePalette, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-\\", ToggleChanges, None),
        KeyBinding::new("cmd-o", OpenFolder, None),
        KeyBinding::new("cmd-b", ToggleSidebar, None),
    ]);
}

pub const FX_BRAILLE: &str = " ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆
 ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀
 ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀
 ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀
 ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀
 ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦
  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀";

const CHANGES: f32 = 576.;
const SLIDE: Duration = Duration::from_millis(160);
pub(super) const FRAME: Duration = Duration::from_millis(33);
const IDLE: Duration = Duration::from_millis(250);

pub struct FxApp {
    pub(crate) store: Store,
    pub(crate) agent: AgentState,
    pub(crate) workspaces: Vec<Workspace>,
    pub(crate) folder: Option<usize>,
    pub(crate) active: Option<(usize, usize)>,
    pub(crate) page: Page,
    pub(crate) input: Entity<TextareaState>,
    pub(crate) attachments: Vec<Arc<Image>>,
    pub(crate) scroll: ScrollHandle,
    pub(crate) picker: Option<Picker>,
    pub(crate) palette: Option<crate::views::palette::Palette>,
    pub(crate) dialog: Option<Dialog>,
    pub(crate) changes: Option<crate::views::changes::Changes>,
    pub(crate) pop: Option<Pop>,
    pub(crate) just_closed: Option<Pop>,
    pub(crate) model_search: Option<ModelSearch>,
    pub(crate) menu: Option<MenuAt>,
    pub(crate) menu_closed: Option<MenuAt>,
    sidebar_open: bool,
    sidebar_closing: bool,
    sidebar_slides: usize,
    changes_width: f32,
    resizing: Option<(f32, f32)>,
    pub(crate) beside: Option<String>,
    pub(crate) recent: Vec<String>,
    pub(crate) seen: std::rc::Rc<std::cell::RefCell<Seen>>,
    pub(super) unseen: bool,
    pub(super) drawn: Instant,
    pub(crate) update: crate::host::update::Update,
    pub(crate) home_tab: HomeTab,
    pub(crate) catalog: Vec<Account>,
    hint: &'static str,
    pub(crate) settings: crate::views::settings::SettingsState,
    first_prompt: Option<String>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
    focus: FocusHandle,
}

impl FxApp {
    pub fn new(
        folder: Option<PathBuf>,
        first_prompt: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut store = Store::load();
        if let Some(folder) = &folder {
            store.add_workspace(folder.clone());
            store.save();
        }
        let workspaces: Vec<Workspace> = store
            .workspaces
            .iter()
            .filter(|p| p.is_dir())
            .cloned()
            .map(Workspace::new)
            .collect();
        for (ws, w) in workspaces.iter().enumerate() {
            Self::load_folder(ws, w.path.clone(), cx);
        }
        let active_ws = folder
            .as_ref()
            .and_then(|f| workspaces.iter().position(|w| &w.path == f))
            .or(if workspaces.is_empty() { None } else { Some(0) });

        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Describe a change. @ to attach files, / for skills")
                .auto_grow(2, 12)
                .submit_on_enter(true)
        });
        let on_input = cx.subscribe_in(&input, window, Self::on_input);
        let on_quit = cx.on_app_quit(|this, _| {
            this.stop_idle();
            async {}
        });

        let start = Self::start_agent(cx);
        let ticker = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let alive = this.update(cx, |this, cx| {
                    if this.any_running() {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        let pulse = cx.spawn(async move |this, cx| {
            let mut wait = IDLE;
            loop {
                cx.background_executor().timer(wait).await;
                let moving = this.update(cx, |this, cx| {
                    let moving = crate::design::take_spinning() | std::mem::take(&mut this.unseen);
                    if moving {
                        this.drawn = Instant::now();
                        cx.notify();
                    }
                    moving
                });
                match moving {
                    Ok(moving) => wait = if moving { FRAME } else { IDLE },
                    Err(_) => break,
                }
            }
        });

        input.read(cx).focus_handle(cx).focus(window, cx);

        Self {
            store,
            agent: AgentState::Starting,
            folder: active_ws,
            active: None,
            workspaces,
            page: Page::Session,
            input,
            scroll: ScrollHandle::new(),
            picker: None,
            palette: None,
            dialog: None,
            changes: None,
            attachments: Vec::new(),
            pop: None,
            just_closed: None,
            model_search: None,
            menu: None,
            menu_closed: None,
            sidebar_open: true,
            sidebar_closing: false,
            sidebar_slides: 0,
            changes_width: CHANGES,
            resizing: None,
            beside: None,
            recent: Vec::new(),
            seen: Default::default(),
            unseen: false,
            drawn: Instant::now(),
            update: Default::default(),
            home_tab: HomeTab::Recent,
            catalog: vec![],
            hint: "",
            settings: Default::default(),
            first_prompt,
            _tasks: vec![start, ticker, pulse],
            _subscriptions: vec![on_input, on_quit],
            focus: cx.focus_handle(),
        }
    }

    pub(crate) fn agent(&self) -> Option<Arc<Agent>> {
        match &self.agent {
            AgentState::Ready(agent) => Some(agent.clone()),
            _ => None,
        }
    }

    pub(crate) fn session(&self) -> Option<&Session> {
        let (ws, s) = self.active?;
        self.workspaces.get(ws)?.sessions.get(s)
    }

    pub(crate) fn session_mut(&mut self) -> Option<&mut Session> {
        session_at(&mut self.workspaces, self.active?)
    }

    pub(crate) fn workspace(&self) -> Option<&Workspace> {
        self.workspaces.get(self.folder?)
    }

    pub(super) fn show(&mut self, ws: usize, session: Option<usize>) {
        self.folder = Some(ws);
        self.active = session.map(|s| (ws, s));
    }

    fn locate_in(&self, ws: usize, id: Option<&str>) -> Option<usize> {
        self.workspaces
            .get(ws)?
            .sessions
            .iter()
            .position(|s| s.id.as_deref() == id)
    }

    fn locate(&self, id: &str) -> Option<(usize, usize)> {
        (0..self.workspaces.len()).find_map(|ws| Some((ws, self.locate_in(ws, Some(id))?)))
    }

    fn find(&mut self, id: &str) -> Option<(&mut Session, PathBuf)> {
        let (ws, index) = self.locate(id)?;
        let w = &mut self.workspaces[ws];
        Some((&mut w.sessions[index], w.path.clone()))
    }

    fn any_running(&self) -> bool {
        self.workspaces
            .iter()
            .any(|w| w.sessions.iter().any(|s| s.thread.running()))
    }

    fn live(&self) -> Option<(String, Arc<Agent>)> {
        let session = self.session()?;
        Some((session.id.clone()?, session.agent.clone()?))
    }
}

fn session_at(workspaces: &mut [Workspace], (ws, index): (usize, usize)) -> Option<&mut Session> {
    workspaces.get_mut(ws)?.sessions.get_mut(index)
}

fn panel(content: AnyElement) -> Div {
    v_flex()
        .flex_1()
        .h_full()
        .min_w_0()
        .rounded(px(12.))
        .overflow_hidden()
        .bg(background_100())
        .border_1()
        .border_color(alpha_200())
        .shadow(shadow_panel())
        .child(content)
}

impl FxApp {
    fn sync_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pop != Some(Pop::Model) {
            self.model_search = None;
        }
        let hint = if self.session().is_some_and(|s| !s.is_empty()) {
            "Reply to fx, or type @ for files and / for skills"
        } else {
            "Describe a change. @ to attach files, / for skills"
        };
        if self.hint != hint {
            self.hint = hint;
            self.input
                .update(cx, |i, cx| i.set_placeholder(hint, window, cx));
        }
    }

    fn sync_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        let composer = self.page == Page::Session
            && self.workspace().is_some()
            && !matches!(self.agent, AgentState::Failed(_));
        let confirm = matches!(
            self.dialog,
            Some(Dialog::Remove { .. } | Dialog::Discard(_) | Dialog::FullAccess(_))
        );
        let input = self.input.read(cx).focus_handle(cx);
        if confirm {
            if !self.focus.is_focused(window) {
                self.focus.focus(window, cx);
            }
        } else if self.palette.is_none() && self.dialog.is_none() {
            if composer && self.focus.is_focused(window) {
                input.focus(window, cx);
            } else if (!composer && input.is_focused(window)) || window.focused(cx).is_none() {
                self.focus.focus(window, cx);
            }
        }
    }

    fn render_page(&self, cx: &mut Context<Self>) -> AnyElement {
        match (self.page, self.session()) {
            (Page::Settings, _) => self.render_settings(cx).into_any_element(),
            (_, Some(s)) if !s.is_empty() => {
                let ground = background_100();
                v_flex()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_thread(s, cx))
                    .child(
                        v_flex()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom_0()
                            .child(div().h(px(56.)).bg(gpui_kit::linear_gradient(
                                180.,
                                gpui_kit::linear_color_stop(ground.opacity(0.), 0.),
                                gpui_kit::linear_color_stop(ground.opacity(0.86), 1.),
                            )))
                            .child(
                                h_flex()
                                    .justify_center()
                                    .px(px(40.))
                                    .pb(px(20.))
                                    .bg(ground.opacity(0.86))
                                    .child(
                                        div()
                                            .w_full()
                                            .max_w(COLUMN)
                                            .child(self.render_composer(cx)),
                                    ),
                            ),
                    )
                    .into_any_element()
            }
            _ => self.render_home(cx),
        }
    }

    fn render_panels(&self, cx: &mut Context<Self>) -> Div {
        let body = self.render_page(cx);
        let main = v_flex()
            .size_full()
            .child(self.render_header(cx))
            .child(body)
            .into_any_element();
        let changes = (self.page == Page::Session)
            .then(|| {
                self.changes
                    .as_ref()
                    .map(|c| self.render_changes(c, cx).into_any_element())
            })
            .flatten();
        let beside = (self.page == Page::Session)
            .then(|| self.beside.as_deref().and_then(|id| self.locate(id)))
            .flatten()
            .map(|(ws, index)| self.render_beside(ws, index, cx).into_any_element());
        let handle = div()
            .id("changes-resize")
            .w(px(8.))
            .h_full()
            .flex_shrink_0()
            .cursor_col_resize()
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(|this, down: &gpui_kit::MouseDownEvent, _, cx| {
                    this.resizing = Some((f32::from(down.position.x), this.changes_width));
                    cx.notify();
                }),
            );
        let width = self.changes_width;
        h_flex()
            .flex_1()
            .h_full()
            .min_w_0()
            .pr(px(8.))
            .pb(px(8.))
            .child(panel(main))
            .children(beside.map(|b| {
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .pl(px(8.))
                    .child(panel(b))
            }))
            .children(changes.map(|c| {
                h_flex()
                    .w(px(width + 8.))
                    .flex_shrink_0()
                    .h_full()
                    .child(handle)
                    .child(panel(c))
            }))
    }

    fn render_root(&self, cx: &mut Context<Self>) -> Div {
        let mut root = div();
        root.text_style().font_fallbacks =
            Some(gpui_kit::FontFallbacks::from_fonts(vec![MONO.into()]));
        root.size_full()
            .relative()
            .font_family(sans())
            .text_size(px(13.))
            .text_color(gray_1000())
            .bg(background_200())
            .track_focus(&self.focus)
            .capture_any_mouse_down(cx.listener(|this, _, _, _| {
                this.just_closed = None;
                this.menu_closed = None;
            }))
            .on_action(cx.listener(|this, _: &NewSession, _, cx| this.new_session(cx)))
            .on_action(
                cx.listener(|this, _: &TogglePalette, window, cx| this.toggle_palette(window, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenSettings, _, cx| this.open_settings(cx)))
            .on_action(cx.listener(|this, _: &ToggleChanges, _, cx| this.toggle_changes(cx)))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &OpenFolder, _, cx| this.open_folder(cx)))
            .capture_key_down(cx.listener(Self::question_key))
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_move(
                cx.listener(|this, moved: &gpui_kit::MouseMoveEvent, _, cx| {
                    let Some((from, width)) = this.resizing else {
                        return;
                    };
                    if moved.pressed_button != Some(gpui_kit::MouseButton::Left) {
                        this.resizing = None;
                    } else {
                        let dragged = from - f32::from(moved.position.x);
                        this.changes_width = (width + dragged).clamp(360., 960.);
                    }
                    cx.notify();
                }),
            )
            .on_mouse_up(
                gpui_kit::MouseButton::Left,
                cx.listener(|this, _, _, _| this.resizing = None),
            )
    }

    fn render_frame(&self, panels: Div, window: &Window, cx: &mut Context<Self>) -> Div {
        if self.sidebar_open {
            let sidebar = div()
                .h_full()
                .flex_shrink_0()
                .overflow_hidden()
                .child(self.render_sidebar(cx));
            let full = f32::from(crate::design::SIDEBAR);
            let sidebar = if self.sidebar_slides == 0 {
                sidebar.w(px(full)).into_any_element()
            } else {
                let closing = self.sidebar_closing;
                sidebar
                    .with_animation(
                        ("sidebar-slide", self.sidebar_slides),
                        gpui_kit::Animation::new(SLIDE).with_easing(gpui_kit::ease_in_out),
                        move |d, t| d.w(px(full * if closing { 1. - t } else { t })),
                    )
                    .into_any_element()
            };
            h_flex().size_full().child(sidebar).child(panels.pt(px(8.)))
        } else {
            v_flex()
                .size_full()
                .child(self.render_tabs(window, cx))
                .child(h_flex().flex_1().min_h_0().child(panels.pl(px(8.))))
        }
    }
}

impl Render for FxApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_composer(window, cx);
        self.sync_focus(window, cx);
        let panels = self.render_panels(cx);
        self.render_root(cx)
            .child(self.render_frame(panels, window, cx))
            .children(self.render_palette(window, cx))
            .children(self.render_dialog(cx))
    }
}
