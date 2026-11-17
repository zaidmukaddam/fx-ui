use crate::fx::acp::ToolCall;
use std::time::{Duration, Instant};

fn answer_text() -> String {
    let section = "## Quicksort\n\nQuicksort picks a **pivot**, partitions the slice around it and \
recurses into both halves. It is `O(n log n)` on average and sorts in place.\n\n\
- Pick a pivot, often the middle element\n- Partition so smaller items come first\n\
- Recurse into each side\n\n\
```rust\nfn quicksort<T: Ord>(items: &mut [T]) {\n    if items.len() <= 1 {\n        return;\n    }\n    \
let pivot = partition(items);\n    let (left, right) = items.split_at_mut(pivot);\n    quicksort(left);\n    \
quicksort(&mut right[1..]);\n}\n```\n\n\
| Algorithm | Average | Worst | Stable |\n| --- | --- | --- | --- |\n\
| Quicksort | n log n | n^2 | no |\n| Mergesort | n log n | n log n | yes |\n\n";
    section.repeat(6)
}

fn time(name: &str, runs: u32, mut work: impl FnMut()) -> Duration {
    work();
    let start = Instant::now();
    for _ in 0..runs {
        work();
    }
    let each = start.elapsed() / runs;
    eprintln!("{name:<44} {each:>12.1?}");
    each
}

#[test]
#[ignore]
fn waits_on_fx() {
    use crate::fx::acp::{Agent, Launch};
    let dir = std::env::var("FX_BENCH_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .canonicalize()
        .unwrap();
    smol::block_on(async {
        let clock = Instant::now();
        let (agent, _events) = Agent::start("fx", &dir, &Launch::default()).await.unwrap();
        eprintln!(
            "{:<44} {:>12.1?}",
            "start fx acp and handshake",
            clock.elapsed()
        );
        let clock = Instant::now();
        let saved = agent.list_sessions(&dir).await.unwrap();
        eprintln!(
            "{:<44} {:>12.1?}",
            format!("list {} sessions", saved.len()),
            clock.elapsed()
        );
        if let Some(first) = saved.first() {
            let clock = Instant::now();
            let _ = agent.load_session(&first.id, &dir).await;
            eprintln!("{:<44} {:>12.1?}", "load one session", clock.elapsed());
        }
        agent.stop();
        let clock = Instant::now();
        let (fresh, _events) = Agent::start("fx", &dir, &Launch::default()).await.unwrap();
        let _ = fresh.new_session(&dir, None).await;
        eprintln!(
            "{:<44} {:>12.1?}",
            "start and open a new session",
            clock.elapsed()
        );
        fresh.stop();
    });
    for (name, args) in [
        ("fx status --json", vec!["status", "--json"]),
        ("fx usage --json", vec!["usage", "--period", "7d", "--json"]),
        ("fx doctor", vec!["doctor"]),
        ("fx models (catalog)", vec!["models", "--json"]),
    ] {
        let clock = Instant::now();
        let _ = crate::fx::cli::fx(&args);
        eprintln!("{name:<44} {:>12.1?}", clock.elapsed());
    }
}

#[test]
#[ignore]
fn costs_at_startup() {
    let dir = std::env::var("FX_BENCH_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap());
    let clock = Instant::now();
    let branch = crate::host::git::branch(&dir);
    eprintln!(
        "{:<44} {:>12.1?}",
        format!("git branch ({branch:?})"),
        clock.elapsed()
    );
    let clock = Instant::now();
    let skills = crate::host::pickers::skills(&dir);
    eprintln!(
        "{:<44} {:>12.1?}",
        format!("read {} skills", skills.len()),
        clock.elapsed()
    );
    let clock = Instant::now();
    let files = crate::host::pickers::files(&dir);
    eprintln!(
        "{:<44} {:>12.1?}",
        format!("list {} files", files.len()),
        clock.elapsed()
    );
    let clock = Instant::now();
    let _ = crate::host::store::Store::load();
    eprintln!("{:<44} {:>12.1?}", "load saved state", clock.elapsed());
    let clock = Instant::now();
    let _ = crate::host::mac::user_name();
    eprintln!("{:<44} {:>12.1?}", "user name (id -F)", clock.elapsed());
}

#[test]
#[ignore]
fn costs_per_draw() {
    let text = answer_text();
    eprintln!("answer: {} bytes", text.len());
    time("markdown parse", 200, || {
        let _ = markdown::to_mdast(&text, &markdown::ParseOptions::gfm());
    });
    time("prose::answer (one turn)", 200, || {
        let _ = crate::design::prose::answer(0, &text);
    });
    time("prose::answer (40 turns)", 20, || {
        for turn in 0..40 {
            let _ = crate::design::prose::answer(turn, &text);
        }
    });

    let kinds = [
        ("  paragraphs only", "Quicksort picks a **pivot**, partitions the slice around it and recurses into both halves. It is `O(n log n)` on average.\n\n".repeat(12)),
        ("  lists only", "- Pick a pivot, often the middle element\n- Partition so smaller items come first\n- Recurse into each side\n\n".repeat(12)),
        ("  code only", "```rust\nfn quicksort<T: Ord>(items: &mut [T]) {\n    if items.len() <= 1 {\n        return;\n    }\n    let pivot = partition(items);\n    quicksort(&mut items[..pivot]);\n}\n```\n\n".repeat(6)),
        ("  tables only", "| Algorithm | Average | Worst | Stable |\n| --- | --- | --- | --- |\n| Quicksort | n log n | n^2 | no |\n| Mergesort | n log n | n log n | yes |\n\n".repeat(6)),
    ];
    for (name, text) in &kinds {
        time(name, 200, || {
            let _ = crate::design::prose::answer(0, text);
        });
    }

    let old: String = (0..200).map(|i| format!("let a{i} = {i};\n")).collect();
    let new: String = (0..200)
        .map(|i| format!("let a{i} = {};\n", if i % 9 == 0 { i + 1 } else { i }))
        .collect();
    let call = ToolCall {
        kind: "edit".into(),
        input: serde_json::json!({ "path": "/ws/a.rs", "old_string": old, "new_string": new }),
        ..ToolCall::default()
    };
    time("edit_stat (200-line edit)", 50, || {
        let _ = crate::fx::tools::edit_stat(&call);
    });
}
