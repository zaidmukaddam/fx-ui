import { useSyncExternalStore } from "react"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { PlanLimits } from "./agent/providers"
import type { DiffView, GitStatus } from "./workspace/git"

export type PermissionMode = "ask" | "auto" | "full-access"

export type ToolState = "running" | "ok" | "error" | "denied"

export type SubagentStep = {
  id: string
  name: string
  label: string
  state: ToolState
  output: string
}

export type Message =
  | { id: string; kind: "user"; at: number; text: string; images?: string[] }
  | {
      id: string
      kind: "assistant"
      at: number
      text: string
      reasoning: string
    }
  | {
      id: string
      kind: "tool"
      at: number
      callId: string
      name: string
      label: string
      state: ToolState
      output: string
      steps?: SubagentStep[]
      patch?: string
      language?: string
      endedAt?: number
    }
  | {
      id: string
      kind: "approval"
      at: number
      approvalId: string
      toolName: string
      title: string
      detail: string
      language?: string
      patch?: string
      scope: string
      decision: "pending" | "allowed" | "granted" | "denied"
    }
  | {
      id: string
      kind: "question"
      at: number
      questionId: string
      question: string
      options: string[]
      answer: string | null
    }
  | {
      id: string
      kind: "notice"
      at: number
      tone: "info" | "error"
      text: string
      action?: "settings"
    }

export type Context = {
  used: number
  system: number
  tools: number
  mcp: number
  skills: number
}

export type Session = {
  id: string
  workspaceId: string
  title: string
  createdAt: number
  updatedAt: number
  model: string | null
  modelName: string | null
  provider: "grok" | "codex" | null
  effort: string | null
  fast: boolean
  mode: PermissionMode
  status: "idle" | "running" | "error"
  compacting: boolean
  messages: Message[]
  context: Context
  grants: string[]
  forkedFrom?: string
}

export type Workspace = {
  id: string
  name: string
  path: string
  createdAt: number
}

export type PaneView = { kind: "changes"; workspaceId: string }
export type Pane = { sessionId: string | null; view?: PaneView }

export type Account = { provider: "grok" | "codex"; account: string | null }

export type BackgroundCommand = {
  handle: string
  command: string
  exit: number | null
  startedAt: number
  endedAt: number | null
  log: string
  urls: string[]
}

export type QueuedPrompt = {
  id: string
  text: string
  images: string[]
}

export type Chosen = {
  id: string
  provider: "grok" | "codex" | null
  name: string | null
}

export type UsageRecord = {
  id: string
  at: number
  sessionId: string
  sessionTitle: string
  model: string | null
  modelName: string | null
  provider: "grok" | "codex" | null
  input: number
  output: number
  cached: number
  reasoning: number
}

export type Model = {
  id: string
  name: string
  provider?: "grok" | "codex"
  efforts?: string[]
  defaultEffort?: string
  fast?: { label: string; detail: string }
  contextWindow?: number
  vision?: boolean
  search?: boolean
}

export const DEFAULT_MODEL: Model = {
  id: "poolside/laguna-s-2.1-free",
  name: "Laguna S 2.1 Free",
}

export const NO_CREDENTIAL =
  "This session has no credential. Add an AI Gateway API key, or pick a model from a subscription you are signed in to."

export type Dialog =
  | { kind: "add-workspace"; value: string; error: string | null }
  | { kind: "delete-session"; sessionId: string }
  | { kind: "remove-workspace"; workspaceId: string }
  | { kind: "rename-session"; sessionId: string; value: string }

export type Overlay = { kind: "palette" } | Dialog

export type UpdateStatus =
  | { stage: "idle" }
  | { stage: "downloading"; version: string }
  | { stage: "ready"; version: string; appPath: string }
  | { stage: "error"; message: string }

/** A pending request to scroll a transcript to a specific message. */
export type Reveal = { sessionId: string; messageId: string }

export type AppState = {
  workspaces: Workspace[]
  sessions: Session[]
  activeWorkspaceId: string | null
  panes: Pane[]
  focusedPane: number
  splitRatio: number
  sidebarCollapsed: boolean
  apiKey: string | null
  useCli: boolean
  accounts: Account[]
  models: Model[]
  defaultModel: Chosen | null
  background: Record<string, BackgroundCommand[]>
  attachments: Record<string, string[]>
  queue: Record<string, QueuedPrompt[]>
  git: Record<string, GitStatus | null>
  diffView: Record<string, DiffView>
  limits: Record<string, PlanLimits>
  usage: UsageRecord[]
  settingsOpen: boolean
  overlay: Overlay | null
  update: UpdateStatus
  reveal: Reveal | null
}

