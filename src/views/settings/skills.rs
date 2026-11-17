use super::reveal;
use super::rows::{card_rows, page_title, row, rows_card};
use crate::app::FxApp;
use crate::design::*;
use crate::fx::cli::{SkillWarning, doctor_skill_warnings};
use crate::host::pickers::{Skill, rank};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClickEvent, Context, Div, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};
use std::path::{Path, PathBuf};

fn skills_folder(list: &[&Skill], base: Option<&Path>, home: &str) -> String {
    list.first()
        .and_then(|s| s.path.parent()?.parent().map(|p| p.to_path_buf()))
        .map(|p| match base.and_then(|b| p.strip_prefix(b).ok()) {
            Some(rel) => rel.display().to_string(),
            None => p.display().to_string().replacen(home, "~", 1),
        })
        .unwrap_or_default()
}

fn skills_filter_field(input: &Entity<InputState>) -> impl IntoElement {
    h_flex()
        .h(px(36.))
        .px_3()
        .gap(px(10.))
        .rounded(px(10.))
        .bg(gray_100())
        .border_1()
        .border_color(alpha_300())
        .child(icon("search", 14., gray_700()))
        .child(div().flex_1().child(Input::new(input).appearance(false)))
}

fn counted_header(title: &'static str, detail: Div, count: usize) -> impl IntoElement {
    h_flex()
        .px(px(2.))
        .gap_2()
        .items_baseline()
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .child(title),
        )
        .child(detail.flex_1().text_size(px(12.)).text_color(gray_700()))
        .child(
            div()
                .text_size(px(12.))
                .text_color(gray_700())
                .child(count.to_string()),
        )
}

fn skill_row(skill: &Skill, key: &'static str, i: usize) -> AnyElement {
    let path = skill.path.clone();
    h_flex()
        .gap_3()
        .min_h(px(56.))
        .px_4()
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .font_family(MONO)
                        .text_size(px(13.))
                        .line_height(px(20.))
                        .child(format!("/{}", skill.name)),
                )
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(gray_900())
                        .child(skill.description.clone()),
                ),
        )
        .child(
            text_button((key, i), "Open")
                .h(px(28.))
                .font_weight(FontWeight::NORMAL)
                .on_click(move |_: &ClickEvent, _, _| reveal(&path)),
        )
        .into_any_element()
}

fn skill_rows(
    list: &[&Skill],
    key: &'static str,
    limit: usize,
    cx: &mut Context<FxApp>,
) -> Vec<AnyElement> {
    let mut out: Vec<AnyElement> = list
        .iter()
        .take(limit)
        .enumerate()
        .map(|(i, s)| skill_row(s, key, i))
        .collect();
    if list.len() > limit {
        out.push(
            div()
                .id((key, usize::MAX))
                .h(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(gray_900())
                .hover(|d| d.text_color(gray_1000()))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.settings.skills_all = true;
                    cx.notify();
                }))
                .child(format!("Show {} more", list.len() - limit))
                .into_any_element(),
        );
    }
    out
}

fn skills_group(
    title: &'static str,
    path: String,
    count: usize,
    body: Vec<AnyElement>,
) -> impl IntoElement {
    v_flex()
        .gap(px(10.))
        .child(counted_header(
            title,
            div().font_family(MONO).child(path),
            count,
        ))
        .child(card_rows(body))
}

fn skipped_row(i: usize, warning: &SkillWarning, home: &str) -> AnyElement {
    let path = PathBuf::from(&warning.path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| warning.path.clone());
    let folder = path
        .parent()
        .map(|p| p.display().to_string().replacen(home, "~", 1))
        .unwrap_or_default();
    h_flex()
        .gap_3()
        .min_h(px(56.))
        .px_4()
        .py(px(9.))
        .child(dot(amber_700()))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    h_flex()
                        .gap_2()
                        .items_baseline()
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_family(MONO)
                                .text_size(px(13.))
                                .line_height(px(20.))
                                .child(format!("/{name}")),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(MONO)
                                .text_size(px(12.))
                                .text_color(gray_700())
                                .child(folder),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(gray_900())
                        .child(warning.reason.clone()),
                ),
        )
        .child(
            text_button(("skipped", i), "Reveal")
                .h(px(28.))
                .font_weight(FontWeight::NORMAL)
                .on_click(move |_: &ClickEvent, _, _| reveal(&path)),
        )
        .into_any_element()
}

