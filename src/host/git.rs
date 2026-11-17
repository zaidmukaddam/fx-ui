use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub path: String,
    pub code: char,
    pub staged: bool,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Line {
    Context,
    Added,
    Removed,
    Hunk,
}

pub type DiffLine = (Line, Option<usize>, Option<usize>, String);

fn run(command: &mut Command) -> Result<String, String> {
    let command = command.env("PATH", super::shell::path());
    super::printed(command.output().map_err(|e| e.to_string())?)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run(Command::new("git").args(args).current_dir(cwd))
}

pub fn branch(cwd: &Path) -> Option<String> {
    git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
}

pub fn last_commit(cwd: &Path) -> Option<String> {
    git(cwd, &["log", "-1", "--format=%h · %cr"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn git_aside(cwd: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    run(Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_INDEX_FILE", index))
}

fn scratch_index() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    std::env::temp_dir().join(format!("fx-desktop-index-{}-{nanos}", std::process::id()))
}

pub fn snapshot(cwd: &Path) -> Option<String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let same = |a: &Path, b: &Path| a.canonicalize().ok() == b.canonicalize().ok();
    if !same(Path::new(root.trim()), cwd) {
        return None;
    }
    let index = scratch_index();
    let _ = git_aside(cwd, &index, &["read-tree", "HEAD"]);
    let tree = git_aside(cwd, &index, &["add", "-A"])
        .and_then(|_| git_aside(cwd, &index, &["write-tree"]));
    let _ = std::fs::remove_file(&index);
    tree.ok().map(|t| t.trim().to_string())
}

pub fn restore(cwd: &Path, before: &str, after: &str) -> Result<usize, String> {
    if snapshot(cwd).as_deref() != Some(after) {
        return Err("Files have changed since this turn ended, so nothing was restored.".into());
    }
    let listed = git(
        cwd,
        &["diff", "--name-status", "--no-renames", "-z", before, after],
    )?;
    let mut fields = listed.split('\0').filter(|f| !f.is_empty());
    let (mut created, mut changed) = (Vec::new(), Vec::new());
    while let (Some(code), Some(path)) = (fields.next(), fields.next()) {
        if code == "A" {
            created.push(path);
        } else {
            changed.push(path);
        }
    }
    if !changed.is_empty() {
        let index = scratch_index();
        let mut args = vec!["checkout", before, "--"];
        args.extend(changed.iter().copied());
        let out = git_aside(cwd, &index, &args);
        let _ = std::fs::remove_file(&index);
        out?;
    }
    let mut failed = None;
    for path in &created {
        if let Err(e) = std::fs::remove_file(cwd.join(path)) {
            failed.get_or_insert(format!("{path}: {e}"));
        }
    }
    match failed {
        Some(why) => Err(why),
        None => Ok(created.len() + changed.len()),
    }
}

pub fn status(cwd: &Path) -> Result<Vec<Change>, String> {
    let porcelain = git(cwd, &["status", "--porcelain=v1", "-uall"])?;
    let counts = |args: &[&str]| parse_numstat(&git(cwd, args).unwrap_or_default());
    let staged_counts = counts(&["diff", "--cached", "--numstat", "-z"]);
    let unstaged_counts = counts(&["diff", "--numstat", "-z"]);
    Ok(parse_status(
        &porcelain,
        &staged_counts,
        &unstaged_counts,
        |p| {
            std::fs::read_to_string(cwd.join(p))
                .map(|s| s.lines().count())
                .unwrap_or(0)
        },
    ))
}

fn parse_numstat(text: &str) -> Vec<(String, usize, usize)> {
    let mut fields = text.split('\0');
    let mut counts = Vec::new();
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        counts.push((
            path.to_string(),
            added.parse().unwrap_or(0),
            removed.parse().unwrap_or(0),
        ));
    }
    counts
}

pub fn tracked(cwd: &Path) -> Vec<String> {
    git(
        cwd,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    )
    .map(|listed| listed.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

pub fn counts(lines: &[DiffLine]) -> (usize, usize) {
    (
        lines.iter().filter(|l| l.0 == Line::Added).count(),
        lines.iter().filter(|l| l.0 == Line::Removed).count(),
    )
}

fn parse_status(
    porcelain: &str,
    staged_counts: &[(String, usize, usize)],
    unstaged_counts: &[(String, usize, usize)],
    untracked_lines: impl Fn(&str) -> usize,
) -> Vec<Change> {
    let find = |counts: &[(String, usize, usize)], path: &str| {
        counts
            .iter()
            .find(|(p, ..)| p == path)
            .map(|&(_, a, r)| (a, r))
            .unwrap_or((0, 0))
    };
    let mut changes = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let (x, y) = (line.as_bytes()[0] as char, line.as_bytes()[1] as char);
        let path = line[3..]
            .rsplit(" -> ")
            .next()
            .unwrap_or(&line[3..])
            .to_string();
        if x == '?' {
            let added = untracked_lines(&path);
            changes.push(Change {
                path,
                code: '?',
                staged: false,
                added,
                removed: 0,
            });
            continue;
        }
        if x != ' ' {
            let (added, removed) = find(staged_counts, &path);
            changes.push(Change {
                path: path.clone(),
                code: x,
                staged: true,
                added,
                removed,
            });
        }
        if y != ' ' {
            let (added, removed) = find(unstaged_counts, &path);
            changes.push(Change {
                path,
                code: y,
                staged: false,
                added,
                removed,
            });
        }
    }
    changes
}

pub fn file_diff(cwd: &Path, change: &Change) -> Result<Vec<DiffLine>, String> {
    let text = if change.code == '?' {
        let body = std::fs::read_to_string(cwd.join(&change.path)).map_err(|e| e.to_string())?;
        return Ok(line_diff("", &body, usize::MAX));
    } else if change.staged {
        git(cwd, &["diff", "--cached", "--", &change.path])?
    } else {
        git(cwd, &["diff", "--", &change.path])?
    };
    Ok(parse_unified(&text))
}

pub fn parse_unified(text: &str) -> Vec<DiffLine> {
    let (mut old, mut new) = (0usize, 0usize);
    let mut lines = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            let mut parts = rest.split_whitespace();
            let start = |s: Option<&str>| {
                s.and_then(|s| s[1..].split(',').next()?.parse::<usize>().ok())
                    .unwrap_or(1)
            };
            old = start(parts.next());
            new = start(parts.next());
            lines.push((Line::Hunk, None, None, line.to_string()));
        } else if lines.is_empty() {
            continue;
        } else if let Some(t) = line.strip_prefix('+') {
            lines.push((Line::Added, None, Some(new), t.to_string()));
            new += 1;
        } else if let Some(t) = line.strip_prefix('-') {
            lines.push((Line::Removed, Some(old), None, t.to_string()));
            old += 1;
        } else if let Some(t) = line.strip_prefix(' ') {
            lines.push((Line::Context, Some(old), Some(new), t.to_string()));
            old += 1;
            new += 1;
        }
    }
    lines
}

