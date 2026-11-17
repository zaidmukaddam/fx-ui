# How fx-ui works

The long version of the [README](../README.md): what each feature does, and why
it works the way it does. What the platforms underneath do that you could not
guess is in [platform.md](platform.md).

## The app

fx is a desktop app for the fx coding agent, drawn with GPUI. The agent is
`fx acp`, the fx CLI speaking the Agent Client Protocol over stdio. fx owns the
model, the tools, the providers and the permission modes. This app owns the
window.

The app is one `fx acp` process, the workspaces you opened, and every session
in them. One entity, `FxApp`, owns all of it, so an ACP event has exactly one
place to land and every view reads the same state. The state and what changes
it sit in one module. The screens are further `impl FxApp` blocks, one per
surface: the shell (titlebar, sidebar, header), home, the composer, the thread,
the changes panel, the palette and settings.

`FxApp.folder` is the chosen workspace and `FxApp.active` is the open session,
as a pair of workspace index and session index. A folder with no session open
is home: `folder` is set and `active` is `None`. `show` sets the two together.
`Page` says what fills the inset panel: a session or Settings.

### The command line

```
fx-desktop [folder] [--prompt "<text>"]
```

The folder is added to the saved workspaces. The prompt is sent once a session
is ready. With no folder and none saved, the app opens on first run.

The name the app calls you by is the first name on the Mac account ("Zaid"),
read once from `id -F`. It falls back to `$USER` and then to "You".

### Finding fx

The app runs `fx` and `git` by name, with the `PATH` from `host::shell::path`.
Started from Finder or the Dock, an app gets only `/usr/bin:/bin:/usr/sbin:/sbin`,
where neither the fx installer's `~/.local/bin` nor Homebrew's folders are, so
every launch from Finder used to fail with "could not start `fx acp`". When fx
is not on the inherited `PATH`, the app asks your login shell for its `PATH`
(`$SHELL -l -i -c printenv PATH`, given five seconds) and adds
`~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` if they are missing.
This runs once, on a thread started first thing in `main`, so it is usually
done before the window is. `FX_BINARY` still names fx exactly when set.

When fx cannot start, home says why. If fx is not on that `PATH` at all, it
shows the install command (`curl -fsSL https://fx.sh/setup.sh | bash`) with a
Copy button, before the first-run screen. If fx exits because no account is
signed in (its message mentions `fx login`), it says "No account connected"
and offers the Models page. Anything else is "fx stopped", with fx's last lines.
Settings rows that list fx's choices say "fx is not running" in that state
rather than asking for a folder.

### Keys and focus

Esc closes whatever is on top, one layer at a time: the palette or a dialog,
then a menu, then a popover, then Settings. With none of those up it rejects a
waiting approval, and after that it stops a running turn. ⏎ confirms a confirm
dialog.

Focus is kept inside the app's one view: on the composer when it shows,
otherwise on the root. `FxApp.focus` is a focus handle on the root that holds
focus when no field does, so ⌘K and the other shortcuts still reach the root's
action handlers on first run and on Settings. A confirm dialog (remove, discard,
full access) takes the keys, so ⏎ confirms it and cannot send the draft
underneath. The palette and the rename dialog focus their own fields, which are
not drawn yet on the pass that opens them, so focus is left alone while they
are up.

While any turn runs the app redraws once a second, for the elapsed time.

## The fx process, accounts and sessions

### The ACP client

fx brings its own tools, providers and permission modes, so the client
advertises no capabilities. It sends `initialize` with
`"protocolVersion": 1, "clientCapabilities": {}` and only has to answer one
kind of request, `session/request_permission`. Everything else the agent says
arrives as a `session/update` notification and is folded into `Update`. Any
other request that carries an id, such as `fs/read_text_file`, is answered with
JSON-RPC error `-32601` "not supported".

fx's version comes from the handshake, at `agentInfo.version` in the
`initialize` result.

The child process handle is held on the client, so the process lives as long as
the client does. When the app quits the pipes close and `fx acp` exits on the
end of its input. The reader task holds an `Arc<Agent>` and so keeps the client
alive for as long as fx's output stays open. Dropping the last handle elsewhere
is therefore not enough to end the process. A session that moves to another
process, or is removed, stops its old process explicitly with `Agent::stop`,
which kills the child.

When fx's stdout ends, every request still waiting is failed by clearing the
pending map, which drops the senders, so no caller hangs on a dead process.
Then `Event::Exited("fx stopped")` is sent. `Event::Exited` means the process
ended and nothing more will arrive on the channel.

Each fx process's events are forwarded into the app. A session's process ending
is that session's problem, not the app's, so its exit is not passed on, and the
next request to it reports the failure. Only the main process's exit marks the
whole agent as failed.

Two shapes come out of the fold that the rest of the app reads directly:

- A `ToolCall` carries `name`, the tool's own name such as `shell` or
  `write_file`; `kind`, ACP's coarse kind (`read`, `edit`, `execute`, `search`
  and so on); and `input`, ACP's `rawInput`. A missing `status` is read as
  `pending`.
- A `ConfigOption` is a session setting fx exposes. The ids are `provider`,
  `model`, `mode`, `effort` and `fast`.

### One process per session

One `fx acp` process keeps only one session live. Opening a second session in
the same process makes fx refuse the first with "Session is not active". So
each session has an fx process of its own (`Session.agent`), which is also what
lets sessions run side by side on different accounts.

A `Launch` is the account (provider) and model an fx process runs on, and the
permission mode its sessions start in. It is passed as
`fx acp --permission-mode <mode> --provider <provider> --model <model>`. Given
at launch, the account and model hold for that process alone. Switching account
inside a running process would rewrite fx's saved default for everything else.

The mode is one of `ask`, `auto` or `full-access`, and the mode new sessions
start in is the app's own default. It is passed at launch and not set on the
session, because setting it on the session (`session/set_config_option`) would
save it into fx's settings and so change the fx CLI too.

`open_process` gives a session its own fx process on the launch's account and
model, then creates the session in it, or reloads it there when `reload` is
set. `find` names the session by id, and `None` is the one fx has not made yet.
The session may have moved in the list while the process started, so it is
looked up again by id each time.

Your standing instructions, set in Settings, go to fx as the session is made.
They are sent as `systemPrompt`, an array of text blocks. fx adds them after
its own system prompt and they stay with the session. Blank instructions are
not sent. The other defaults set in Settings are applied to the new session one
option at a time, only where they differ from what fx gave it.

`launch_of` gives the account and model a session last ran on, from the
store's `ran_on`, as a launch for its process. It is fx's default when the
session has not run here. `start_turn` records where a session runs so it can
be reopened there. fx keeps the account choice for the process only, so
reopening a session needs it from the store.

### Idle sessions are put down

Each opened session has a process of its own, and without a limit they pile up
for as long as the app runs. `rest_idle` stops the fx process of every session
that is doing nothing, except the ones named and the six you opened most
recently (`FxApp.recent`, `WARM`). Six is cheap, about 12 MB each, and it makes
going back to a recent session instant: its process and thread are still there.
Sessions that are running, awaiting approval, awaiting a change tally, shown
beside, empty or not yet created are left alone too.

A stopped session keeps its name and its turns. The turns move to
`Session.stale`, and `Session::turns` hands the view those until fx has
replayed the session again, so reopening an old session shows its transcript
at once instead of "Loading…" for the three seconds a reload takes. The
composer's pills fill in when the reload lands. Switching a session's account
replays it in place the same way.

When the app quits it stops the process of every session that is not running
(`stop_idle`). Left to end on their own, those processes save their sessions
on the way out, which moves each one's "updated" time to now and reshuffles the
list by nothing you did.

### Accounts and the model catalogue

An `Account` is one of fx's accounts (Codex, Grok, AI Gateway) and the models
it offers. `FxApp.catalog` is every account fx knows and the models each
offers, for the model menu. It is empty until fx has been asked.

The app asks fx what each account offers with a short-lived process per
account, because switching account inside one process would rewrite fx's saved
default. The default account is asked first, and it also names the others,
which are then asked all at once: each costs about three quarters of a second,
and one after another that was over two seconds for three accounts. A
session that never gets a prompt is not saved by fx, so opening one in each
account's process just to read its model list leaves nothing behind.

`account_of` gives the account that serves a model, known once fx has listed
them. A default model saved before accounts were tracked has no account with
it. Once the catalogue is loaded it says whose the model is, and the provider
default is filled in and saved.

`saved_models` reads the `models` map in `~/.fx/settings.json`, which is the
model fx last used on each account. A process started for an account opens on
that model.

### Sessions

A `Session` has no `id` until fx has created it. `saved_title` is fx's title
from the saved list, shown before the history is loaded. `loaded` says whether
the history has been replayed into the thread. A listed session is loaded when
it is opened, not before. `SavedSession.updated` is the `updatedAt` time in
RFC 3339, as fx writes it.

A session with nothing said in it yet is the composer on home, not a row in a
list (`Session::is_empty`). A session fx listed has a title from fx, so it is
never empty, even in the moment its history is still loading. Empty sessions
are left out of the sidebar, the counts and the tabs.

