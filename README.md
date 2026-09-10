# fx — a desktop client for the fx coding agent

A GUI wrapper over [fx](https://fx.sh), built on [GPUIX](https://gpuix.dev) so the
whole window is drawn on the GPU by GPUI, the same renderer Zed uses.

The agent is [`libfx`](https://fx.sh/docs/lib), running in this process as a
native addon. The embedded fx core has **no** filesystem, shell, or built-in
tools — it can only do what the host hands it — so this app supplies a set of
tools scoped to one workspace directory, and puts every edit and command behind
an approval you can see before it runs.

```bash
bun install
export AI_GATEWAY_API_KEY=…   # or paste a key into the app
bun run dev
```

## What it does

- **Multiple workspaces.** A workspace is a directory. Everything the agent
  reads, edits, or runs stays inside it — paths are resolved through the real
  filesystem, so a symlink cannot walk out either.
- **Sessions.** Each workspace holds any number of conversations. History is
  saved as a libfx checkpoint, so a session resumes after a restart. The first
  prompt names the session immediately, and one short model request renames it
  from the first exchange once that turn finishes.
- **Split view.** Two panes, each on its own session, with a draggable divider.
  `⌘\` opens and closes it; the pane the keyboard talks to keeps its title at
  full brightness while the other dims.
- **Command palette.** `⌘K` over commands, workspaces, and sessions.
- **Notices.** The app's own messages — a stop reason, a catalogue that would
  not load — sit in the transcript and are the one row you can dismiss: click
  one, or *Clear notices* for a screenful. Sign-in state is not among them; it
  belongs to settings, which shows it now rather than as of an hour ago.
- **Settings.** The gear in the sidebar footer, `⌘,`, or the palette. A full
  page in place of the panes — the Gateway key, sign-ins, the model new
  sessions start on, which runtime answers a turn, and what skills and MCP
  servers are loaded. It reads from disk each
  time it opens, because a sign-in is a file rather than anything state can
  derive. Opening a session is how you leave it.
- **Approvals.** Writes and commands stop and ask, with the diff or the exact
  command line in front of you. The three answers mirror fx's own prompt: yes,
  yes and don't ask again, no.
- **Permission modes.** `ask`, `auto`, and `full access`, mapped from
  [fx's modes](https://fx.sh/docs/configure-fx/permissions). `auto` runs edits
  and still asks before a command.
- **Grok and Codex sign-in.** Settings signs in to either with a PKCE flow
  against `auth.x.ai` / `auth.openai.com`, and offers that subscription's own
  models. The addon libfx loads is built Gateway-only, so the routing happens in
  the `fetch` the host supplies: [src/agent/providers.ts](src/agent/providers.ts) intercepts
  the one model request the core makes, translates it into an OpenAI Responses
  call, and translates the answer back. The session's `provider` decides where a
  turn goes; the model id is the provider's own. Both sign-ins have exacting,
  undocumented requirements — see [PLATFORM.md](PLATFORM.md).
- **The fx CLI as the core.** *Run through the fx CLI* points `createFxAgent`
  at `fx acp` through its `runtimeFactory` — the same core built with every
  provider, answering to whatever `fx login` stored in `~/.fx`. Useful for a
  sign-in this app does not carry. Tools, approvals, skills, MCP and
  checkpoints ride on the same ACP messages either way; transport diagnostics
  are lost, since the CLI makes its own requests. Needs fx 0.0.7 or newer.
- **Model picker.** Whatever can actually answer: a signed-in subscription's
  models, plus the Gateway's when there is a key — the Gateway catalogue is not
  fetched without one, since none of it could be spent. Subscription catalogues
  are read at startup and the whole list is saved with the rest of the state, so
  a relaunch opens the picker on what it had rather than on nothing while three
  requests land. Switching a
  model checkpoints the conversation and restores it into a new agent, because
  the model is a creation option.
- **What a new session starts on.** *New sessions start on* in settings, if you
  have set it: an explicit choice outranks anything inherited, and every new
  session opens on it. Left on *Automatic*, a session follows the last one in
  that workspace — model, provider, effort and fast tier together, since a
  model id without the provider that serves it routes nowhere. The first
  session in a workspace has nothing to follow, so it opens on a signed-in
  subscription's own model — the first its catalogue lists, which is the first
  the picker shows — and only falls back to `poolside/laguna-s-2.1-free` on the
  Gateway when no subscription is signed in. Neither provider publishes which
  model it considers default, so the order it lists them in is the only thing
  to go on. Whichever rule applies, a model nothing could answer with is
  skipped: a Gateway model with no key in hand gives way to a subscription.
- **Reasoning effort.** Every provider publishes the levels a model accepts and
  which is default — Grok's `reasoning_efforts`, Codex's
  `supported_reasoning_levels`, and they differ per model. The composer's
  slider offers exactly those, and the shim sends the choice as
  `reasoning: { effort }`. Changing it restarts the conversation from its
  checkpoint, the same as changing the model. The chip in the composer footer
  opens the dial: a pill track with a dot per level and a round handle, the
  shape Claude Code uses. A pill and a circle also sidestep GPUI's refusal to
  clip children to a parent's radius, which a fill running to the track's edge
  cannot.
- **Fast tier.** Codex sells a faster service tier on some of its models, and
  says how much faster in its own words — 2x on GPT-6-Astra, 1.5x on the
  GPT-5.6 line, nothing at all on Daybreak Blue or Spark. The composer shows
  the toggle only where the model has one, labelled and explained with the
  provider's own text, and the choice ships as `service_tier: "priority"`.
  Grok publishes no such tier, so nothing is offered there.
- **Context meter.** The ring at the end of the composer footer shows how full
  the model's context window is: the last request's input plus what it wrote,
  against the window the model's catalogue publishes. Click it for the split
  across messages, system prompt, tools, MCP tools, skills and free space. The
  total is the provider's own count, taken on every request. The split is an
  estimate at four characters a token, and whatever it leaves over counts as
  messages. It replaces a running count of every token billed, which grew with
  each tool call and said nothing about how close the conversation was to the
  limit.
- **Skills.** fx's own live in `.fx/skills` in the workspace and in
  `~/.fx-ui/skills`, and go into the prompt whole. Skills written for Claude
  Code and Codex are picked up too: `.claude/skills/<name>/SKILL.md` and
  `.agents/skills/<name>/SKILL.md`, in the workspace and in your home folder.
  They show in the `/` menu, and the prompt carries a list of them: each
  name with its description, trimmed evenly so the whole list stays within
  16,000 characters however many there are. A skill's full text is sent only
  when you invoke it or the model reads it with the `skill` tool. There can be
  hundreds of them, and all of that text would fill the context window. A name
  in the workspace beats the same name at home, and `.fx` beats both.
- **MCP servers, local and remote.** Settings adds one from a single line — a
  `https://…` URL for a remote server, or the command line that starts a local
  one — and removing it there takes it out of the running sessions as well.
  Either way it lands in `~/.fx-ui/mcp.json`, which stays hand-editable and
  keeps whatever else you have in it. A remote server that
  answers `401` is not a failed load: it becomes a row in settings with a
  **Sign in** button, and the rest of the session carries on without it. Signing
  in runs the MCP authorization flow — the `WWW-Authenticate` challenge names
  the protected-resource metadata, that names the authorization server, this app
  registers itself there dynamically, and a PKCE round trip through your browser
  returns a token bound to that one server by `resource`. Tokens live in
  `~/.fx-ui/mcp-auth.json` at mode 600 and refresh themselves. Nothing opens a
  browser mid-turn: a server that needs you appears as a notice, and you sign in
  when you choose to.
- **Attach an image.** ⌘V pastes one from the clipboard — a screenshot or a
  copied image — through the patched gpuix build described below. **+** →
  *Paste image* reads the clipboard directly, which also takes an image file
  copied in Finder whatever text that copy carries; *Choose images…* picks them
  from disk, and `@screenshot.png` mentions one in the workspace. Clipboard text
  still pastes as text. Attached images sit as thumbnails above the prompt until it is sent,
  then under your message, where a click opens one in Preview. Each is copied
  into `~/.fx-ui/attachments`, so the conversation keeps it when the original
  moves. libfx cannot carry an image in a prompt at all — its SDK rejects image
  prompt blocks outright, and a tool result's images are dropped before they
  leave the core — so an image is handed over as a path with an instruction to
  look at it, and `vision` reads it on the session's own credential. `vision`
  reaches the attachments folder and, as before, nothing else outside the
  workspace.
- **Background commands.** A command started with `shell` background true used
  to run unseen until the session closed. The composer now shows how many are
  live and stops any of them, and the row disappears when one exits on its own.
  Each runs in its own process group, so stopping one ends everything it
  started, and quitting fx stops them all.
- **Sessions keep going when you switch.** A turn belongs to its session, not
  the pane showing it, so switching sessions or panes leaves it running. The
  sidebar dot shows it working, and a shield or a speech bubble in its place
  means it is waiting on you, for an approval or an answer. A turn does not
  survive quitting the app: the conversation picks up from the last finished
  turn.
- **Undo the last write.** `⌘K` → *Undo the edit to …* puts a file back as it
  was, or deletes it if that write created it. It refuses when the file has
  changed since, rather than throwing the newer change away. The last twenty
  writes of a session are remembered.
- **Project instructions.** `AGENTS.md` (or `CLAUDE.md`) at the workspace root
  is loaded into the system instructions, the way the fx CLI does it.

## Tools the agent gets

The set fx documents at [capabilities/tools](https://fx.sh/docs/capabilities/tools),
plus git.

| Area | Tools | Approval |
| --- | --- | --- |
| Find and read | `glob_files`, `grep_files`, `read_file`, `list_files` | none, inside the workspace |
| Write and edit | `write_file`, `edit_file` | asks, and shows the unified diff |
| Commands | `shell` — `run`, `interact`, `stop` | asks every time, and grants are per-program |
| Web | `web_search`, `web_fetch` | asks; `web_fetch` grants per host |
| Images | `vision` | none |
| Skills | `skill`, `install_skill` | `install_skill` asks |
| Subagents | `subagent` | inherits the parent's approvals |
| MCP | `capability_search`, `mcp_features`, `mcp_select_tool`, plus every connected server tool | a server's own tools ask, and grants are per server |
| Interaction | `ask_user_question`, `read_tool_result` | none |
| Git | `git_status`, `git_diff`, `git_log` | none — they only read |

`subagent` and `vision` run on whatever credential the session runs on. Every
model whose catalogue reports an `image` input modality can read one — which is
both providers' whole line except Codex Spark — so `vision` sends it as an
`input_image` part on the subscription and only falls back to the Gateway when
the session has no provider, or its model takes text alone.

Search works the same way, and its catalogue flag is the deciding one. Grok and
Codex both run web search on their own side, so a session on one of those models
searches through the provider: the host `web_search` is withdrawn, the Gateway
key stops mattering, and every query and opened page becomes its own row in the
transcript. Grok also gets its X search tool, so it can search posts and users
on X, and each of those searches shows as an `x_search` row with its query.
Those rows are a report, not a gate — a search that runs inside the
response cannot be approved before it happens, which is the one place this app
shows a tool it could not stop. A Gateway session keeps the host tool, Exa, and
the approval.

A result larger than 24k is kept whole and returned as a preview plus a handle;
`read_tool_result` reads a byte range or searches it. Nothing is truncated away.

## Motion

Three animations, and the restraint is the point: this is a keyboard-driven
tool, and motion on anything reached hundreds of times a day reads as lag. The
command palette, the `@` picker and every transcript row stay instant on
purpose.

- The sidebar's width, collapsing and expanding, and the folded sidebar peeking
  out over the panes — the same 160–200ms ease-out, because they are the same
  surface arriving the same way.
- The effort dial's handle and trail, 150ms, easing to the level you picked
  rather than jumping to it. Suppressed to zero while dragging, since a
  direct-manipulation gesture must track the pointer exactly.
- The braille mark on the empty screens, fading in over 300ms. The one place
  with a delight budget, and it is spent once.

## Design

The palette and the type are fx.sh's own: `--background: #000`,
`--foreground: #ededed`, `--border: #262626`, `--primary: #ededed` on black, and
one monospace family for the entire interface. There is no accent hue in that
system, so there is none here — the only white edge on screen is the approval
card that is blocking the turn.

`<markdown>`, `<code>` and `<diff>` are GPUI native elements: the syntax
highlighting and the diff are computed in Rust, and the theme is passed to them
as props.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Start the app with hot remount |
| `bun run build` | Compile a standalone binary into `dist/fx` |
| `bun run test` | Drive the app through the GPU test renderer with Vitest |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run screenshot` | Drive the real window and write a PNG |

## The patched gpuix binary

The app runs its own build of `@gpuix/native` 0.7.0 with three changes
(`patches/gpuix-native.diff`). Its text field draws the caret at the height of
its own font rather than the full 26px row, so a wrapped draft does not get a
caret twice the size of its text. gpuix's text field binds ⌘V to its own paste and
swallows the key even when the clipboard holds only an image; now, when there is
no text to paste, the key carries on to `onKeyDown`. And the renderer gains
`promptForPaths(elementId, multiple)`, which opens GPUI's own macOS file panel
and reports the chosen paths as a `change` event on that element, so choosing
images no longer waits on an `osascript` process to start and build a panel.
`vendor/gpuix-native.darwin-arm64.node` is that build, and `postinstall` copies
it next to the package's loader, which tries that path before the published
binary. It is built with GPUI's `runtime_shaders` because this machine's Xcode
has no Metal toolchain, so its shaders compile when the window opens rather than
at build time. It is linked against the macOS 26.5 SDK, as the published binary
is: macOS 27 refuses an addon linked against its own beta SDK, and the loader
then falls back to the published binary without a word, which the ⌘V test is
there to catch. To rebuild it:

```sh
git clone https://github.com/remorses/gpuix && cd gpuix
git checkout @gpuix/native@0.7.0
git submodule update --init --depth 1 zed
git apply ../fx-ui/patches/gpuix-native.diff
cd packages/native
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export SDKROOT=$DEVELOPER_DIR/SDKs/MacOSX26.5.sdk
rustup run 1.97.1 cargo build --release --features gpui_platform/runtime_shaders
cp target/release/libgpuix_native.dylib ../../../fx-ui/vendor/gpuix-native.darwin-arm64.node
```

Drop the feature once `xcodebuild -downloadComponent MetalToolchain` has run, to
match the published build exactly. Upgrading gpuix means redoing this, or
deleting all of it if upstream takes the change.

## Files

```
app.tsx              the shell: panes, split view, window shortcuts
libfx.d.ts           types for the part of libfx this app calls
src/store.ts         state, persistence, and the actions that mutate it

src/agent/           what answers a turn
  agent.ts           one libfx Agent per session, streaming into the store
  backing.ts         what backs a session: its key, runtime, route and search
  credentials.ts     keys, sign-ins, and the model list
  oauth.ts           PKCE sign-in to Grok and Codex, and the tokens it stores
  providers.ts       the request shim that routes a turn to a subscription
  cli.ts             the fx binary as the core, for the sign-in it owns

src/tools/           what the agent can do
  index.ts           the set handed to the core, and this folder's surface
  kit.ts             defineTool: the transcript row, the retained-result store
  approvals.ts       the approval and question brokers
  edits.ts           what each write replaced, so it can be put back
  paths.ts           path confinement, the file index, globs
  files.ts           list, read, grep, glob, write, edit
  shell.ts           commands, foreground and background
  web.ts             search, fetch, vision
  vcs.ts             git status, diff, log
  agents.ts          subagent, read_tool_result, ask_user_question
  extend.ts          skills and MCP

src/workspace/       the machine a workspace sits on
  files.ts           @-mentions and file ranking
  git.ts             git for the pane header and the tools
  images.ts          pasting and choosing images, and keeping them
  run.ts             spawning a process and capturing it
  skills.ts          skills from .fx, .claude and .agents
  mcp/               connected MCP servers
    index.ts         config to connected tools, and the pool that shares them
    config.ts        ~/.fx-ui/mcp.json: a command, or a url
    stdio.ts         a server this app spawns
    http.ts          a server it reaches over Streamable HTTP
    auth.ts          the MCP authorization flow, and the tokens it stores

src/ui/              primitives
  theme.ts           design tokens, taken from fx.sh's stylesheet
  ui.tsx             buttons, labels, tooltips, the effort dial
  icons.tsx          the icon set
  hooks.ts           useMountEffect

src/views/           screens
  sidebar.tsx        workspaces and sessions
  palette.tsx        command palette and dialogs
  settings.tsx       the settings page
  models.tsx         choosing a model, in the composer and in settings
  transcript/        the conversation
    index.tsx        the list, its scroll fades, and which row renders what
    shared.tsx       the column, the gutter, and holding the tail while a row grows
    messages.tsx     what the user and the model said
    tool.tsx         one tool call, its timing, and its output
    blocking.tsx     the two rows that stop the turn: approval and question
  composer/          the prompt line
    index.tsx        the draft, the @ and / triggers, send and stop
    pickers.tsx      model, reasoning effort, fast tier, permission mode
    context.tsx      the context meter and what fills the window
    tokens.tsx       the @ and / suggestion list
    shared.ts        substring ranking, and how many suggestions to show
```

State lives in `~/.fx-ui`: `state.json` (mode 600, since it can hold an API key),
`providers.json` and `mcp-auth.json` (also 600 — OAuth tokens, for the two
subscriptions and for each remote MCP server), `mcp.json` for the servers
themselves, and one checkpoint per session. `FX_UI_HOME` moves that directory, which is what
the tests and the screenshot script use so they never touch your real
workspaces. While it is set, the `.claude` and `.agents` skill folders are
looked for inside it instead of in your home folder. A session you leave
without sending anything is dropped, not kept.

## Notes on the platform

The code carries no comments. What GPUIX, libfx, Grok and Codex do that you
could not guess from reading — every one of it measured, and every one a silent
failure if you get it wrong — is in [PLATFORM.md](PLATFORM.md). Read it before
changing rendering, the request shim, or either sign-in.

This app is desktop-only. It needs the filesystem, a shell, and the native
libfx addon, so the browser target from the GPUIX starter was removed.
