use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .unwrap_or_else(|| "/".into())
        .into()
}

pub(crate) fn binary() -> String {
    std::env::var("FX_BINARY").unwrap_or_else(|_| "fx".into())
}

pub(crate) fn profile_path() -> PathBuf {
    home().join(".fx/settings.json")
}

pub(crate) fn profile() -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(profile_path()).ok()?).ok()
}

fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(binary());
    command
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::host::shell::path())
        .env_remove("AI_GATEWAY_API_KEY");
    command
}

fn printed_json(mut command: Command) -> Option<Value> {
    serde_json::from_slice(&command.output().ok()?.stdout).ok()
}

pub(crate) fn fx(args: &[&str]) -> Result<String, String> {
    fx_in(&home(), args)
}

pub(crate) fn fx_in(cwd: &Path, args: &[&str]) -> Result<String, String> {
    crate::host::printed(command(cwd, args).output().map_err(|e| e.to_string())?)
}

pub(crate) fn fx_json(cwd: &Path, args: &[&str]) -> Option<Value> {
    printed_json(command(cwd, args))
}

pub(crate) fn usage_report(period: &str, account: Option<&str>) -> Option<Value> {
    let mut command = command(&home(), &["usage", "--period", period, "--json"]);
    if let Some(account) = account {
        command.env("FX_PROVIDER", account);
    }
    printed_json(command)
}

pub(crate) fn credits() -> Option<f64> {
    fx(&["credits"])
        .ok()?
        .split("balance=")
        .nth(1)?
        .trim()
        .parse()
        .ok()
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Status {
    pub auth: String,
    pub update_channel: Option<String>,
    pub build_revision: String,
}

impl Status {
    pub(crate) fn connected(&self) -> bool {
        !self.auth.is_empty() && !self.auth.to_lowercase().contains("not ")
    }
}

pub(crate) fn status() -> Option<Status> {
    parse_status(&fx(&["status", "--json"]).ok()?)
}

fn parse_status(text: &str) -> Option<Status> {
    let status: Value = serde_json::from_str(text).ok()?;
    let field = |key: &str| status[key].as_str().map(str::to_string);
    Some(Status {
        auth: field("auth").unwrap_or_default(),
        update_channel: field("update_channel"),
        build_revision: field("build_revision").unwrap_or_default(),
    })
}

pub(crate) fn permission_rules() -> Vec<String> {
    fx(&["permissions"])
        .map(|text| parse_permission_rules(&text))
        .unwrap_or_default()
}

fn parse_permission_rules(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim_start_matches("[permissions]").trim().to_string())
        .filter(|l| {
            !l.is_empty() && !l.starts_with("mode=") && !l.ends_with("(none)") && !l.ends_with(':')
        })
        .map(|l| l.split_once(": ").map(|(_, r)| r.to_string()).unwrap_or(l))
        .collect()
}

pub(crate) fn extra_folders(cwd: &Path) -> Vec<String> {
    fx_in(cwd, &["workspace", "list", "--json"])
        .map(|text| parse_extra_folders(&text))
        .unwrap_or_default()
}

fn parse_extra_folders(text: &str) -> Vec<String> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v["additional_directories"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|d| d["path"].as_str().map(str::to_string))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Check {
    pub level: Level,
    pub name: String,
    pub detail: String,
}

pub(crate) fn doctor_checks() -> Vec<Check> {
    parse_doctor(&fx(&["doctor"]).unwrap_or_else(|e| e))
}

fn parse_doctor(text: &str) -> Vec<Check> {
    text.lines()
        .filter_map(|l| {
            let (level, rest) = l.trim().strip_prefix('[')?.split_once("] ")?;
            let level = match level {
                "ok" => Level::Ok,
                "warn" => Level::Warn,
                "fail" | "error" => Level::Fail,
                _ => return None,
            };
            let (name, detail) = rest.split_once(": ").unwrap_or((rest, ""));
            Some(Check {
                level,
                name: name.to_string(),
                detail: detail.to_string(),
            })
        })
        .collect()
}

