# Platform notes

Facts about GPUIX, libfx and the two subscription providers that this app is
built around. Each one was measured, and each one is a silent failure if you get
it wrong — nothing throws, the pixels are just wrong or the request just waits.
The code carries no comments, so this is where the knowledge lives.

## GPUIX

**The React root holds one host element.** An overlay rendered as a sibling of
the app replaces it rather than floating above it, so the palette and the
dialogs live inside the root element.

**Paint order is tree order.** A `position: "absolute"` element paints under
every `<virtual-list>` declared after it, and over every one declared before it.
This is why an overlay mounted at the root needs `<anchored deferred>` to escape,
and why the transcript's two scroll fades are declared *after* its list — the top
one is absolute and paints over the list precisely because it comes later.

**`<anchored>` paints its own opaque surface, and that surface ignores alpha.**
`#ff00ff40` renders as solid magenta. A window-sized child therefore means a
window-sized opaque quad, which is why the palette used to hide the whole app.
The surface is square, so a rounded overlay on top of it shows it at each corner;
give the `anchored` the same `borderRadius`.

**So a drag must not catch the mouse with an `anchored` overlay.** The split
divider used a window-sized `anchored` to follow the pointer, and the whole
window went blank until release. While the drag lasts, it now mounts a plain
absolute `div` as the root's last child. That `div` has no fill, so it paints
nothing, and it is the topmost hitbox, so it hears every move.

**A filled box swallows the mouse for everything under it.** gpuix gives every
`div` with a visible fill, and every absolute one, a hitbox that ends the hit
test. So a parent never hears a press that lands on a painted child, and a
listener on the root never hears a move over the panes. The divider's 1px line
ate every press aimed at it until it got `pointerEvents: "none"`.

**`width` and `height` are the border box.** Padding comes out of them, not on
top. Setting `height: 26` with 25px of vertical padding leaves a 1px content box
and the children overflow it — the row still looks right, and everything inside
has silently moved.

**`bounds()` returns the content box**, so `x` excludes left padding while
`width` is the padded width. Arithmetic across the two does not close. For pixel
questions, screenshot and scan.

**`onVisibleRange` never fires on `<virtual-list>`.** Anything conditioned on
scroll position will simply never happen.

**Nested scrolling is not supported.** The transcript is the only scroller in a
pane, so an expanded tool result is capped with a Show more row instead of
getting its own viewport. An overlay in the deferred layer may scroll: it is not
in a pane.

**`motion.div` is the only animatable element, and it animates a short list.**
`width`, `height`, `opacity`, `top`/`right`/`bottom`/`left` and `borderRadius`
— there is no `transform` channel, so press-scale and scale-from-a-trigger
cannot be expressed. Transitions are `{duration, delay, ease}` only: no springs,
no bounce, no stagger, and no `prefers-reduced-motion` hook to honour. Animating
a value the element also needs for layout means putting the static half in
`style` and only the animated property in `animate`.

**Children are not clipped to a parent's border radius.** `overflow: "hidden"`
clips to the rectangle, not the rounded rectangle, so any child painted to the
edge — a fill, a selected row — squares off the corners it covers. Shapes that
never reach the corner, or a child carrying the same radius, are the way out.

**A text field is 26px tall whatever its font.** An `<input>` at `fontSize: 12`
and one at `fontSize: 13` both measure 26, because the row height is
`window.line_height()` — the window's text style, not the field's — and
`lineHeight` does not touch it: measured, the box stays 26 with or without one.
The ink sits at a fixed offset inside that box, roughly `y` 6 to 19. Stock gpuix
paints the caret the full 26, more than twice the height of its own text; the
patched build paints it at 1.2× the field's own font size, centred on the row, so
a wrapped draft gets the same small caret a one-line field does.

**`overflow: hidden` always keeps the top of a box, never the middle.** So
setting `height` on the input itself cannot work: it crops from 6 downwards,
clipping descenders long before the caret is short — at 12px, 16px of height
still cuts a `g` — and a `marginTop` on that same element only slides the
result around, it does not choose which slice you keep.

