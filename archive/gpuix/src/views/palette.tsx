import { useState } from "react"
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@gpuix/react/combobox"

import { Icon, type IconName } from "../ui/icons"
import { color, nativeTheme, radius, space, text } from "../ui/theme"
import { Backdrop, Kbd, Label, fieldStyle, overlayStyle } from "../ui/ui"
import { cancel, forkSessionReporting, reloadSkills } from "../agent/agent"
import { setUseCli, signInWithFx } from "../agent/credentials"
import { forgetGrants, lastEdit, undoLastEdit } from "../tools"
import { lastTurn, restoreTurn } from "../workspace/turns"
import { refreshGitStatus } from "../workspace/git"
import {
  clearNotices,
  findSession,
  findWorkspace,
  notice,
  openSession,
  openSessionAt,
  setDialog,
  setPalette,
  setSettings,
  toggleChanges,
  setSplit,
  setState,
  startSession,
  type AppState,
  type Message,
} from "../store"

const PALETTE_WIDTH = 560
const PALETTE_TOP = 96
const MAX_RESULTS = 8
const MAX_HITS = 4
const SNIPPET_RADIUS = 40

type Command = {
  id: string
  label: string
  detail?: string
  icon: IconName
  hint?: string
  run: () => void
}

function buildCommands(state: AppState): Command[] {
  const commands: Command[] = []
  const workspaceId = state.activeWorkspaceId ?? state.workspaces[0]?.id ?? null
  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  const split = state.panes.length > 1

  if (workspaceId) {
    commands.push({
      id: "new-session",
      label: "New session",
      icon: "plus",
      hint: "⌘N",
      run: () => startSession(workspaceId),
    })
  }
  commands.push({
    id: "add-workspace",
    label: "Add workspace",
    icon: "folderPlus",
    hint: "⌘⇧O",
    run: () => setDialog({ kind: "add-workspace", value: process.cwd(), error: null }),
  })
  commands.push({
    id: "toggle-split",
    label: split ? "Close split view" : "Open split view",
    icon: "columns",
    hint: "⌘\\",
    run: () => setSplit(!split),
  })
  const focusedWorkspace = focused
    ? (findSession(state, focused)?.workspaceId ?? null)
    : (state.panes[state.focusedPane]?.view?.workspaceId ?? null)
  if (focusedWorkspace) {
    const open = state.panes.some(
      (pane) =>
        pane.view?.kind === "changes" && pane.view.workspaceId === focusedWorkspace,
    )
    commands.push({
      id: "toggle-changes",
      label: open ? "Hide changes" : "Show changes",
      detail: "Changed files and diffs in a pane",
      icon: "fileDiff",
      run: () => toggleChanges(focusedWorkspace),
    })
  }
  commands.push({
    id: "toggle-sidebar",
    label: state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
    icon: "panelLeft",
    hint: "⌘B",
    run: () =>
      setState((current) => ({
        ...current,
        sidebarCollapsed: !current.sidebarCollapsed,
      })),
  })
  if (focused && findSession(state, focused)?.status === "running") {
    commands.push({
      id: "stop-turn",
      label: "Stop the running turn",
      icon: "square",
      hint: "⌘.",
      run: () => cancel(focused),
    })
  }
  if (focused) {
    commands.push({
      id: "reload-skills",
      label: "Reload skills and MCP servers",
      detail: "Re-reads them from disk; open sessions keep their history",
      icon: "sparkle",
      run: () => void reloadSkills(),
    })
  }
  if (
    focused &&
    findSession(state, focused)?.messages.some((message) => message.kind === "notice")
  ) {
    commands.push({
      id: "clear-notices",
      label: "Clear notices",
      detail: "Takes the app's own messages off this transcript",
      icon: "x",
      run: () => clearNotices(focused),
    })
  }
  const undoable = focused ? lastEdit(focused) : null
  if (focused && undoable) {
    commands.push({
      id: "undo-edit",
      label: `Undo the edit to ${undoable}`,
      detail: "Puts the file back as it was, if nothing has changed it since",
      icon: "history",
      run: () => {
        try {
          notice(focused, "info", undoLastEdit(focused))
        } catch (error) {
          notice(focused, "error", error instanceof Error ? error.message : String(error))
        }
      },
    })
  }
  const restored = focused ? lastTurn(focused) : null
  if (focused && restored) {
    commands.push({
      id: "restore-turn",
      label: restored === 1 ? "Restore this turn's file" : `Restore this turn's ${restored} files`,
      detail: "Puts the workspace back as it was before the turn, if nothing has changed it since",
      icon: "history",
      run: () => {
        const workspaceId = findSession(state, focused)?.workspaceId
        void restoreTurn(focused)
          .then((text) => {
            notice(focused, "info", text)
            if (workspaceId) void refreshGitStatus(workspaceId)
          })
          .catch((error) => {
            notice(focused, "error", error instanceof Error ? error.message : String(error))
          })
      },
    })
  }
  commands.push({
    id: "settings",
    label: "Settings",
    detail: "Keys, sign-ins, runtime, skills and MCP",
    icon: "settings",
    hint: "⌘,",
    run: () => setSettings(true),
  })
  commands.push({
    id: "fx-sign-in",
    label: "Sign in with the fx CLI",
    detail: "The binary's own sign-in, for a provider this app does not carry",
    icon: "terminal",
    run: () => void signInWithFx(),
  })
  commands.push({
    id: "use-cli",
    label: state.useCli ? "Run in this process instead" : "Run through the fx CLI",
    detail: state.useCli
      ? "Back to the embedded agent, on the AI Gateway key"
      : "Uses whichever provider you signed in to",
    icon: "terminal",
    run: () => void setUseCli(!state.useCli),
  })

  for (const workspace of state.workspaces) {
    commands.push({
      id: `workspace:${workspace.id}`,
      label: `Go to ${workspace.name}`,
      detail: workspace.path,
      icon: "folder",
      run: () =>
        setState((current) => ({ ...current, activeWorkspaceId: workspace.id })),
    })
  }
  for (const session of state.sessions.slice(0, 40)) {
    const workspace = findWorkspace(state, session.workspaceId)
    commands.push({
      id: `session:${session.id}`,
      label: session.title,
      detail: workspace?.name,
      icon: "message",
      run: () => openSession(session.id),
    })
  }
  if (focused) {
    const session = findSession(state, focused)
    commands.push({
      id: "fork-session",
      label: "Fork this session",
      detail: "Copy it into a second pane to try another approach",
      icon: "gitBranch",
      run: () => void forkSessionReporting(focused, focused),
    })
    commands.push({
      id: "rename-session",
      label: "Rename this session",
      icon: "filePen",
      run: () =>
        setDialog({ kind: "rename-session", sessionId: focused, value: session?.title ?? "" }),
    })
    if (session && session.grants.length > 0) {
      commands.push({
        id: "forget-grants",
        label: "Forget what this session may do without asking",
        icon: "shieldAlert",
        run: () => forgetGrants(focused),
      })
    }
    commands.push({
      id: "delete-session",
      label: "Delete this session",
      icon: "trash",
      run: () => setDialog({ kind: "delete-session", sessionId: focused }),
    })
  }
  return commands
}

