use crate::app::{AgentState, FxApp, MenuAt, Page, RECENT, Session, Status, Workspace, ago};
use crate::design::*;
use crate::host::mac::user_name;
use crate::views::settings::Section;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, ClipboardItem, Context, Div, ElementId, FontWeight,
    InteractiveElement as _, IntoElement, MouseDownEvent, ParentElement as _, SharedString,
    Stateful, StatefulInteractiveElement as _, Styled as _, Window, deferred, div, px, svg,
};

pub(crate) fn status_mark(status: Status) -> Option<AnyElement> {
    match status {
        Status::Waiting => Some(dot(amber_700()).into_any_element()),
        Status::Running => Some(spinner(12.).into_any_element()),
        Status::Stopped => Some(dot(red_700()).into_any_element()),
        Status::Idle => None,
    }
}

fn session_key(wi: usize, si: usize) -> usize {
    wi * 10_000 + si
}

fn mark() -> impl IntoElement {
    svg()
        .path(crate::design::assets::FX_MARK)
        .size(px(16.))
        .flex_shrink_0()
        .text_color(gray_1000())
}

fn avatar() -> Div {
    text(11., 12.)
        .size(px(24.))
        .flex_shrink_0()
        .rounded(px(12.))
        .bg(gray_300())
        .flex()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::SEMIBOLD)
        .child(
            user_name()
                .chars()
                .next()
                .unwrap_or('f')
                .to_uppercase()
                .to_string(),
        )
}

pub(crate) fn menu_item(
    id: impl Into<ElementId>,
    name: &'static str,
    label: impl Into<SharedString>,
    keys: &'static str,
    danger: bool,
) -> Stateful<Div> {
    let color = if danger { red_900() } else { gray_1000() };
    h_flex()
        .id(id)
        .h(px(32.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(10.))
        .rounded(px(7.))
        .cursor_pointer()
        .hover(|d| d.bg(alpha_200()))
        .child(icon(name, 14., color))
        .child(
            text(13., 18.)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(color)
                .child(label.into()),
        )
        .when(!keys.is_empty(), |d| {
            d.child(text(12., 16.).text_color(gray_700()).child(keys))
        })
}

fn nav(
    id: &'static str,
    name: &'static str,
    label: &'static str,
    keys: &'static str,
    on: bool,
) -> Stateful<Div> {
    h_flex()
        .id(id)
        .h(px(30.))
        .flex_shrink_0()
        .px(px(8.))
        .gap(px(10.))
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |d| d.bg(alpha_200()))
        .hover(|d| d.bg(alpha_200()))
        .child(icon(name, 16., gray_1000()))
        .child(text(13., 18.).flex_1().child(label))
        .when(!keys.is_empty(), |d| {
            d.child(text(12., 16.).text_color(gray_700()).child(keys))
        })
}

fn no_workspaces() -> Div {
    v_flex()
        .pt(px(20.))
        .px(px(8.))
        .gap(px(2.))
        .child(
            text(12., 16.)
                .font_weight(FontWeight::MEDIUM)
                .text_color(gray_900())
                .child("No workspaces yet"),
        )
        .child(
            text(12., 16.)
                .text_color(gray_700())
                .child("Sessions show up here once you add a folder."),
        )
}

fn branch_pill(branch: String) -> Div {
    h_flex()
        .h(px(28.))
        .flex_shrink_0()
        .px(px(10.))
        .gap(px(6.))
        .rounded(px(6.))
        .child(icon("branch", 14., gray_900()))
        .child(
            text(12., 16.)
                .font_family(MONO)
                .text_color(gray_900())
                .child(branch),
        )
}