Starting a new session reuses an untouched one instead of piling up empty ones.
The default account and model are given to the process as it starts, and the
other defaults are set once the session exists. A model is only passed together
with the account that serves it. Alone it would be asked of whichever account
is fx's default.

When the session list is refreshed, what is open is remembered by id across the
refresh, because the sort moves indexes. Sessions sort newest first. A session
made this run has no timestamp yet and sorts as newest: its sort key is "~",
which sorts after any RFC 3339 timestamp. The lists are re-sorted as fx reports
sessions, so async work finds its session again by id with `locate`.

Opening a listed session replays its history into its thread, in a process of
its own on the account it last ran on, or fx's default.

Removing a session takes it off the list only. fx keeps it, its id goes into
the store's `hidden`, and it joins the workspace's `archived` sessions. Home's
Archived tab puts it back on the list and opens it.

### Switching model or account

Using a model on the session's own account is one option change. On another
account the session moves to a new fx process started for that account, which
leaves every other session and fx's saved default as they were. If nothing has
been said yet, a new session on the new account takes its place with the same
defaults. Otherwise the session is reloaded there. A running turn must be
stopped first.

`reload_session` starts a session's fx process afresh. fx replays the history
as it reloads, so the thread starts empty and fills back in.

### Notifications

A macOS notification is sent through `osascript`, with the title "fx" and the
session's name as subtitle. It is sent only while fx is in the background and
only if Settings has not muted them. The store's `mute` is off by default, so
notifications come when a turn needs you or finishes.

## Sending a turn, steering and the queue

### Sending

`submit` sends what the composer holds to the active session. With nothing
running it starts a turn. While a turn runs, plain text steers it. Images and
skill commands (`/…`) need a turn of their own, so they wait in the queue. It
returns false when there is nothing to send or the session cannot take a prompt
yet. A session is not ready until its fx process has made or loaded it. ⏎ on an
empty composer sends the next queued prompt.

`Agent::prompt` sends a prompt as text blocks and image blocks and waits for
the turn to end. It returns the stop reason, read as `end_turn` when fx gives
none.

`/name rest` becomes a request to follow that skill: "Use the `name` skill:
read <path> first and follow it." fx reads the file itself, so the prompt
carries the path, not the text.

The round button in the composer sends when there is a draft (non-blank text or
at least one attached image) or when no turn is running. While a turn runs and
nothing is drafted it becomes stop, a 10px square. So with something written
during a running turn, the button sends it into the running turn instead of
stopping it.

### Steering

Steering is text said into the running turn. It waits above the composer
(`Session.steering`) until the model reads it, when fx sends it back as your
user message. That echo is how the app knows the text no longer waits.

`Steered` says what became of a steering message. `Absorbed` means the turn
read it. `Dropped` means you stopped the turn first. `Missed` means the turn
ended by itself first, so the text must be sent as a prompt of its own. Text
that was not read goes to the head of the queue: stopping keeps it there, and a
turn that ended by itself gets it as its next prompt.

In the transcript, steering closes the turn in hand and starts one on the new
prompt (`Thread::open_turn`). The work so far folds away under its own "Worked
for", and the new turn inherits `timed` so the clock keeps running.

### The queue

`Session.queue` is the prompts waiting for the running turn to finish, in
order. Each `Queued` is what you typed plus the images that go with it.

`start_turn` starts a turn in a session with nothing running, and returns false
when the session cannot take a prompt. Only a turn that finished by itself
(`end_turn`) sends the next queued prompt. A stop, an error or a limit leaves
the queue alone.

### Retries

`Recovery` is fx trying a model request again: `attempt` is how many times so
far and `message` is why. `Update::Recovery(None)` means the retrying has
stopped. `Thread.recovery` is set while fx is trying.

### What waits above the composer

Above the composer card sits what is waiting:

- The line that says fx is trying a request again. It reads "Retrying", or
  "Retrying · attempt N" from the second attempt, with fx's message.
- The words said into the running turn that the model has yet to read, labelled
  "Steering", with a spinner.
- The prompts queued behind the turn, labelled "Next" for the first and "Then"
  for the rest. A queued prompt shows its first line, or "Images" when it has
  no text, plus an image count, and a × on hover that removes it from the
  queue.

## The transcript and work log

### Folding updates into turns

A session's transcript is folded from ACP updates into turns, and the view
never reads raw updates. A turn is your prompt and everything fx did in answer
(prose, thoughts and tool calls, in order), so the view can collapse the work
into "Worked for 1m 12s" and show the answer under it.

The answer is the prose after the last tool call (`Turn::answer`). Everything
before it, tool calls and the narration between them in order, is the work
(`Turn::work`), which is what "Worked for" folds away. Narration before a tool
stays with the work and is not lost.

A user message opens a new turn, unless the current turn has no answer yet (no
items and not ended), in which case it joins that turn's prompt. Said into a
live (timed) turn before it answered, it becomes a second paragraph of the
prompt, joined with a blank line, not more of its first paragraph. In replayed
history the chunks are appended as they come.

`Update::UserImage` is an image you sent, replayed with the history, as its
MIME type and its bytes in Base64. An image joins the current turn when that
turn has no answer yet. Otherwise it opens a turn with an empty prompt, so an
image sent with no words still gets its own turn.

`Update::Notice` is fx's own start-of-turn diagnostics, which are context notes
and the skills it skipped. Settings shows the skills, and the transcript shows
neither.

After a load has replayed history, nothing in it is still running, so
`Thread::settle` gives every turn without an end one.

`Turn.timed` is true when the turn ran in this app, so its start and end times
are real. History replayed from fx carries no times, so replayed turns are
untimed. A duration reads "1m 12s" from 60 seconds up, and "24s" below.

`Thread.usage` is the context tokens used and the context window size, from
fx's `usage_update`s.

`Turn.stop` is set only when the turn ended for a reason other than finishing.

| Stop reason | Reads |
| --- | --- |
| `cancelled` | "Stopped" |
| `max_tokens` | "Stopped at the output limit" |
| `refusal` | "The model declined to answer" |
| anything else | the reason with underscores turned to spaces |
| an error | its own text |

### What a draw costs

`FxApp` is one view, so every draw rebuilds and lays out the whole window. A
live profile of a streaming answer put the time in the layout pass, not in this
app's code, so the first thing that matters is how often the window draws.

- The spinner does not use GPUI's animation, which asks for a frame at the
  display's full rate (120 a second on a ProMotion screen). `spinner_in` turns
  the arc by the clock and raises a flag, and a `pulse` task in `FxApp` redraws
  every 33 ms while the flag keeps coming back. With no spinner on screen the
  pulse only looks every 250 ms.
- Stream updates are held to the same rate. `on_event` applies each update at
  once but draws at most every 33 ms; anything held back is drawn by the next
  pulse. A turn ending, an approval and everything else still draw at once.

Together these took a streaming answer from 25 to 45% of a core to about 14%.
Three more things keep each draw cheap.

- Parsed markdown is cached by its text (`parsed`), as code colours already
  were. Parsing was two thirds of the cost of drawing an answer: 0.55 ms for a
  4 KB answer with code and a table, 0.13 ms once cached. Both caches keep two
  generations (`Recent`), so what was drawn last frame is never thrown away
  when the cache turns over, and a streaming answer, which is new text on every
  chunk, cannot push the finished turns out.
- An edit step's `+n −n` is cached by its old and new text (`edit_stat`), since
  working it out is a line diff.
- Turns more than 1000px beyond the window are not built. The column reports
  each turn's place and height after layout (`on_children_prepainted`, kept in
  `Seen`), and on the next draw `spaces` swaps a far-off turn for an empty box
  of that height. The last two turns and a running turn are always built. The
  heights belong to one session at one width: a different session starts
  again, and a change of width throws them away and draws once more with
  everything built, because wrapped text changes height. The scroll position
  read while building is clamped to the content first, and if layout still
  shows a skipped turn inside the window the frame is drawn again; without
  both, one long flick to the top drew an empty thread.

`cargo test costs_per_draw -- --ignored --nocapture` prints these costs.

### A turn on screen

A session's transcript is drawn as the "full agent run" artboard draws it: the
prompt bubble; the work as a timeline of tool calls with what fx said between
them, folded into "Worked for 1m 12s" once done; the answer; the files the turn
changed; and the approval card when fx asks before it acts.

Your message sits at the right, with the images you sent under it as 96 by 72
thumbnails.

A running turn shows the last 6 lines of its log as they happen, narration
included, so nothing fx says is lost between one call and the next.

A finished turn reads "Worked for 1m 12s" only when it was run here and took at
least a second, and "Worked · N actions" otherwise, because history loaded from
fx carries no timings. Under a finished answer sits a copy button and a note of
what answered in how long. Only a turn run here knows what model answered it
and how long it took, so replayed turns show the copy button alone.

A listed session with no turns yet is one fx is still replaying, so it reads
"Loading…". An error notice stays until you dismiss it.

The composer floats over the thread, so the thread pads its bottom by 146px,
which is the two-line composer plus 16px of clearance for the last turn. On top
of that goes what sits on the composer: 6px plus 30px for each row waiting
above it (steering messages, queued prompts and the recovery row), and 60px for
the thumbnails inside it when there are attachments. A short thread is
bottom-aligned so it sits just above the composer, as drawn.

### The work log