function rank(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands.slice(0, MAX_RESULTS)
  const tokens = needle.split(/\s+/).filter(Boolean)
  return commands
    .map((command) => {
      const hay = `${command.label} ${command.detail ?? ""}`.toLowerCase()
      let score = 0
      for (const token of tokens) {
        const at = hay.indexOf(token)
        if (at < 0) return { command, score: -1 }
        score += at
      }
      return { command, score }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.command)
}

function searchableText(message: Message): string | null {
  if (message.kind === "user" || message.kind === "assistant") return message.text
  if (message.kind === "tool") return `${message.name} ${message.label}`
  if (message.kind === "notice") return message.text
  return null
}

function snippet(body: string, tokens: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + SNIPPET_RADIUS * 2)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

function searchSessions(state: AppState, query: string): Command[] {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  const tokens = needle.split(/\s+/).filter(Boolean)

  const hits: Command[] = []
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of sessions) {
    if (hits.length >= MAX_HITS) break
    const workspace = findWorkspace(state, session.workspaceId)
    const wname = workspace?.name ?? ""
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index]!
      const body = searchableText(message)
      if (!body) continue
      const text = body.toLowerCase()
      const inText = tokens.some((token) => text.includes(token))
      const inAll = tokens.every((token) => `${wname} ${text}`.includes(token))
      if (!inText || !inAll) continue
      hits.push({
        id: `hit:${session.id}:${message.id}`,
        label: session.title,
        detail: `${wname ? `${wname} · ` : ""}${snippet(body, tokens)}`,
        icon: "fileSearch",
        run: () => openSessionAt(session.id, message.id),
      })
      break
    }
  }
  return hits
}

