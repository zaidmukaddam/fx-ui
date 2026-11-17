# Platform notes

Facts about GPUI, gpui-kit, macOS, Finder, git, the fx CLI and the Agent Client
Protocol that this app is built around. Each one was measured, against the
version named where there is one. The source carries no comments, so this is
where the knowledge lives. Why the app works the way it does is in
[how-it-works.md](how-it-works.md).

## GPUI and gpui-kit

### A window draws nothing until the app has been active once

A GPUI window opened by an app that has never been active stays blank. The app
calls `cx.activate(true)` before it opens its window.

### Focus left on a field that is not drawn makes every shortcut miss

While focus sits on a field that is not in the tree, no shortcut reaches a
handler. The app keeps focus on the composer when it shows and on a handle on
the root otherwise. The palette and
the rename dialog focus their own fields, which are not drawn yet on the pass
that opens them, so focus is left alone while they are up.

### GPUI cannot blur what is behind an element

There is no backdrop blur. The thread therefore fades into the panel's ground
as it nears the composer, through a 56px gradient to 86% opacity, instead of
sitting behind a blurred composer.

### A container's rounded corners do not clip its children

A header with a background inside a rounded, bordered card must round its own
top corners. The files card has radius 12 with a
1px border, so its header rounds its top at 11. The approval card's diff block
has radius 8, so its header rounds at 7 and the diff below it rounds its bottom
at 7.

### The system font is drawn in its regular weight only

A Mac without Apple's SF Pro fonts installed falls back to `.SystemUIFont`, and
GPUI can only draw the system font in its regular weight. Medium and semibold
text loses its weight on such a Mac. Where SF Pro is installed the app uses SF
Pro Text and SF Pro Display by name, which have all their weights.

### The runs of a `StyledText` must add up to the length of its text

If the lengths of the text runs do not sum to the length of the text, the text
element panics. The test `inline_runs_cover_the_text_and_keep_links` holds this
for the markdown renderer's lines.

### A capture-phase mouse-down listener runs before anything inside the element

`capture_any_mouse_down` sees a press before the element's children do. With
`stop_propagation`, a click in the thread shown beside the open one only ever
means "work in this one" and never reaches the rows under it.

### gpui-kit's text field binds ↑, ↓, Tab and Esc itself

The actions are `input::MoveUp`, `input::MoveDown`, `input::IndentInline` and
`input::Escape`. For the `/` and `@` list to get those keys while it is open,
the composer card handles them in the capture phase with `capture_action`,
before the field does. ↑ and ↓ call `picker_step`. Tab and Esc call
`cx.stop_propagation()` only when a picker is open, so otherwise the field
still receives them.

### `TextareaState::set_value` puts the caret at the start of a multi-line value

Setting a value that has more than one line leaves the caret before the first
character. `set_draft` moves it to the end, using the line count and the UTF-16
column of the last line, so typing carries on from there.

### gpui-kit's text field pads its own text 10px across and 8px down

The composer wraps the field in a div with margins of -4px at the sides, -8px
at the top and -4px at the bottom, so the first line starts 16px in and 14px
down, as drawn in the design, with the toolbar 8px under two lines of text.

### gpui-kit's text field and markdown view draw icons of their own

The app's asset source must therefore fall back to `gpui_kit::assets::Assets`
for every path it does not serve itself.

### gpui-kit's markdown view cannot be styled as far as the design needs

The app does not use the stock view for fx's answers. It lays the blocks out
itself from the parsed markdown tree, the `markdown` crate's mdast with GFM
options.

### Markdown without MDX never fails to parse

The `markdown` crate returns a tree for any input when MDX is off. `render`
still falls back to the source as plain text if it does fail.

## macOS and Finder

### An app opened from Finder gets the system `PATH`, not your shell's

launchd starts it with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Measured on
2026-11-17 by opening the packaged app with an empty environment: it started no
fx process, because fx lives in `~/.local/bin`. Launching from a terminal hides
this, since the app then inherits the terminal's `PATH`.

### A Developer ID signature seals the bundle around the binary

