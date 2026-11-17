use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const RELEASES: &str = "https://api.github.com/repos/zaidmukaddam/fx-ui/releases/latest";
const SIGNED_BY: &str = "Developer ID Application: Zaid Altaf Mukaddam (8BN7M8YM4J)";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Default, PartialEq)]
pub enum Update {
    #[default]
    Idle,
    Checking,
    Current,
    Downloading(String),
    Ready {
        version: String,
        app: PathBuf,
    },
    Failed(String),
}

pub fn compare_versions(a: &str, b: &str) -> i64 {
    let parts = |v: &str| -> Vec<i64> {
        v.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    (0..a.len().max(b.len()))
        .map(|i| a.get(i).unwrap_or(&0) - b.get(i).unwrap_or(&0))
        .find(|diff| *diff != 0)
        .unwrap_or(0)
}

pub fn app_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let app = exe.parent()?.parent()?.parent()?;
    (app.extension()? == "app").then(|| app.to_path_buf())
}

fn release(body: &Value) -> Option<(String, String)> {
    let version = body["tag_name"].as_str()?.trim_start_matches('v');
    let dmg = body["assets"].as_array()?.iter().find_map(|asset| {
        asset["name"]
            .as_str()
            .filter(|name| name.ends_with(".dmg"))
            .and(asset["browser_download_url"].as_str())
    })?;
    Some((version.to_string(), dmg.to_string()))
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    super::printed(
        Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("{program}: {e}"))?,
    )
}

pub fn newer() -> Result<Option<(String, String)>, String> {
    let body = run("curl", &["-fsSL", "--max-time", "20", RELEASES])?;
    let body: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(release(&body).filter(|(version, _)| compare_versions(version, VERSION) > 0))
}

pub fn install(dmg_url: &str, app: &Path) -> Result<(), String> {
    let stamp = std::process::id();
    let dmg = std::env::temp_dir().join(format!("fx-update-{stamp}.dmg"));
    let mount = std::env::temp_dir().join(format!("fx-update-{stamp}"));
    let (dmg_s, mount_s) = (dmg.to_string_lossy(), mount.to_string_lossy());
    let installed = (|| {
        run(
            "curl",
            &["-fsSL", "--max-time", "600", "-o", &dmg_s, dmg_url],
        )
        .map_err(|why| format!("Could not download the update: {why}"))?;
        let requirement =
            format!("-R=anchor apple generic and certificate leaf[subject.CN] = \"{SIGNED_BY}\"");
        run("codesign", &["--verify", &requirement, &dmg_s]).map_err(|_| {
            "The downloaded update is not signed by fx-ui's Developer ID, so it was not installed."
                .to_string()
        })?;
        std::fs::create_dir_all(&mount).map_err(|e| e.to_string())?;
        run(
            "hdiutil",
            &["attach", &dmg_s, "-nobrowse", "-mountpoint", &mount_s],
        )
        .map_err(|why| format!("Could not open the update: {why}"))?;
        let from = mount.join("fx.app");
        let copied = run("ditto", &[&from.to_string_lossy(), &app.to_string_lossy()])
            .map_err(|why| format!("Could not install the update: {why}"));
        let _ = run("hdiutil", &["detach", &mount_s, "-force"]);
        copied.map(|_| ())
    })();
    let _ = std::fs::remove_file(&dmg);
    let _ = std::fs::remove_dir_all(&mount);
    installed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_versions_by_their_parts() {
        assert!(compare_versions("0.3.1", "0.3.0") > 0);
        assert!(compare_versions("v0.10.0", "0.9.9") > 0);
        assert!(compare_versions("0.2.7", "0.3.0") < 0);
        assert_eq!(compare_versions("1.2", "v1.2.0"), 0);
    }

    #[test]
    fn reads_a_release_s_version_and_disk_image() {
        let body = serde_json::json!({
            "tag_name": "v0.3.1",
            "assets": [
                { "name": "notes.txt", "browser_download_url": "https://example.com/notes.txt" },
                { "name": "fx-0.3.1.dmg", "browser_download_url": "https://example.com/fx.dmg" },
            ],
        });
        assert_eq!(
            release(&body),
            Some(("0.3.1".into(), "https://example.com/fx.dmg".into()))
        );
        assert_eq!(
            release(&serde_json::json!({ "tag_name": "v9", "assets": [] })),
            None
        );
    }
}