export function CommandPalette({ state }: { state: AppState }) {
  const [query, setQuery] = useState("")
  const commands = buildCommands(state)
  const results = [...rank(commands, query), ...searchSessions(state, query)]
  const byId = new Map(results.map((command) => [command.id, command]))

  const close = () => setPalette(false)

  return (
    <Backdrop width={PALETTE_WIDTH} top={PALETTE_TOP}>
      <Combobox
        open
        items={results.map((command) => command.id)}
        filter={null}
        autoHighlight="always"
        inputValue={query}
        onInputValueChange={setQuery}
        onOpenChange={(open) => {
          if (!open) close()
        }}
        onValueChange={(value) => {
          const command = typeof value === "string" ? byId.get(value) : null
          close()
          command?.run()
        }}
      >
        <div
          testId="palette"
          onMouseDownOutside={close}
          style={{ ...overlayStyle(space.xs, space.xs), width: PALETTE_WIDTH }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              height: 40,
              paddingLeft: space.lg,
              paddingRight: space.lg,
              borderBottomWidth: results.length > 0 ? 1 : 0,
              borderColor: color.border,
            }}
          >
            <Icon name="search" size={14} color={color.faint} />
            <div style={fieldStyle(text.body).box}>
              <ComboboxInput
                testId="palette-input"
                placeholder="Search commands, sessions, and messages"
                theme={nativeTheme}
                style={fieldStyle(text.body).text}
              />
            </div>
            <Kbd keys="esc" />
          </div>

          <ComboboxList
            style={{
              display: "flex",
              flexDirection: "column",
              paddingTop: results.length > 0 ? space.xs : 0,
            }}
          >
            {(id: string) => {
              const command = byId.get(id)
              if (!command) return null
              return (
                <ComboboxItem
                  key={id}
                  value={id}
                  testId={`command-${id}`}
                  style={(itemState) => ({
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.lg,
                    height: 34,
                    flexShrink: 0,
                    paddingLeft: space.lg,
                    paddingRight: space.lg,
                    borderRadius: radius.md,
                    cursor: "pointer",
                    userSelect: "none",
                    backgroundColor: itemState.highlighted ? color.hoverStrong : undefined,
                  })}
                >
                  <Icon name={command.icon} size={14} color={color.tertiary} />
                  <Label truncate size={text.body} color={color.text}>
                    {command.label}
                  </Label>
                  {command.detail ? (
                    <Label grow truncate size={text.small} color={color.ghost}>
                      {command.detail}
                    </Label>
                  ) : (
                    <div style={{ flexGrow: 1 }} />
                  )}
                  {command.hint ? <Kbd keys={command.hint} /> : null}
                </ComboboxItem>
              )
            }}
          </ComboboxList>

          {results.length === 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 40,
                paddingLeft: space.lg,
              }}
            >
              <Label size={text.body} color={color.faint}>
                {`No command matches "${query}"`}
              </Label>
            </div>
          ) : null}
        </div>
      </Combobox>
    </Backdrop>
  )
}