`Entry` is one line of the work timeline:

- `Say(text, item index)` is something fx said between steps and the item it
  came from.
- `Thought` is the model's reasoning, shown as one quiet row until opened,
  since it is long and rarely what you came to read.
- `Step` is a tool call. `more` counts the like calls folded behind it, and
  `group` is the key (the item index of the run's first call) that opens them,
  set only on the row that toggles.
- `Output` is the tail of a failed call's output, or a subagent's report.

The log lists narration as it came and folds runs of the same kind of call into
one line ("Read src/shell.rs +2 more") until opened. A failed call always
stands alone and shows why. Reasoning that arrived in pieces is still one
thought, so consecutive thought items are joined with a blank line. Work handed
to a subagent is a step of its own, never folded in with the calls that wait on
it. A failure shows its output and a subagent shows what it reported back.
Either way only the last 6 non-empty lines are kept.

`Session.expanded` is the turns whose "Worked for" row is open.
`Session.open_steps` is the runs of like tool calls that are opened into a log,
keyed by (turn, first item). `toggle_steps` opens or folds a run of like calls,
or a thought, by turn index and item index.

`summarize` gives a call's verb and what it acted on: "Ran" and "cargo check",
"Edited" and "src/app.rs". Work for a subagent reads as the agent's name and
the first line of the task. The subagent calls that only wait on subagents or
check them read as "Subagents" plus the title fx gives them. A question reads
as "Asked" plus its text. On a step row, the call in hand reads in the present
("Editing", not "Edited"), and a failed call reads "Failed". The lines an edit
adds and removes are shown only when the call carries both sides (`old_string`
or `old_text`, with `new_string` or `new_text`).

`doing` is what a running turn is on right now, short enough for a list row:
"Reading shell.rs", "Running cargo check". A path reads as its file name (kinds
read, edit, delete) and a command as its first line. Once the last call settles
the turn reads "Working" again, because it is thinking.

The timeline is one row per entry. The 16px lane at its left, the gutter, holds
an icon, joined to the step above and below by a 1px hairline when there is
one. Steps and thoughts are joined to their neighbours by that line. An opened
thought hangs its reasoning under its row, so the line down to the next step is
left out, since it would cut through the text.

### The files a turn changed

`Workspace.status` is `git status` against HEAD, refreshed when a turn ends.
Turns show the files they touched from it, and the header shows its total.

`touched` returns the changed files a turn edited, as they stand against HEAD
now, not what the turn itself wrote. It returns nothing while the turn is still
running. Only calls of kind "edit" or "delete" count, and the file is read from
the call's `path` or `file_path` input, made relative to the workspace folder.

Only the latest turn carries the files card, once it has finished: the working
tree shows where things stand now, not what each turn did. The card reads
"3 files changed +169 −18" over one row per file. Review opens the changes
panel, and does nothing when the panel is already open, so it never closes it.

`Session.tally` is `git status` as a prompt began, and the index of the turn it
began at. Once the prompt ends and status is read again, the difference is what
the prompt changed. `delta` measures the lines a prompt's turns added and
removed as how far the files they edited moved against HEAD between the two
readings. A file new to the status counts in full.

A turn that has ended adds what it changed to its session's count, which home
shows on the row. Steering splits one prompt's work over several turns, so the
count covers every turn from the one the prompt began at. A queued prompt can
start before the last one's changes are counted. Then both are counted together
from the first, because the tally is only set if none is pending. The count is
kept in the store's `changes`, as the lines stood against HEAD when the
session's last turn ended.

## Approvals and questions

### Approvals

`Event::Permission` means the agent wants a yes or no before running a tool.
`request` is the JSON-RPC id of fx's request, and the answer goes through
`Agent::answer_permission` with that same value passed back as the response id.
The answer is `{ "outcome": { "outcome": "selected", "optionId": <id> } }` or
`{ "outcome": { "outcome": "cancelled" } }`.

The approval card shows the question, exactly what fx will run or change, and
the three answers: always allow, deny and allow once. The question depends on
the call's kind.

| Kind | Question |
| --- | --- |
| `execute` | "Run this command?" |
| `edit` or `delete` | "Make this change?" |
| `fetch` | "Fetch this?" |
| anything else | "Allow this?" |

An edit shows the file and its +/− over the diff as one block, capped at 40
lines with a "more" row. A command or anything else shows the line itself, a
command behind "$ ". `edit_preview` works out what an edit will do to the file.
A whole-file write (a `content` input beside a path) is diffed against the file
on disk with 3 lines of context. A replacement (`old_string` or `old_text`,
with `new_string` or `new_text`) shows its two sides in full. Other tools have
nothing to preview.

For a command the always-allow button reads "Always allow" plus the command's
first two words, as the design names it ("Always allow cargo check"). For
anything else it reads "Always allow in this session".

`answer_in` answers the approval a session is waiting on, whether the session
is open or not, because home answers from its card. The answer goes back to the
process that asked. With an approval waiting and nothing typed, ⏎ answers it
with "allow once".

### What a session may do without asking

An "always allow" is recorded as a grant in plain words, phrased as you would
say it: "Run <first two words of the command>", "Edit files", "Delete files",
"Fetch from the web", or "Use <tool name>". `Session.grants` is that list. fx
has no list of what it granted, so the app keeps its own, and closing the old
process is how fx forgets: `forget_grants` reloads the session for exactly
that.

The grants are listed under the modes in the permission menu, on a darker
footer (`background_200`), and only when there is at least one. The footer is
headed "Allowed in this session" and has a single "Forget all" and no "Forget"
on each row, because fx can only take back all of them at once.

### Questions

`asked` reads the question the model put to you in a turn, its text and the
answers it offered, from the last `ask_user_question` call in that turn. It
yields nothing when no answers were offered.

The question the last turn left you with stays until you answer or skip it
(`Session::question`). It yields the turn it is in, what it asks, and the
answers on offer. It is withheld while the turn runs, while an approval is
pending, and while prompts are queued. `Session.skipped` is the turn whose
question you skipped, and its question card stays away.

The question is drawn as a card with each answer the model offered on a row of
its own, numbered for the keyboard, plus "Something else…" as the way out to a
typed answer (it focuses the composer) and Skip. With a question on screen and
nothing typed, pressing its number answers it. This is ignored on Settings,
with the palette, a dialog or a popover open, or with a modifier held.

## The composer

The composer is the text field, the row of pills under it, and everything that
opens above it: the `/` skills list and `@` files list, the attach menu, the
permission (mode) menu, the model menu, the thinking menu and the context
meter's popover. All of them float over the thread (`absolute` with
`deferred(..).with_priority(1)`), and none of them pushes the layout.

The composer itself floats over the thread, which scrolls on under it: no band,
no hard edge. The thread dissolves into the panel's ground as it nears the
composer, through a 56px gradient to 86% opacity.

The card's top padding is 10px when thumbnails are shown and 14px for text
alone. Its background is `gray_100` at 0.94 opacity, a touch see-through, so a
thread scrolling under it shows as a ghost. A press anywhere in the card puts
the caret in the text field, not only a press on the line the text is on.

The placeholder depends on the session. A new session asks for a change:
"Describe a change. @ to attach files, / for skills". An open one asks for a
reply: "Reply to fx, or type @ for files and / for skills". `FxApp.hint` is the
placeholder last set, so render only sets it when it changes.

Setting the draft from code moves the caret to the end, so typing carries on
from there.

### The toolbar

Everything in the toolbar is 32px tall and fully round (16px radius): the pills
(`pill`) and the send or stop button (`round_button`). The order left to right
is attach (+), permission mode, a flexible gap, model, thinking, branch (home
only), context ring (in a session only), send.

On home, meaning no session or a session with no turns, the git branch sits in
the toolbar. Once a session has turns the header carries the branch and the
context ring takes its place in the toolbar. The ring is hidden on home even if
usage is known.

`choice_name` gives the name of an option's current choice for a pill, and "…"
until it is known.

### Popovers

`Pop` names the composer's popovers (attach, mode, model, thinking, usage), and
`FxApp.pop` is the one that is open, if any. A pill's click opens its popover,
or closes it if it is open, and always closes the `/` or `@` picker.

The card every composer menu sits in (`pop_card`) closes on a mouse press
outside it. It occludes, so presses do not fall through to the thread. A press
on a pill while its own popover is open is first seen by the popover as a
mouse-down outside, which closes it and records it in `FxApp.just_closed`. The
click that follows on release must then not reopen it, so `pop_toggle` takes
`just_closed` and returns early when it names the same pill. `just_closed` and
its counterpart for menus, `menu_closed`, are both cleared on the next
mouse-down anywhere, captured at the root.

Menus open 6px above the pills: `pop_card` is absolutely placed 48px from the
composer's bottom.

| Popover | Width | Opens from |
| --- | --- | --- |
| Attach | 220px | the left edge |
| Permission | 340px | 40px in from the left |
| Model | 360px | the right edge |
| Usage | 300px | the right edge |
| Thinking | 300px | over its own pill: the right edge on home, 72px in once a session has turns, which is past the send button and the context ring |

### Models

The model pill shows the account's logo (from the session's `provider` option,
through `account_logo`) and then the model's name.