A binary signed inside `fx.app` is killed at launch (exit 137) when copied into
a bundle with another `Info.plist`; the linker's ad hoc signature on a plain
`cargo build` has no such seal. Test builds go into another bundle unsigned.

The Finder facts below were measured on macOS 27 on 2026-11-16 with throwaway
disk images.

### SF Pro has no ⏎

SF Pro lacks U+23CE, and Geist Mono has it. The root sets Geist Mono as a font
fallback so every Return hint is the design's glyph instead of the system's ↵.

### The traffic lights take the left of the top row

The traffic lights sit at the left of the sidebar's 48px top row, so the row
starts 80px in. The fx mark follows them and the sidebar toggle closes the row.
The tab bar, shown when the sidebar is closed, starts 92px in for the same
reason.

### The executable sits three folders inside the app bundle

The binary is at `…/fx.app/Contents/MacOS/fx-desktop`, so the bundle is three
parents up from the executable. The app counts as bundled, and so able to
update itself, only when that folder's extension is `app`.

### `open -R <path>` shows a file in Finder with it selected

`reveal` uses it.

### Finder draws icon names in black whenever the window has a background picture

It does so in light and dark mode alike. Setting the stored background colour
to black in the `.DS_Store` (`icvp` `backgroundColorRed/Green/Blue` = 0 with
`backgroundType` 2) does not change that. On a black picture the names are
invisible, so the install window draws its own names into the background, about
20pt below Finder's.

### macOS draws the fx icon with a hairline edge

The app icon is a black rounded square, but the hairline keeps it visible on a
black window without a light tile behind it.

### Finder plays an animated image set as a window's background picture

An animated GIF plays but is 1x only. An animated PNG (APNG) written with
ImageIO at 1280x720 pixels and 144 dpi plays too and is drawn at 640x360
points, so it is sharp on Retina. The install window's blinking cursor is such
an APNG.

## git

### `git add -A` into an empty index lets an ignore rule hide a tracked file

A file that is tracked but matches an ignore rule would be left out of a tree
built from an empty index. The scratch index a snapshot uses is therefore
seeded with `git read-tree HEAD` first. A repository with no commit yet has
nothing to seed from, so that step's failure is ignored.

### `git diff --name-status -z` is a status, NUL, a path, NUL, and so on

`--no-renames` keeps every entry to one path. Restoring a turn's files reads
the difference between its two snapshots this way, taking the fields in pairs.

### `git diff --numstat -z` writes a rename as three fields

A changed file is one record, `added<TAB>removed<TAB>path`, ended by NUL. A
renamed file's record has an empty path, and the old and new paths follow as
two more NUL-ended fields. Without `-z` the path reads `old => new`, which
matches neither name, so a staged rename showed `+0 −0`. `parse_numstat` reads
the `-z` form and files the counts under the new name. A binary file prints `-`
for both counts and is read as 0 and 0.

### A hunk header reads `@@ -a,b +c,d @@ heading`

`a` and `c` are the first old and new line numbers, which is where the diff
view's line numbers start. Everything before the first hunk is the
`diff --git` / `index` / `---` / `+++` header and is skipped.

## The fx CLI

### What fx takes, measured

On an M-series Mac with fx 0.0.17, in November 2026:

| What | Time |
| --- | --- |
| Start `fx acp` and finish the handshake | 0.75 to 0.95 s |
| `session/list` for a folder with 18 sessions | 3 ms |
| `session/load` of a short saved session | 2.4 s |
| Start a process and open a new session | 0.75 s |
| `fx status --json` | 25 ms |
| `fx usage --json` | 240 ms |
| `fx models --json` | 490 ms |
| `fx doctor` | 600 ms |

A running `fx acp` process holds about 12 MB. Opening a saved session cold is
therefore a little over three seconds of fx's own time, which is why the app
keeps recent sessions running and shows a stopped session's last transcript
while it reloads. `cargo test waits_on_fx -- --ignored --nocapture` measures
these again; set `FX_BENCH_DIR` to a folder that has sessions.

### fx moves a session's "updated" time when its process ends on its own

