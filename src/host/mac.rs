use std::process::Command;
use std::sync::OnceLock;

pub fn user_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let full = Command::new("id")
            .arg("-F")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "You".into());
        full.split_whitespace().next().unwrap_or("You").to_string()
    })
}

pub fn notify(title: &str, body: &str) {
    let quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display notification \"{}\" with title \"fx\" subtitle \"{}\"",
        quote(body),
        quote(title)
    );
    let _ = Command::new("osascript").args(["-e", &script]).spawn();
}
