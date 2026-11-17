use super::dialogs::scrim;
use crate::app::{Dialog, FxApp};
use crate::design::*;
use crate::host::pickers;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, Div, Entity, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _,
    ScrollHandle, StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

pub(crate) struct Palette {
    input: Entity<InputState>,
    selected: usize,
    scroll: ScrollHandle,
    _subscription: Subscription,
}

fn row_of(entries: &[Entry], selected: usize) -> usize {
    let mut headings = 0;
    let mut last = "";
    for e in entries.iter().take(selected + 1) {
        if e.group != last {
            headings += 1;
            last = e.group;
        }
    }
    selected + headings
}

#[derive(Clone)]
enum Command {
    NewSession,
    OpenFolder,
    Settings,
    Changes,
    Sidebar,
    Rename,
    Remove,
    Stop,
    Restore,
    Forget,
    Open(usize, usize),
}

#[derive(Clone)]
struct Entry {
    group: &'static str,
    icon: &'static str,
    label: String,
    detail: String,
    keys: &'static str,
    command: Command,
}

fn command(
    group: &'static str,
    icon: &'static str,
    label: &str,
    keys: &'static str,
    command: Command,
) -> Entry {
    Entry {
        group,
        icon,
        label: label.into(),
        detail: String::new(),
        keys,
        command,
    }
}

fn highlighted(label: &str, query: &str) -> impl IntoElement {
    let query = query.trim();
    let at = (!query.is_empty())
        .then(|| label.to_lowercase().find(&query.to_lowercase()))
        .flatten()
        .filter(|&at| label.is_char_boundary(at) && label.is_char_boundary(at + query.len()));
    let row = h_flex().flex_1().min_w_0().overflow_hidden();
    match at {
        Some(at) => row
            .child(
                div()
                    .flex_shrink_0()
                    .whitespace_nowrap()
                    .child(label[..at].to_string()),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .whitespace_nowrap()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(label[at..at + query.len()].to_string()),
            )
            .child(
                div()
                    .truncate()
                    .child(label[at + query.len()..].to_string()),
            ),
        None => row.child(div().truncate().child(label.to_string())),
    }
}

