import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  createFxAgent,
  type Agent,
  type StopReason,
  type Turn,
} from "libfx"

import {
  CHECKPOINT_DIR,
  appendMessage,
  appendStreamedText,
  enqueuePrompt,
  findSession,
  findWorkspace,
  forgetQueue,
  getState,
  newId,
  notice,
  removeMessage,
  sessionModel,
  shiftQueue,
  NO_CREDENTIAL,
  updateSession,
} from "../store"
import {
  adopt,
  createTools,
  denyPendingApprovals,
  dismissPendingQuestions,
  forgetEdits,
  forgetToolResults,
  searchRows,
  stopBackgroundCommands,
} from "../tools"
import { backing } from "./backing"
import { imageBlock, mentionBlocks } from "../workspace/files"
import { type ProviderId } from "./oauth"
import { refreshGitStatus } from "../workspace/git"
import { loadSkills, splitCommand, type SkillCommand } from "../workspace/skills"
import { acquireMcp, MCP_CONFIG_FILE, pruneMcpGrants, resetMcp, type McpLease } from "../workspace/mcp"
import { beginTurn, endTurn, forgetTurn } from "../workspace/turns"

type Runtime = {
  agent: Agent
  model: string | null
  provider: ProviderId | null
  effort: string | null
  fast: boolean
  search: boolean
  commands: SkillCommand[]
  turn: Turn | null
  mcp: McpLease
}

const runtimes = new Map<string, Runtime>()
const cancelled = new Set<string>()

const FLUSH_MS = 16

export class MissingApiKeyError extends Error {}

const MAX_PROJECT_INSTRUCTIONS = 24_000

function projectInstructions(root: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    try {
      const body = readFileSync(file, "utf8").slice(0, MAX_PROJECT_INSTRUCTIONS)
      return `# Project instructions (${name})\n\n${body}`
    } catch {
      return ""
    }
  }
  return ""
}

