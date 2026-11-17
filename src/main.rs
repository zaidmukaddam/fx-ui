mod app;
#[cfg(test)]
mod bench;
mod design;
mod fx;
mod host;
mod views;

use gpui_kit::component::Root;
use gpui_kit::{
    AppContext as _, Bounds, TitlebarOptions, WindowBounds, WindowOptions, point, px, size,
};

fn main() {
    std::thread::spawn(host::shell::path);
    let mut args = std::env::args().skip(1);
    let (mut folder, mut first_prompt) = (None, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--prompt" => first_prompt = args.next(),
            _ => folder = Some(std::path::PathBuf::from(arg)),
        }
    }
    let folder = folder.map(|f| f.canonicalize().unwrap_or(f));

    gpui_kit::application()
        .with_assets(design::assets::AppAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            design::load_fonts(cx);
            design::apply(cx);
            app::bind_keys(cx);
            cx.activate(true);

            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1440.), px(900.)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("fx".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(16.), px(18.))),
                }),
                ..Default::default()
            };
            cx.spawn(async move |cx| {
                let opened = cx.open_window(options, |window, cx| {
                    let app = cx.new(|cx| app::FxApp::new(folder, first_prompt, window, cx));
                    cx.new(|cx| Root::new(app, window, cx))
                });
                if let Err(e) = opened {
                    eprintln!("fx: could not open a window: {e:#}");
                }
            })
            .detach();
        });
}