The slice is only selectable with two elements: a **wrapper** clamped to the
height you want, and the input **lifted inside it** by the ink's top offset. The
visible window is then `[lift, lift + height]`, which can be made to hug the ink.
`fieldStyle(size)` returns both halves — `box` at 1.15× the font size, `text`
lifted by 6 — so they cannot drift apart. The composer reached the same numbers
by hand for its own prompt: a 15px window lifted 6, at a 13px font.

Only a single-line field can take this; a `textarea` that grows needs its own
clamp, applied only while it is one row tall.

**`Select` and `Combobox` wrap their trigger in a box of their own.** The root
renders a `div` with `display: flex; position: relative` around whatever
`asChild` hands it, and that box, not the trigger, is the flex item. A trigger
that says `minWidth: 0` still holds its full width: in a narrow split pane a long
model name pushed the composer footer 123px past its edge. The root takes a
`style`, and `minWidth: 0` there is what lets the trigger shrink and truncate.

**The stock text field swallows ⌘V even when there is nothing to paste.** gpuix
binds `cmd-v` and `ctrl-v` to its `Paste` action, which inserts clipboard text
and otherwise does nothing, and an action that does not propagate ends the key's
dispatch. So neither the element's `onKeyDown` nor the window's ever sees ⌘V,
while ⌘K, ⌘⇧V and plain keys reach both, and an image on the clipboard had no
way in. gpuix has no clipboard, file-drop or file-dialog API either.

fx-ui runs a patched native build (`patches/gpuix-native.diff`, built into
`vendor/`) whose `Paste` calls `cx.propagate()` when the clipboard holds no
text. ⌘V then arrives as an ordinary key event and the app reads the pasteboard
itself: `osascript -l JavaScript` with `NSPasteboard` takes a Finder copy's file
URLs first, then PNG data, then TIFF converted to PNG. Clipboard text still wins
and pastes as text.

**Choosing files goes through GPUI's own panel, not `osascript`.** AppleScript's
`choose file` works but is slow to appear: every call starts a fresh
`osascript`, which has to become a foreground app and build its own panel. The
patched build adds `promptForPaths(elementId, multiple)`, which opens GPUI's
`prompt_for_paths`, an NSOpenPanel inside the app's own process, and reports the
chosen paths as a `change` event on the element that asked. `choose file`
remains the fallback for the stock binary. A script that names a variable
`picture` does not compile, since that is an AppleScript class, and `osascript`
then exits before any dialog opens, so the tests compile both scripts with
`osacompile`.

**macOS 27 will not load an addon linked against the 27 beta SDK.** dyld rejects
it with `mis-aligned LINKEDIT string pool`, while the same crate linked against
the 26.5 SDK loads, and the published binary's string pool sits at an offset
just as unaligned. The napi loader swallows the failure: it tries the patched
file first, catches the error, and loads the published binary instead, so the
app runs and only ⌘V is wrong. The test that presses ⌘V in an empty field is
what notices.

**`<img src>` takes an absolute path, and `borderRadius` rounds the picture.** A
missing file paints a debug `img: load failed` label rather than nothing, so a
thumbnail checks the file exists before it renders one.

**`<svg>` is a monochrome renderer and `color` is required.** Without it the icon
does not draw at all.

**`followTail` shoves a growing row upwards, and `scrollToItem` cannot undo it.**
A tail-pinned list keeps its last row against the bottom, so height added
anywhere above moves everything above it up — expanding a tool result measured a
346px jump. `scrollToItem` does not repair that: its third argument is an offset
*within* the item, so all it can do is pin the item to the top of the viewport,
which is its own 261px jump in the same direction. Calling it made the symptom
smaller and no less wrong.

The fix is not to scroll but to stop pinning: a row that expands tells the
transcript to hold the tail, and the tail is followed again as soon as another
message arrives. `followTail={heldAt !== rows.length}` says exactly that in one
expression, with no effect and no stored scroll position. Turning `followTail`
off outright is not the answer either — an idle session then opens on its oldest
messages instead of its newest.

