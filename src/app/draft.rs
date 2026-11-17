use super::state::MAX_IMAGE_BYTES;
use super::{FxApp, MAX_IMAGES, Picker};
use crate::host::pickers;
use gpui_kit::component::input::{self, InputEvent, TextareaState};
use gpui_kit::{
    ClipboardEntry, ClipboardItem, Context, Entity, Focusable as _, Image, ImageFormat,
    PathPromptOptions, Window,
};
use std::sync::Arc;

impl FxApp {
    pub(super) fn on_input(
        &mut self,
        _: &Entity<TextareaState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Change => self.update_picker(cx),
            InputEvent::PressEnter { shift: false, .. } => {
                if self.picker.is_some() {
                    self.accept_pick(window, cx);
                    return;
                }
                let empty = self.input.read(cx).value().trim().is_empty();
                if empty && self.session().is_some_and(|s| s.permission.is_some()) {
                    self.answer_kind("allow_once", cx);
                } else {
                    self.send(window, cx);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn attach_images(&mut self, images: Vec<Image>, cx: &mut Context<Self>) {
        let mut refused = None;
        for image in images {
            if self.attachments.len() >= MAX_IMAGES {
                refused = Some(format!("A prompt carries at most {MAX_IMAGES} images."));
                break;
            }
            if image.bytes.len() > MAX_IMAGE_BYTES {
                refused = Some("That image is larger than 3.75 MiB, the most fx takes.".into());
                continue;
            }
            self.attachments.push(Arc::new(image));
        }
        if let (Some(refused), Some(session)) = (refused, self.session_mut()) {
            session.error = Some(refused);
        }
        self.pop = None;
        cx.notify();
    }

    pub(crate) fn paste_images(&mut self, cx: &mut Context<Self>) {
        let images = cx
            .read_from_clipboard()
            .map(|item| clipboard_images(&item, true))
            .unwrap_or_default();
        self.attach_images(images, cx);
    }

    pub(crate) fn choose_images(&mut self, cx: &mut Context<Self>) {
        self.pop = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let images = paths.iter().filter_map(|p| read_image(p)).collect();
            let _ = this.update(cx, |this, cx| this.attach_images(images, cx));
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.read(cx).focus_handle(cx).focus(window, cx);
    }

    fn update_picker(&mut self, cx: &mut Context<Self>) {
        let draft = self.input.read(cx).value().to_string();
        let Some(ws) = self.workspace() else { return };
        self.picker = pickers::trigger(&draft).and_then(|(kind, query)| {
            let items: Vec<(String, String, String)> = if kind == '/' {
                pickers::rank(&ws.skills, &query, |s| &s.name, 5)
                    .into_iter()
                    .map(|s| {
                        (
                            s.name.clone(),
                            s.description.clone(),
                            format!("/{} ", s.name),
                        )
                    })
                    .collect()
            } else {
                pickers::rank(&ws.files, &query, |f| f.as_str(), 8)
                    .into_iter()
                    .map(|f| {
                        let (dir, name) = f.rsplit_once('/').unwrap_or(("", f));
                        (name.to_string(), dir.to_string(), format!("@{f} "))
                    })
                    .collect()
            };
            (!items.is_empty()).then_some(Picker {
                kind,
                items,
                selected: 0,
                query,
            })
        });
        if self.picker.is_some() {
            self.pop = None;
        }
        cx.notify();
    }

    pub(crate) fn accept_pick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picker) = self.picker.take() else {
            return;
        };
        let Some((_, _, insert)) = picker.items.get(picker.selected).cloned() else {
            return;
        };
        let draft = self.input.read(cx).value().to_string();
        let next = if picker.kind == '/' {
            insert
        } else {
            let start = draft.rfind('@').unwrap_or(draft.len());
            format!("{}{insert}", &draft[..start])
        };
        self.set_draft(next, window, cx);
        cx.notify();
    }

    pub(crate) fn attach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = self.input.read(cx).value().to_string();
        let sep = if draft.is_empty() || draft.ends_with(char::is_whitespace) {
            ""
        } else {
            " "
        };
        self.set_draft(format!("{draft}{sep}@"), window, cx);
        self.update_picker(cx);
    }

    fn set_draft(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let line = text.matches('\n').count() as u32;
        let character = text
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count() as u32;
        self.input.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.set_cursor_position(input::Position { line, character }, window, cx);
        });
    }

    pub(crate) fn picker_step(&mut self, step: usize, cx: &mut Context<Self>) {
        let Some(picker) = self.picker.as_mut() else {
            return;
        };
        let count = picker.items.len().max(1);
        picker.selected = (picker.selected + step) % count;
        cx.stop_propagation();
        cx.notify();
    }
}

fn read_image(path: &std::path::Path) -> Option<Image> {
    let format = match path.extension()?.to_str()?.to_lowercase().as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "gif" => ImageFormat::Gif,
        "webp" => ImageFormat::Webp,
        _ => return None,
    };
    Some(Image::from_bytes(format, std::fs::read(path).ok()?))
}

pub(crate) fn clipboard_images(item: &ClipboardItem, with_text: bool) -> Vec<Image> {
    let mut images = Vec::new();
    for entry in item.entries() {
        match entry {
            ClipboardEntry::String(s) if !with_text && !s.text().trim().is_empty() => {
                return Vec::new();
            }
            ClipboardEntry::Image(image) => images.push(image.clone()),
            ClipboardEntry::ExternalPaths(paths) => {
                images.extend(paths.paths().iter().filter_map(|p| read_image(p)));
            }
            ClipboardEntry::String(_) => {}
        }
    }
    images
}
