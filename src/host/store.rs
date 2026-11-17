use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Store {
    pub workspaces: Vec<PathBuf>,
    pub titles: HashMap<String, String>,
    pub hidden: Vec<String>,
    pub defaults: HashMap<String, String>,
    pub changes: HashMap<String, (usize, usize)>,
    pub ran_on: HashMap<String, (String, String)>,
    pub mute: bool,
}

impl Store {
    pub fn path() -> PathBuf {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        home.join("Library/Application Support/fx-desktop/state.json")
    }

    pub fn load() -> Store {
        match std::fs::read(Self::path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Store {
                workspaces: earlier_folders(),
                ..Store::default()
            },
        }
    }

    pub fn save(&self) {
        let path = Self::path();
        let Some(dir) = path.parent() else { return };
        let _ = std::fs::create_dir_all(dir);
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(self)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    pub fn add_workspace(&mut self, path: PathBuf) {
        if !self.workspaces.contains(&path) {
            self.workspaces.push(path);
        }
    }
}

fn earlier_folders() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    std::fs::read(home.join(".fx-ui/state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|state| folders_in(&state))
        .unwrap_or_default()
        .into_iter()
        .filter(|folder| folder.is_dir())
        .collect()
}

fn folders_in(state: &Value) -> Vec<PathBuf> {
    state["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|workspace| workspace["path"].as_str())
        .map(PathBuf::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_folders_the_app_before_0_3_saved() {
        let state = serde_json::json!({
            "workspaces": [
                { "id": "d8939fc6", "name": "fx-ui", "path": "/Users/me/projects/fx-ui", "createdAt": 1 },
                { "id": "x", "name": "no path" },
            ],
            "sessions": [],
        });
        assert_eq!(
            folders_in(&state),
            [PathBuf::from("/Users/me/projects/fx-ui")]
        );
        assert!(folders_in(&serde_json::json!({})).is_empty());
    }
}