pub(crate) fn signed_in() -> Vec<&'static str> {
    let fx = home().join(".fx");
    let has = |file: &str| std::fs::metadata(fx.join(file)).is_ok_and(|m| m.len() > 2);
    let stored_key =
        profile().is_some_and(|v| v["credential_source"].as_str() == Some("stored_key"));
    let mut out = Vec::new();
    if has("chatgpt-auth.json") {
        out.push("codex");
    }
    if has("grok-auth.json") {
        out.push("grok");
    }
    if stored_key || std::env::var_os("AI_GATEWAY_API_KEY").is_some() {
        out.push("gateway");
    }
    out
}

pub(crate) fn saved_models() -> std::collections::HashMap<String, String> {
    profile()
        .and_then(|v| v["models"].as_object().cloned())
        .map(|models| {
            models
                .into_iter()
                .filter_map(|(account, model)| Some((account, model.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SkillWarning {
    pub path: String,
    pub reason: String,
}

fn sentence(text: &str) -> String {
    let text = text.trim().trim_end_matches('.');
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn explain(why: &str, fix: &str) -> String {
    if why.contains("linked skill directory") || why.contains("link does not lead") {
        return "Its link doesn't lead to a readable folder. Repair or remove the link.".into();
    }
    if why.contains("unsupported_multiline") {
        return "Its description breaks across lines. Put it on one line, or use a > or | block."
            .into();
    }
    let fix = fix.replace(", then reload skills", "");
    [sentence(why), sentence(&fix)]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn skill_warnings(notice: &str) -> Option<(Vec<SkillWarning>, usize)> {
    let body = notice
        .lines()
        .find_map(|l| l.strip_prefix("skill discovery warning:"))?;
    let list = body
        .split("candidate \"")
        .skip(1)
        .filter_map(|piece| {
            let (path, rest) = piece.split_once('"')?;
            let rest = rest.trim();
            let rest = rest.strip_prefix("was skipped because ").unwrap_or(rest);
            let mut parts = rest.split(';');
            let why = parts.next().unwrap_or_default();
            let fix = parts.next().unwrap_or_default();
            Some(SkillWarning {
                path: path.to_string(),
                reason: explain(why, fix),
            })
        })
        .collect();
    let omitted = body
        .split(';')
        .find(|part| part.contains("additional diagnostic"))
        .and_then(|part| part.split_whitespace().next()?.parse().ok())
        .unwrap_or(0);
    Some((list, omitted))
}

pub(crate) fn doctor_skill_warnings(checks: &[Check]) -> Vec<SkillWarning> {
    checks
        .iter()
        .filter(|check| check.level != Level::Ok && check.name == "skills")
        .filter_map(|check| {
            let (path, why) = check.detail.split_once(" was skipped: ")?;
            Some(SkillWarning {
                path: path.to_string(),
                reason: explain(why, ""),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_skills_fx_skipped() {
        let notice = "skill discovery warning: candidate \"/Users/z/.claude/skills/code-review\" \
            was skipped because its linked skill directory could not be resolved to an authorized \
            readable directory; repair or remove the link, or authorize its external location, \
            then reload skills; candidate \"/Users/z/.agents/skills/vercel-composition-patterns\" \
            was skipped because its metadata is invalid (unsupported_multiline); use one safe \
            name and an optional inline description or a >, >-, or | block, then reload skills; \
            1 additional diagnostic omitted; relaunch with FX_TRACE=1 to write a trace log";
        let (list, omitted) = skill_warnings(notice).unwrap();
        assert_eq!(omitted, 1);
        assert_eq!(
            list,
            [
                SkillWarning {
                    path: "/Users/z/.claude/skills/code-review".into(),
                    reason: "Its link doesn't lead to a readable folder. Repair or remove the link."
                        .into(),
                },
                SkillWarning {
                    path: "/Users/z/.agents/skills/vercel-composition-patterns".into(),
                    reason:
                        "Its description breaks across lines. Put it on one line, or use a > or | block."
                            .into(),
                },
            ]
        );
        let (list, omitted) = skill_warnings(
            "skill discovery warning: candidate \"/a/b\" was skipped because its name is taken; rename it, then reload skills",
        )
        .unwrap();
        assert_eq!(omitted, 0);
        assert_eq!(list[0].reason, "Its name is taken. Rename it.");
        assert!(skill_warnings("[context] skill descriptions shortened: 3").is_none());

        let checks = [Check {
            level: Level::Warn,
            name: "skills".into(),
            detail: "/Users/z/.claude/skills/code-review was skipped: its link does not lead to a readable folder"
                .into(),
        }];
        assert_eq!(
            doctor_skill_warnings(&checks),
            [SkillWarning {
                path: "/Users/z/.claude/skills/code-review".into(),
                reason: "Its link doesn't lead to a readable folder. Repair or remove the link."
                    .into(),
            }]
        );
    }

    #[test]
    fn reads_status() {
        let status = parse_status(
            r#"{"kind":"status","update_channel":"stable","build_revision":"d1d4a883382d","auth":"stored API key (macOS Keychain)","auth_refreshable":false}"#,
        )
        .unwrap();
        assert_eq!(
            status,
            Status {
                auth: "stored API key (macOS Keychain)".into(),
                update_channel: Some("stable".into()),
                build_revision: "d1d4a883382d".into(),
            }
        );
        assert!(status.connected());

        let bare = parse_status("{}").unwrap();
        assert_eq!(bare.update_channel, None);
        assert!(!bare.connected());
        assert!(
            !parse_status(r#"{"auth":"Not signed in"}"#)
                .unwrap()
                .connected()
        );
        assert!(parse_status("fx: command failed").is_none());
    }

    #[test]
    fn reads_the_always_allowed_rules() {
        let none = "[permissions] mode=auto\n\
            [permissions] configured rules: (none)\n\
            [permissions] session grants: (none)\n";
        assert!(parse_permission_rules(none).is_empty());

        let some = "[permissions] mode=ask\n\
            [permissions] configured rules:\n\
            [permissions] git status\n\
            \x20 cargo test\n\
            [permissions] shell: bun run build\n\
            \n\
            [permissions] session grants: (none)\n";
        assert_eq!(
            parse_permission_rules(some),
            ["git status", "cargo test", "bun run build"]
        );
    }

    #[test]
    fn reads_the_extra_folders() {
        let none = r#"{"kind":"workspace","action":"list","changed":false,"primary_directory":"/Users/z/projects/fx-ui","saved_suppressed":false,"limit":16,"additional_directories":[]}"#;
        assert!(parse_extra_folders(none).is_empty());

        let some = r#"{"kind":"workspace","action":"list","additional_directories":[{"path":"/Users/z/notes"},{"missing":true},{"path":"/Users/z/shared"}]}"#;
        assert_eq!(
            parse_extra_folders(some),
            ["/Users/z/notes", "/Users/z/shared"]
        );
        assert!(parse_extra_folders("fx: not a workspace").is_empty());
    }

    #[test]
    fn reads_doctor_checks() {
        let text = "[doctor] ok=9 warn=2 fail=0\n\
            [doctor] version=0.0.17\n\
            [ok] workspace: using workspace /Users/z\n\
            [ok] sessions: 24 saved session(s); latest=chUF5_FEUHkO\n\
            [warn] git: this folder is not in a git repository; fx pr and fx issue need one\n\
            \x20 fix: run git init here, or run fx in a repository\n\
            [fail] auth: AI Gateway rejected the credential\n\
            [error] model\n";
        let check = |level, name: &str, detail: &str| Check {
            level,
            name: name.into(),
            detail: detail.into(),
        };
        assert_eq!(
            parse_doctor(text),
            [
                check(Level::Ok, "workspace", "using workspace /Users/z"),
                check(
                    Level::Ok,
                    "sessions",
                    "24 saved session(s); latest=chUF5_FEUHkO"
                ),
                check(
                    Level::Warn,
                    "git",
                    "this folder is not in a git repository; fx pr and fx issue need one"
                ),
                check(Level::Fail, "auth", "AI Gateway rejected the credential"),
                check(Level::Fail, "model", ""),
            ]
        );
    }
}