`model_name` turns an id into a name: "deepseek/deepseek-v4.1-flash" reads as
"Deepseek V4.1 Flash". Names fx already writes for people, containing a space
and no slash, pass through. "gpt", "glm", "ai", "llm" and "oss" are
upper-cased.

The menu lists every account's models in catalogue order, and picking a model
of another account moves the session to that account. One row (`ModelRow`) is
the account it belongs to (id and display name), whether that account is usable
(`connected`), and the model choice. Until fx has listed the accounts only the
session's own models are shown, under the heading "Models". For the session's
own account the live `model` option's choices are used, not the catalogue's
copy.

An account counts as connected when it is the session's own, when it is a
custom connection, or when it is in the settings' `signed_in`. A connection set
up in fx's settings has no sign-in of its own, so it is always ready. Only the
three built-in accounts need their credential. A custom connection is
recognised by `account_logo` returning `None`.

The menu opens on a focused search field, with the arrow position
(`ModelSearch::at`) starting on the model in use. `FxApp.model_search` exists
only while the model menu is open. Render drops it when the menu is not open,
and dropping it hands focus back to the composer. What the menu lists for what
is typed is the models of connected accounts whose display name, id or account
name contains the query, case-insensitively. Typing resets the position to the
first result. ↑ and ↓ move through the results, wrapping, while the field has
focus (handled with `capture_key_down` on the menu). ⏎ uses the model the
arrows are on.

The list scrolls, to at most 320px, while the search field above and the key
hints below stay put. Each account's logo and name head its models. Accounts
with no sign-in appear at the end with a "Sign in" link that opens Settings →
Models, but only when nothing is typed. The typed letters are shown in semibold
where the model's name contains them. A row's right edge shows a check for the
model in use, "⏎" for the aimed row while searching, and otherwise the maker.
The footer counts "N models", or found of total while searching.

### Thinking and speed

The thinking pill sits beside the model pill and only exists when the session
has an `effort` option. Thinking effort is drawn as four rising bars, with
heights of 4, 7, 10 and 13px, each 2.5px wide in a 14px box: none lit for off,
all four for the most. The pill and the thinking menu's rows use the same
glyph, and unlit bars are `gray_500`.

`thinking(value, name)` returns `(rank, lit, label, about)`: where the level
sorts in the menu (least thinking first), how many of the four bars it lights,
the name shown, and the line that says what it means. The level's id alone
decides all four.

| Id | Rank | Bars lit | Name | What it says |
| --- | --- | --- | --- | --- |
| `default`, `auto` | 0 | 0 | Default | What the model prefers |
| `none`, `off` | 1 | 0 | Off | Answers straight away |
| `minimal` | 2 | 1 | Minimal | Barely pauses |
| `low` | 3 | 1 | Low | A brief think first |
| `medium` | 4 | 2 | Medium | For everyday changes |
| `high` | 5 | 3 | High | Longer on hard problems |
| `xhigh`, `max` | 6 | 4 | Max | As long as it takes |
| anything else | 7 | 0 | fx's own name, through `model_name` | nothing |

"default" sits outside the scale: it sorts first and lights no bars. A level id
this app has not met sorts after all the rest, lights none and has no
description.

The menu lists the levels with the least thinking at the top and the most at
the bottom, sorted by that rank and not by the order fx gives. Under them sit
the speed switches "Fast mode" and "Ultrafast". The first one present gets the
top border that separates the switches from the levels. A switch toggles by
setting the option to its other choice, the first choice whose value is not the
current one. A bolt icon on the pill is lit when either speed option (`fast` or
`ultrafast`) is on, where "on" means the option's current value is `"on"` or
`"true"`.

### Permission modes

Permission modes are listed least trusting first (`ask`, `auto`, `full-access`)
whatever order fx lists them in. A mode the app does not know sorts before
those three, since its sort key is `None`. The app describes `auto` as "A
safety review decides instead of you".

Choosing `full-access` when it is not already on does not set it. It opens the
`Dialog::FullAccess` confirmation first, which holds the mode option's id, and
the dialog sets it.

### Context and plan usage

The context ring is an 18px canvas: a `gray_400` circular track of radius 6.3px
and stroke 1.8px, with the used share drawn over it clockwise from the top in
`gray_900`, turning `amber_700` past 80%. The fraction is clamped to 0.02 to
0.999. No reason is recorded for the clamp. A guess is that an empty window
then still shows a dot, and a full one does not make the arc's start and end
points coincide.

The ring's popover spells out how full the context window is ("Nk / Nk", with
"fx summarises older turns at N%.") and then one meter per plan window of the
account: "<account> · 5-hour limit", "N% used", "Resets …". The account name
drops a trailing " subscription": "Codex subscription" is the account, but its
limits are just Codex's.

fx has to be asked for the plan limits (`usage_report("7d", Some(account))`),
and it is asked again every time the popover opens because the numbers move. If
the cached plan belongs to a different account it is cleared before the fetch,
and the plan is shown only if the cached report is for the session's current
account, so stale limits are never shown under the wrong name. The same
background task reads fx's profile at `~/.fx/settings.json`, because it says
when older turns get summarised (`auto_compact_percent`). It is stored only if
Settings has not already read it.

One block of the popover (`meter`) is a label, a value, a 4px bar and a note.
The value and bar turn amber past four fifths (fraction > 0.8). The bar's width
is clamped to at least 1% so it is never invisible.

`plan_windows` returns the windows shortest first, each as (length in seconds,
percent used, reset time in ms since the epoch). A window without
`used_percent` is skipped. Grok's named period maps to 86_400 seconds (daily),
2_592_000 (monthly, 30 days) or 604_800 (weekly, the default).

A window is named by its length (`limit_name`).

| Length | Name |
| --- | --- |
| 2_592_000s | "monthly limit" |
| 604_800s | "weekly limit" |
| 86_400s | "daily limit" |
| other lengths over a day | "N-day limit" |
| below a day | "N-hour limit" (18_000s is "5-hour limit") |

A reset is said the way a person would say it (`resets_on`): a time
("at 2:30 PM") when it is less than a day away, a weekday ("Monday") within a
week, and a date ("on 23 November") after that. It reads "soon" if the
timestamp is invalid. `offset` is the local zone's seconds east of UTC.

### `@` files and `/` skills

`Picker` is the `@` or `/` list above the composer. Each item is (label,
detail, text to insert), and `query` is what was typed after the `/` or `@`.
The `/` list shows up to 5 skills and the `@` list up to 8 files. Opening a
picker closes any composer popover.

`trigger` finds the `@query` or `/query` being typed at the end of the draft. A
skill only counts as the first word of the draft. A file mention can be
anywhere. The + in the composer starts an `@` mention, which opens the file
list. Accepting a file replaces the trailing `@query` with the chosen path.

The list opens 8px above the composer from its left edge, 520px wide for skills
and 460px for files. A skill row is 44px: its name in a 112px column, then what
it does. A file row is 36px: an icon (a folder when the inserted text ends in
`/`), the name, then its folder right-aligned. The footer under the rows says
what the keys do ("⏎ Use skill"; "⏎ Attach" and "Tab Complete path") and, for
skills, how many the workspace has.

A name marks the typed prefix when the label starts with the query, compared
ASCII case-insensitively and only on a char boundary. The prefix is tinted
`blue_900`. Its weight does not change.

↑ steps the picker by `count - 1` (one back, wrapping) and ↓ by 1. Tab accepts
the highlighted item. Esc closes the list. The composer catches those keys
before the text field does, and only while a picker is open.

The file picker lists files git knows about plus untracked ones it does not
ignore (`git ls-files --cached --others --exclude-standard`). Outside a
repository the picker has nothing to offer.

A folder's branch, skills and files are read off the main thread
(`load_folder`), so a folder opens empty and fills in a moment later; reading
them up front held the first frame back by about 77 ms per saved folder, most
of it the skill files. The branch and the file list are read again whenever git
status is (`refresh_status`), which is after every turn, so a file the agent
just created can be mentioned and a branch it switched to shows.

Skills are read from fx's own folder and the other agents' folders
(`.fx/skills`, `.agents/skills`, `.claude/skills`), in the workspace and in
your home. These are the places the previous app read them from. A skill is a
folder holding `SKILL.md`. The nearest copy of a skill name wins, because the
workspace roots are listed before the home ones. A skill's description is the
frontmatter's `description:` folded onto one line, including YAML's `>` and `|`
continuation lines.

Both lists are ranked by a subsequence match on the typed text (`rank`). Each
matched letter scores 1, a letter that continues a contiguous run adds 3, and a
match at a word start (after `/`, `_`, `-`, `.`, a space, or at position 0)
adds 2. Shorter items break ties. `score` takes the best greedy match over
every place the first query letter occurs, so "side" finds `sidebar` and not
the `s` of `src/`.

### Images

A prompt carries at most 8 images (`MAX_IMAGES`), each at most 3,932,160 bytes,
which is 3.75 MiB (`MAX_IMAGE_BYTES`). `FxApp.attachments` is the images
waiting to go with the prompt being written. Anything past the limits is left
out and the session says so.

The images a clipboard item holds are copied pixels or image files copied in
Finder. The explicit paste-images action takes them whatever text sits beside
them. A plain ⌘V passes `with_text` false, so a clipboard that also holds text
pastes as text and gives no images. The text field's `on_paste` handler returns
true (handled) only when images were found and attached.

