use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

fn skill_roots(workspace: &Path) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut roots = Vec::new();
    for base in [workspace, home.as_path()] {
        for harness in [".fx", ".agents", ".claude"] {
            roots.push(base.join(harness).join("skills"));
        }
    }
    roots
}

pub fn skills(workspace: &Path) -> Vec<Skill> {
    let mut found: Vec<Skill> = Vec::new();
    for root in skill_roots(workspace) {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.path().join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if found.iter().any(|s| s.name == name) {
                continue;
            }
            found.push(Skill {
                description: description(&text),
                name,
                path: file,
            });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn description(text: &str) -> String {
    let Some(front) = text
        .strip_prefix("---")
        .and_then(|t| t.split("\n---").next())
    else {
        return String::new();
    };
    let mut lines = front.lines().skip_while(|l| !l.starts_with("description:"));
    let Some(first) = lines.next() else {
        return String::new();
    };
    let mut out = first["description:".len()..]
        .trim()
        .trim_matches(['"', '>', '|'])
        .trim()
        .to_string();
    for line in lines {
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        out.push(' ');
        out.push_str(line.trim());
    }
    out.trim().to_string()
}

pub fn files(workspace: &Path) -> Vec<String> {
    super::git::tracked(workspace)
}

pub fn rank<'a, T>(
    items: &'a [T],
    query: &str,
    key: impl Fn(&T) -> &str,
    limit: usize,
) -> Vec<&'a T> {
    let query = query.to_lowercase();
    let mut scored: Vec<(i32, usize, &T)> = items
        .iter()
        .filter_map(|item| {
            let text = key(item);
            score(&text.to_lowercase(), &query).map(|s| (s, text.len(), item))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, item)| item)
        .collect()
}

fn score(text: &str, query: &str) -> Option<i32> {
    let Some(first) = query.bytes().next() else {
        return Some(0);
    };
    text.bytes()
        .enumerate()
        .filter(|&(_, b)| b == first)
        .filter_map(|(start, _)| score_from(text, query, start))
        .max()
}

fn score_from(text: &str, query: &str, start: usize) -> Option<i32> {
    let bytes = text.as_bytes();
    let mut score = 0;
    let mut at = start;
    let mut previous: Option<usize> = None;
    for q in query.bytes() {
        let found = bytes[at..].iter().position(|&b| b == q)? + at;
        score += 1;
        if previous == Some(found.wrapping_sub(1)) {
            score += 3;
        }
        if found == 0 || matches!(bytes[found - 1], b'/' | b'_' | b'-' | b'.' | b' ') {
            score += 2;
        }
        previous = Some(found);
        at = found + 1;
    }
    Some(score)
}

pub fn trigger(draft: &str) -> Option<(char, String)> {
    if let Some(rest) = draft.strip_prefix('/')
        && !rest.contains(char::is_whitespace)
    {
        return Some(('/', rest.to_string()));
    }
    let word = draft.rsplit(char::is_whitespace).next()?;
    word.strip_prefix('@').map(|q| ('@', q.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_contiguous_and_word_start_matches_first() {
        let files = [
            "src/views/sidebar.rs",
            "src/state/side_effects.rs",
            "docs/inside.md",
        ];
        let ranked = rank(&files, "side", |s| s, 10);
        assert_eq!(ranked[0], &"src/views/sidebar.rs");
        assert!(rank(&files, "zzz", |s| s, 10).is_empty());
    }

    #[test]
    fn triggers_on_a_leading_slash_or_a_trailing_mention() {
        assert_eq!(trigger("/rev"), Some(('/', "rev".into())));
        assert_eq!(trigger("/review now"), None);
        assert_eq!(trigger("match rows in @side"), Some(('@', "side".into())));
        assert_eq!(trigger("plain text"), None);
    }

    #[test]
    fn reads_a_folded_description() {
        let text =
            "---\nname: review\ndescription: >\n  Review the diff\n  for bugs.\n---\n# Review\n";
        assert_eq!(description(text), "Review the diff for bugs.");
        assert_eq!(
            description("---\ndescription: \"One line\"\n---\n"),
            "One line"
        );
    }
}