fn omitted_note(omitted: usize) -> impl IntoElement {
    div()
        .px(px(2.))
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(gray_700())
        .child(format!(
            "{omitted} more {} skipped. Start fx with FX_TRACE=1 to list {}.",
            if omitted == 1 { "was" } else { "were" },
            if omitted == 1 { "it" } else { "them" },
        ))
}

fn skipped_group(skipped: &[SkillWarning], omitted: usize, home: &str) -> impl IntoElement {
    let rows: Vec<AnyElement> = skipped
        .iter()
        .enumerate()
        .map(|(i, w)| skipped_row(i, w, home))
        .collect();
    v_flex()
        .gap(px(10.))
        .child(counted_header(
            "Skipped",
            div().child("fx can't load these until they're fixed"),
            skipped.len() + omitted,
        ))
        .child(rows_card(rows, 35.))
        .when(omitted > 0, |d| d.child(omitted_note(omitted)))
}

fn no_skills(filtered: bool) -> impl IntoElement {
    card_rows(vec![row(
        if filtered {
            "No skills match"
        } else {
            "No skills found"
        },
        "fx looks in .fx/skills, .agents/skills and .claude/skills",
        None,
    )])
}

impl FxApp {
    fn skipped_skills(&self) -> (Vec<SkillWarning>, usize) {
        match &self.settings.skipped {
            Some((list, more)) => (list.clone(), *more),
            None => (
                doctor_skill_warnings(self.settings.doctor.as_deref().unwrap_or_default()),
                0,
            ),
        }
    }

    pub(super) fn skills_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self
            .settings
            .skills_filter
            .as_ref()
            .map(|i| i.read(cx).value().to_string())
            .unwrap_or_default();
        let workspace = self.workspace();
        let root = workspace.map(|w| w.path.clone()).unwrap_or_default();
        let all: Vec<&Skill> = match workspace {
            Some(w) if query.is_empty() => w.skills.iter().collect(),
            Some(w) => rank(&w.skills, &query, |s| &s.name, usize::MAX),
            None => vec![],
        };
        let (project, yours): (Vec<_>, Vec<_>) =
            all.into_iter().partition(|s| s.path.starts_with(&root));
        let home = std::env::var("HOME").unwrap_or_default();
        let limit = if self.settings.skills_all || !query.is_empty() {
            usize::MAX
        } else {
            4
        };
        let project_rows = skill_rows(&project, "skill-project", limit, cx);
        let your_rows = skill_rows(&yours, "skill-yours", limit, cx);
        let none = project.is_empty() && yours.is_empty();
        let (skipped, omitted) = self.skipped_skills();
        v_flex()
            .gap(px(28.))
            .child(page_title(
                "Skills",
                "Type / in the composer to use one. fx reads it before it starts.",
            ))
            .when_some(self.settings.skills_filter.clone(), |d, input| {
                d.child(skills_filter_field(&input))
            })
            .when(!skipped.is_empty(), |d| {
                d.child(skipped_group(&skipped, omitted, &home))
            })
            .when(!project.is_empty(), |d| {
                d.child(skills_group(
                    "This project",
                    skills_folder(&project, Some(&root), &home),
                    project.len(),
                    project_rows,
                ))
            })
            .when(!yours.is_empty(), |d| {
                d.child(skills_group(
                    "Yours",
                    skills_folder(&yours, None, &home),
                    yours.len(),
                    your_rows,
                ))
            })
            .when(none, |d| d.child(no_skills(!query.is_empty())))
    }
}
