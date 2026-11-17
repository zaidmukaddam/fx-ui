use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, Pixels, hsla, px, rgb, rgba};
use std::borrow::Cow;

pub const MONO: &str = "Geist Mono";

static FACES: std::sync::OnceLock<(&'static str, &'static str)> = std::sync::OnceLock::new();

pub fn sans() -> &'static str {
    FACES.get().map_or(".SystemUIFont", |f| f.0)
}

pub fn display() -> &'static str {
    FACES.get().map_or(".SystemUIFont", |f| f.1)
}

pub fn background_100() -> Hsla {
    rgb(0x0a0a0a).into()
}
pub fn background_200() -> Hsla {
    rgb(0x000000).into()
}
pub fn gray_100() -> Hsla {
    rgb(0x1a1a1a).into()
}
pub fn gray_200() -> Hsla {
    rgb(0x1f1f1f).into()
}
pub fn gray_300() -> Hsla {
    rgb(0x292929).into()
}
pub fn gray_400() -> Hsla {
    rgb(0x2E2E2E).into()
}
pub fn gray_500() -> Hsla {
    rgb(0x454545).into()
}
pub fn gray_600() -> Hsla {
    rgb(0x878787).into()
}
pub fn gray_700() -> Hsla {
    rgb(0x8f8f8f).into()
}
pub fn gray_900() -> Hsla {
    rgb(0xa1a1a1).into()
}
pub fn gray_1000() -> Hsla {
    rgb(0xededed).into()
}
pub fn alpha_100() -> Hsla {
    rgba(0xffffff0f).into()
}
pub fn alpha_200() -> Hsla {
    rgba(0xffffff17).into()
}
pub fn alpha_300() -> Hsla {
    rgba(0xffffff21).into()
}
pub fn alpha_400() -> Hsla {
    rgba(0xffffff24).into()
}

fn hsl(h: f32, s: f32, l: f32) -> Hsla {
    hsla(h / 360., s / 100., l / 100., 1.)
}
pub fn amber_700() -> Hsla {
    hsl(39., 100., 57.)
}
pub fn red_700() -> Hsla {
    hsl(358., 75., 59.)
}
pub fn red_900() -> Hsla {
    hsl(358., 100., 69.)
}
pub fn green_700() -> Hsla {
    hsl(131., 41., 46.)
}
pub fn green_900() -> Hsla {
    hsl(131., 43., 57.)
}
pub fn blue_700() -> Hsla {
    hsl(212., 100., 48.)
}
pub fn blue_900() -> Hsla {
    hsl(210., 100., 66.)
}
pub fn pink_900() -> Hsla {
    hsl(341., 90., 67.)
}
pub fn purple_900() -> Hsla {
    hsl(275., 80., 71.)
}
pub fn amber_900() -> Hsla {
    hsl(39., 90., 50.)
}

pub const COLUMN: Pixels = px(720.);
pub const SIDEBAR: Pixels = px(248.);

pub fn load_fonts(cx: &mut App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![Cow::Borrowed(include_bytes!(
        "../../assets/fonts/GeistMono-Regular.ttf"
    ))];
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        eprintln!("fx: could not load Geist Mono: {e:#}");
    }
    let installed = cx.text_system().all_font_names();
    let has = |name: &str| installed.iter().any(|n| n == name);
    let text = if has("SF Pro Text") {
        "SF Pro Text"
    } else {
        ".SystemUIFont"
    };
    let display = if has("SF Pro Display") {
        "SF Pro Display"
    } else {
        text
    };
    let _ = FACES.set((text, display));
}

pub fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    let t = Theme::global_mut(cx);
    t.font_family = sans().into();
    t.mono_font_family = MONO.into();
    t.font_size = px(14.);
    t.mono_font_size = px(13.);
    t.radius = px(8.);
    t.radius_lg = px(12.);

    let c = &mut t.colors;
    c.background = background_100();
    c.foreground = gray_1000();
    c.border = alpha_400();
    c.input = alpha_400();
    c.ring = gray_600();
    c.caret = gray_1000();
    c.muted = gray_100();
    c.muted_foreground = gray_900();
    c.popover = gray_100();
    c.popover_foreground = gray_1000();
    c.primary = gray_1000();
    c.primary_foreground = background_100();
    c.secondary = gray_100();
    c.secondary_hover = gray_200();
    c.secondary_foreground = gray_1000();
    c.accent = alpha_200();
    c.accent_foreground = gray_1000();
    c.list_hover = alpha_200();
    c.list_active = alpha_200();
    c.selection = rgba(0x0070f355).into();
    c.scrollbar_thumb = alpha_300();
    c.sidebar = background_200();
    c.title_bar = background_200();
    c.danger = red_700();
}