function home(): string {
  const override = process.env.FX_UI_HOME
  if (override) return path.resolve(override)
  if (process.env.VITEST) {
    throw new Error(
      "A test run must set FX_UI_HOME so it never touches the real ~/.fx-ui. Run the suite with `bun run test`.",
    )
  }
  return path.join(os.homedir(), ".fx-ui")
}

export const DIR = home()
export const HOME_DIR = process.env.FX_UI_HOME ? DIR : os.homedir()
const STATE_FILE = path.join(DIR, "state.json")
export const CHECKPOINT_DIR = path.join(DIR, "checkpoints")

export function checkpointFile(sessionId: string): string {
  return path.join(CHECKPOINT_DIR, `${sessionId}.bin`)
}

/** Nothing reads a removed session's checkpoint again, so it would only pile up. */
function forgetCheckpoint(sessionId: string): void {
  try {
    rmSync(checkpointFile(sessionId), { force: true })
  } catch (error) {
    console.error("[fx] could not delete the session checkpoint:", error)
  }
}
export const ATTACHMENT_DIR = path.join(DIR, "attachments")

const MAX_PERSISTED_MESSAGES = 400

const EMPTY_CONTEXT: Context = {
  used: 0,
  system: 0,
  tools: 0,
  mcp: 0,
  skills: 0,
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function emptyState(): AppState {
  return {
    workspaces: [],
    sessions: [],
    activeWorkspaceId: null,
    panes: [{ sessionId: null }],
    focusedPane: 0,
    splitRatio: 0.5,
    sidebarCollapsed: false,
    apiKey: process.env.AI_GATEWAY_API_KEY ?? null,
    useCli: false,
    accounts: [],
    models: [],
    defaultModel: null,
    background: {},
    attachments: {},
    queue: {},
    git: {},
    diffView: {},
    limits: {},
    usage: [],
    settingsOpen: false,
    overlay: null,
    update: { stage: "idle" },
    reveal: null,
  }
}

const PERSISTED = [
  "workspaces",
  "sessions",
  "activeWorkspaceId",
  "panes",
  "focusedPane",
  "splitRatio",
  "sidebarCollapsed",
  "apiKey",
  "useCli",
  "models",
  "defaultModel",
  "usage",
] as const satisfies readonly (keyof AppState)[]

const persisted = (source: Partial<AppState>): Partial<AppState> =>
  Object.fromEntries(
    PERSISTED.filter((key) => key in source).map((key) => [key, source[key]]),
  ) as Partial<AppState>

function isSubagentStep(step: unknown): step is SubagentStep {
  if (typeof step !== "object" || step === null) return false
  const value = step as Partial<SubagentStep>
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.label === "string" &&
    typeof value.output === "string"
  )
}

function load(): AppState {
  const base = emptyState()
  let saved: Partial<AppState>
  try {
    saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<AppState>
  } catch {
    return base
  }
  const sessions = (saved.sessions ?? []).map((session) => ({
    ...session,
    status: "idle" as const,
    compacting: false,
    context: { ...EMPTY_CONTEXT, ...session.context },
    grants: session.grants ?? [],
    modelName: session.modelName ?? null,
    provider: session.provider ?? null,
    effort: session.effort ?? null,
    fast: session.fast ?? false,
    messages: (session.messages ?? []).map((message) => {
      if (message.kind === "approval" && message.decision === "pending") {
        return { ...message, decision: "denied" as const }
      }
      if (message.kind === "question" && message.answer === null) {
        return { ...message, answer: "" }
      }
      if (message.kind === "tool" && message.steps) {
        const steps = message.steps.filter(isSubagentStep)
        return { ...message, steps: steps.length > 0 ? steps : undefined }
      }
      return message
    }),
  }))
  return {
    ...base,
    ...persisted(saved),
    sessions,
    apiKey: process.env.AI_GATEWAY_API_KEY ?? saved.apiKey ?? null,
  }
}