Waiting images show as 56px thumbnails above the text, each with a remove (×)
button that shows only while its thumbnail is hovered. The × is an 18px
`gray_1000` disc inside a 22px disc of the composer card's own colour
(`gray_100`), which reads as a 2px ring separating it from the image.

## Sidebar, tabs and home

### The shell

The shell is the frame around every screen: the sidebar, the tab bar that
stands in for it when it is closed, the session and folder menus, and the
header of the inset panel. Sizes, gaps and colours are the Paper file's.

With the sidebar open, its own top row holds the traffic lights, so the panels
start 8px down beside it. With it closed, the sessions move into a tab bar
beside the traffic lights and the panels take the full width.

The sidebar takes 160ms to slide open or shut. `sidebar_closing` is set while
it slides shut, and `sidebar_slides` is counted up on every toggle so each
slide is its own animation, since the animation id includes the count. It
slides shut first and only then is `sidebar_open` cleared, at which point the
tab bar takes over. The sidebar's box grows from nothing as it opens and
shrinks to nothing as it shuts, clipping the sidebar inside. The first draw
(`sidebar_slides == 0`) is still, with no animation.

### Sidebar rows

A workspace shows 5 sessions (`RECENT`) before "Show N more" is pressed.

The right end of a session row is one 20px slot. It shows the status (an amber
dot when waiting on approval, a spinner when running, a red dot when the last
turn stopped) or the age, and is swapped for the menu button on hover, so the
column stays put. `ago` writes the age as "now", "5m", "3h" or "2d" from fx's
timestamp.

The round 24px avatar stands for you. It is the first letter of the user name,
or "F" when there is none. Under your name is the account answering, which is
the current choice of the session's `provider` option. When there is none it
says what fx is doing instead: "Starting fx…", "fx is not running" or "fx".

`open_section` opens Settings at a section. The sidebar's Skills row and the
account row both land there.

### Menus

`MenuAt` says which menu is open: a session's (on its sidebar row or in the
header), the tab bar's folder switcher, or a server's row on the MCP settings
page, by its place in the list. Every menu in the shell opens as the same 220px
card (`menu_frame`), and a press outside closes it.

A press outside a menu closes it on mouse down and remembers which menu it was
in `menu_closed`. If that press was on the menu's own button, the click that
follows on release would reopen it. `toggle_menu` takes `menu_closed` and does
nothing when it matches, so a press that just closed the menu does not reopen
it.

The session menu is rename, show changes, open beside, copy the session id,
remove. "Open beside" is offered for any session but the open one. "Copy
session id" only shows once the session has an id.

### The tab bar

The band across the top when the sidebar is closed holds, beside the traffic
lights, the button that brings the sidebar back and the folder name; then that
folder's sessions as tabs; then search, settings and the avatar. It shows as
many tabs as stay readable at about 150px each beside the bar's fixed parts
(420px), between 2 and 8, and ⌘K has the rest. The open session always keeps
its tab: if it would be cut it takes the last slot. Tabs share the bar like a
browser's, up to 220px each and narrower as more open.

On home nothing is open yet, so the new-session button is lit. A session
waiting on approval in another folder shows as an amber dot on the folder's
name.

The folder switcher under the folder name lists each folder with what its
sessions are doing (an amber dot, a spinner, or a check for the current one),
then the way to add one. Picking a folder starts a new session in it.

### The header

