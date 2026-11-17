use gpui_kit::AssetSource;
use std::borrow::Cow;

pub const FX_MARK: &str = "icons/fx-mark.svg";

const ICONS: &[(&str, &str, &str)] = &[
    (
        "panel-left",
        "1.4",
        r#"<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M6 2.75v10.5"/>"#,
    ),
    (
        "panel-split",
        "1.4",
        r#"<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M8 2.75v10.5"/>"#,
    ),
    (
        "panel-right",
        "1.4",
        r#"<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M10 2.75v10.5"/>"#,
    ),
    (
        "compose",
        "1.4",
        r#"<path d="M12.5 8.5V12a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 12V5A1.5 1.5 0 014 3.5h3.5" stroke-linecap="round"/><path d="M11.5 2.5l2 2L8 10H6V8l5.5-5.5z" stroke-linejoin="round"/>"#,
    ),
    (
        "search",
        "1.4",
        r#"<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L13.5 13.5" stroke-linecap="round"/>"#,
    ),
    (
        "star",
        "1.4",
        r#"<path d="M8 2l1.6 3.6L13.5 6l-2.9 2.6.8 3.9L8 10.6 4.6 12.5l.8-3.9L2.5 6l3.9-.4L8 2z" stroke-linejoin="round"/>"#,
    ),
    (
        "plus",
        "1.4",
        r#"<path d="M8 3.5v9M3.5 8h9" stroke-linecap="round"/>"#,
    ),
    (
        "plus-lg",
        "1.5",
        r#"<path d="M8 3v10M3 8h10" stroke-linecap="round"/>"#,
    ),
    (
        "settings",
        "1.4",
        r#"<circle cx="8" cy="8" r="2"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" stroke-linecap="round"/>"#,
    ),
    (
        "shield",
        "1.4",
        r#"<path d="M8 1.75l5 2v4c0 3-2.2 5.3-5 6.5-2.8-1.2-5-3.5-5-6.5v-4l5-2z" stroke-linejoin="round"/>"#,
    ),
    (
        "chevron-down",
        "1.5",
        r#"<path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "chevron-right",
        "1.5",
        r#"<path d="M6 3.5L10.5 8 6 12.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "branch",
        "1.4",
        r#"<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5.5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-3 2.5-6.5 3.5"/>"#,
    ),
    (
        "arrow-up",
        "1.75",
        r#"<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "ellipsis",
        "0",
        r##"<circle cx="3.5" cy="8" r="1" fill="#fff"/><circle cx="8" cy="8" r="1" fill="#fff"/><circle cx="12.5" cy="8" r="1" fill="#fff"/>"##,
    ),
    (
        "check",
        "1.5",
        r#"<path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "x",
        "1.5",
        r#"<path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/>"#,
    ),
    (
        "file",
        "1.4",
        r#"<path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6L9 2z" stroke-linejoin="round"/>"#,
    ),
    (
        "folder",
        "1.4",
        r#"<path d="M2.5 4.5A1.5 1.5 0 014 3h2.5l1.5 1.5h4A1.5 1.5 0 0113.5 6v5.5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z" stroke-linejoin="round"/>"#,
    ),
    (
        "lines",
        "1.4",
        r#"<path d="M3 4.5h10M3 8h10M3 11.5h6" stroke-linecap="round"/>"#,
    ),
    (
        "user",
        "1.4",
        r#"<circle cx="8" cy="6" r="2.5"/><path d="M3 13.5c.8-2.3 2.7-3.5 5-3.5s4.2 1.2 5 3.5" stroke-linecap="round"/>"#,
    ),
    (
        "alert",
        "1.75",
        r#"<path d="M8 4.5v4M8 11v.01" stroke-linecap="round"/>"#,
    ),
    (
        "pencil",
        "1.4",
        r#"<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10L11 2.5z" stroke-linejoin="round"/>"#,
    ),
    (
        "copy",
        "1.4",
        r#"<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 014 2.5h7" stroke-linecap="round"/>"#,
    ),
    (
        "trash",
        "1.4",
        r#"<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "terminal",
        "1.4",
        r#"<path d="M3 4.5L6.5 8 3 11.5M8.5 11.5H13" stroke-linecap="round" stroke-linejoin="round"/>"#,
    ),
    (
        "globe",
        "1.4",
        r#"<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c2.2 2 2.2 9.5 0 11.5M8 2.25c-2.2 2-2.2 9.5 0 11.5"/>"#,
    ),
    (
        "bolt",
        "1.4",
        r#"<path d="M9 1.75L3.5 9h4l-.5 5.25L12.5 7h-4L9 1.75z" stroke-linejoin="round"/>"#,
    ),
    (
        "image",
        "1.4",
        r##"<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="5.75" cy="6.5" r="1.1" fill="#fff" stroke="none"/><path d="M2.5 11.5l3.5-3 2.5 2 2-1.5 3 2.5" stroke-linejoin="round"/>"##,
    ),
    ("spin-track", "2", r#"<circle cx="8" cy="8" r="6"/>"#),
    (
        "spin-arc",
        "2",
        r#"<path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"/>"#,
    ),
];

fn icon(name: &str) -> Option<String> {
    let (_, width, body) = ICONS.iter().find(|(n, ..)| *n == name)?;
    Some(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="{width}">{body}</svg>"##
    ))
}

#[derive(Clone, Copy, Default)]
pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        let file: Option<&'static [u8]> = match path {
            FX_MARK => Some(include_bytes!("../../assets/icons/fx-mark.svg")),
            "logos/codex.svg" => Some(include_bytes!("../../assets/icons/codex.svg")),
            "logos/grok.svg" => Some(include_bytes!("../../assets/icons/grok.svg")),
            "logos/vercel.svg" => Some(include_bytes!("../../assets/icons/vercel.svg")),
            _ => None,
        };
        if let Some(bytes) = file {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        if let Some(svg) = path
            .strip_prefix("fx/")
            .and_then(|p| p.strip_suffix(".svg"))
            .and_then(icon)
        {
            return Ok(Some(Cow::Owned(svg.into_bytes())));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> gpui_kit::Result<Vec<gpui_kit::SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_is_served_and_named_once() {
        for (name, ..) in ICONS {
            let bytes = AppAssets
                .load(&format!("fx/{name}.svg"))
                .unwrap()
                .unwrap_or_else(|| panic!("{name} is not served"));
            assert!(bytes.starts_with(b"<svg"));
            assert_eq!(ICONS.iter().filter(|(n, ..)| n == name).count(), 1);
        }
        assert!(icon("nope").is_none());
    }
}