**A test capture draws `<svg>` as well as layout.** `app.screenshot()` against a
`createTestRoot` renderer paints icons and raw SVG markup: the context meter's
ring comes out with its dim track and its arc. Because the test renderer's clicks
work, that also makes it the way to look at an open popover, which the live
window cannot show while clicking there hangs.

**Live-window automation hangs on `mouse.down`, `click` and `press`.** `hover`,
`fill`, `wheel`, `bounds` and `screenshot` work, and one `wheel` per session
works where ten hang. The test renderer's clicks work fine, so drive interaction
through `createTestRoot` and keep the live window for pixels.

**An icon is imported, not read.** `import icon from "./x.svg" with { type: "text" }`
hands back the file's contents as a string, and Bun's bundler embeds it, so every
icon ships inside the compiled binary rather than being looked up on disk.
`assets.d.ts` is what tells TypeScript that.

**The titlebar centre is 32, not Apple's 20pt.** Measured against this window's
traffic lights. `titlebarBand` pads to it from above and closes with an ordinary
gap, rather than doubling the centre — a symmetric band pays for the space above
the row a second time underneath, where there are no lights to clear.

## libfx

**The embedded core is built Gateway-only.** `napi_core_main.zig` hands the ACP
server `provider_set.gateway_only(...)`, which leaves the Codex and Grok bundles
empty, and sets `oauth_transport.unavailable_provider`. No option can reach them
from here. The `fx` binary is the same core built with `builtin_providers.native`
and has all three.

**`createFxAgent` accepts an undocumented `runtimeFactory`.** It is called ahead
of instantiating a backend, and libfx's own native path is written as exactly
that, so it is the seam for running `fx acp` as the core instead. Host tools
cross that seam as `libfx/tool_call` requests rather than as a native callback,
so they keep working.

**`apiKey` is required even when the core will not use it**, which is why the CLI
runtime passes a placeholder and strips `AI_GATEWAY_API_KEY` from the child's
environment: a key there outranks the stored session and the turn comes back
`refused · HTTP 401`.

