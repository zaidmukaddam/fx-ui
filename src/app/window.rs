use super::{FxApp, Page, SLIDE};
use gpui_kit::{AppContext as _, Context, Focusable as _, KeyDownEvent, Window};

impl FxApp {
    pub(crate) fn open_settings(&mut self, cx: &mut Context<Self>) {
        self.page = Page::Settings;
        self.refresh_settings(cx);
        cx.notify();
    }

    pub(crate) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.menu = None;
        self.sidebar_slides += 1;
        if self.sidebar_open && !self.sidebar_closing {
            self.sidebar_closing = true;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SLIDE).await;
                let _ = this.update(cx, |this, cx| {
                    if this.sidebar_closing {
                        this.sidebar_open = false;
                        this.sidebar_closing = false;
                        cx.notify();
                    }
                });
            })
            .detach();
        } else {
            self.sidebar_open = true;
            self.sidebar_closing = false;
        }
        cx.notify();
    }

    pub(crate) fn check_update(&mut self, cx: &mut Context<Self>) {
        use crate::host::update::{self, Update};
        let Some(app) = update::app_path() else {
            return;
        };
        if matches!(self.update, Update::Checking | Update::Downloading(_)) {
            return;
        }
        self.update = Update::Checking;
        cx.spawn(async move |this, cx| {
            let found = cx.background_spawn(async move { update::newer() }).await;
            let (version, dmg) = match found {
                Ok(Some(release)) => release,
                other => {
                    let _ = this.update(cx, |this, cx| {
                        this.update = match other {
                            Err(why) => Update::Failed(why),
                            _ => Update::Current,
                        };
                        cx.notify();
                    });
                    return;
                }
            };
            let _ = this.update(cx, |this, cx| {
                this.update = Update::Downloading(version.clone());
                cx.notify();
            });
            let target = app.clone();
            let installed = cx
                .background_spawn(async move { update::install(&dmg, &target) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.update = match installed {
                    Ok(()) => Update::Ready { version, app },
                    Err(why) => Update::Failed(why),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn restart_updated(&mut self, cx: &mut Context<Self>) {
        if let crate::host::update::Update::Ready { app, .. } = &self.update {
            let _ = std::process::Command::new("open")
                .arg("-n")
                .arg(app)
                .spawn();
            self.store.save();
            cx.quit();
        }
    }

    pub(crate) fn toggle_changes(&mut self, cx: &mut Context<Self>) {
        if self.changes.take().is_none() {
            self.changes = Some(Default::default());
            self.refresh_changes(cx);
        }
        cx.notify();
    }

    pub(super) fn on_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.key == "enter" && self.confirm_dialog(cx) {
            cx.stop_propagation();
            return;
        }
        if event.keystroke.key != "escape" {
            return;
        }
        if self.palette.is_some() || self.dialog.is_some() {
            self.palette = None;
            self.dialog = None;
            self.input.read(cx).focus_handle(cx).focus(window, cx);
        } else if self.menu.is_some() {
            self.menu = None;
        } else if self.pop.is_some() {
            self.pop = None;
        } else if self.page == Page::Settings {
            self.page = Page::Session;
        } else if self.session().is_some_and(|s| s.permission.is_some()) {
            self.answer_kind("reject_once", cx);
        } else if self.session().is_some_and(|s| s.thread.running()) {
            self.stop(cx);
        }
        cx.notify();
    }
}
