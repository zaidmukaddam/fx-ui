use crate::fx::cli::fx_json;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum State {
    Ready { tools: usize },
    SignedOut,
    Waiting,
    Rejected,
    NotChecked,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Server {
    pub name: String,
    pub project: bool,
    pub remote: bool,
    pub status: String,
    pub address: String,
}

pub(crate) fn server(listed: &Value) -> Server {
    let name = listed["name"].as_str().unwrap_or_default().to_string();
    let entry = listed["file"]
        .as_str()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|config| config["mcpServers"][&name].clone())
        .unwrap_or_default();
    Server {
        address: address(&entry),
        project: listed["source"] == "project",
        remote: listed["transport"] == "http",
        status: listed["status"].as_str().unwrap_or_default().to_string(),
        name,
    }
}

fn address(entry: &Value) -> String {
    if let Some(url) = entry["url"].as_str() {
        return url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .to_string();
    }
    let args = entry["args"].as_array().into_iter().flatten();
    entry["command"]
        .as_str()
        .into_iter()
        .chain(args.filter_map(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn name_for(address: &str) -> String {
    let address = address.trim();
    let url = address
        .strip_prefix("https://")
        .or_else(|| address.strip_prefix("http://"));
    if let Some(rest) = url {
        let host = rest.split(['/', ':']).next().unwrap_or_default();
        let labels: Vec<&str> = host
            .split('.')
            .filter(|l| !matches!(*l, "mcp" | "api" | "www"))
            .collect();
        let at = labels.len().saturating_sub(2);
        return labels.get(at).unwrap_or(&"server").to_string();
    }
    let word = address
        .split_whitespace()
        .rfind(|w| !w.starts_with('-') && !w.starts_with('/') && !w.starts_with('.'))
        .unwrap_or("server");
    let tail = word.rsplit('/').next().unwrap_or(word);
    let tail = tail.split('@').next().unwrap_or(tail);
    ["mcp-server-", "server-", "mcp-"]
        .iter()
        .find_map(|prefix| tail.strip_prefix(prefix))
        .unwrap_or(tail)
        .to_string()
}

pub(crate) fn show(cwd: &Path, name: &str) -> Option<Value> {
    fx_json(cwd, &["mcp", "show", name, "--json"])
}

pub(crate) fn state(server: &Server, shown: Option<&Value>) -> State {
    let status = shown
        .and_then(|s| s["status"].as_str())
        .unwrap_or(&server.status);
    match status {
        "ready" => State::Ready {
            tools: shown
                .and_then(|s| s["tools"].as_array())
                .map_or(0, Vec::len),
        },
        "needs_login" => State::SignedOut,
        "waiting_for_approval" => State::Waiting,
        "rejected" => State::Rejected,
        "not_started" | "" => State::NotChecked,
        _ => State::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_server_from_its_address() {
        assert_eq!(name_for("https://mcp.linear.app/mcp"), "linear");
        assert_eq!(
            name_for("https://api.githubcopilot.com/mcp"),
            "githubcopilot"
        );
        assert_eq!(name_for("http://localhost:3845/mcp"), "localhost");
        assert_eq!(
            name_for("npx -y @modelcontextprotocol/server-postgres"),
            "postgres"
        );
        assert_eq!(
            name_for("npx -y @modelcontextprotocol/server-filesystem /tmp"),
            "filesystem"
        );
        assert_eq!(name_for("uvx mcp-server-git@2.1"), "git");
    }

    #[test]
    fn reads_an_address_and_a_state() {
        let remote = serde_json::json!({ "type": "http", "url": "https://mcp.context7.com/mcp" });
        let local = serde_json::json!({ "command": "npx", "args": ["-y", "pkg", "/tmp"] });
        assert_eq!(address(&remote), "mcp.context7.com/mcp");
        assert_eq!(address(&local), "npx -y pkg /tmp");

        let server = Server {
            name: "docs".into(),
            project: false,
            remote: true,
            status: "not_started".into(),
            address: String::new(),
        };
        assert_eq!(state(&server, None), State::NotChecked);
        let ready = serde_json::json!({ "status": "ready", "tools": [{}, {}] });
        assert_eq!(state(&server, Some(&ready)), State::Ready { tools: 2 });
        let out = serde_json::json!({ "status": "needs_login", "tools": [] });
        assert_eq!(state(&server, Some(&out)), State::SignedOut);
        let down = serde_json::json!({ "status": "failed", "error": "connection refused" });
        assert_eq!(state(&server, Some(&down)), State::Failed);
    }
}
