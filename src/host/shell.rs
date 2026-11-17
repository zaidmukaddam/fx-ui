use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const PATIENCE: Duration = Duration::from_secs(5);

pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(resolve)
}

pub fn has(program: &str) -> bool {
    if program.contains('/') {
        Path::new(program).is_file()
    } else {
        finds(path(), program)
    }
}

fn resolve() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    if finds(&current, "fx") {
        return current;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    widened(&from_login_shell().unwrap_or(current), &home)
}

fn finds(path: &str, program: &str) -> bool {
    path.split(':')
        .any(|dir| !dir.is_empty() && Path::new(dir).join(program).is_file())
}

fn widened(path: &str, home: &str) -> String {
    let mut dirs: Vec<String> = path
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(str::to_string)
        .collect();
    let usual = [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    for dir in usual {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

fn from_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", "/usr/bin/printenv PATH"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + PATIENCE;
    while child.try_wait().ok()?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut printed = String::new();
    child.stdout.take()?.read_to_string(&mut printed).ok()?;
    printed_path(&printed)
}

fn printed_path(printed: &str) -> Option<String> {
    printed
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_under_whatever_a_shell_prints_first() {
        let printed = "Last login: Mon\nwelcome back\n/opt/homebrew/bin:/usr/bin:/bin\n\n";
        assert_eq!(
            printed_path(printed).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin:/bin")
        );
        assert_eq!(printed_path("nothing useful\n"), None);
    }

    #[test]
    fn adds_the_usual_places_once() {
        assert_eq!(
            widened("/usr/bin:/bin", "/Users/me"),
            "/usr/bin:/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin"
        );
        assert_eq!(
            widened("/opt/homebrew/bin::/usr/bin", "/Users/me"),
            "/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin:/usr/local/bin"
        );
    }

    #[test]
    fn finds_a_program_only_where_it_is() {
        assert!(finds("/nowhere:/bin", "sh"));
        assert!(!finds("/nowhere", "sh"));
        assert!(!finds("", "sh"));
    }
}