An `fx acp` process that sees its input close saves its session as it exits,
and `fx sessions` then reports it as updated just now. A process that is
killed does not. The app kills the processes of idle sessions, when it puts one
down and when it quits, so opening a session to read it does not reorder the
list.

### An animation redraws every view above it, every frame

`with_animation` asks for the next frame each time it is drawn, and a frame
draws the root view again, with layout for everything in it. One 12px spinner
therefore costs a full-window layout at the display's refresh rate. GPUI only
skips a subtree when it is a separate cached view that was not notified, and a
view is notified whenever something animates inside it. This app has one view,
so it drives its spinner from a timer at 30 frames a second instead.

### A window that is fully covered is not drawn

macOS stops delivering frames to it, so the app's CPU drops to almost nothing
and a profiler shows only the run loop. Profile with the window visible.

### A scroll position can be past the content until layout

`ScrollHandle::offset` read while building a frame is whatever the last scroll
event asked for. It is only held to the content's limits during layout, so
anything that places things from it before then has to clamp it against
`max_offset` itself.

### One `fx acp` process keeps one session live

Opening a second session in the same process makes fx refuse the first with
"Session is not active". The app runs one process per session. An ignored live
test, `live_accounts_run_side_by_side`, fails with "fx now keeps two sessions
live in one process" if fx ever lifts the limit.

### Changing account or mode inside a running process rewrites fx's saved default

Switching account in a process changes the default for everything else, and
setting the mode on a session with `session/set_config_option` saves it into
fx's settings, so the fx CLI changes too. The app passes all three at launch,
as `fx acp --permission-mode <mode> --provider <provider> --model <model>`,
where they hold for that process alone. It reads each account's models with a
short-lived process per account for the same reason.

### A key in the environment outranks the stored sign-in

With `AI_GATEWAY_API_KEY` set, fx uses it over the stored sign-in, and the turn
comes back refused. The app removes that variable when it spawns `fx acp`,
because Settings owns credentials, not the shell the app was launched from.

### A session that never gets a prompt is not saved

So the app can open one in each account's process just to read its model list,
and nothing is left in fx's session list.

### An account started without a model lists the default account's model too

Started for an account without a model of its own, fx puts the default
account's model in that account's list. The app removes it.

### An "always allow" lasts until the session's fx process closes

fx has no list of what it granted, and it takes a grant back only by starting
the session over. So the app keeps its own list, and forgetting the grants
means reloading the session in a new process. That is why the "Allowed in this
session" footer of the mode menu has a single "Forget all" and no "Forget" on
each row.

### `auto` is fx's own permission mode

A safety review of each action decides in your place. The app describes it as
"A safety review decides instead of you".

### `fast` and `ultrafast` are separate session options

fx offers each only where the model has it, and turns one off itself when the
other goes on. The app does not enforce the exclusion.

### The `effort` option lists its choices highest first

Grok's session gives `default, xhigh, high, medium, low`. The order of the list
says nothing about which level is least, so the app sorts by meaning instead.
The ids seen are `default`/`auto`, `none`/`off`, `minimal`, `low`, `medium`,
`high` and `xhigh`/`max`.

### A gateway model id names its maker before a slash

AI Gateway ids are `maker/model`, such as `anthropic/...` or `zai/...`. A
provider's own models, for example Codex's, have ids without a `/`. The model
menu shows the prefix as the maker.

### fx writes UTC timestamps like `2026-11-15T14:39:20Z`

`epoch` reads the first 19 characters with chrono, as UTC, and gives seconds
since 1970. A space in place of the `T` is accepted too.

### fx summarises older turns at `auto_compact_percent`

The setting is in `~/.fx/settings.json`. It is 80 when the profile does not set
it.

### `fx usage --json` reports Codex and Grok in different shapes

The report has a `codex` and a `grok` key. Codex reports `codex.limits`, a list
of limits each with up to two windows, `primary` and `secondary`, each carrying
`used_percent`, `window_seconds` and `resets_at_ms`. Grok reports a single
window at `grok` with `used_percent`, `resets_at_ms` and a named `period`
(`daily`, `monthly`, otherwise weekly) instead of a length in seconds. An
account billed by use reports neither (both null), so it has no windows.