**An image cannot reach the model through the core, by either door.**
`normalizePromptInput` throws `image prompt blocks are unsupported`, so the
prompt is out. A host tool *may* return `{type: "libfx.tool-result", text,
images: [{type: "image", data, mimeType}]}` — the SDK validates it, up to 8
images of 5MB — but the core then drops them, substituting `[Tool images were
retained but not sent because this model does not support image input.]`.
Measured: that happens for every model id tried (`openai/gpt-4o`, `openai/gpt-5`,
`anthropic/claude-sonnet-5`, a subscription's own `gpt-6-astra`) and whatever the
catalogue says — `image` or `vision` in `tags`, `input_modalities`, both. The
capability lives in a table inside the native core that nothing here can reach.
So an image goes around the core: the app hands over a path, and `vision` calls
the provider directly, which is why that tool exists.

**A tool's row can land before the text that preceded it.** The turn's async
iterator and the host tool callback are separate paths, so `execute` — and the
row it appends — can run before the `text_delta` that came first has been drained
from the loop. Nothing that writes the transcript may assume it still owns the
tail: the streaming assistant message re-checks, and starts a new one when
something else has been appended under it. That is also why a test cannot assert
an exact transcript shape across a tool call, only that text streamed after a row
lands after it.

**A turn's `usage` is every request in it added together.** Two requests that
read 11 and 20 input tokens come back as 31, so a turn with ten tool calls
reports about ten times the context. How full the context is has to be read per
request, from each `finish` event's `usage`, which the request shim does for the
Gateway and the subscriptions alike.

**`fx acp` before 0.0.7 routes every session to the Gateway** whatever provider
is signed in, while `fx ask` on the same machine uses the subscription.

## The Gateway wire format

The core makes exactly one kind of model request:

```
POST https://ai-gateway.vercel.sh/v3/ai/language-model
ai-language-model-id: xai/grok-4.6
ai-language-model-specification-version: 4
{"prompt":[…],"tools":[…],"toolChoice":{"type":"auto"},"providerOptions":{…}}
```

`prompt` messages carry `content` arrays of `{type:"text"}`,
`{type:"tool-call",toolCallId,toolName,input}` and
`{type:"tool-result",toolCallId,toolName,output:{type:"text",value}}`.

It parses exactly these stream events, as `data:` lines:

| Event | Fields |
| --- | --- |
| `text-delta` | `delta` |
| `reasoning-delta` | `delta` |
| `tool-input-start` | `id`, `toolName` |
| `tool-input-delta` | `id`, `delta` |
| `tool-input-end` | `id` |
| `tool-call` | `toolCallId`, `toolName`, `input` |
| `finish` | `finishReason.unified`, `usage.inputTokens.total`, `usage.outputTokens.total` |
| `error` | `error` |

**A response carrying tool calls must finish with `tool-calls`, not `stop`.** It
is the one mismatch the core rejects outright, as an opaque `ModelError`, rather
than tolerating the way it tolerates an unknown reason.

**The core also fetches `/coding-agent/v1/models`** to learn a model's context
window. Entries are `{id, type:"language", released, tags:[…], context_window,
max_tokens}`. A subscription's models are not in the Gateway's list, so the shim
answers this request too — otherwise the window is guessed from the vendor prefix
and Grok's 500k is read as `xai/`'s 131k.

## Grok and Codex

Client ids, endpoints and scopes are fx's, matched exactly, because its
registration is what we must fit. They are public identifiers; PKCE is what makes
that safe.

| | Grok | Codex |
| --- | --- | --- |
| Authorize | `auth.x.ai/oauth2/authorize` | `auth.openai.com/oauth/authorize` |
| Redirect host | `127.0.0.1` | `localhost` |
| Callback path | `/callback` | `/auth/callback` on port 1455 or 1457 |
| Extra params | `referrer=fx` | `id_token_add_organizations`, `codex_cli_simplified_flow`, `originator=fx` |
| Refresh body | form | JSON |
| Models | `cli-chat-proxy.grok.com/v1/models` | `chatgpt.com/backend-api/codex/models` |
| Turns | `cli-chat-proxy.grok.com/v1/responses` | `chatgpt.com/backend-api/codex/responses` |

**`localhost` and `127.0.0.1` are the same socket and not the same string**, and
a registered redirect is compared as a string. Codex answers the wrong one with
`error_code: unknown_error` on its own page, saying nothing about which parameter
it disliked. x.ai answers a missing `referrer` by silently serving a page that
shows a code to paste instead of redirecting.

**x.ai's code page finishes the sign-in by `fetch`ing the loopback listener**,
not by redirecting to it. That needs CORS for `https://accounts.x.ai`, including
`Access-Control-Allow-Private-Network: true` — without it Chrome refuses the
preflight outright, the request is never made, and the page waits for ever with
nothing in the network tab to explain it.

**Codex's catalogue requires `client_version`** as a query parameter, and answers
a missing one with a pydantic validation error rather than anything about models.
The value is the published Codex CLI's version, read from
`registry.npmjs.org/@openai/codex/latest`; pinning one would freeze the catalogue
at whatever was current that day.

**Grok refuses a turn from a client that does not name its version.**
`cli-chat-proxy` answers `426` with "Your Grok CLI version (none) is outdated"
unless the request carries `x-grok-client-version`, read from
`https://x.ai/cli/stable` (plain text, e.g. `1.0.25`) alongside
`x-grok-client-identifier`. Its catalogue endpoint does not care; only the
responses endpoint does, so a sign-in and a model list can both look healthy
while every turn fails.

**Both providers run web search themselves, and fx never asks them to.** Codex
reports `supports_search_tool` with a `web_search_tool_type`, Grok reports
`supports_backend_search`, and `tools: [{"type":"web_search"}]` is accepted on
either responses endpoint beside ordinary function tools. fx reads neither flag:
its own `web_search` always runs Exa inside the Gateway, on that key. This app
sends the tool wherever the catalogue offers it, and withdraws the host
`web_search` from that session so there is only one way to search.

**A provider-run search cannot be handed to the core.** It arrives as
`response.output_item.added` with `item.type: "web_search_call"`, then
`response.web_search_call.in_progress`, `.searching`, `.completed`, then
`response.output_item.done` carrying `item.action`: either `{type: "search",
query, sources: [{url}]}` or `{type: "open_page", url}`. The query is empty
until `done` on both providers. None of it can be forwarded as a `tool-call` —
`web_search` is a host tool, so the core would run it itself against a Gateway
key the session may not have. The shim reports the steps out of band instead,
through `Route.onSearch`, and the app writes the transcript rows. Grok searches
several times and opens result pages between them, so one turn produces several
rows — an `open_page` is shown as `web_fetch`, since that is what it did. Both
providers write their own citations into the answer text, so the rows do not
have to carry them.

**Grok searches X too, and those steps look nothing like a web search.** Its
subscription endpoint takes `{"type": "x_search"}` beside `web_search`, so the
shim sends both to Grok and only `web_search` to Codex. An X search streams as a
`custom_tool_call` item, not a `web_search_call`, named `x_keyword_search`,
`x_user_search` or `x_semantic_search`, with `response.custom_tool_call_input`
deltas between `added` and `done`; the query is only whole in the finished item's
`input` JSON. It runs inside the response like a web search, so it becomes a
transcript row through `Route.onSearch` and never reaches the core. Measured on
one question about @xai: four X searches, no web search, one cited post.

**Nothing can approve a provider-run search.** It happens inside the response,
where the approval broker cannot reach, so a subscription session searches the
web without asking. That is the price of searching at all without a Gateway key.

**Neither provider names a default model.** Codex's catalogue carries plenty of
per-model defaults — `default_reasoning_level`, `default_verbosity`,
`default_service_tier` — and Grok's carries none at all, but nothing in either
says which model to open on. The order they list them in is the only signal:
Codex leads with `gpt-6-astra`, Grok with `grok-4.6`. Picking the first listed
model therefore tracks whatever they promote, where a pinned id would go stale.

**Both providers take images on nearly every model.** `input_modalities`
carries it — inline on Codex's catalogue, on a separate `api.x.ai/v1/language-models`
for Grok, joined on the model id. The Responses call takes the image as
`{"type":"input_image","detail":"auto","image_url":"data:…"}` beside the text
part. libfx's own prompt blocks are text and resources only, which is why this
is a direct call rather than part of a turn.

**Codex's fast tier is `service_tiers` with `id: "priority"`**, sent back as
`service_tier: "priority"` on the request. `additional_speed_tiers` carries the
same fact as a bare `["fast"]`, but the `service_tiers` entry is the one with a
name and a per-model description worth showing. Grok publishes neither.

**Filter Codex's catalogue on `visibility === "list"` only.** Its
`supported_in_api` flag describes the public API rather than this backend and is
false for models the Codex app itself lists and runs.

Both providers speak OpenAI's Responses API, so one translator serves both:
`{model, instructions, input:[…], tools, stream}` where input items are
`message`, `function_call` and `function_call_output`.

## Processes

**Killing `bash -lc` does not kill what it started, and nothing dies with fx.**
Measured: stopping a background command killed only its `bash`, leaving the
process it had started running, and a command outlived the app that started it,
since a child is never killed with its parent. Background commands now start in
their own process group (`detached: true`) and are stopped as a group, whether
from the composer, the agent, a deleted session, or the app's exit, which stops
every one. A crash or `kill -9` still leaves them running, since nothing is left
to stop them.

## Hot reload

**`bun --hot` evaluates an edited module again and leaves the old copy
running.** Measured: after one edit, the old copy's `setInterval` kept firing
beside the new copy's, each counting in its own module state. `bun run dev` is
`bun --hot`, so every edit to the store left two stores in the process. Each
held its own sessions and wrote `state.json` on its own timer, the last write
won, and a session could vanish. The store now keeps its state, its listeners
and its save timer on `globalThis`, so every copy of the module shares one of
each. Other module state still splits: a turn that was running keeps the copy
that started it.