impl FxApp {
    pub(crate) fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() {
            self.input.read(cx).focus_handle(cx).focus(window, cx);
            cx.notify();
            return;
        }
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search commands and sessions"));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    if let Some(p) = this.palette.as_mut() {
                        p.selected = 0;
                        p.scroll.scroll_to_item(0);
                    }
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.run_selected(window, cx),
                _ => {}
            },
        );
        input.read(cx).focus_handle(cx).focus(window, cx);
        self.palette = Some(Palette {
            input,
            selected: 0,
            scroll: ScrollHandle::new(),
            _subscription: subscription,
        });
        self.pop = None;
        self.menu = None;
        self.picker = None;
        cx.notify();
    }

    fn entries(&self, query: &str) -> Vec<Entry> {
        let mut list = self.session_commands();
        list.extend(self.general_commands());
        list.extend(self.session_entries());
        ranked(list, query)
    }

    fn session_commands(&self) -> Vec<Entry> {
        let has_session = self
            .session()
            .is_some_and(|s| s.id.is_some() && !s.is_empty());
        let running = self.session().is_some_and(|s| s.thread.running());
        let mut list = Vec::new();
        if has_session {
            list.push(command(
                "This session",
                "pencil",
                "Rename this session",
                "",
                Command::Rename,
            ));
            list.push(command(
                "This session",
                "trash",
                "Remove this session from the list",
                "",
                Command::Remove,
            ));
        }
        if running {
            list.push(command(
                "This session",
                "x",
                "Stop the running turn",
                "Esc",
                Command::Stop,
            ));
        }
        let restorable = self
            .session()
            .and_then(|s| s.snap.as_ref())
            .is_some_and(|(before, after)| after.as_ref().is_some_and(|a| a != before));
        if restorable && !running {
            list.push(command(
                "This session",
                "copy",
                "Restore this turn's files",
                "",
                Command::Restore,
            ));
        }
        if self.session().is_some_and(|s| !s.grants.is_empty()) {
            list.push(command(
                "This session",
                "shield",
                "Forget what this session may do without asking",
                "",
                Command::Forget,
            ));
        }
        list
    }

    fn general_commands(&self) -> [Entry; 5] {
        [
            command(
                "Commands",
                "compose",
                "New session",
                "⌘N",
                Command::NewSession,
            ),
            command(
                "Commands",
                "folder",
                "Open folder",
                "⌘O",
                Command::OpenFolder,
            ),
            command(
                "Commands",
                "panel-split",
                if self.changes.is_some() {
                    "Hide changes"
                } else {
                    "Open in split view"
                },
                "⌘\\",
                Command::Changes,
            ),
            command(
                "Commands",
                "panel-left",
                "Toggle the sidebar",
                "⌘B",
                Command::Sidebar,
            ),
            command("Commands", "settings", "Settings", "⌘,", Command::Settings),
        ]
    }

    fn session_entries(&self) -> Vec<Entry> {
        let mut list = Vec::new();
        for (wi, w) in self.workspaces.iter().enumerate() {
            for (si, s) in w.sessions.iter().enumerate() {
                if s.id.is_none() || s.is_empty() {
                    continue;
                }
                list.push(Entry {
                    group: "Sessions",
                    icon: "lines",
                    label: s.label(&self.store).to_string(),
                    detail: format!("{} · {}", w.name, crate::app::ago(&s.updated)),
                    keys: "",
                    command: Command::Open(wi, si),
                });
            }
        }
        list
    }

    fn run_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = self.palette.as_ref() else {
            return;
        };
        let query = palette.input.read(cx).value().to_string();
        let Some(entry) = self.entries(&query).into_iter().nth(palette.selected) else {
            return;
        };
        self.palette = None;
        self.input.read(cx).focus_handle(cx).focus(window, cx);
        match entry.command {
            Command::NewSession => self.new_session(cx),
            Command::OpenFolder => self.open_folder(cx),
            Command::Settings => self.open_settings(cx),
            Command::Changes => self.toggle_changes(cx),
            Command::Sidebar => self.toggle_sidebar(cx),
            Command::Stop => self.stop(cx),
            Command::Restore => self.restore_turn(cx),
            Command::Forget => self.forget_grants(cx),
            Command::Open(w, s) => self.select(w, s, cx),
            Command::Rename => {
                if let Some((w, s)) = self.active {
                    self.start_rename(w, s, window, cx);
                }
            }
            Command::Remove => {
                if let Some((ws, session)) = self.active {
                    self.dialog = Some(Dialog::Remove { ws, session });
                }
            }
        }
        cx.notify();
    }

    fn palette_keys(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = self.palette.as_ref() else {
            return;
        };
        let entries = self.entries(&palette.input.read(cx).value());
        let count = entries.len().max(1);
        let palette = self.palette.as_mut().unwrap();
        match event.keystroke.key.as_str() {
            "up" => palette.selected = (palette.selected + count - 1) % count,
            "down" => palette.selected = (palette.selected + 1) % count,
            _ => return,
        }
        palette.scroll.scroll_to_item(match palette.selected {
            0 => 0,
            selected => row_of(&entries, selected),
        });
        cx.stop_propagation();
        cx.notify();
    }

    pub(crate) fn render_palette(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = self.palette.as_ref()?;
        let top = (f32::from(window.viewport_size().height) * 0.133).clamp(24., 120.);
        let query = palette.input.read(cx).value().to_string();
        let entries = self.entries(&query);
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut last_group = "";
        for (i, e) in entries.iter().enumerate() {
            if e.group != last_group {
                rows.push(palette_heading(e.group, last_group.is_empty()));
                last_group = e.group;
            }
            rows.push(palette_row(i, e, i == palette.selected, &query, cx));
        }
        Some(
            scrim(cx)
                .child(
                    v_flex()
                        .absolute()
                        .size_full()
                        .top_0()
                        .left_0()
                        .pt(px(top))
                        .pb(px(24.))
                        .px(px(24.))
                        .items_center()
                        .child(palette_card(palette, rows, cx)),
                )
                .into_any_element(),
        )
    }
}

fn ranked(list: Vec<Entry>, query: &str) -> Vec<Entry> {
    if query.trim().is_empty() {
        return list.into_iter().take(12).collect();
    }
    pickers::rank(&list, query, |e| e.label.as_str(), 12)
        .into_iter()
        .cloned()
        .collect()
}

fn hint(keys: &'static str) -> Div {
    text(12., 16.).text_color(gray_900()).child(keys)
}