type Shared = {
  state: AppState
  listeners: Set<() => void>
  persistTimer: ReturnType<typeof setTimeout> | null
}

const shared: Shared = ((globalThis as { fxUiStore?: Shared }).fxUiStore ??= {
  state: load(),
  listeners: new Set(),
  persistTimer: null,
})

function persistNow(): void {
  const { state } = shared
  const snapshot = {
    ...persisted(state),
    sessions: state.sessions.map((session) => ({
      ...session,
      compacting: false,
      messages: session.messages.slice(-MAX_PERSISTED_MESSAGES),
    })),
    apiKey: process.env.AI_GATEWAY_API_KEY ? null : state.apiKey,
  }
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(snapshot), { mode: 0o600 })
    chmodSync(STATE_FILE, 0o600)
  } catch (error) {
    console.error("[fx] could not save state:", error)
  }
}

function schedulePersist(): void {
  if (shared.persistTimer) return
  shared.persistTimer = setTimeout(() => {
    shared.persistTimer = null
    persistNow()
  }, 400)
}

export function getState(): AppState {
  return shared.state
}

export function setState(update: (current: AppState) => AppState): void {
  const next = update(shared.state)
  if (next === shared.state) return
  shared.state = next
  for (const listener of shared.listeners) listener()
  schedulePersist()
}

function subscribe(listener: () => void): () => void {
  shared.listeners.add(listener)
  return () => shared.listeners.delete(listener)
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export function findSession(
  current: AppState,
  id: string | null,
): Session | null {
  if (!id) return null
  return current.sessions.find((session) => session.id === id) ?? null
}

export function findWorkspace(
  current: AppState,
  id: string | null,
): Workspace | null {
  if (!id) return null
  return current.workspaces.find((workspace) => workspace.id === id) ?? null
}

export function updateSession(
  id: string,
  patch: (session: Session) => Session,
): void {
  setState((current) => ({
    ...current,
    sessions: current.sessions.map((session) =>
      session.id === id ? patch(session) : session,
    ),
  }))
}

export function appendMessage(sessionId: string, message: Message): void {
  updateSession(sessionId, (session) => ({
    ...session,
    updatedAt: Date.now(),
    messages: [...session.messages, message],
  }))
}

export function notice(
  sessionId: string,
  tone: "info" | "error",
  text: string,
  action?: "settings",
): void {
  appendMessage(sessionId, {
    id: newId(),
    kind: "notice",
    at: Date.now(),
    tone,
    text,
    ...(action ? { action } : {}),
  })
}

export function removeMessage(sessionId: string, messageId: string): void {
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.filter((message) => message.id !== messageId),
  }))
}

export function clearNotices(sessionId: string): void {
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.filter((message) => message.kind !== "notice"),
  }))
}

export function patchMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>,
): void {
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId
        ? ({ ...message, ...patch } as Message)
        : message,
    ),
  }))
}

export function appendStreamedText(
  sessionId: string,
  messageId: string,
  patch: { text?: string; reasoning?: string },
): void {
  updateSession(sessionId, (session) => ({
    ...session,
    updatedAt: Date.now(),
    messages: session.messages.map((message) =>
      message.id === messageId && message.kind === "assistant"
        ? {
            ...message,
            text: message.text + (patch.text ?? ""),
            reasoning: message.reasoning + (patch.reasoning ?? ""),
          }
        : message,
    ),
  }))
}

export function createWorkspace(dir: string, name: string): Workspace {
  const workspace: Workspace = {
    id: newId(),
    name,
    path: dir,
    createdAt: Date.now(),
  }
  setState((current) => ({
    ...current,
    workspaces: [...current.workspaces, workspace],
    activeWorkspaceId: workspace.id,
  }))
  return workspace
}

type StartsOn = Pick<
  Session,
  "model" | "modelName" | "provider" | "effort" | "fast" | "mode"
>

export function answerable(current: AppState, provider: "grok" | "codex" | null): boolean {
  return provider !== null || apiKeySource(current) !== "none"
}

export function canAnswer(current: AppState, session: Session | null): boolean {
  if (!session) return false
  return Boolean(current.apiKey) || current.useCli || session.provider !== null
}

function firstSubscription(current: AppState): Chosen | null {
  const model = current.models.find((entry) => entry.provider)
  if (!model) return null
  return { id: model.id, provider: model.provider ?? null, name: model.name }
}

