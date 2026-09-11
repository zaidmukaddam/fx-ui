import { useState } from "react"
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@gpuix/react/combobox"

import { Icon, type IconName } from "../ui/icons"
import { useT, type Translate } from "../ui/i18n"
import { color, nativeTheme, radius, space, text } from "../ui/theme"
import { Backdrop, Kbd, Label, fieldStyle, overlayStyle } from "../ui/ui"
import { cancel, reloadSkills } from "../agent/agent"
import { setUseCli, signInWithFx } from "../agent/credentials"
import { forgetGrants, lastEdit, undoLastEdit } from "../tools"
import {
  clearNotices,
  findSession,
  findWorkspace,
  notice,
  openSession,
  setDialog,
  setPalette,
  setSettings,
  setSplit,
  setState,
  startSession,
  type AppState,
} from "../store"

const PALETTE_WIDTH = 560
const PALETTE_TOP = 96
const MAX_RESULTS = 8

type Command = {
  id: string
  label: string
  detail?: string
  icon: IconName
  hint?: string
  run: () => void
}

function buildCommands(state: AppState, t: Translate): Command[] {
  const commands: Command[] = []
  const workspaceId = state.activeWorkspaceId ?? state.workspaces[0]?.id ?? null
  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  const split = state.panes.length > 1

  if (workspaceId) {
    commands.push({
      id: "new-session",
      label: t("cmd.newSession"),
      icon: "plus",
      hint: "⌘N",
      run: () => startSession(workspaceId),
    })
  }
  commands.push({
    id: "add-workspace",
    label: t("cmd.addWorkspace"),
    icon: "folderPlus",
    hint: "⌘⇧O",
    run: () => setDialog({ kind: "add-workspace", value: process.cwd(), error: null }),
  })
  commands.push({
    id: "toggle-split",
    label: split ? t("cmd.closeSplit") : t("cmd.openSplit"),
    icon: "columns",
    hint: "⌘\\",
    run: () => setSplit(!split),
  })
  commands.push({
    id: "toggle-sidebar",
    label: state.sidebarCollapsed ? t("cmd.showSidebar") : t("cmd.hideSidebar"),
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
      label: t("cmd.stopTurn"),
      icon: "square",
      hint: "⌘.",
      run: () => cancel(focused),
    })
  }
  if (focused) {
    commands.push({
      id: "reload-skills",
      label: t("cmd.reloadSkills"),
      detail: t("cmd.reloadSkills.detail"),
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
      label: t("cmd.clearNotices"),
      detail: t("cmd.clearNotices.detail"),
      icon: "x",
      run: () => clearNotices(focused),
    })
  }
  const undoable = focused ? lastEdit(focused) : null
  if (focused && undoable) {
    commands.push({
      id: "undo-edit",
      label: t("cmd.undoEdit", { file: undoable }),
      detail: t("cmd.undoEdit.detail"),
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
  commands.push({
    id: "settings",
    label: t("cmd.settings"),
    detail: t("cmd.settings.detail"),
    icon: "settings",
    hint: "⌘,",
    run: () => setSettings(true),
  })
  commands.push({
    id: "fx-sign-in",
    label: t("cmd.fxSignIn"),
    detail: t("cmd.fxSignIn.detail"),
    icon: "terminal",
    run: () => void signInWithFx(),
  })
  commands.push({
    id: "use-cli",
    label: state.useCli ? t("cmd.runInProcess") : t("cmd.runCli"),
    detail: state.useCli
      ? t("cmd.runInProcess.detail")
      : t("cmd.runCli.detail"),
    icon: "terminal",
    run: () => void setUseCli(!state.useCli),
  })

  for (const workspace of state.workspaces) {
    commands.push({
      id: `workspace:${workspace.id}`,
      label: t("cmd.goTo", { name: workspace.name }),
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
      label: t("cmd.renameSession"),
      icon: "filePen",
      run: () =>
        setDialog({ kind: "rename-session", sessionId: focused, value: session?.title ?? "" }),
    })
    if (session && session.grants.length > 0) {
      commands.push({
        id: "forget-grants",
        label: t("cmd.forgetGrants"),
        icon: "shieldAlert",
        run: () => forgetGrants(focused),
      })
    }
    commands.push({
      id: "delete-session",
      label: t("cmd.deleteSession"),
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

export function CommandPalette({ state }: { state: AppState }) {
  const t = useT()
  const [query, setQuery] = useState("")
  const commands = buildCommands(state, t)
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
                placeholder={t("palette.search")}
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
                {t("palette.noMatch", { query })}
              </Label>
            </div>
          ) : null}
        </div>
      </Combobox>
    </Backdrop>
  )
}

