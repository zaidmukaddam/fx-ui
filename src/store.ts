import { useSyncExternalStore } from "react"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { GitStatus } from "./workspace/git"

export type PermissionMode = "ask" | "auto" | "full-access"

export type ToolState = "running" | "ok" | "error" | "denied"

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
  modelName?: string | null
  provider?: "grok" | "codex" | null
  effort?: string | null
  fast?: boolean
  mode: PermissionMode
  status: "idle" | "running" | "error"
  messages: Message[]
  context: Context
  grants: string[]
}

export type Workspace = {
  id: string
  name: string
  path: string
  createdAt: number
}

export type Pane = { sessionId: string | null }

export type Account = { provider: "grok" | "codex"; account: string | null }

export type BackgroundCommand = {
  handle: string
  command: string
  exit: number | null
}

export type Chosen = {
  id: string
  provider: "grok" | "codex" | null
  name: string | null
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

export type Dialog =
  | { kind: "add-workspace"; value: string; error: string | null }
  | { kind: "delete-session"; sessionId: string }
  | { kind: "remove-workspace"; workspaceId: string }

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
  git: Record<string, GitStatus | null>
  paletteOpen: boolean
  settingsOpen: boolean
  dialog: Dialog | null
}

function home(): string {
  const override = process.env.FX_UI_HOME
  if (override) return path.resolve(override)
  if (process.env.VITEST) {
    throw new Error(
      "A test run must set FX_UI_HOME. Refusing to read or write the real ~/.fx-ui — run the suite with `bun run test`.",
    )
  }
  return path.join(os.homedir(), ".fx-ui")
}

export const DIR = home()
export const HOME_DIR = process.env.FX_UI_HOME ? DIR : os.homedir()
const STATE_FILE = path.join(DIR, "state.json")
export const CHECKPOINT_DIR = path.join(DIR, "checkpoints")
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
    git: {},
    paletteOpen: false,
    settingsOpen: false,
    dialog: null,
  }
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
    context: { ...EMPTY_CONTEXT, ...session.context },
    grants: session.grants ?? [],
    messages: (session.messages ?? []).map((message) =>
      message.kind === "approval" && message.decision === "pending"
        ? { ...message, decision: "denied" as const }
        : message.kind === "question" && message.answer === null
          ? { ...message, answer: "" }
          : message,
    ),
  }))
  return {
    ...base,
    ...saved,
    sessions,
    apiKey: process.env.AI_GATEWAY_API_KEY ?? saved.apiKey ?? null,
    accounts: [],
    models: saved.models ?? [],
    defaultModel: saved.defaultModel ?? null,
    background: {},
    attachments: {},
    git: {},
    paletteOpen: false,
    settingsOpen: false,
    dialog: null,
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
    workspaces: state.workspaces,
    sessions: state.sessions.map((session) => ({
      ...session,
      messages: session.messages.slice(-MAX_PERSISTED_MESSAGES),
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    panes: state.panes,
    focusedPane: state.focusedPane,
    splitRatio: state.splitRatio,
    sidebarCollapsed: state.sidebarCollapsed,
    apiKey: process.env.AI_GATEWAY_API_KEY ? null : state.apiKey,
    useCli: state.useCli,
    models: state.models,
    defaultModel: state.defaultModel,
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

function answerable(current: AppState, provider: "grok" | "codex" | null): boolean {
  return provider !== null || apiKeySource(current) !== "none"
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
  const mode = previous?.mode ?? "ask"

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

export function createSession(workspaceId: string): Session {
  const session: Session = {
    id: newId(),
    workspaceId,
    title: "New session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...startsOn(getState(), workspaceId),
    status: "idle",
    messages: [],
    context: { ...EMPTY_CONTEXT },
    grants: [],
  }
  setState((current) => ({
    ...current,
    sessions: [session, ...current.sessions],
    activeWorkspaceId: workspaceId,
  }))
  return session
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

export function removeSession(sessionId: string): void {
  setState((current) => ({
    ...current,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    panes: current.panes.map((pane) =>
      pane.sessionId === sessionId ? { sessionId: null } : pane,
    ),
  }))
}

export function removeWorkspace(workspaceId: string): void {
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
      panes: current.panes.map((pane) =>
        pane.sessionId && live.has(pane.sessionId)
          ? pane
          : { sessionId: null },
      ),
    }
  })
}

export function setSplit(open: boolean): void {
  setState((current) => {
    if (open === current.panes.length > 1) return current
    if (!open) {
      const kept = current.panes[current.focusedPane] ?? current.panes[0]
      return dropUnsent({ ...current, panes: [kept], focusedPane: 0 })
    }
    return {
      ...current,
      panes: [current.panes[0], { sessionId: null }],
      focusedPane: 1,
    }
  })
}

export function setDialog(dialog: Dialog | null): void {
  setState((current) => ({ ...current, dialog, paletteOpen: false }))
}

export function setPalette(open: boolean): void {
  setState((current) => ({ ...current, paletteOpen: open, dialog: null }))
}

export function setSettings(open: boolean): void {
  setState((current) => ({ ...current, settingsOpen: open, paletteOpen: false }))
}

export function setBackground(sessionId: string, running: BackgroundCommand[]): void {
  setState((current) => ({
    ...current,
    background: { ...current.background, [sessionId]: running },
  }))
}

export function setAttachments(sessionId: string, files: string[]): void {
  setState((current) => ({
    ...current,
    attachments: { ...current.attachments, [sessionId]: files },
  }))
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

export function credential(current: AppState): {
  label: string
  detail: string[]
  ready: boolean
} {
  const names = current.accounts.map((entry) =>
    entry.provider === "grok" ? "Grok" : "Codex",
  )
  const key = apiKeySource(current)
  if (names.length > 0) {
    return {
      label: names.join(" · "),
      detail: [
        `Signed in to ${names.join(" and ")}`,
        key === "none"
          ? "Turns run on the subscription. Gateway models need a key as well."
          : "Every model is available: the subscription's, and the Gateway's on your key.",
        "Click for settings.",
      ],
      ready: true,
    }
  }
  if (key === "none") {
    return {
      label: "No models",
      detail: [
        "Nothing can answer a prompt yet",
        "Add an AI Gateway key, or sign in to a Grok or Codex subscription.",
        "Click for settings.",
      ],
      ready: false,
    }
  }
  return {
    label: "AI Gateway",
    detail: [
      "Connected through the AI Gateway",
      key === "env"
        ? "The key comes from AI_GATEWAY_API_KEY, which overrides any key saved here."
        : "The key is saved in ~/.fx-ui/state.json, readable only by you.",
      "Click for settings.",
    ],
    ready: true,
  }
}

export function resetState(): void {
  setState(emptyState)
}

export function flushState(): void {
  if (shared.persistTimer) clearTimeout(shared.persistTimer)
  shared.persistTimer = null
  persistNow()
}