impl FxApp {
    fn toggle_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        icon_button("sidebar-toggle", "panel-left", 16.)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_sidebar(cx)))
    }

    pub(crate) fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let skills = self.page == Page::Settings && self.settings.section == Section::Skills;
        let mut groups: Vec<AnyElement> = self
            .workspaces
            .iter()
            .enumerate()
            .map(|(wi, w)| self.workspace_group(wi, w, cx).into_any_element())
            .collect();
        groups.push(if self.workspaces.is_empty() {
            no_workspaces().into_any_element()
        } else {
            self.add_folder_row(cx).into_any_element()
        });

        v_flex()
            .w(SIDEBAR)
            .flex_shrink_0()
            .h_full()
            .px(px(8.))
            .pb(px(8.))
            .child(
                h_flex()
                    .h(px(48.))
                    .flex_shrink_0()
                    .pl(px(80.))
                    .pr(px(4.))
                    .child(mark())
                    .child(div().flex_1())
                    .child(self.toggle_button(cx)),
            )
            .child(self.sidebar_nav(skills, cx))
            .child(
                div()
                    .id("workspaces")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(v_flex().children(groups)),
            )
            .child(self.account_row(skills, cx))
    }

    fn sidebar_nav(&self, skills: bool, cx: &mut Context<Self>) -> Div {
        let home = self.page == Page::Session
            && self.workspace().is_some()
            && self.session().is_none_or(Session::is_empty);
        v_flex()
            .gap(px(1.))
            .pt(px(4.))
            .child(
                nav("new", "compose", "New session", "⌘N", home)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.new_session(cx))),
            )
            .child(nav("search", "search", "Search", "⌘K", false).on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_palette(window, cx)),
            ))
            .child(
                nav("skills", "star", "Skills", "", skills).on_click(cx.listener(
                    |this, _: &ClickEvent, window, cx| {
                        this.open_section(Section::Skills, window, cx)
                    },
                )),
            )
    }

    fn workspace_group(&self, wi: usize, w: &Workspace, cx: &mut Context<Self>) -> Div {
        let total = w.listed().count();
        let shown = if w.show_all { total } else { total.min(RECENT) };
        let rows: Vec<AnyElement> = w
            .listed()
            .take(shown)
            .map(|(si, s)| self.session_row(wi, si, s, cx).into_any_element())
            .collect();
        v_flex()
            .pt(px(if wi == 0 { 20. } else { 16. }))
            .gap(px(1.))
            .child(
                h_flex()
                    .h(px(26.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .gap(px(6.))
                    .child(
                        text(12., 16.)
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gray_900())
                            .child(w.name.clone()),
                    )
                    .child(
                        div()
                            .id(("new-in", wi))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                this.new_session_in(wi, cx)
                            }))
                            .child(icon("plus", 14., gray_700())),
                    ),
            )
            .children(rows)
            .when(total > RECENT, |d| {
                d.child(self.show_more(wi, w.show_all, total, cx))
            })
    }

    fn show_more(
        &self,
        wi: usize,
        all: bool,
        total: usize,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let label = if all {
            "Show fewer".to_string()
        } else {
            format!("Show {} more", total - RECENT)
        };
        text(13., 18.)
            .id(("more", wi))
            .h(px(30.))
            .flex_shrink_0()
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .cursor_pointer()
            .text_color(gray_700())
            .hover(|d| d.text_color(gray_1000()))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.workspaces[wi].show_all = !this.workspaces[wi].show_all;
                cx.notify();
            }))
            .child(label)
    }

    fn add_folder_row(&self, cx: &mut Context<Self>) -> Div {
        div().pt(px(16.)).child(
            h_flex()
                .id("add-folder")
                .h(px(30.))
                .px(px(8.))
                .gap(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_color(gray_700())
                .hover(|d| d.bg(alpha_200()).text_color(gray_1000()))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.open_folder(cx)))
                .child(text(13., 18.).flex_1().child("Add folder"))
                .child(text(12., 16.).text_color(gray_700()).child("⌘O")),
        )
    }

    fn account_row(&self, skills: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        h_flex()
            .id("account")
            .h(px(44.))
            .flex_shrink_0()
            .px(px(8.))
            .gap(px(10.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|d| d.bg(alpha_200()))
            .when(self.page == Page::Settings && !skills, |d| {
                d.bg(alpha_200())
            })
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                this.open_section(Section::Models, window, cx)
            }))
            .child(avatar())
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(text(13., 16.).truncate().child(user_name()))
                    .child(
                        text(12., 16.)
                            .truncate()
                            .text_color(gray_700())
                            .child(self.account_line()),
                    ),
            )
            .child(icon("settings", 16., gray_900()))
    }

    fn account_line(&self) -> SharedString {
        self.session()
            .and_then(|s| s.option("provider"))
            .and_then(|o| o.choices.iter().find(|c| c.value == o.current))
            .map(|c| c.name.clone().into())
            .unwrap_or_else(|| match &self.agent {
                AgentState::Starting => "Starting fx…".into(),
                AgentState::Failed(_) => "fx is not running".into(),
                AgentState::Ready(_) => "fx".into(),
            })
    }

    fn session_row(
        &self,
        wi: usize,
        si: usize,
        s: &Session,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.page == Page::Session && self.active == Some((wi, si));
        let at = MenuAt::Row(wi, si);
        let menu_open = self.menu == Some(at);
        let key = session_key(wi, si);
        let trailing = status_mark(s.status()).unwrap_or_else(|| {
            text(12., 16.)
                .text_color(gray_700())
                .child(ago(&s.updated))
                .into_any_element()
        });
        h_flex()
            .id(("session", key))
            .group("row")
            .h(px(30.))
            .flex_shrink_0()
            .px(px(8.))
            .gap(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .when(selected || menu_open, |d| d.bg(alpha_200()))
            .hover(|d| d.bg(alpha_200()))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select(wi, si, cx)))
            .child(
                text(13., 18.)
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(if selected { gray_1000() } else { gray_900() })
                    .child(s.label(&self.store)),
            )
            .child(
                div()
                    .relative()
                    .w(px(20.))
                    .h_full()
                    .flex_shrink_0()
                    .child(
                        h_flex()
                            .size_full()
                            .justify_end()
                            .group_hover("row", |s| s.invisible())
                            .when(menu_open, |d| d.invisible())
                            .child(trailing),
                    )
                    .child(
                        div()
                            .id(("row-menu", key))
                            .absolute()
                            .right_0()
                            .top(px(5.))
                            .size(px(20.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .when(!menu_open, |d| {
                                d.invisible().group_hover("row", |s| s.visible())
                            })
                            .when(menu_open, |d| d.bg(alpha_300()))
                            .hover(|d| d.bg(alpha_300()))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                cx.stop_propagation();
                                this.toggle_menu(at, cx);
                            }))
                            .child(icon("ellipsis", 14., gray_1000())),
                    )
                    .when(menu_open, |d| {
                        d.child(
                            deferred(
                                self.menu_card(wi, si, cx)
                                    .absolute()
                                    .top(px(34.))
                                    .left(px(-6.)),
                            )
                            .with_priority(1),
                        )
                    }),
            )
    }

    pub(crate) fn toggle_menu(&mut self, at: MenuAt, cx: &mut Context<Self>) {
        if self.menu_closed.take() == Some(at) {
            return;
        }
        self.menu = if self.menu == Some(at) {
            None
        } else {
            Some(at)
        };
        cx.notify();
    }

    pub(crate) fn menu_frame(&self, cx: &mut Context<Self>) -> Div {
        v_flex()
            .w(px(220.))
            .p(px(6.))
            .rounded(px(12.))
            .bg(background_100())
            .border_1()
            .border_color(alpha_400())
            .shadow(shadow_pop())
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, _, cx| {
                this.menu_closed = this.menu.take();
                cx.notify();
            }))
    }

    fn menu_card(&self, ws: usize, si: usize, cx: &mut Context<Self>) -> Div {
        let item = menu_item;
        let id = self.workspaces[ws].sessions[si].id.clone();
        self.menu_frame(cx)
            .child(
                item("menu-rename", "pencil", "Rename", "", false).on_click(cx.listener(
                    move |this, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        this.menu = None;
                        this.start_rename(ws, si, window, cx);
                    },
                )),
            )
            .child(
                item("menu-changes", "panel-right", "Show changes", "⌘\\", false).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.menu = None;
                        this.select(ws, si, cx);
                        if this.changes.is_none() {
                            this.toggle_changes(cx);
                        }
                    }),
                ),
            )
            .when(self.active != Some((ws, si)), |d| {
                d.child(
                    item("menu-beside", "panel-split", "Open beside", "", false).on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| {
                            cx.stop_propagation();
                            this.open_beside(ws, si, cx);
                        }),
                    ),
                )
            })
            .when_some(id, |d, id| {
                d.child(
                    item("menu-copy", "copy", "Copy session id", "", false).on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            cx.stop_propagation();
                            this.menu = None;
                            cx.write_to_clipboard(ClipboardItem::new_string(id.clone()));
                            cx.notify();
                        },
                    )),
                )
            })
            .child(div().h(px(1.)).my(px(4.)).bg(alpha_200()))
            .child(
                item("menu-remove", "trash", "Remove from list", "", true).on_click(cx.listener(
                    move |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.menu = None;
                        this.dialog = Some(crate::app::Dialog::Remove { ws, session: si });
                        cx.notify();
                    },
                )),
            )
    }

    pub(crate) fn render_tabs(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let room = f32::from(window.viewport_size().width) - 420.;
        let fit = ((room / 150.) as usize).clamp(2, 8);
        let open = self.active.filter(|_| self.page == Page::Session);
        let wi = self.folder.unwrap_or(0);
        let tabs: Vec<AnyElement> = self
            .tab_sessions(fit, open)
            .into_iter()
            .map(|(si, s)| {
                self.tab(wi, si, s, open == Some((wi, si)), cx)
                    .into_any_element()
            })
            .collect();
        let home = open.is_some() && self.session().is_none_or(Session::is_empty);
        let wide = |button: Stateful<Div>| button.w(px(32.)).rounded(px(8.));

        h_flex()
            .h(px(48.))
            .w_full()
            .flex_shrink_0()
            .pl(px(92.))
            .pr(px(12.))
            .gap(px(8.))
            .child(wide(self.toggle_button(cx)))
            .child(self.folders_button(wi, cx))
            .child(div().w(px(1.)).h(px(16.)).flex_shrink_0().bg(alpha_300()))
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .overflow_hidden()
                    .children(tabs)
                    .child(
                        icon_button("tab-new", "plus", 14.)
                            .rounded(px(8.))
                            .when(home, |d| d.bg(alpha_200()))
                            .on_click(
                                cx.listener(|this, _: &ClickEvent, _, cx| this.new_session(cx)),
                            ),
                    ),
            )
            .child(wide(icon_button("tab-search", "search", 16.)).on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_palette(window, cx)),
            ))
            .child(
                wide(icon_button("tab-settings", "settings", 16.))
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.open_settings(cx))),
            )
            .child(
                div()
                    .id("tab-account")
                    .flex_shrink_0()
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.open_section(Section::Models, window, cx)
                    }))
                    .child(avatar()),
            )
    }

    fn tab_sessions(&self, fit: usize, open: Option<(usize, usize)>) -> Vec<(usize, &Session)> {
        let mut shown: Vec<(usize, &Session)> = self
            .workspace()
            .map(|w| w.listed().collect())
            .unwrap_or_default();
        let kept = shown
            .iter()
            .position(|(si, _)| open.is_some_and(|a| a.1 == *si))
            .filter(|at| *at >= fit)
            .map(|at| shown[at]);
        shown.truncate(fit);
        if let Some(kept) = kept {
            shown[fit - 1] = kept;
        }
        shown
    }

    fn tab(
        &self,
        wi: usize,
        si: usize,
        s: &Session,
        on: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let key = session_key(wi, si);
        h_flex()
            .id(("tab", key))
            .h(px(32.))
            .max_w(px(220.))
            .min_w(px(64.))
            .px(px(12.))
            .gap(px(8.))
            .rounded(px(8.))
            .border_1()
            .border_color(alpha_300().opacity(if on { 1. } else { 0. }))
            .cursor_pointer()
            .when(on, |d| d.bg(gray_100()))
            .when(!on, |d| d.hover(|d| d.bg(alpha_100())))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select(wi, si, cx)))
            .children(status_mark(s.status()))
            .child(
                text(13., 18.)
                    .min_w_0()
                    .truncate()
                    .text_color(if on { gray_1000() } else { gray_900() })
                    .when(on, |d| d.font_weight(FontWeight::MEDIUM))
                    .child(s.label(&self.store)),
            )
    }

    fn folders_button(&self, wi: usize, cx: &mut Context<Self>) -> Div {
        let elsewhere = self
            .workspaces
            .iter()
            .enumerate()
            .any(|(i, w)| i != wi && w.session_status() == Status::Waiting);
        let folders_open = self.menu == Some(MenuAt::Folders);
        let w = self.workspace();
        div()
            .relative()
            .flex_shrink_0()
            .child(
                h_flex()
                    .id("folders")
                    .h(px(28.))
                    .px(px(8.))
                    .gap(px(6.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(folders_open, |d| d.bg(alpha_200()))
                    .hover(|d| d.bg(alpha_200()))
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.toggle_menu(MenuAt::Folders, cx)
                    }))
                    .child(
                        text(13., 18.)
                            .max_w(px(160.))
                            .truncate()
                            .text_color(gray_900())
                            .child(w.map_or("No folder".into(), |w| w.name.clone())),
                    )
                    .when(elsewhere, |d| d.children(status_mark(Status::Waiting)))
                    .child(icon("chevron-down", 12., gray_700())),
            )
            .when(folders_open, |d| {
                d.child(
                    deferred(self.folders_menu(cx).absolute().top(px(34.)).left(px(0.)))
                        .with_priority(1),
                )
            })
    }

    fn folders_menu(&self, cx: &mut Context<Self>) -> Div {
        let current = self.folder;
        let rows: Vec<AnyElement> = self
            .workspaces
            .iter()
            .enumerate()
            .map(|(wi, w)| {
                let trailing = status_mark(w.session_status()).or_else(|| {
                    (current == Some(wi)).then(|| icon("check", 14., gray_900()).into_any_element())
                });
                menu_item(("folder", wi), "folder", w.name.clone(), "", false)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.menu = None;
                        this.new_session_in(wi, cx);
                    }))
                    .children(trailing)
                    .into_any_element()
            })
            .collect();
        self.menu_frame(cx)
            .children(rows)
            .child(div().h(px(1.)).my(px(4.)).bg(alpha_200()))
            .child(
                menu_item("folder-add", "plus", "Add folder", "⌘O", false).on_click(cx.listener(
                    |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.menu = None;
                        this.open_folder(cx);
                    },
                )),
            )
    }

    pub(crate) fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let bar = h_flex()
            .h(px(44.))
            .flex_shrink_0()
            .pl(px(20.))
            .pr(px(10.))
            .gap(px(8.));
        let plain =
            |label: &'static str| text(13., 18.).flex_1().text_color(gray_900()).child(label);
        if self.page == Page::Settings {
            return bar.child(plain("Settings"));
        }
        let Some(w) = self.workspace() else {
            return bar.child(plain("Welcome"));
        };
        let Some((session, (ws, si))) = self.session().filter(|s| !s.is_empty()).zip(self.active)
        else {
            return bar.child(plain("New session"));
        };

        let menu_open = self.menu == Some(MenuAt::Header);
        bar.child(text(13., 18.).text_color(gray_900()).child(w.name.clone()))
            .child(icon("chevron-right", 12., gray_600()))
            .child(
                text(13., 18.)
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .child(session.label(&self.store)),
            )
            .when_some(w.branch.clone(), |d, branch| d.child(branch_pill(branch)))
            .when(self.changes.is_none(), |d| {
                d.child(self.changes_toggle(w, cx))
            })
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        icon_button("header-menu", "ellipsis", 16.)
                            .when(menu_open, |d| d.bg(alpha_200()))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                this.toggle_menu(MenuAt::Header, cx)
                            })),
                    )
                    .when(menu_open, |d| {
                        d.child(
                            deferred(
                                self.menu_card(ws, si, cx)
                                    .absolute()
                                    .top(px(32.))
                                    .right(px(0.)),
                            )
                            .with_priority(1),
                        )
                    }),
            )
    }

    fn changes_toggle(&self, w: &Workspace, cx: &mut Context<Self>) -> Stateful<Div> {
        let (added, removed) = w
            .status
            .iter()
            .fold((0, 0), |(a, r), c| (a + c.added, r + c.removed));
        h_flex()
            .id("changes-toggle")
            .h(px(28.))
            .flex_shrink_0()
            .px(px(10.))
            .gap(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(alpha_400())
            .cursor_pointer()
            .hover(|d| d.bg(alpha_200()))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_changes(cx)))
            .map(|d| {
                if w.status.is_empty() {
                    d.child(text(12., 16.).text_color(gray_900()).child("No changes"))
                } else {
                    d.child(stat(added, removed))
                }
            })
    }

    pub(crate) fn open_section(
        &mut self,
        section: Section,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_section(section, window, cx);
        self.open_settings(cx);
    }
}
