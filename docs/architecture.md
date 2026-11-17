# Architecture

fx-ui is one Rust binary, `fx-desktop`. It draws a window with GPUI (through
gpui-kit) and drives the `fx` command-line tool: `fx acp` for the agent, and
plain `fx` commands for accounts, usage, MCP servers and health checks. fx owns
the model, tools, providers and permission modes; this app owns the window.

The source has no comments. Why a feature works the way it does is in
[how-it-works.md](how-it-works.md), and what the platforms underneath do that
you could not guess is in [platform.md](platform.md).

## Layers

`src/` is five folders. The first three know nothing about the app's window.

| Folder | What it holds | May import |
| --- | --- | --- |
| `fx/` | Everything the app knows about fx: the protocol, the transcript model, reading tool calls, the command line | `host` |
| `host/` | This Mac: git, the saved state file, self-update, files and skills on disk, notifications | nothing in the crate |
| `design/` | Geist tokens, the components every screen is built from, icons, markdown | nothing in the crate |
| `app/` | `FxApp`, the one GPUI entity: its state and what it does | `fx`, `host`, `design`, `views` |
| `views/` | What `FxApp` draws, as more `impl FxApp` blocks | `fx`, `host`, `design`, `app` |

`fx/`, `host/` and `design/` never import `app/` or `views/`. `fx/` builds no
UI; it uses GPUI only for `Image`, as plain image data on a turn. `app/` and
`views/` are one layer cut by concern: `app/` holds state and behaviour,
`views/` holds drawing, and both add methods to the same `FxApp`.

## fx/

| File | What it does |
| --- | --- |
| `acp.rs` | The ACP client: starts `fx acp`, sends requests, routes replies, and parses session updates into `Update` and `Event` |
| `transcript.rs` | `Thread`, `Turn` and `Item`: a session's turns, folded from the updates as they arrive or replay |
| `tools.rs` | Reads a turn's tool calls: which files a turn touched, what a step is doing, what a question asks, the diff an edit will make |
| `cli.rs` | Runs `fx` commands and reads what they print into types: status, usage, credits, doctor checks, permission rules, extra folders, skill warnings, and fx's own `~/.fx/settings.json` |
| `usage.rs` | Reads fx's usage report: totals, tokens by kind, use by model, plan limit windows |
| `mcp.rs` | MCP servers as fx lists them: their addresses, names and state |

## host/

| File | What it does |
| --- | --- |
| `git.rs` | Branch, status, diffs, staging, and the snapshot and restore behind "Restore this turn's files" |
| `store.rs` | The app's own saved state: workspaces, names, defaults |
| `update.rs` | Finds a newer release, checks who signed it, and installs it |
| `pickers.rs` | The files `@` completes and the skills `/` completes, and how matches are ranked |
| `mac.rs` | The signed-in user's first name, and notifications |
| `shell.rs` | The `PATH` that `fx` and `git` run with, read from your login shell when the app's own does not reach fx |
| `mod.rs` | `printed`: what a finished command printed, or its error text; git, the updater and the fx runner all end in it |

## design/

| File | What it does |
| --- | --- |
| `tokens.rs` | Geist colours, fonts and the two fixed widths, and how they are applied to GPUI's theme |
| `components.rs` | Icons, text, buttons, dots, cards, switches, shadows |
| `assets.rs` | The embedded icon set |
| `prose.rs` | Markdown answers: paragraphs, lists, tables and highlighted code |

`design/mod.rs` re-exports the tokens and components, so a view starts with
`use crate::design::*;`.

## app/

| File | What it does |
| --- | --- |
| `mod.rs` | `FxApp` and its fields, `new`, the session lookups, key bindings, and `Render`: the window's frame |
| `state.rs` | The data `FxApp` holds: `Session`, `Workspace`, `Pending`, `Queued`, and the enums for which menu, page, tab or dialog is open |
| `agent.rs` | The fx process: starting and restarting it, its events, the account catalog, models and options |
| `sessions.rs` | The session list: opening folders, new, select, remove, restore, rename, the split view |
| `turns.rs` | Sending a prompt, steering, the queue, stopping, answering approvals and questions, restoring a turn's files |
| `draft.rs` | The composer's draft: typing, images, and the `@` and `/` pickers |
| `window.rs` | Window-level actions: settings, the sidebar, the changes panel, updates, Esc and Return |
| `format.rs` | Names and times for people: model names, "2h ago", day headings |

## views/

| File | What it draws |
| --- | --- |
| `shell.rs` | The sidebar, the tab bar when it is closed, and the menus they open |
| `home.rs` | Home: what needs you, what is running, recent sessions; first run; fx not running |
| `thread/` | The transcript: `mod.rs` a turn and its answer, `timeline.rs` the work log, `prompts.rs` the approval and question cards |
| `composer/` | `mod.rs` the composer and its pills, `picker.rs` the `@` and `/` list, `menus.rs` permission mode and thinking, `models.rs` the model menu, `usage.rs` context and plan usage |
| `changes.rs`, `diff.rs` | The changes panel and the diff block |
| `palette.rs` | The command palette |
| `dialogs.rs` | The confirm and rename dialogs |
| `settings/` | `mod.rs` the settings frame and its state, one file per page (`models`, `behaviour`, `skills`, `usage`, `about`, `mcp`), and `rows.rs` the rows they share |

## Where a change goes

- fx prints something new, or a protocol field changes: `fx/`. Parse it into a
  type there and test it there; views should not read fx's JSON or text.
- A new colour, size or shared control: `design/`.
- New state, or something the app does: `app/`. A new screen or a new part of
  one: `views/`.
- Anything that shells out to the system (git, `open`, `osascript`): `host/`.

Tests sit beside the code they test, in a `tests` module at the end of the
file. `cargo test` runs them; the two that need a signed-in fx are ignored by
default.

`src/bench.rs` holds three ignored tests that print timings instead of
asserting: `costs_per_draw` (building a transcript's elements),
`costs_at_startup` (what each folder loads) and `waits_on_fx` (starting fx and
loading a session). Run one with
`cargo test costs_per_draw -- --ignored --nocapture` before and after a change
that is meant to make something faster.