### `fx usage --json` exits 1 when the refresh fails and still prints the report

The report then carries `status: failed` and a `reason`. `usage_report` reads
stdout whatever the exit code. The command reports on fx's own default account
unless the `FX_PROVIDER` environment variable names another account.

### `fx doctor` prints one check per line behind a bracketed level

A line reads `[ok] auth: stored API key …`. `doctor_checks` reads each as
(level, check, detail), keeping only the levels `ok`, `warn`, `fail` and
`error`.

### `fx doctor` names fewer skipped skills than the turn notice

It also words them differently: a non-ok `skills` check whose detail reads
`<path> was skipped: <why>`. The Skills page uses it only until a turn has run.

### `fx credits` prints the balance after `balance=`

A line reads `[credits] balance=3.3071438303`. The number is the AI Gateway
balance in dollars.

### `fx permissions` prints a header, then one rule per line

With no rules the output is `[permissions] configured rules: (none)`. With
rules, they follow one per line. The Behaviour page drops the `[permissions]`
prefix, `mode=` lines, lines ending in `(none)` and header lines ending in `:`.

### `fx mcp list --json` carries no address

Each entry has `name`, `file`, `source`, `transport` and `status`. The app
reads the address itself from `mcpServers[name]` in the config file the entry's
`file` names, because asking fx to show a server would connect to it.

### `fx mcp show NAME --json` connects to the server

It reports the server's status and tools. For a remote server that answers at
once. For a local one it means starting the server's process, so the app only
asks a local server when you press "Check now".

### `fx mcp show` exits non-zero for a server it could not reach, and still prints

Either way the JSON is on stdout or nowhere. The app reads stdout whatever the
exit code (`fx_json`), so a server fx could not reach still reaches the page as
"Failed" with fx's reason under its name. `fx usage --json` has the same habit
and is read the same way.

### `fx mcp add` writes a remote and a local server in different shapes

As of fx 0.0.17, a remote server is written as
`{ "type": "http", "url": "https://…" }` and a local one as
`{ "command": "npx", "args": ["-y", "pkg", "/tmp"] }`. The address test uses
entries in exactly this shape.

## The ACP protocol as fx speaks it

### Messages are newline-delimited JSON-RPC 2.0 over stdin and stdout

`fx acp` speaks the Agent Client Protocol over the fx CLI's stdin and stdout,
one JSON message per line.

### An ACP client gets none of fx's MCP servers unless it asks

The servers set up in fx (`~/.fx/mcp.json`) are not given to an ACP client by
default. The app asks by sending
`"_meta": { "fx": { "profileMcpServers": true } }` with `session/new` and
`session/load`, and an empty `mcpServers` array, so sessions use the same
servers the fx CLI does.

### An image is an inline Base64 block of up to 3.75 MiB

A prompt block carrying an image is
`{ "type": "image", "mimeType": <mime>, "data": <standard Base64> }`. fx takes
inline images up to 3.75 MiB each and reads PNG, JPEG, GIF and WebP. It sends
images back the same way, as Base64 in `content.data`.

### `session/list` returns one workspace's saved sessions, newest first

It takes the workspace `cwd`.

### `session/load` replays the history before it returns

The history arrives as `session/update` notifications, and only then does the
`session/load` request return. After it returns nothing in the thread is still
running, so the app gives every turn without an end one.

### Replayed history echoes every prompt, and a live turn echoes only steering

Replayed history sends each prompt as a `user_message_chunk`. A live turn sends
one only for what you say while it runs, and only once the model has read it.
Your own opening prompt is not echoed. That echo is how the app knows steering
text no longer waits.

### fx marks where each image went with a line of its own

The prompt text carries "[Image #1]", "[Image #2]" and so on, each on its own
line. The image itself follows as its own `user_message_chunk` of type `image`,
as fx 0.0.17 replays it, so the app drops the marker lines.