function startsOn(current: AppState, workspaceId: string): StartsOn {
  const previous = current.sessions.find(
    (session) => session.workspaceId === workspaceId,
  )
  const mode = previous?.mode ?? "auto"

  const pinned = current.defaultModel
  if (pinned && answerable(current, pinned.provider)) {
    return {
      mode,
      model: pinned.id,
      modelName: pinned.name,
      provider: pinned.provider,
      effort: null,
      fast: false,
    }
  }

  if (previous && answerable(current, previous.provider ?? null)) {
    return {
      mode,
      model: previous.model,
      modelName: previous.modelName ?? null,
      provider: previous.provider ?? null,
      effort: previous.effort ?? null,
      fast: previous.fast ?? false,
    }
  }

  const subscription = firstSubscription(current)
  return {
    mode,
    model: subscription?.id ?? null,
    modelName: subscription?.name ?? null,
    provider: subscription?.provider ?? null,
    effort: null,
    fast: false,
  }
}

function dropUnsent(current: AppState): AppState {
  const open = new Set(current.panes.map((pane) => pane.sessionId))
  const sessions = current.sessions.filter(
    (session) =>
      open.has(session.id) ||
      session.messages.some((message) => message.kind !== "notice"),
  )
  return sessions.length === current.sessions.length
    ? current
    : { ...current, sessions }
}

function newSession(current: AppState, workspaceId: string): Session {
  return {
    id: newId(),
    workspaceId,
    title: "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...startsOn(current, workspaceId),
    status: "idle",
    compacting: false,
    messages: [],
    context: { ...EMPTY_CONTEXT },
    grants: [],
  }
}

export function createSession(workspaceId: string): Session {
  let created!: Session
  setState((current) => {
    created = newSession(current, workspaceId)
    return {
      ...current,
      sessions: [created, ...current.sessions],
      activeWorkspaceId: workspaceId,
    }
  })
  return created
}

export function startSession(workspaceId: string, pane?: number): Session {
  let created!: Session
  setState((current) => {
    created = newSession(current, workspaceId)
    const index = pane ?? current.focusedPane
    return dropUnsent({
      ...current,
      sessions: [created, ...current.sessions],
      activeWorkspaceId: workspaceId,
      focusedPane: index,
      panes: current.panes.map((p, i) =>
        i === index ? { sessionId: created.id } : p,
      ),
      settingsOpen: false,
    })
  })
  return created
}

export function openSession(sessionId: string, pane?: number): void {
  setState((current) => {
    const index = pane ?? current.focusedPane
    const session = findSession(current, sessionId)
    return dropUnsent({
      ...current,
      activeWorkspaceId: session?.workspaceId ?? current.activeWorkspaceId,
      focusedPane: index,
      panes: current.panes.map((entry, i) =>
        i === index ? { sessionId } : entry,
      ),
      settingsOpen: false,
    })
  })
}

export function openSessionAt(sessionId: string, messageId: string, pane?: number): void {
  openSession(sessionId, pane)
  setState((current) => ({ ...current, reveal: { sessionId, messageId } }))
}

/** Picks a pane to drop new content into: an empty pane first, otherwise any
 *  pane other than `avoid` (typically the pane the new content originated
 *  from), so it never silently overwrites the pane you're acting on. */
function targetPane(panes: Pane[], avoid?: number): number {
  const empty = panes.findIndex((pane, i) => i !== avoid && !pane.sessionId && !pane.view)
  if (empty >= 0) return empty
  const other = panes.findIndex((_, i) => i !== avoid)
  return other >= 0 ? other : 0
}

