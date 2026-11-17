use super::rows::{card_rows, group, row};
use super::{in_terminal, reveal};
use crate::app::{FxApp, capitalized};
use crate::design::*;
use crate::fx::cli::{Check, Level, doctor_checks};
use crate::host::update::Update;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, Div, FontWeight, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};

impl FxApp {
    fn rerun_doctor(&mut self, cx: &mut Context<Self>) {
        self.settings.doctor = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let checks = cx.background_spawn(async move { doctor_checks() }).await;
            let _ = this.update(cx, |this, cx| {
                this.settings.doctor = Some(checks);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn about_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap(px(32.))
            .child(self.about_hero())
            .child(self.health_section(cx))
            .child(group("This app", vec![self.app_update_row(cx)], 16.))
            .child(group("Files", file_rows(), 16.))
    }

    fn about_hero(&self) -> Div {
        h_flex()
            .gap(px(20.))
            .p(px(20.))
            .rounded(px(12.))
            .bg(gray_100())
            .border_1()
            .border_color(alpha_300())
            .child(fx_mark())
            .child(self.fx_version_lines())
            .child(
                outline_button("upgrade", "Update fx", None)
                    .h(px(30.))
                    .on_click(|_: &ClickEvent, _, _| in_terminal("upgrade")),
            )
    }

    fn fx_version_lines(&self) -> Div {
        let version = self
            .agent()
            .and_then(|a| a.version())
            .unwrap_or_else(|| "unknown".into());
        let status = self.settings.status.as_ref();
        let channel = status
            .and_then(|s| s.update_channel.as_deref())
            .unwrap_or("stable");
        let build: String = status
            .map_or("", |s| s.build_revision.as_str())
            .chars()
            .take(7)
            .collect();
        let channel_name = capitalized(channel);
        v_flex()
            .flex_1()
            .gap(px(2.))
            .child(
                div()
                    .text_size(px(20.))
                    .line_height(px(26.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(format!("fx {version}")),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(gray_900())
                    .child(format!(
                        "{channel_name} channel{} · desktop {}",
                        if build.is_empty() {
                            String::new()
                        } else {
                            format!(" · build {build}")
                        },
                        env!("CARGO_PKG_VERSION")
                    )),
            )
    }

    fn app_update_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let (app_detail, app_button): (String, Option<(&'static str, bool)>) = match &self.update {
            Update::Idle if crate::host::update::app_path().is_none() => (
                "Updates install into the packaged app; this is a development build".into(),
                None,
            ),
            Update::Idle => ("Not checked yet".into(), Some(("Check for updates", false))),
            Update::Checking => ("Checking…".into(), None),
            Update::Current => ("Up to date".into(), Some(("Check again", false))),
            Update::Downloading(version) => (format!("Downloading {version}…"), None),
            Update::Ready { version, .. } => (
                format!("{version} is installed and runs when you restart"),
                Some(("Restart", true)),
            ),
            Update::Failed(why) => (why.clone(), Some(("Try again", false))),
        };
        row(
            &format!("fx desktop {}", crate::host::update::VERSION),
            &app_detail,
            app_button.map(|(label, restart)| {
                outline_button("app-update", label, None)
                    .h(px(30.))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        if restart {
                            this.restart_updated(cx)
                        } else {
                            this.check_update(cx)
                        }
                    }))
                    .into_any_element()
            }),
        )
    }

    fn health_section(&self, cx: &mut Context<Self>) -> Div {
        v_flex()
            .gap(px(10.))
            .child(
                h_flex()
                    .px(px(2.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Health"),
                    )
                    .child(
                        text_button("doctor-again", "Run again")
                            .h(px(24.))
                            .px(px(6.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::NORMAL)
                            .on_click(
                                cx.listener(|this, _: &ClickEvent, _, cx| this.rerun_doctor(cx)),
                            ),
                    ),
            )
            .child(card_rows(self.health_checks()))
    }

    fn health_checks(&self) -> Vec<AnyElement> {
        match &self.settings.doctor {
            None => vec![row("Checking…", "Running fx doctor", None)],
            Some(list) if list.is_empty() => {
                vec![row("No checks", "fx doctor printed nothing", None)]
            }
            Some(list) => list.iter().map(check_row).collect(),
        }
    }
}

fn fx_mark() -> Div {
    div()
        .flex_shrink_0()
        .font_family(MONO)
        .text_size(px(6.))
        .line_height(px(7.))
        .text_color(gray_900())
        .whitespace_nowrap()
        .children(
            crate::app::FX_BRAILLE
                .lines()
                .map(|l| div().child(l.to_string())),
        )
}

fn check_row(check: &Check) -> AnyElement {
    let color = match check.level {
        Level::Ok => green_700(),
        Level::Warn => amber_700(),
        Level::Fail => red_700(),
    };
    let name = if check.name == "gh" {
        "GitHub CLI".into()
    } else {
        capitalized(&check.name)
    };
    let detail = capitalized(&check.detail);
    h_flex()
        .h(px(44.))
        .px_4()
        .gap_3()
        .child(dot(color))
        .child(
            div()
                .w(px(96.))
                .flex_shrink_0()
                .text_size(px(13.))
                .child(name),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(gray_900())
                .child(detail),
        )
        .into_any_element()
}

fn file_rows() -> Vec<AnyElement> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        file_row(
            "reveal-fx",
            "fx settings",
            crate::fx::cli::profile_path(),
            &home,
        ),
        file_row(
            "reveal-app",
            "This app",
            crate::host::store::Store::path(),
            &home,
        ),
    ]
}

fn file_row(
    id: &'static str,
    label: &'static str,
    path: std::path::PathBuf,
    home: &str,
) -> AnyElement {
    let shown = path.display().to_string().replacen(home, "~", 1);
    h_flex()
        .h(px(48.))
        .px_4()
        .gap_3()
        .child(
            div()
                .w(px(96.))
                .flex_shrink_0()
                .text_size(px(13.))
                .child(label),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(MONO)
                .text_size(px(12.))
                .text_color(gray_900())
                .child(shown),
        )
        .child(
            text_button(id, "Reveal")
                .h(px(28.))
                .font_weight(FontWeight::NORMAL)
                .on_click(move |_: &ClickEvent, _, _| reveal(&path)),
        )
        .into_any_element()
}