pub fn stage(cwd: &Path, path: &str) -> Result<(), String> {
    git(cwd, &["add", "--", path]).map(drop)
}

pub fn unstage(cwd: &Path, path: &str) -> Result<(), String> {
    git(cwd, &["restore", "--staged", "--", path]).map(drop)
}

pub fn discard(cwd: &Path, change: &Change) -> Result<(), String> {
    if change.code == '?' {
        std::fs::remove_file(cwd.join(&change.path)).map_err(|e| e.to_string())
    } else {
        git(cwd, &["restore", "--", &change.path]).map(drop)
    }
}

pub fn line_diff(old: &str, new: &str, context: usize) -> Vec<DiffLine> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut all = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            all.push((Line::Context, Some(i + 1), Some(j + 1), a[i].to_string()));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            all.push((Line::Removed, Some(i + 1), None, a[i].to_string()));
            i += 1;
        } else {
            all.push((Line::Added, None, Some(j + 1), b[j].to_string()));
            j += 1;
        }
    }
    if context == usize::MAX {
        return all;
    }
    let near = |k: usize| {
        let lo = k.saturating_sub(context);
        let hi = (k + context).min(all.len().saturating_sub(1));
        (lo..=hi).any(|x| all[x].0 != Line::Context)
    };
    all.iter()
        .enumerate()
        .filter(|&(k, _)| near(k))
        .map(|(_, l)| l.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_diff_keeps_changes_and_context() {
        let old = "a\nb\nc\nd\ne\nf\n";
        let new = "a\nb\nC\nd\ne\nf\ng\n";
        let lines = line_diff(old, new, 1);
        let kinds: Vec<_> = lines.iter().map(|l| (l.0, l.3.as_str())).collect();
        assert_eq!(
            kinds,
            [
                (Line::Context, "b"),
                (Line::Removed, "c"),
                (Line::Added, "C"),
                (Line::Context, "d"),
                (Line::Context, "f"),
                (Line::Added, "g"),
            ]
        );
        let fresh = line_diff("", "x\ny", usize::MAX);
        assert_eq!(fresh[1], (Line::Added, None, Some(2), "y".into()));
    }

    #[test]
    fn a_turn_s_files_go_back_and_staging_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("fx-desktop-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| git(&dir, args).unwrap();
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap();
        write("kept.txt", "one\n");
        write("gone.txt", "bye\n");
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "first"]);
        write("kept.txt", "one\nyours\n");
        write("staged.txt", "staged\n");
        run(&["add", "staged.txt"]);

        let before = snapshot(&dir).unwrap();
        write("kept.txt", "one\nyours\nturn\n");
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        write("new.txt", "made by the turn\n");
        let after = snapshot(&dir).unwrap();
        assert_ne!(before, after);

        write("later.txt", "after the turn\n");
        assert!(restore(&dir, &before, &after).is_err());
        assert_eq!(read("new.txt"), "made by the turn\n");
        std::fs::remove_file(dir.join("later.txt")).unwrap();

        assert_eq!(restore(&dir, &before, &after), Ok(3));
        assert_eq!(read("kept.txt"), "one\nyours\n");
        assert_eq!(read("gone.txt"), "bye\n");
        assert!(!dir.join("new.txt").exists());
        assert_eq!(run(&["diff", "--cached", "--name-only"]), "staged.txt\n");
        assert_eq!(snapshot(&dir).as_deref(), Some(before.as_str()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert_eq!(snapshot(&dir.join("sub")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_splits_staged_unstaged_and_untracked() {
        let porcelain = "MM src/a.rs\nA  src/b.rs\n?? notes.md\nR  old.rs -> new.rs\n";
        let staged = [
            ("src/a.rs".to_string(), 2, 1),
            ("src/b.rs".to_string(), 9, 0),
        ];
        let unstaged = [("src/a.rs".to_string(), 1, 0)];
        let changes = parse_status(porcelain, &staged, &unstaged, |_| 4);
        let summary: Vec<_> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.code, c.staged, c.added, c.removed))
            .collect();
        assert_eq!(
            summary,
            [
                ("src/a.rs", 'M', true, 2, 1),
                ("src/a.rs", 'M', false, 1, 0),
                ("src/b.rs", 'A', true, 9, 0),
                ("notes.md", '?', false, 4, 0),
                ("new.rs", 'R', true, 0, 0),
            ]
        );
    }

    #[test]
    fn numstat_counts_a_rename_under_its_new_name() {
        let text = "2\t1\tsrc/a.rs\x003\t4\t\0old.rs\0new.rs\0-\t-\tlogo.png\0";
        assert_eq!(
            parse_numstat(text),
            [
                ("src/a.rs".to_string(), 2, 1),
                ("new.rs".to_string(), 3, 4),
                ("logo.png".to_string(), 0, 0),
            ]
        );
        let porcelain = "R  old.rs -> new.rs\n";
        let changes = parse_status(porcelain, &parse_numstat(text), &[], |_| 0);
        assert_eq!((changes[0].added, changes[0].removed), (3, 4));
    }

    #[test]
    fn unified_diff_numbers_lines() {
        let text =
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n same\n";
        let lines = parse_unified(text);
        assert_eq!(lines[0].0, Line::Hunk);
        assert_eq!(lines[1], (Line::Context, Some(3), Some(3), "keep".into()));
        assert_eq!(lines[2], (Line::Removed, Some(4), None, "old".into()));
        assert_eq!(lines[3], (Line::Added, None, Some(4), "new".into()));
        assert_eq!(lines[4], (Line::Context, Some(5), Some(5), "same".into()));
    }
}