The working tree's diff is a button in the header: `+184 −62`, or "No changes",
opens the changes beside the session (`⌘\`). In split view the button is hidden
because the changes panel itself shows the total.

### Home

Home is what the panel shows before a session has a first turn: the mark, the
question and the composer over the workspace's sessions; the two setup steps on
first run; and the way back when `fx acp` has exited.

Every home screen opens with the braille fx mark (mono, 10/11) over a 28px line
set in the display face. The home column is centred, starts 120px down and has
28px between its parts.

`HomeTab` is the list under home's composer: Recent, Running or Archived. The
open filter is a filled pill, and Running counts the sessions that are working.
Working sessions lead the list. The rest follow newest first, as the sidebar
orders them. At most 6 rows show. A working row says what the turn is on and
how long it has run ("now", "5m", "2h"). An idle row says what its last turn
left changed (`+N −M`) and its age.

A list row is the status mark, the title, then a note and the age in fixed
lanes (the age lane is 28px) so they line up down the list. The status mark
sits in a 16px slot so titles share one left edge. The dim 4px bullet is a
session that is neither working nor waiting.

`day` gives the heading home files a session under ("Today", "Yesterday",
"Earlier"), by the local calendar day it was last touched. A session made this
run has no timestamp and counts as today. Days turn over at local midnight, not
UTC midnight, and a timestamp from a clock that ran ahead still files under
today. The day names sit over the rows they cover. Headings after the first sit
a little lower: 36px tall with 14px above, instead of 32px with 10px. Day
headings space the rows on Recent. On the other tabs there are none, so the
first row gets its own 6px gap.

A session waiting on an answer is a card on home that takes the answer right
there, and it leaves the list below. The detail is one line, and a path inside
the folder reads from the folder's root, with the folder path prefix stripped.
The card itself opens the session, so its Deny and Allow buttons stop
propagation. The allow button reads "Run" for an `execute` call and only shows
when the agent offered `allow_once`.

When `fx acp` has exited, home shows what it said and the ways back: start it
again, fix sign-in, or run fx doctor. Only the last 4 non-empty lines of the
error are shown, because the last few lines are the useful ones.

### The command palette and dialogs

The ⌘K palette and the small confirm and rename dialogs all sit on the same
dimmed scrim, black at 0x8c alpha. A click on the scrim closes whichever
overlay is open. Opening the palette closes the composer's popover, menu and
picker, so nothing of the composer's floats over the palette.

What you can do to the open session leads the list, as the palette is drawn,
then the commands, then sessions. With nothing typed the list keeps that
natural order (commands, then recent sessions) and shows the first 12. With a
query it shows the 12 best matches by label, and draws each label with the
first place the query appears in semibold.

At the right of a row a command shows its shortcut and a session shows where it
lives: the workspace name and how long ago it was updated. A command wears its
icon. A session wears the 6px dot its row has in the sidebar.

The palette sits 120px down in a tall window and closer to the top in a short
one (13.3% of the window height, clamped to 24 to 120), and is never taller
than the room under it: the list scrolls instead. The scroll handle lets the
keyboard selection be scrolled into view. The list's children also hold one
heading per group, so the index of an entry is its position plus the number of
headings above it (`row_of`). With children heading, a, a, heading, b, b the
four entries sit at 1, 2, 4 and 5. Moving the selection to the first entry
scrolls to child 0, so the first entry takes its heading into view with it.

A dialog is centred in the window and 400 wide, as the dialog artboard draws
it. Its foot is a darker bar with Cancel at one end and the action at the
other. The rename dialog's input is drawn focused, as designed: a blue border
with a soft halo, a 3px spread shadow of 0x0070f3 at 0x40 alpha.

⏎ on an open confirm dialog (full access, remove, discard) confirms it, as its
button says, and `confirm_dialog` reports true. A rename dialog is left open
and reports false, because its own input handles ⏎.

## Changes and the split view

### The changes panel

The changes panel sits beside the session, as the split designs draw it. Files
lists what is staged and what is not. Diff opens one file at a time with the
rest folded under it. `⌘\` opens and closes the panel, and it refreshes when a
turn ends.

The panel starts 576px wide. Its left edge drags it: the 8px gap between the
session and the panel is itself the drag handle. `changes_width` is the current
width and `resizing` is the drag in hand, as (pointer x when the button went
down, width at that moment). The width is clamped to 360 to 960px. The panel
follows the pointer until the button comes up, wherever in the window that is,
which is why the move and mouse-up listeners sit on the root.

The panel's state:

| Field | Meaning |
| --- | --- |
| `Changes.open` | The file whose diff is showing. `None` shows the file list. |
| `Changes.full` | The open diff shows every line, not only the first `DIFF_LINES` (120). |
| `Changes.hovered` | The file row under the mouse, keyed as "staged:path". That row shows its actions. |
| `Changes.last_commit` | Text such as "7053d71 · 2 days ago", shown when there is nothing to commit. |

Every file row starts the same way: status dot, name, folder, and "new file"
when git does not track the file yet (status `?`) or it is newly added (`A`).
The +/− stat shows until the row is hovered. Then its actions take its place:
Discard only on unstaged rows, and Stage or Unstage. The 26px buttons inside a
row are filled to stage and outlined to unstage.

The diff view shows the open file's card with its diff, and the other files
folded below it as one-row cards that open on click. 120 diff lines
(`DIFF_LINES`) show before "Show N more lines".

With nothing to commit the panel shows a check, the branch the working tree
matches ("HEAD" when there is none) and the last commit.

A refresh keeps the open file open if it is still changed, matching path and
staged side first and then path alone. After the panel updates it also
refreshes the workspace's status, because the header's +/− and the turn's files
card read the same list. `git_edit` runs one git edit off the main thread, then
refreshes. An error from the edit shows in the panel.

### What git is asked

The git module holds the changes view's git and the line diff the approval card
shows before fx writes a file. Every call shells out to `git` in the workspace,
and the calls run on a background thread because none of them is fast enough
for the render loop.

- `status` gives staged and unstaged changes with line counts. A file changed
  in both places appears twice, once per side, the way `git status` lists it.
  It reads `git status --porcelain=v1 -uall` and takes counts from
  `git diff --cached --numstat -z` and `git diff --numstat -z`. The `-z` form
  is used because it names a renamed file plainly, so a staged rename gets its
  counts under its new name. An untracked file counts every line as added. A `Change.code` is one of `M`, `A`, `D`, `R` or
  `?` (untracked).
- `file_diff` gives the diff of one side of one file, parsed for display. An
  untracked file has no git diff, so it is shown as all additions. A `DiffLine`
  is one rendered diff line as (kind, old line number, new line number, text).
- `discard` throws away the working-tree change with `git restore -- <path>`.
  An untracked file is deleted.
- `last_commit` runs `git log -1 --format=%h · %cr`, which gives a line like
  "7053d71 · 2 days ago" for the clean panel.
- `line_diff` is a line diff of `old` to `new` that keeps `context` unchanged
  lines either side of each change. `usize::MAX` keeps every line. Where a line
  changed, removals come first, as unified diffs print them.

### A session beside another

`FxApp.beside` is a second session shown beside the open one. It is held by id,
because indexes move when the list is sorted. Opening a session beside loads it
if need be. A session cannot sit beside itself, so opening the one that is
beside clears the beside slot.

The session beside draws its name over its thread, dimmed to 0.6 opacity
because the keyboard is with the other. A press anywhere in its thread makes it
the open one, and the two trade places (`swap_beside`): it becomes the open
one, and the one that was open takes its place, unless it is empty.

## Restoring a turn's files

`Session.snap` is the folder as a git tree when the last prompt began, and
again once it ended. It is what "Restore this turn's files" puts back, and its
proof that nothing has changed since.

A snapshot is taken off the main thread. It is the folder as it stands, written
as a git tree: tracked and untracked files alike, ignored ones left out
(`git add -A` then `git write-tree`). It returns nothing when the workspace is
not the root of a repository, because a subfolder's snapshot would miss its
siblings. Where there is nothing to restore from, the session's snapshot is
cleared.

Snapshots and restores run git against a throwaway index file. `GIT_INDEX_FILE`
is set to `fx-desktop-index-<pid>-<nanos>` in the temp folder, so nothing they
do touches what you have staged.

`restore_turn` puts the open session's files back as they were before its last
prompt. git does it: `restore` puts back every file that differs between the
two snapshots as `before` had it, and removes files that only `after` has. The
checkout runs first and the removals after it, so a checkout that fails leaves
the folder exactly as it was; a file that cannot be removed does not stop the
others, and the first such failure is what gets reported. It refuses with "Files have changed since this turn ended, so nothing was
restored." when the folder has moved on from `after`, so newer work is never
thrown away. It returns how many files went back. Once restored the snapshot is
cleared: nothing is left to undo.

The palette offers "Restore this turn's files" once the last prompt has ended
and left files changed. That is when the session's snapshot has an "after" that
differs from its "before" and no turn is running.

## Settings

Settings is drawn as the Settings artboards draw it: a section list on the
left, a page title, and grouped rows with the control on the right.

### What Settings holds

`refresh_settings` asks fx for each of these separately and in the background
(`fetch`), and each lands on the page when it arrives. `fx doctor` takes about
0.6 s and `fx usage` about 0.25 s; fetched together in one go, everything
waited for the slowest.

| State | Holds |
| --- | --- |
| `status` | The parsed output of `fx status --json`. |
| `fx` | `~/.fx/settings.json`, which names the provider in use and its models. |
| `permissions` | The always-allowed rules from `fx permissions`, parsed when they are fetched. |
| `usage` | `fx usage --json` for the period in `period`. |
| `period` | `today`, `7d` or `month`. `None` means `7d`. |
| `plan` | The same usage report for one account, keyed by the account's id. It is what the context meter shows of the plan the open session runs on. |
| `credits` | The AI Gateway balance from `fx credits`, when the gateway is the provider. |
| `doctor` | `fx doctor` as one (level, check, detail) tuple per printed line. `None` means the check is still running. |
| `open` | The select whose menu is open, by its option id (`model`, `mode`). |
| `skills_filter` | The Skills page's filter field. It is created the first time the Skills section is shown (`set_section`), not when the app starts. |
| `skipped` | The skills fx skipped and how many more it did not list. |
| `signed_in` | The accounts that hold a credential, as the fx provider ids `codex`, `grok`, `gateway`. |
| `servers` | The MCP page's own state. |
| `account_note` | The account currently being signed in or out, and what its row says meanwhile. |
| `instructions` | The textarea for the instructions every new session starts with. It is created the first time the Behaviour section is shown. |
| `extra` | The open folder's extra folders, from `fx workspace list --json`. |

`fx_in` runs `fx` with a folder as its working directory, because that folder's
own MCP servers, extra folders and settings apply there. Without a folder, fx
runs in `$HOME`.

### Accounts and sign-in

fx owns credentials. Its sign-in commands need a terminal (`fx setup` refuses
to run without one), so the account buttons run or open the right `fx` command
instead of handling keys or tokens in this app.

Each entry of `ACCOUNTS` is (fx provider id, display name, the name `fx login`
takes, logo path). The gateway's provider id is `gateway` but its `fx login`
name is `vercel`. The logos come from svgl. `account_logo` gives an account's
logo for the composer's model pill and model menu.

`account_run` signs an account in or out with `fx <cmd>`. Codex and Grok sign
in through the browser, so fx runs in the background and the row says to finish
there. A gateway key is typed, and fx only takes one at a terminal, so that
command goes to Terminal and the key never passes through this app. Terminal is
also the fallback if fx refuses to run without one, which shows as the
background run failing. Afterwards settings and the model catalogue are both
reloaded, because the model menu lists accounts by who is signed in.

`in_terminal` opens Terminal running `fx <args>` through `osascript`, for the
fx commands that need a TTY (`login vercel --api-key`, `upgrade`).

`fx status` only speaks for the default account, so `signed_in` reads the other
accounts from where fx keeps them. A ChatGPT (Codex) sign-in is the file
`~/.fx/chatgpt-auth.json`, a Grok sign-in is `~/.fx/grok-auth.json`, and a
stored gateway key is noted in `~/.fx/settings.json` as
`credential_source: "stored_key"`. An `AI_GATEWAY_API_KEY` in the environment
also counts. The auth files are only checked for existence and a length over 2
bytes. Their contents are never read.

After `fx provider <id>` changes the default account, the open session's
`provider` option is set too, so the open session follows the new default.

### The Models page

"Connected" means something can answer a prompt: either the default account's
`auth` from `fx status` is non-empty and does not contain "not ", or any
account is signed in.

Every signed-in account can answer, and the model you pick decides which one
does. One of the accounts is the default, which is where new sessions start.
While fx signs an account in or out, its row shows the progress note instead of
its detail. On the default account's row, fx's `auth` string (for example
"stored API key (macOS Keychain)") has its first letter capitalised so it reads
as a sentence before " · new sessions start here".

The default model can come from any signed-in account, so its choices are every
signed-in account's models, each tagged with its account as
`account<tab>model`, with a tab character between them.

### Selects and defaults

The defaults' choices (model, mode, effort, fast) come from any session's copy
of fx's config options: the open session's if it has any, else the first
session in any workspace that does (`any_options`). With no session at all the
rows say "Open a folder first".

`select_row` is a row whose control is a select, and its menu drops below it.
`select_button` only looks like a select: it shows the current value and a
chevron, and the caller opens the menu. An option whose current value contains
a tab is a model tagged with its account and carries its own current value.
Otherwise the saved default is used. Choosing a tagged value saves both the
`provider` default, the account that serves the model, and the model. Rows that
are not the chosen one show which account the model belongs to.

`default_value` is the value new sessions get: the saved default, or else what
fx uses now, which is the option's current value.

### The Behaviour page

The instructions text is saved to the store's `instructions` default on every
change as you type, and a new session reads it when it starts. An empty field
removes the default.

Thinking is a segmented control across fx's effort levels. The segments run
from least thinking to most and are named as the composer names them, through
the same `thinking` function.

The always-allowed rules are read from the output of `fx permissions`. The page
drops the `[permissions]` prefix, `mode=` lines, lines ending in `(none)` and
header lines ending in `:`.

The Extra folders group lists the folders fx may read and edit as well as the
open one, as fx has them saved. Adding or removing runs
`fx workspace add <path>` or `fx workspace remove <path>` in the open folder
and then lists again. Adding goes through a folder picker that allows several
folders.

### The Usage page

"Where the tokens went" is one stacked bar and a legend. "By model" gives the
biggest spender the widest bar, and the others are scaled to it. `compact`
writes 18200000 as "18.2M" and 940 as "940". `grouped` writes 1204 as "1,204".

### The About page

The "This app" row is the desktop app's own updates, separate from fx's:
"Update fx" runs `fx upgrade` in Terminal. The row shows where the update check
stands and the button that moves it on.

### Rows and hairlines

Rows sit in a card with hairlines between them (`rows_card`). The hairlines
start `inset` from the left: 56 under the account tiles so they line up with
the text, 16 elsewhere (`card_rows`), 35 for skipped skills, 52 for
always-allowed rules. For insets of 16 or less the hairline also stops the same
distance from the right. For larger insets it runs to the right edge.

## MCP servers

The MCP servers page is drawn as its artboard draws it: your servers with what
each is doing, the open folder's own servers waiting on your say-so, and a form
to add one. Every change goes through `fx mcp`, which owns the config files and
the logins. The app never writes those files itself.

`fx mcp` runs in the open folder, because that is the folder whose `.mcp.json`
fx reads. With no folder open it runs in `$HOME`, and failing that in `/`.

### What the page holds

| State | Holds |
| --- | --- |
| `Servers.list` | The result of `fx mcp list --json`, with each server's address read from the config file fx names for it. |
| `Servers.shown` | The answer of `fx mcp show NAME --json` for each server that has been asked, keyed by server name: its status and its tools, and an `error` string when it failed. |
| `Servers.adding` | The add form's two inputs, name then address, present only while the form is open. |
| `Servers.note` | The line under the page title. `(false, words)` is what an `fx mcp` command is doing right now, shown with a spinner. `(true, words)` is why the last one failed, shown with a red dot. |
| `Server.project` | True when the server comes from the open folder's `.mcp.json`, not from your own list (`source == "project"` in the listing). |
| `Server.remote` | True when the server is reached over HTTP (`transport == "http"`). Otherwise it is a command fx starts. |
| `Server.status` | fx's word for the server before anything connects: `not_started`, `waiting_for_approval` or `rejected`. After a check, the status in `Servers.shown` wins over it. |
| `Server.address` | The URL without its scheme, or the command line, with command and args joined by spaces. |

### Where a server stands

`state` gives the dot colour and the words.

| Status | Words | Dot |
| --- | --- | --- |
| ready | "N tools" | green |
| `needs_login` | "Signed out" | amber |
| `waiting_for_approval` | "Waiting" | amber |
| `rejected` | "Rejected" | grey |
| `not_started` or empty | "Not checked" | grey |
| any other status | "Failed" | red |

On a row's detail line, a failure says why in the place where the address would
be, and a server waiting for approval says "Waiting for you to approve it"
there. Only a real address is set in the mono font.

### Listing and checking

`refresh_mcp` lists the servers and asks each remote one that is `not_started`
how it is. Asking connects. A remote server answers at once, but a local one
would be started only to be asked, so local servers wait for "Check now". A
refresh keeps what "Check now" learned about servers that are still listed and
forgets it for servers that are gone.

"Check now" (`mcp_check`) connects to one server and keeps what it says. If fx
gives no answer, whatever was known about that server is dropped.

`mcp_run` runs one `fx mcp` command off the main thread, says what it is doing
meanwhile, says why it failed if it did, then lists the servers again. Every
row button and menu item that changes a server goes through it.

### Adding a server

While the add form is open it leads the "Yours" list as its first row. An
address that starts with `http://` or `https://` is a remote server. Anything
else is the command line of a local one, passed after `--`. A remote server is
added with `--no-login`: sign-in is its own step, on the row, so adding never
blocks on a browser.

`name_for` makes a name for a server from its address when you give none:
"linear" for `https://mcp.linear.app/mcp`, "postgres" for
`npx -y @modelcontextprotocol/server-postgres`. For a URL it drops the host
labels `mcp`, `api` and `www` and takes the label before the last ("linear" of
linear.app). For a command it takes the package or program, meaning the last
word that is no flag and no path (it does not start with `-`, `/` or `.`),
keeps what follows the last `/`, drops an `@version` suffix, and strips one
leading `mcp-server-`, `server-` or `mcp-`. With nothing usable the name is
"server".

## Skills

The Skills page groups skills by where they live. Skills whose path is under
the workspace are "This project", and the rest are "Yours". The folder shown
beside each title is the first skill's grandparent folder: relative inside the
project (`.fx/skills`), and with `~` for home outside it (`~/.agents/skills`).
Each group shows 4 skills until "Show more" is clicked or a filter is typed.

Problems come first, above the skill lists: the skills fx found but would not
load. The skills fx skipped arrive as a notice at the start of a turn, and they
are kept for Settings. fx reports skipped skills afresh with each turn, so
starting a turn clears the list: none reported means none skipped. The settings'
`skipped` is `None` until a turn has run, and until then the page falls back to
what `fx doctor` reported. Each row shows the skill's folder as well as its
name, because two folders can hold a skill of the same name.

`explain` turns fx's reason for skipping a skill into a sentence or two saying
what went wrong and what to do. fx's two usual reasons are rewritten in plain
words: a broken link, matched by "linked skill directory" or "link does not
lead", and a multi-line description, matched by `unsupported_multiline`. Any
other reason is passed on as fx wrote it, capitalised and ended with a full
stop by `sentence` ("its link is broken" becomes "Its link is broken."), with
", then reload skills" cut from the fix.

## Updates

The app updates the way fx-ui has always done it. It asks GitHub for the latest
release (`https://api.github.com/repos/zaidmukaddam/fx-ui/releases/latest`),
and if it is newer, downloads its disk image, checks it carries fx-ui's
Developer ID, copies the app inside over this one, and offers to restart. Only
the packaged app updates. Nothing happens unless the app is running from an
`.app` bundle, since a development build has nothing to install into.

The network and disk work is `curl`, `codesign`, `hdiutil` and `ditto`, all of
which macOS ships, so the app takes on no HTTP client for updating. The release
check allows 20 seconds (`--max-time 20`) and the download 600.

`release` reads a release's version (`tag_name` without the `v`) and the
download URL of its first `.dmg` asset from GitHub's JSON. A release with no
disk image is nothing to install. `compare_versions` is negative, zero or
positive as `a` is older than, the same as, or newer than `b`. A leading `v`
and missing parts are forgiven: 1.2 equals 1.2.0.

`install` downloads the release's disk image and refuses it unless fx-ui's
Developer ID signed it. The check runs on the `.dmg` itself:

```
codesign --verify -R=anchor apple generic and certificate leaf[subject.CN] = "Developer ID Application: Zaid Altaf Mukaddam (8BN7M8YM4J)"
```

It then mounts the image with `hdiutil attach -nobrowse -mountpoint` and copies
`fx.app` over the running app with `ditto`.

`FxApp.update` is where this app's own update stands, and the About page shows
it.

| State | Meaning |
| --- | --- |
| `Idle` | Not looked yet, or not running from an app bundle. |
| `Current` | This is the latest release. |
| `Ready` | The new version is installed over this app and restarting runs it. |

No release to move to and GitHub being unreachable both end with nothing to
install. The second is shown as a failure. `restart_updated` starts the updated
app with `open -n` and leaves this one.

## What is stored on disk

The store is what the app remembers between launches: the workspaces you
opened, names you gave sessions, sessions you removed from the list, and the
defaults new sessions start with. fx keeps the sessions themselves. The store
lives at `~/Library/Application Support/fx-desktop/state.json`.

The first time it runs, with no store yet, the app takes the folders the app
before 0.3.0 had open from `~/.fx-ui/state.json` (each workspace's `path`,
kept only if the folder still exists), so an update keeps your sidebar. Nothing
else carries over: that app ran its own agent and its sessions are not fx's.

| Field | Holds |
| --- | --- |
| `titles` | Session id to the name you gave it. |
| `hidden` | Sessions removed from the sidebar. fx still has them on disk. |
| `defaults` | Option id (`model`, `mode`, `effort`, `fast`) to the value new sessions are switched to. The `provider` and `instructions` defaults are kept here too. |
| `changes` | Session id to the lines its edits added and removed, as they stood against HEAD when its last turn ended. Home shows it on the session's row. |
| `ran_on` | Session id to the account and model its last turn ran on. |
| `mute` | When true, no notifications when a turn needs you or finishes while fx is in the background. |

The file is written through a temporary file (`state.json.tmp`, then renamed
over `state.json`) so a crash mid-write never leaves half a file behind.

## The design system

### Tokens

The colours are Vercel's Geist dark theme, the same tokens as the Paper design
file. The values come from Vercel's stylesheet (`.dark-theme`,
`--ds-*-value`). The app uses nothing outside the tokens module for colour, so
a design change is a change in one file.