fn palette_heading(group: &'static str, first: bool) -> AnyElement {
    text(12., 16.)
        .px(px(8.))
        .pt(px(if first { 8. } else { 12. }))
        .pb(px(6.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(gray_900())
        .child(group)
        .into_any_element()
}

fn palette_row(i: usize, e: &Entry, on: bool, query: &str, cx: &mut Context<FxApp>) -> AnyElement {
    let trailing = if e.keys.is_empty() {
        e.detail.clone()
    } else {
        e.keys.to_string()
    };
    let mark = if matches!(e.command, Command::Open(..)) {
        div()
            .size(px(6.))
            .rounded(px(3.))
            .bg(gray_500())
            .into_any_element()
    } else {
        icon(e.icon, 16., if on { gray_1000() } else { gray_900() }).into_any_element()
    };
    h_flex()
        .id(("entry", i))
        .h(px(40.))
        .flex_shrink_0()
        .px(px(8.))
        .gap(px(10.))
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |d| d.bg(alpha_200()))
        .when(!on, |d| d.hover(|d| d.bg(alpha_100())))
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            if let Some(p) = this.palette.as_mut() {
                p.selected = i;
            }
            this.run_selected(window, cx);
        }))
        .child(
            h_flex()
                .w(px(16.))
                .flex_shrink_0()
                .justify_center()
                .child(mark),
        )
        .child(
            text(14., 20.)
                .flex_1()
                .min_w_0()
                .flex()
                .child(highlighted(&e.label, query)),
        )
        .when(!trailing.is_empty(), |d| {
            d.child(
                text(12., 16.)
                    .flex_shrink_0()
                    .text_color(gray_900())
                    .child(trailing),
            )
        })
        .into_any_element()
}

fn palette_header(palette: &Palette, cx: &mut Context<FxApp>) -> Div {
    h_flex()
        .h(px(52.))
        .flex_shrink_0()
        .pl(px(16.))
        .pr(px(16.))
        .border_b_1()
        .border_color(alpha_400())
        .child(icon("search", 16., gray_900()))
        .child(
            text(16., 24.)
                .flex_1()
                .min_w_0()
                .child(Input::new(&palette.input).appearance(false)),
        )
        .child(
            h_flex()
                .id("palette-esc")
                .h(px(20.))
                .px(px(6.))
                .flex_shrink_0()
                .rounded(px(4.))
                .bg(gray_100())
                .border_1()
                .border_color(alpha_400())
                .cursor_pointer()
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_palette(window, cx)),
                )
                .child(hint("Esc")),
        )
}

fn palette_footer() -> Div {
    h_flex()
        .h(px(40.))
        .flex_shrink_0()
        .px(px(16.))
        .gap(px(16.))
        .bg(background_200())
        .border_t_1()
        .border_color(alpha_400())
        .child(hint("↑↓ Navigate"))
        .child(hint("⏎ Run"))
        .child(div().flex_1())
        .child(text(12., 16.).text_color(gray_700()).child("⌘K"))
}

fn palette_card(palette: &Palette, rows: Vec<AnyElement>, cx: &mut Context<FxApp>) -> Div {
    let empty = rows.is_empty();
    v_flex()
        .w(px(600.))
        .max_w_full()
        .min_h_0()
        .rounded(px(12.))
        .overflow_hidden()
        .bg(background_100())
        .border_1()
        .border_color(alpha_400())
        .shadow(shadow_modal())
        .capture_key_down(cx.listener(FxApp::palette_keys))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(palette_header(palette, cx))
        .child(
            v_flex()
                .id("palette-list")
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&palette.scroll)
                .p(px(8.))
                .children(rows)
                .when(empty, |d| {
                    d.child(
                        text(13., 18.)
                            .py(px(22.))
                            .flex()
                            .justify_center()
                            .text_color(gray_700())
                            .child("Nothing matches"),
                    )
                }),
        )
        .child(palette_footer())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_selection_scrolls_past_the_headings_above_it() {
        let entry = |group: &'static str| Entry {
            group,
            icon: "file",
            label: String::new(),
            detail: String::new(),
            keys: "",
            command: Command::Settings,
        };
        let entries = [entry("a"), entry("a"), entry("b"), entry("b")];
        let rows: Vec<usize> = (0..4).map(|i| row_of(&entries, i)).collect();
        assert_eq!(rows, [1, 2, 4, 5]);
    }
}