### Steering is a `session/prompt` with `_meta.fx.steer`

A `session/prompt` with `"_meta": { "fx": { "steer": true } }` sent while a
turn runs is handed to the model at the next safe point without stopping what
the turn is doing, and the request returns when the turn does. It is text only.
A result with `_meta.fx.steering == "dropped"` means the turn was stopped
first. An error result means the turn had already ended.

### A retry arrives in a `session_info_update` under `_meta.fx.modelResponseRecovery`

It carries `state`, `attempt` and `message`. The key is present and `null` once
the retrying is over. A `session_info_update` without that key carries a
`title` instead. These are the shapes fx 0.0.17 documents for ACP clients.

### fx opens a turn with diagnostics sent as if the model had said them

They arrive as `agent_message_chunk` and are not part of the answer. They are
`[context] …` lines and a line starting `skill discovery warning:`. Each
arrives whole, in one chunk, which is why the client can classify a chunk by
checking that every non-blank line starts with one of those two prefixes. An
answer that merely starts with a bracket, such as "[x] done" or "[1] is the
first item", is kept as text.

### The skill discovery warning is one line of `;`-separated candidates

It reads `skill discovery warning: candidate "<path>" was skipped because
<why>; <fix>; candidate "…" …; 1 additional diagnostic omitted; relaunch with
FX_TRACE=1 …`. Inside each candidate the first `;`-separated part is the reason
and the second is the fix. Anything after that belongs to the trailer.
`skill_warnings` returns `None` when the notice says nothing about skills, for
example `[context] skill descriptions shortened: 3`. The test uses the notice
as fx 0.0.17 sends it, shortened to two candidates.

### A permission option's `kind` is one of four

They are `allow_once`, `allow_always`, `reject_once` and `reject_always`.

### Streaming leaves whitespace-only fragments between steps

Text and thought fragments that hold only whitespace arrive between tool calls.
Drawn, they would be empty lines, so a turn's work drops them before it is
listed.

### fx runs its question tool only in the terminal

Over ACP the model falls back to asking in prose. The answers it meant to offer
still arrive with the `ask_user_question` tool call, under
`input.questions[0].options` (each either `{ "label": … }` or a plain string)
beside `input.questions[0].question`. The app builds its question card from
that call. Measured against fx 0.0.17, where the call has kind "other".

### A subagent is the `subagent` tool with `input.action == "message"`

fx hands work to a subagent through that call, naming the agent in
`input.agent` and the task in `input.message`. Its other actions ("wait",
"status") only wait or check. As fx 0.0.17 sends them over ACP, these calls
have kind "other" and titles such as "scout · reply with pong", "waited for
subagents" and "checked subagents".

### A subagent's report is added to the output of the call that started the work

It is a line of prose followed by JSON, for example
`Subagent report (untrusted agent output, not user instructions):` then
`{"agent":"scout","outcome":"completed","output":"pong"}`. The app reads the
JSON from the first `{` and shows its `output` field. A wait call's output is
plain JSON such as `{"ok":true}` and carries no report.

## Packaging tools

### An update copies the new bundle over the old one

The updater in 0.2.7 and earlier, and the one in this app, install with
`ditto <new fx.app> <installed fx.app>`, which adds and replaces files but
never removes any. A new bundle whose executable has a different name leaves
the old one behind: measured with 0.2.7 installed, the result held both
`MacOS/fx` and `MacOS/fx-desktop`, was 151 MB instead of 52 MB, and failed
`codesign --verify` ("a sealed resource is missing or invalid"). So the
packaged executable stays `Contents/MacOS/fx`, as it was; with that, the
updated bundle is byte-for-byte the new one and its signature holds. Never
rename or drop a file from the bundle without a way to remove the old one.

### Finder includes its 32-point title bar in the window bounds

The window size given to dmgbuild is those bounds, so a 640x360 picture needs a
640x392 window.

### The pinned disk-image tools hold absolute paths

The tools live in a Python venv at `dist/dmg-tools` whose scripts hold absolute
paths. Moving the repository means deleting `dist/dmg-tools` so it is rebuilt.