The app is dark only, like the design. `apply` sets the gpui-kit `Theme` to the
same greys so components that draw from the theme (inputs, menus, scrollbars)
match the app's own views. The theme sizes are font 14px, mono 13px, radius 8px
and large radius 12px. Selection is `#0070f3` at alpha 0x55.

`COLUMN` (720px) is the content column as in the design. `SIDEBAR` is 248px.

Four tokens double as code colours: `blue_900` is for links, and for constants
and types in code; `pink_900` is keywords; `purple_900` is functions;
`amber_900` is parameters.

The inset panels are near-black on the black window, with a hairline ring and
the faintest shadow.

### Fonts

`FACES` holds two font names chosen once in `load_fonts`: the UI face and the
face for text of 20px and up. `sans()` is SF Pro Text, the design's face, with
all its weights. `display()` is SF Pro Display, the optical size Apple draws
from 20px up, used for the home heading and page titles. If SF Pro Display is
missing, display falls back to whatever the text face is. Before `load_fonts`
has run both return `.SystemUIFont`.

Geist Mono (`assets/fonts/GeistMono-Regular.ttf`) is bundled into the binary so
code renders in the right face on any machine. The UI face is not bundled: it
is whichever SF Pro the Mac has installed. A failure to load Geist Mono is
printed to stderr and the app carries on.

