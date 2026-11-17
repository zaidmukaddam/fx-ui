use crate::app::{Dialog, FxApp, Page};
use crate::design::*;
use crate::host::git::Change;
use crate::views::changes::status_dot;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, BoxShadow, ClickEvent, Context, Div, Entity, Focusable as _,
    FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, Stateful, StatefulInteractiveElement as _, Styled as _, Window, div, point, px,
    rgba,
};

impl FxApp {
    pub(crate) fn start_rename(
        &mut self,
        ws: usize,
        session: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.workspaces[ws].sessions[session]
            .label(&self.store)
            .to_string();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(current));
        let subscription = cx.subscribe_in(
            &input,
            window,
            move |this, input, event: &InputEvent, _, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let name = input.read(cx).value().to_string();
                    this.rename_session(ws, session, name, cx);
                }
            },
        );
        input.read(cx).focus_handle(cx).focus(window, cx);
        self.dialog = Some(Dialog::Rename {
            ws,
            session,
            input,
            _subscription: subscription,
        });
        self.page = Page::Session;
        cx.notify();
    }

    pub(crate) fn render_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (head, confirm) = match self.dialog.as_ref()? {
            Dialog::Remove { ws, session } => remove_dialog(
                &self.workspaces[*ws].sessions[*session].label(&self.store),
                cx,
            ),
            Dialog::Rename {
                ws, session, input, ..
            } => rename_dialog(*ws, *session, input, cx),
            Dialog::Discard(change) => discard_dialog(change, cx),
            Dialog::FullAccess(_) => full_access_dialog(cx),
        };
        let foot = dialog_footer(confirm, cx);
        Some(dialog_card(head, foot, cx).into_any_element())
    }

    pub(crate) fn confirm_dialog(&mut self, cx: &mut Context<Self>) -> bool {
        match self.dialog.take() {
            Some(Dialog::FullAccess(option)) => {
                self.set_option(option, "full-access".into(), cx);
                cx.notify();
                true
            }
            Some(Dialog::Remove { ws, session }) => {
                self.remove_session(ws, session, cx);
                true
            }
            Some(Dialog::Discard(change)) => {
                self.discard(change, cx);
                true
            }
            other => {
                self.dialog = other;
                false
            }
        }
    }
}

fn dialog_title(title: SharedString) -> Div {
    text(20., 26.)
        .font_weight(FontWeight::SEMIBOLD)
        .child(title)
}

fn dialog_note(body: SharedString) -> Div {
    text(14., 22.).text_color(gray_900()).child(body)
}

fn confirms(button: Stateful<Div>, cx: &mut Context<FxApp>) -> Stateful<Div> {
    button.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
        this.confirm_dialog(cx);
    }))
}

fn remove_dialog(label: &str, cx: &mut Context<FxApp>) -> (Div, Stateful<Div>) {
    (
        v_flex()
            .gap(px(8.))
            .child(dialog_title("Remove this session?".into()))
            .child(dialog_note(
                format!(
                    "“{label}” moves to Archived on the home screen. The files it changed are not touched."
                )
                .into(),
            )),
        confirms(danger_button("remove", "Remove session"), cx),
    )
}

fn rename_dialog(
    ws: usize,
    session: usize,
    input: &Entity<InputState>,
    cx: &mut Context<FxApp>,
) -> (Div, Stateful<Div>) {
    let input = input.clone();
    (
        v_flex()
            .gap(px(14.))
            .child(dialog_title("Rename session".into()))
            .child(
                text(14., 20.)
                    .h(px(38.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .rounded(px(10.))
                    .bg(background_200())
                    .border_1()
                    .border_color(blue_700())
                    .shadow(vec![BoxShadow {
                        color: rgba(0x0070f340).into(),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(3.),
                        inset: false,
                    }])
                    .child(Input::new(&input).appearance(false)),
            )
            .child(
                text(12., 16.)
                    .text_color(gray_700())
                    .child("Only this app shows the new name. fx keeps its own."),
            ),
        primary_button("save", "Rename", Some("⏎"))
            .px(px(14.))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                let name = input.read(cx).value().to_string();
                this.rename_session(ws, session, name, cx)
            })),
    )
}

fn discard_dialog(change: &Change, cx: &mut Context<FxApp>) -> (Div, Stateful<Div>) {
    let name = change.path.rsplit('/').next().unwrap_or(&change.path);
    (
        v_flex()
            .gap(px(12.))
            .child(
                v_flex()
                    .gap(px(8.))
                    .child(dialog_title(format!("Discard changes to {name}?").into()))
                    .child(dialog_note(
                        if change.code == '?' {
                            "The new file is deleted. This can't be undone."
                        } else {
                            "The file goes back to its last commit. This can't be undone."
                        }
                        .into(),
                    )),
            )
            .child(
                h_flex()
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(10.))
                    .rounded(px(8.))
                    .bg(background_200())
                    .border_1()
                    .border_color(alpha_200())
                    .child(status_dot(change.code))
                    .child(
                        text(12., 16.)
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(MONO)
                            .child(change.path.clone()),
                    )
                    .child(stat(change.added, change.removed).gap(px(10.))),
            ),
        confirms(danger_button("discard", "Discard"), cx),
    )
}

fn full_access_dialog(cx: &mut Context<FxApp>) -> (Div, Stateful<Div>) {
    (
        v_flex()
            .gap(px(8.))
            .child(dialog_title("Switch to Full access?".into()))
            .child(dialog_note(
                "fx runs every edit and command in this session without asking. You can switch back at any time."
                    .into(),
            )),
        confirms(primary_button("full-access", "Switch", Some("⏎")), cx),
    )
}

fn dialog_footer(confirm: Stateful<Div>, cx: &mut Context<FxApp>) -> Div {
    h_flex()
        .h(px(64.))
        .flex_shrink_0()
        .px(px(24.))
        .justify_between()
        .bg(background_200())
        .border_t_1()
        .border_color(alpha_400())
        .child(
            outline_button("cancel", "Cancel", None)
                .rounded(px(6.))
                .bg(background_100())
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.dialog = None;
                    cx.notify();
                })),
        )
        .child(confirm.px(px(12.)).rounded(px(6.)))
}

fn dialog_card(head: Div, foot: Div, cx: &mut Context<FxApp>) -> Stateful<Div> {
    scrim(cx).flex().items_center().justify_center().child(
        v_flex()
            .w(px(400.))
            .rounded(px(12.))
            .overflow_hidden()
            .bg(background_100())
            .border_1()
            .border_color(alpha_400())
            .shadow(shadow_modal())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().p(px(24.)).child(head))
            .child(foot),
    )
}

pub(super) fn scrim(cx: &mut Context<FxApp>) -> Stateful<Div> {
    div()
        .id("scrim")
        .absolute()
        .size_full()
        .top_0()
        .left_0()
        .bg(rgba(0x0000008c))
        .occlude()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, _, cx| {
                this.palette = None;
                this.dialog = None;
                cx.notify();
            }),
        )
}