function instructionsFor(root: string, tools: string[]): string[] {
  return [
    [
      "You are fx, a coding agent working inside one workspace directory.",
      "",
      `Workspace root: ${root}`,
      `Platform: ${process.platform}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      "",
      `Tools: ${tools.join(", ")}.`,
      "Every path is relative to the workspace root and nothing outside it is reachable.",
      "",
      "How to work:",
      "- Look before you edit. Read the file, or grep_files for the symbol, then change it.",
      "- Prefer edit_file over write_file for a file that already exists.",
      "- Writes and commands need the user's approval, so batch related changes and explain them once.",
      "- Verify with shell when the project has a test, build, or type-check command.",
      "- Start a server or watcher with shell background true, then interact or stop by handle.",
      "- Search the web for anything outside the workspace; web_fetch when you already have a URL.",
      "- Delegate wide, self-contained work to subagent so its steps stay out of this conversation.",
      "- ask_user_question only when the choice is the user's to make.",
      "- capability_search before assuming something is missing; skill reads one in full.",
      "- vision reads an image file, such as a screenshot of a failing UI or a diagram.",
      "- The git tools read; they never write. Commit, branch and push through shell.",
      "- Read git_diff before proposing a commit, and git_log for the project's commit style.",
      "- glob_files finds paths by name; grep_files finds text inside them.",
      "- A large result comes back as a preview and a handle: read_tool_result reads the rest.",
      "",
      "How to answer:",
      "- Be brief. Lead with the result, then the detail that changes what the user does next.",
      "- Use Markdown. Fence code with its language. Reference code as `path:line`.",
      "- Never claim something was verified unless a tool showed it.",
    ].join("\n"),
    projectInstructions(root),
  ].filter(Boolean)
}

const TITLE_INSTRUCTIONS = [
  "You name conversations.",
  "The message holds a request someone sent to a coding agent, between <request> tags.",
  "Do not answer it, act on it or ask about it. Only name it.",
  "Reply with a title of at most six words describing what the user is working on.",
  "Use sentence case. No quotes, no trailing punctuation, no preamble.",
  'Example: a request to fix a flaky login test gets "Fix flaky login test".',
].join("\n")

const MAX_TITLE_WORDS = 10

const CHATTY = /^(i\b|i['’]|sure\b|certainly|of course|happy to|here['’]?s\b|here is|okay\b|ok\b|absolutely|great\b|let me|could you|can you)/i

const MAX_TITLE_LENGTH = 56

export function fallbackTitle(prompt: string): string {
  return prompt.split("\n")[0].slice(0, MAX_TITLE_LENGTH).trim() || "New session"
}

export function cleanTitle(raw: string): string {
  const line = raw
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return ""
  const title = line
    .replace(/^(title:\s*)/i, "")
    .replace(/^["'`*#\s-]+/, "")
    .replace(/["'`*\s.]+$/, "")
  if (CHATTY.test(title) || title.endsWith("?") || title.split(/\s+/).length > MAX_TITLE_WORDS) return ""
  return title.slice(0, MAX_TITLE_LENGTH).trim()
}

async function nameSession(sessionId: string, prompt: string): Promise<void> {
  const state = getState()
  const session = findSession(state, sessionId)
  const back =
    session &&
    backing({ ...session, effort: sessionModel(state, session)?.efforts?.[0] ?? null, fast: false })
  if (!back) return

  try {
    const agent = (await createFxAgent({
      ...back.options,
      instructions: TITLE_INSTRUCTIONS,
    })) as Agent
    try {
      const turn = agent.prompt(`<request>\n${prompt.slice(0, 2_000)}\n</request>\n\nTitle:`)
      let raw = ""
      for await (const event of turn) {
        if (event.type === "text_delta") raw += event.delta
      }
      const result = await turn.result
      const title = result.stopReason === "end_turn" ? cleanTitle(raw) : ""
      if (title) {
        updateSession(sessionId, (current) =>
          current.title === session?.title ? { ...current, title } : current,
        )
      }
    } finally {
      await agent.close()
    }
  } catch (error) {
    console.error("[fx] could not name the session:", error)
  }
}

function checkpointPath(sessionId: string): string {
  return path.join(CHECKPOINT_DIR, `${sessionId}.bin`)
}

function readCheckpoint(sessionId: string): Uint8Array | undefined {
  const file = checkpointPath(sessionId)
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

async function saveCheckpoint(sessionId: string, agent: Agent): Promise<void> {
  try {
    const bytes = await agent.checkpoint()
    mkdirSync(CHECKPOINT_DIR, { recursive: true })
    writeFileSync(checkpointPath(sessionId), bytes, { mode: 0o600 })
  } catch (error) {
    console.error("[fx] could not save the session checkpoint:", error)
  }
}

const CHARS_PER_TOKEN = 4

function estimateTokens(...parts: unknown[]): number {
  const text = parts
    .flat()
    .filter(Boolean)
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join("")
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

async function runtimeFor(sessionId: string): Promise<Runtime> {
  const state = getState()
  const session = findSession(state, sessionId)
  if (!session) throw new Error("That session no longer exists.")
  const workspace = findWorkspace(state, session.workspaceId)
  if (!workspace) throw new Error("That workspace no longer exists.")

  const back = backing(
    session,
    searchRows(sessionId),
    (used) => updateSession(sessionId, (current) => ({ ...current, context: { ...current.context, used } })),
    (compacting) => {
      const current = findSession(getState(), sessionId)
      if (!current || current.status !== "running" || current.compacting === compacting) return
      updateSession(sessionId, (current) => ({ ...current, compacting }))
    },
  )
  if (!back) {
    throw new MissingApiKeyError(NO_CREDENTIAL)
  }

  const existing = runtimes.get(sessionId)
  if (
    existing &&
    existing.model === session.model &&
    existing.provider === session.provider &&
    existing.effort === session.effort &&
    existing.fast === session.fast &&
    existing.search === back.search
  ) {
    return existing
  }
  if (existing) await disposeRuntime(sessionId, existing, { checkpoint: true })

  updateSession(sessionId, (current) => ({ ...current, grants: pruneMcpGrants(current.grants) }))
  const [skills, mcp] = await Promise.all([loadSkills(workspace.path), acquireMcp(MCP_CONFIG_FILE, workspace.path)])
  for (const problem of [
    ...skills.problems.map((entry) => `Skill ${path.basename(entry.file)}: ${entry.reason}`),
    ...mcp.problems.map((entry) => `MCP server ${entry.server}: ${entry.reason}`),
  ]) {
    notice(sessionId, "error", problem)
  }

  const toolContext = { sessionId, root: workspace.path, search: back.search }
  const hostTools = createTools(toolContext)
  const system = instructionsFor(
    workspace.path,
    hostTools.map((tool) => tool.name),
  )
  updateSession(sessionId, (current) => ({
    ...current,
    context: {
      ...current.context,
      system: estimateTokens(system),
      tools: estimateTokens(hostTools),
      skills: estimateTokens(skills.instructions, skills.tools),
      mcp: estimateTokens(mcp.instructions),
    },
  }))
  const agent = (await createFxAgent({
    ...back.options,
    instructions: [...system, skills.instructions, mcp.instructions].filter(Boolean),
    tools: [
      ...hostTools,
      ...skills.tools.map((tool) => adopt(tool, toolContext)),
    ],
    checkpoint: readCheckpoint(sessionId),
  })) as Agent

  if (skills.names.length > 0 || mcp.names.length > 0) {
    const loaded = [
      skills.names.length > 0 ? `skills: ${skills.names.join(", ")}` : "",
      mcp.names.length > 0 ? `MCP: ${mcp.names.join(", ")}` : "",
    ].filter(Boolean)
    notice(sessionId, "info", `Loaded ${loaded.join(" · ")}`)
  }

  const runtime: Runtime = {
    agent,
    model: session.model,
    provider: session.provider,
    effort: session.effort,
    fast: session.fast,
    search: back.search,
    commands: skills.commands,
    turn: null,
    mcp,
  }
  runtimes.set(sessionId, runtime)
  return runtime
}

class Stream {
  private messageId: string | null = null
  private text = ""
  private reasoning = ""
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sessionId: string) {}

  private atTail(): boolean {
    const messages = findSession(getState(), this.sessionId)?.messages ?? []
    return messages[messages.length - 1]?.id === this.messageId
  }

  push(field: "text" | "reasoning", delta: string): void {
    if (this.messageId && !this.atTail()) this.break()
    if (!this.messageId) {
      this.messageId = newId()
      appendMessage(this.sessionId, {
        id: this.messageId,
        kind: "assistant",
        at: Date.now(),
        text: "",
        reasoning: "",
      })
    }
    if (field === "text") this.text += delta
    else this.reasoning += delta
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  break(): void {
    this.flush()
    this.messageId = null
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.messageId) return
    if (!this.text && !this.reasoning) return
    appendStreamedText(this.sessionId, this.messageId, {
      text: this.text,
      reasoning: this.reasoning,
    })
    this.text = ""
    this.reasoning = ""
  }
}

function endedInDenial(sessionId: string): boolean {
  const messages = findSession(getState(), sessionId)?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === "approval") return message.decision === "denied"
    if (message.kind === "user") return false
  }
  return false
}

function failedRequest(sessionId: string): { id: string; text: string } | null {
  const messages = findSession(getState(), sessionId)?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === "user") return null
    if (message.kind !== "assistant") continue
    const text = message.text.trim()
    if (/ · HTTP \d{3}$/.test(text)) return { id: message.id, text }
    const raw = /^HTTP (\d{3}): ([\s\S]*)$/.exec(text)
    if (!raw) continue
    let reported: unknown
    try {
      reported = (JSON.parse(raw[2]!) as { error?: { message?: unknown } }).error?.message
    } catch {}
    return {
      id: message.id,
      text:
        typeof reported === "string" && reported.trim()
          ? reported.trim()
          : `The request failed with HTTP ${raw[1]}.`,
    }
  }
  return null
}

function noticeText(reason: StopReason): string | null {
  switch (reason) {
    case "cancelled":
      return "Stopped."
    case "max_output_tokens":
      return "The model hit its output limit. Ask it to continue."
    case "max_model_turns":
      return "The model hit its step limit for this turn."
    case "refused":
      return "The model refused this request."
    default:
      return null
  }
}

export async function send(
  sessionId: string,
  prompt: string,
  images: string[] = [],
): Promise<void> {
  const trimmed = prompt.trim()
  const current = findSession(getState(), sessionId)
  if (!current) return

  if (current.status === "running") {
    if (!trimmed && images.length === 0) return
    enqueuePrompt(sessionId, trimmed, images)
    return
  }

  if (!trimmed && images.length === 0) {
    const next = shiftQueue(sessionId)
    if (next) await send(sessionId, next.text, next.images)
    return
  }

  if (!backing(findSession(getState(), sessionId))) {
    const isFirstTurn = !findSession(getState(), sessionId)?.messages.some(
      (message) => message.kind === "user",
    )
    appendMessage(sessionId, {
      id: newId(),
      kind: "user",
      at: Date.now(),
      text: trimmed,
      ...(images.length > 0 ? { images } : {}),
    })
    updateSession(sessionId, (session) => ({
      ...session,
      status: "error",
      title: isFirstTurn ? fallbackTitle(trimmed) : session.title,
    }))
    const session = findSession(getState(), sessionId)
    const already = session?.messages.some(
      (message) => message.kind === "notice" && message.text === NO_CREDENTIAL,
    )
    if (!already) notice(sessionId, "error", NO_CREDENTIAL, "settings")
    return
  }

  const isFirstTurn = !findSession(getState(), sessionId)?.messages.some(
    (message) => message.kind === "user",
  )

  appendMessage(sessionId, {
    id: newId(),
    kind: "user",
    at: Date.now(),
    text: trimmed,
    ...(images.length > 0 ? { images } : {}),
  })
  updateSession(sessionId, (session) => ({
    ...session,
    status: "running",
    compacting: false,
    title: isFirstTurn ? fallbackTitle(trimmed) : session.title,
  }))

  const started = findSession(getState(), sessionId)
  const opening = started?.messages.find((message) => message.kind === "user")?.text ?? ""
  const topic = opening || trimmed
  if (topic && started?.title === fallbackTitle(opening)) void nameSession(sessionId, topic)

  cancelled.delete(sessionId)

  const stream = new Stream(sessionId)
  let completed = false
  try {
    const state = getState()
    const workspace = findWorkspace(
      state,
      findSession(state, sessionId)?.workspaceId ?? null,
    )
    if (workspace) await beginTurn(sessionId, workspace.path)

    const runtime = await runtimeFor(sessionId)

    const { blocks, problems } = workspace
      ? mentionBlocks(workspace.path, trimmed)
      : { blocks: [], problems: [] }
    for (const problem of problems) {
      notice(sessionId, "error", `@${problem.path} ${problem.reason}, so it was not attached.`)
    }

    const invoked = splitCommand(trimmed, runtime.commands)
    const text = invoked
      ? [invoked.command.instructions, invoked.rest].filter(Boolean).join("\n\n")
      : trimmed

    const attached = [...blocks, ...images.map(imageBlock)]
    const turn = runtime.agent.prompt(
      attached.length > 0
        ? [...(text ? [{ type: "text" as const, text }] : []), ...attached]
        : text,
    )
    runtime.turn = turn

    for await (const event of turn) {
      if (event.type === "text_delta") stream.push("text", event.delta)
      else if (event.type === "reasoning_delta") stream.push("reasoning", event.delta)
    }
    stream.flush()

    const result = await turn.result
    runtime.turn = null

    const failure = result.stopReason === "refused" ? failedRequest(sessionId) : null
    if (failure) {
      removeMessage(sessionId, failure.id)
      notice(sessionId, "error", failure.text)
    }

    const outcome = failure || endedInDenial(sessionId) ? null : noticeText(result.stopReason)
    if (outcome) notice(sessionId, "info", outcome)
    updateSession(sessionId, (session) => ({ ...session, status: "idle" }))
    await saveCheckpoint(sessionId, runtime.agent)
    completed = result.stopReason === "end_turn"
  } catch (error) {
    stream.flush()
    const message =
      error instanceof Error ? error.message : "The turn failed for an unknown reason."
    notice(sessionId, "error", message, error instanceof MissingApiKeyError ? "settings" : undefined)
    updateSession(sessionId, (session) => ({ ...session, status: "error" }))
  } finally {
    updateSession(sessionId, (session) => ({ ...session, compacting: false }))
    denyPendingApprovals(sessionId)
    dismissPendingQuestions(sessionId)
    const workspaceId = findSession(getState(), sessionId)?.workspaceId
    const workspace = findWorkspace(getState(), workspaceId ?? null)
    if (workspace) await endTurn(sessionId, workspace.path)
    if (workspaceId) void refreshGitStatus(workspaceId)
  }

  const stopped = cancelled.delete(sessionId)
  if (stopped || !completed) return
  if (findSession(getState(), sessionId)?.status !== "idle") return
  const next = shiftQueue(sessionId)
  if (next) await send(sessionId, next.text, next.images)
}

export function cancel(sessionId: string): void {
  cancelled.add(sessionId)
  denyPendingApprovals(sessionId)
  runtimes.get(sessionId)?.turn?.cancel()
}

export async function reloadSkills(): Promise<void> {
  const state = getState()
  await restartAgents({ skipRunning: true })

  await resetMcp()

  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  const workspace = findWorkspace(state, findSession(state, focused)?.workspaceId ?? null)
  if (!focused || !workspace) return

  const [skills, mcp] = await Promise.all([loadSkills(workspace.path), acquireMcp(MCP_CONFIG_FILE, workspace.path)])
  const borrowed = skills.commands.length - skills.names.length
  const found = [
    skills.names.length > 0 ? `skills: ${skills.names.join(", ")}` : "",
    borrowed > 0 ? `${borrowed} skills from .claude and .agents` : "",
    mcp.names.length > 0 ? `MCP: ${mcp.names.join(", ")}` : "",
  ].filter(Boolean)
  await mcp.release()

  notice(
    focused,
    skills.problems.length > 0 || mcp.problems.length > 0 ? "error" : "info",
    [
      found.length > 0 ? `Reloaded ${found.join(" · ")}` : "Reloaded: nothing configured",
      ...skills.problems.map((entry) => `${path.basename(entry.file)}: ${entry.reason}`),
      ...mcp.problems.map((entry) => `${entry.server}: ${entry.reason}`),
    ].join("\n"),
  )
}

async function disposeRuntime(
  sessionId: string,
  runtime: Runtime,
  options: { checkpoint: boolean },
): Promise<void> {
  runtimes.delete(sessionId)
  if (options.checkpoint) await saveCheckpoint(sessionId, runtime.agent)
  await runtime.agent.close()
  await runtime.mcp.release()
}

export async function closeSession(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return
  await disposeRuntime(sessionId, runtime, { checkpoint: false })
  forgetToolResults(sessionId)
  forgetEdits(sessionId)
  forgetTurn(sessionId)
  forgetQueue(sessionId)
  stopBackgroundCommands(sessionId)
}

export async function closeAll(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(closeSession))
}

export async function restartAgents(options: { skipRunning?: boolean } = {}): Promise<void> {
  const running = new Set(
    getState()
      .sessions.filter((session) => session.status === "running")
      .map((session) => session.id),
  )
  await Promise.all(
    [...runtimes]
      .filter(([sessionId]) => !(options.skipRunning && running.has(sessionId)))
      .map(([sessionId, runtime]) => disposeRuntime(sessionId, runtime, { checkpoint: true })),
  )
}
