import { useState } from "react"
import { useWindowSize } from "@gpuix/react"
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@gpuix/react/combobox"

import { Icon, type IconName } from "../ui/icons"
import { color, nativeTheme, radius, space, text } from "../ui/theme"
import {
  Button,
  Kbd,
  Label,
  Paragraph,
  TextField,
  fieldStyle,
  overlayStyle,
} from "../ui/ui"
import { cancel, reloadSkills } from "../agent/agent"
import { setUseCli, signInWithFx } from "../agent/credentials"
import { forgetGrants, isDirectory, lastEdit, undoLastEdit } from "../tools"
import {
  appendMessage,
  clearNotices,
  newId,
  createSession,
  createWorkspace,
  findSession,
  findWorkspace,
  openSession,
  removeSession,
  removeWorkspace,
  setDialog,
  setPalette,
  setSettings,
  setSplit,
  setState,
  updateSession,
  type AppState,
} from "../store"
import path from "node:path"

const PALETTE_WIDTH = 560
const PALETTE_TOP = 96
const DIALOG_WIDTH = 460
const MAX_RESULTS = 8

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
      run: () => openSession(createSession(workspaceId).id),
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
        const tone = (text: string, kind: "info" | "error") =>
          appendMessage(focused, {
            id: newId(),
            kind: "notice",
            at: Date.now(),
            tone: kind,
            text,
          })
        try {
          tone(undoLastEdit(focused), "info")
        } catch (error) {
          tone(error instanceof Error ? error.message : String(error), "error")
        }
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
  return commands
    .map((command) => ({
      command,
      score: `${command.label} ${command.detail ?? ""}`.toLowerCase().indexOf(needle),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.command)
}

function Backdrop({ width, top, children }: {
  width: number
  top: number
  children: React.ReactNode
}) {
  const size = useWindowSize()
  return (
    <anchored
      deferred
      position={{ x: Math.max(0, Math.round((size.width - width) / 2)), y: top }}
      anchor="topLeft"
      occlude
      style={{ borderRadius: radius.lg }}
    >
      {children}
    </anchored>
  )
}

export function CommandPalette({ state }: { state: AppState }) {
  const [query, setQuery] = useState("")
  const commands = buildCommands(state)
  const results = rank(commands, query)
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
                placeholder="Search commands, workspaces, and sessions"
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
                {`No command matches “${query}”`}
              </Label>
            </div>
          ) : null}
        </div>
      </Combobox>
    </Backdrop>
  )
}

function DialogShell({
  title,
  description,
  children,
  onClose,
}: {
  title: string
  description: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <Backdrop width={DIALOG_WIDTH} top={140}>
      <div
        testId="dialog"
        onMouseDownOutside={onClose}
        style={{ ...overlayStyle(space.xl, space.xl), width: DIALOG_WIDTH, gap: space.lg }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <Label size={text.title} color={color.text}>
            {title}
          </Label>
          <Paragraph size={text.small} color={color.tertiary}>
            {description}
          </Paragraph>
        </div>
        {children}
      </div>
    </Backdrop>
  )
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
      }}
    >
      <Icon name="circleAlert" size={12} color={color.danger} />
      <Label size={text.small} color={color.danger}>
        {message}
      </Label>
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space.md,
      }}
    >
      {children}
    </div>
  )
}

export function Dialogs({ state }: { state: AppState }) {
  const dialog = state.dialog
  if (!dialog) return null
  const close = () => setDialog(null)

  if (dialog.kind === "add-workspace") {
    const submit = () => {
      const candidate = path.resolve(dialog.value.trim().replace(/^~/, process.env.HOME ?? "~"))
      if (!isDirectory(candidate)) {
        setDialog({ ...dialog, error: "That path is not a directory on this machine." })
        return
      }
      if (state.workspaces.some((workspace) => workspace.path === candidate)) {
        setDialog({ ...dialog, error: "That directory is already a workspace." })
        return
      }
      close()
      const workspace = createWorkspace(candidate, path.basename(candidate))
      openSession(createSession(workspace.id).id)
    }
    return (
      <DialogShell
        title="Add a workspace"
        description="The agent can read, edit, and run commands inside this directory and nowhere else."
        onClose={close}
      >
        <TextField
          testId="workspace-path"
          value={dialog.value}
          placeholder="/Users/you/projects/app"
          onChange={(value) => setDialog({ ...dialog, value, error: null })}
          onSubmit={submit}
        />
        {dialog.error ? <ErrorLine message={dialog.error} /> : null}
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Add workspace"
            variant="primary"
            testId="confirm-add-workspace"
            onClick={submit}
            hint="↩"
          />
        </Actions>
      </DialogShell>
    )
  }

  if (dialog.kind === "rename-session") {
    const submit = () => {
      const title = dialog.value.trim()
      close()
      if (title) updateSession(dialog.sessionId, (session) => ({ ...session, title }))
    }
    return (
      <DialogShell
        title="Rename this session"
        description="The name shows in the sidebar, the palette, and the pane header."
        onClose={close}
      >
        <TextField
          testId="session-title"
          value={dialog.value}
          placeholder="What this session is about"
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={submit}
        />
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Rename"
            variant="primary"
            testId="confirm-rename-session"
            onClick={submit}
            hint="↩"
          />
        </Actions>
      </DialogShell>
    )
  }

  if (dialog.kind === "delete-session") {
    const session = findSession(state, dialog.sessionId)
    return (
      <DialogShell
        title="Delete this session?"
        description={`“${session?.title ?? "This session"}” and its saved history are removed. The files it changed are not touched.`}
        onClose={close}
      >
        <Actions>
          <Button label="Cancel" variant="ghost" onClick={close} />
          <Button
            label="Delete session"
            variant="danger"
            testId="confirm-delete-session"
            onClick={() => {
              close()
              removeSession(dialog.sessionId)
            }}
          />
        </Actions>
      </DialogShell>
    )
  }

  const workspace = findWorkspace(state, dialog.workspaceId)
  const count = state.sessions.filter(
    (session) => session.workspaceId === dialog.workspaceId,
  ).length
  return (
    <DialogShell
      title="Remove this workspace?"
      description={`“${workspace?.name ?? "This workspace"}” and its ${count} session${count === 1 ? "" : "s"} are removed from fx. The directory on disk is not touched.`}
      onClose={close}
    >
      <Actions>
        <Button label="Cancel" variant="ghost" onClick={close} />
        <Button
          label="Remove workspace"
          variant="danger"
          testId="confirm-remove-workspace"
          onClick={() => {
            close()
            removeWorkspace(dialog.workspaceId)
          }}
        />
      </Actions>
    </DialogShell>
  )
}