The root sets Geist Mono as a font fallback, so every Return hint is the
design's ⏎ glyph instead of the system's ↵.

### Components

These are the pieces every screen is built from, each with the size, radius and
type the Paper file gives it: icons, text, buttons, dots, cards and the
switches.

- `text(size, line)` sets size and line height together, because every text
  layer in the design carries them as a pair.
- The working spinner is a gray track (`spin-track`, `gray_400`) with a quarter
  arc (`spin-arc`) turning on it, one turn every 900ms. `spinner_in` draws the
  arc in a given colour, and amber is used while fx retries.
- The status dot is 7px.
- `text_button` is a quiet text action, like "Always allow cargo check".
  `danger_button` is the red confirm in a dialog and shows ⏎ because Return
  presses it. `icon_button` is the 28px icon button for headers (the panel
  toggle, the close).
- `card` is the card approvals, questions and errors sit in. `error_card` is a
  turn or session that failed: the red mark and what happened, under the fixed
  title "The turn stopped".
- `stat` draws `+12 −3`, green and red, in mono. The added count is shown when
  it is above zero or when nothing was removed, so an empty change reads `+0`.
  The removed count only shows when above zero.
- The settings switch is 34 by 20 and blue when on. The small switch in the
  model menu is 30 by 18 and white when on, and its knob turns dark.

`shadow_panel` sits under the inset panels, `shadow_composer` under the
composer, `shadow_pop` under menus and popovers, and `shadow_modal` under the
palette and dialogs. Pop and modal are three soft layers, as the design's
Overlays page stacks them: a hairline (y 1, blur 1, alpha 0x05), a near one
(alpha 0x0a) and a far one (alpha 0x0f).

### Icons

The icons are exactly as the Paper file draws them: a 16px grid, mostly a 1.4
stroke. `icon(name, size, color)` asks the asset source for `fx/<name>.svg` and
tints it with the text colour, so a view names an icon, a size and a colour and
nothing else.

Each entry of the `ICONS` table is (name, stroke width, markup). Line caps and
joins sit on each element and not on the `<svg>`, because the design mixes
them: the panel's divider is butt-capped, the plus is round.

`icons/fx-mark.svg` (`FX_MARK`) is the fx wordmark from fx.sh, drawn as a
tintable monochrome icon. The fx mark and the account logos
(`logos/codex.svg`, `logos/grok.svg`, `logos/vercel.svg`, taken from svgl) are
files in `assets/icons/`. Everything under `fx/` is generated from the `ICONS`
table. Any other path falls through to gpui-kit's own assets.

### Markdown

fx's answers are drawn as the "full agent run" artboard draws them: 14/24 body,
semibold headings, dot bullets, a code block with its own header and Copy, a
table with a tinted header, a bar beside quotes, blue links. The app lays the
blocks out itself from the parsed markdown tree, the `markdown` crate's mdast
with GFM options.

- Inline content is one wrapping run of text. Links are click ranges on it and
  open in the browser. A soft break inside a paragraph is a space, so `\n` in a
  text node is replaced with " ". A hard break pushes a real newline. Images
  are drawn as their alt text, inline HTML as its source.
- A fenced block is its language (or "text") and a Copy button over the code on
  black. The block's highlight ranges are for the whole block, so each line
  takes the ranges that overlap it, moved to its own offsets, and drops any
  that would not fall on a char boundary.
- Table rows sit under a tinted header and are ruled between rows only, not
  between columns.
- If the markdown ever fails to parse, `render` falls back to the source as
  plain text.

Code is coloured with Geist's code colours, as Vercel maps them
(`CodeColors`): pink keywords (and tags), green strings, purple functions (and
constructors, attributes), blue constants and types (and numbers, booleans,
enums), amber parameters, gray comments. Punctuation and operators are
`gray_900`. Syntax colours are cached per (language, code) hash in a
thread-local map, so a transcript's code is not highlighted again on every
frame. The cache is emptied when it grows past 128 entries, about a screenful
of blocks. A block with no fence language is not highlighted at all. A language
without a grammar comes back with nothing coloured.

Narration, a line fx said between steps, shows in the work log with the same
marks at the log's smaller size (`Renderer.compact`): 13/20 with 6px between
blocks instead of 14/24 with 14px.

The renderer carries the turn so element ids stay unique across the transcript.
An id is `turn * 10_000 + next`, and `next` starts at `salt * 100` (0 for an
answer, step + 1 for a narration line) so several markdown bodies in one turn
do not collide.

### Diffs

Diff lines are drawn as the design draws them (`diff_block`): one 40px
line-number column, showing the new number or the old one for a removal; tinted
22px rows for changes, green `#45a557` at alpha 0x1f for added and red
`#e5484d` at alpha 0x1a for removed; hunk headings in gray on 26px rows; all on
the black code ground. It draws at most `limit` lines, and callers add
`more_lines` themselves when they cut the diff short. `more_lines` is the "Show
84 more lines" row, and it says "line" for exactly one.

The design layer must not know about git, so the two functions that take a
`DiffLine`, `diff_block` and `more_lines`, live with the views and not with the
components.

## The disk image and packaging

The install window reads as one shell line, `››› mv [fx] [Applications] █`:
three chevrons as the prompt, the two icons as the command's arguments. Icon
centres are (298, 124) and (450, 124) in a 640x360 window, and
`dmg-settings.py` and `dmg-background.swift` must agree on them.

Finder's own black icon names disappear on the black background, so the window
draws its own names (`fx.app`, `/Applications`) into the background, about 20pt
below where Finder puts its own, so Finder's invisible text does not cut into
them. Finder's name for a 96pt icon centred at y sits at about y+56 to y+72.

The background is a two-frame APNG, cursor on and cursor off, 0.53 seconds
each, looping for ever. That is the blinking cursor at the end of the line.

`package.sh` signs ad hoc unless `SIGN_IDENTITY` names a Developer ID
Application identity. With one, it notarizes when `NOTARY_PROFILE` (a
notarytool keychain profile) or `NOTARY_KEY`, `NOTARY_KEY_ID` and
`NOTARY_ISSUER` (an App Store Connect key file) are set. The app's own updater
only installs images signed by fx-ui's Developer ID.

## Known ceilings

Each of these is a deliberate simplification with a stated limit and a way up.

- **A transcript's elements are rebuilt on every draw.** The parsed markdown,
  the code colours and the edit counts are cached, and turns more than a screen
  away are drawn as spacers of their measured height, so the cost follows what
  is near the window and not the length of the session. The split view's second
  transcript has no such skip. If that bites, give it the same treatment.
- **A turn's line count is by file.** `delta` compares how far each edited file
  moved against HEAD, so a turn that deletes lines an earlier turn added and
  never committed shows nothing for them. If rows need exact counts, diff the
  two file contents instead.
- **The thread's bottom padding is sized for the two-line composer.** A taller
  draft covers the last lines of the thread until it is sent. Measure the
  composer if that bites.
- **A local MCP server's command line is split on spaces.** A quoted argument
  with a space in it breaks apart. Parse shell quoting if that comes up.
- **`line_diff` is an LCS over lines with an O(n·m) table.** It is quadratic in
  file length, which is fine for the files an agent writes in one go. If
  approvals on huge files get slow, swap in Myers.

## What the tests hold

- `folds_a_recorded_turn` folds tool-call, tool-update and message-chunk lines
  recorded from fx 0.0.16. `reads_retries_titles_and_images` uses the retry,
  title and image shapes fx 0.0.17 documents for ACP clients.
- `live_handshake_and_new_session` and `live_accounts_run_side_by_side` are
  `#[ignore]`d and need `fx` on PATH. They open sessions without prompting, so
  they spend no tokens. The second checks what the app's sessions rely on: a
  process started for an account runs on it beside others, a process keeps only
  its newest session live, and none of it moves fx's saved default (the
  `provider` key of `~/.fx/settings.json`). Its last assertion fails with "fx
  now keeps two sessions live in one process" if fx ever lifts the
  one-live-session limit.
- `a_turn_counts_only_what_it_moved`: main.py already stood at +6 and the turn
  took it to +7 −2, so the turn counts (1, 2). Another file changed too, but
  the turn never touched it, so it is not counted.
- `like_calls_fold_and_failures_stand_alone`: opening the run at item 1 lists
  each read on its own row.
- `inline_runs_cover_the_text_and_keep_links` holds that a markdown line's text
  runs add up to the length of its text.
- The `resets_on` fixture 1_795_424_400_000 ms is Monday 23 November 2026,
  09:00 UTC.
- The MCP address test uses config entries in exactly the shape `fx mcp add`
  writes in fx 0.0.17.
- The skill notice test uses the notice as fx 0.0.17 sends it, shortened to two
  candidates.