export function copySession(sessionId: string): Session | null {
  let created: Session | null = null
  setState((current) => {
    const source = findSession(current, sessionId)
    if (!source) return current
    created = {
      ...source,
      id: newId(),
      title: `${source.title} (fork)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      compacting: false,
      messages: source.messages.map((message) =>
        message.kind === "approval" && message.decision === "pending"
          ? { ...message, decision: "denied" as const }
          : message.kind === "question" && message.answer === null
            ? { ...message, answer: "" }
            : message.kind === "tool" && message.state === "running"
              ? {
                  ...message,
                  state: "error" as const,
                  output: message.output || "Stopped when the session was forked.",
                  endedAt: Date.now(),
                }
              : message,
      ),
      grants: [...source.grants],
      forkedFrom: sessionId,
    }
    const sourceIndex = current.panes.findIndex((pane) => pane.sessionId === sessionId)
    const panes =
      current.panes.length > 1
        ? current.panes
        : [...current.panes, { sessionId: null }]
    const index = targetPane(panes, sourceIndex)
    return dropUnsent({
      ...current,
      sessions: [created, ...current.sessions],
      focusedPane: index,
      panes: panes.map((pane, i) => (i === index ? { sessionId: created!.id } : pane)),
      settingsOpen: false,
    })
  })
  return created
}

export function clearReveal(): void {
  setState((current) => (current.reveal ? { ...current, reveal: null } : current))
}

export function removeSession(sessionId: string): void {
  setState((current) => ({
    ...current,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    panes: current.panes.map((pane) =>
      pane.sessionId === sessionId ? { sessionId: null } : pane,
    ),
    queue: omitQueue(current.queue, sessionId),
  }))
  forgetCheckpoint(sessionId)
}

export function removeWorkspace(workspaceId: string): void {
  const removed = getState()
    .sessions.filter((session) => session.workspaceId === workspaceId)
    .map((session) => session.id)
  setState((current) => {
    const sessions = current.sessions.filter(
      (session) => session.workspaceId !== workspaceId,
    )
    const live = new Set(sessions.map((session) => session.id))
    const workspaces = current.workspaces.filter(
      (workspace) => workspace.id !== workspaceId,
    )
    return {
      ...current,
      workspaces,
      sessions,
      activeWorkspaceId:
        current.activeWorkspaceId === workspaceId
          ? (workspaces[0]?.id ?? null)
          : current.activeWorkspaceId,
      panes: current.panes.map((pane) => {
        if (pane.view) {
          return pane.view.workspaceId === workspaceId ? { sessionId: null } : pane
        }
        return pane.sessionId && live.has(pane.sessionId) ? pane : { sessionId: null }
      }),
      queue: Object.fromEntries(
        Object.entries(current.queue).filter(([id]) => live.has(id)),
      ),
    }
  })
  for (const sessionId of removed) forgetCheckpoint(sessionId)
}

export function setSplit(open: boolean): void {
  setState((current) => {
    if (open === current.panes.length > 1) return current
    if (!open) {
      const focused = current.panes[current.focusedPane] ?? current.panes[0]
      const kept = focused.sessionId
        ? focused
        : (current.panes.find((pane) => pane.sessionId) ?? focused)
      return dropUnsent({ ...current, panes: [kept], focusedPane: 0 })
    }
    return {
      ...current,
      panes: [current.panes[0], { sessionId: null }],
      focusedPane: 1,
    }
  })
}

export function openChangesPane(workspaceId: string): void {
  setState((current) => {
    const existing = current.panes.findIndex(
      (pane) => pane.view?.kind === "changes" && pane.view.workspaceId === workspaceId,
    )
    if (existing >= 0) {
      return { ...current, focusedPane: existing, settingsOpen: false }
    }
    const view: PaneView = { kind: "changes", workspaceId }
    const panes =
      current.panes.length > 1
        ? current.panes
        : [...current.panes, { sessionId: null }]
    const index = targetPane(panes, current.focusedPane)
    return dropUnsent({
      ...current,
      focusedPane: index,
      settingsOpen: false,
      panes: panes.map((pane, i) => (i === index ? { sessionId: null, view } : pane)),
    })
  })
}

export function closeChangesPane(workspaceId: string): void {
  setState((current) => {
    const index = current.panes.findIndex(
      (pane) => pane.view?.kind === "changes" && pane.view.workspaceId === workspaceId,
    )
    if (index < 0) return current
    const diffView = { ...current.diffView }
    delete diffView[workspaceId]
    return {
      ...current,
      diffView,
      panes:
        current.panes.length > 1
          ? current.panes.filter((_, i) => i !== index)
          : [{ sessionId: current.panes[index]!.sessionId }],
      focusedPane: 0,
    }
  })
}

export function toggleChanges(workspaceId: string): void {
  const open = getState().panes.some(
    (pane) => pane.view?.kind === "changes" && pane.view.workspaceId === workspaceId,
  )
  if (open) closeChangesPane(workspaceId)
  else openChangesPane(workspaceId)
}

export function setOverlay(overlay: Overlay | null): void {
  setState((current) => ({ ...current, overlay }))
}

export function setDialog(dialog: Dialog | null): void {
  setOverlay(dialog)
}

export function setPalette(open: boolean): void {
  setOverlay(open ? { kind: "palette" } : null)
}

export function setSettings(open: boolean): void {
  setState((current) => ({
    ...current,
    settingsOpen: open,
    overlay: current.overlay?.kind === "palette" ? null : current.overlay,
  }))
}

export function setBackground(sessionId: string, running: BackgroundCommand[]): void {
  setState((current) => ({
    ...current,
    background: { ...current.background, [sessionId]: running },
  }))
}

export function setLimits(provider: string, limits: PlanLimits): void {
  setState((current) => ({ ...current, limits: { ...current.limits, [provider]: limits } }))
}

const MAX_USAGE_RECORDS = 2_000

export function recordUsage(
  sessionId: string,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
  },
): void {
  const session = findSession(getState(), sessionId)
  const record: UsageRecord = {
    id: newId(),
    at: Date.now(),
    sessionId,
    sessionTitle: session?.title ?? "Untitled session",
    model: session?.model ?? null,
    modelName: session?.modelName ?? session?.model ?? null,
    provider: session?.provider ?? null,
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cached: usage.cacheReadTokens ?? 0,
    reasoning: usage.reasoningTokens ?? 0,
  }
  setState((current) => ({
    ...current,
    usage: [...current.usage, record].slice(-MAX_USAGE_RECORDS),
  }))
}

export function setUpdate(status: UpdateStatus): void {
  setState((current) => ({ ...current, update: status }))
}

export function setAttachments(sessionId: string, files: string[]): void {
  setState((current) => ({
    ...current,
    attachments: { ...current.attachments, [sessionId]: files },
  }))
}

function omitQueue(
  queue: Record<string, QueuedPrompt[]>,
  sessionId: string,
): Record<string, QueuedPrompt[]> {
  if (!(sessionId in queue)) return queue
  const next = { ...queue }
  delete next[sessionId]
  return next
}

export function enqueuePrompt(sessionId: string, text: string, images: string[] = []): void {
  const item: QueuedPrompt = { id: newId(), text, images }
  setState((current) => ({
    ...current,
    queue: {
      ...current.queue,
      [sessionId]: [...(current.queue[sessionId] ?? []), item],
    },
  }))
}

export function removeQueued(sessionId: string, id: string): void {
  setState((current) => {
    const rest = (current.queue[sessionId] ?? []).filter((item) => item.id !== id)
    if (rest.length === (current.queue[sessionId] ?? []).length) return current
    const queue = { ...current.queue }
    if (rest.length === 0) delete queue[sessionId]
    else queue[sessionId] = rest
    return { ...current, queue }
  })
}

export function shiftQueue(sessionId: string): QueuedPrompt | null {
  let taken: QueuedPrompt | null = null
  setState((current) => {
    const [next, ...rest] = current.queue[sessionId] ?? []
    if (!next) return current
    taken = next
    const queue = { ...current.queue }
    if (rest.length === 0) delete queue[sessionId]
    else queue[sessionId] = rest
    return { ...current, queue }
  })
  return taken
}

export function forgetQueue(sessionId: string): void {
  setState((current) => {
    if (!(sessionId in current.queue)) return current
    return { ...current, queue: omitQueue(current.queue, sessionId) }
  })
}

export function sessionModel(current: AppState, session: Session | null): Model | null {
  if (!session) return null
  const id = session.model ?? DEFAULT_MODEL.id
  return (
    current.models.find(
      (model) => model.id === id && (model.provider ?? null) === (session.provider ?? null),
    ) ?? null
  )
}

export function nativeSearch(current: AppState, session: Session | null): boolean {
  if (!session?.provider) return false
  return sessionModel(current, session)?.search === true
}

export function apiKeySource(current: AppState): "env" | "saved" | "none" {
  if (process.env.AI_GATEWAY_API_KEY) return "env"
  return current.apiKey ? "saved" : "none"
}

export function resetState(): void {
  setState(emptyState)
}

export function flushState(): void {
  if (shared.persistTimer) clearTimeout(shared.persistTimer)
  shared.persistTimer = null
  persistNow()
}
