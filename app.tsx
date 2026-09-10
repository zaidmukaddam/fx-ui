import { spawnSync } from "node:child_process"
import { useState } from "react"
import { motion, render, useWindowSize } from "@gpuix/react"
import type { EventPayload } from "@gpuix/native"

import { cancel, closeAll, send } from "./src/agent/agent"
import { stopAllBackgroundCommands } from "./src/tools"
import { refreshCredentials } from "./src/agent/credentials"
import { Composer } from "./src/views/composer"
import { CommandPalette } from "./src/views/palette"
import { Dialogs } from "./src/views/dialogs"
import { SettingsPage } from "./src/views/settings"
import { Sidebar, SIDEBAR_WIDTH } from "./src/views/sidebar"
import {
  color,
  PANE_PADDING,
  radius,
  space,
  text,
  titlebarBand,
  TRAFFIC_LIGHT_INSET,
} from "./src/ui/theme"
import { NoSession, Transcript } from "./src/views/transcript"
import { Badge, Explain, IconButton, Label, TooltipProvider } from "./src/ui/ui"
import { isClean, refreshGitStatus, summarise } from "./src/workspace/git"
import { CAN_PICK_IMAGES, pasteImage } from "./src/workspace/images"
import { useMountEffect } from "./src/ui/hooks"
import {
  findSession,
  findWorkspace,
  flushState,
  getState,
  setDialog,
  setOverlay,
  setPalette,
  setSettings,
  setSplit,
  setState,
  startSession,
  useApp,
  type AppState,
} from "./src/store"

const MIN_SPLIT_RATIO = 0.25
const DIVIDER_WIDTH = 5

function BranchChip({ workspaceId }: { workspaceId: string }) {
  const status = useApp().git[workspaceId]
  useMountEffect(() => {
    void refreshGitStatus(workspaceId)
  })

  if (!status) return null
  const dirty = !isClean(status)

  return (
    <Explain
      lines={[
        summarise(status),
        dirty ? "Uncommitted changes in this workspace" : "Nothing to commit",
      ]}
    >
      <div
        testId="branch-chip"
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          height: 20,
          flexShrink: 0,
          paddingLeft: space.sm,
          paddingRight: space.sm,
          borderRadius: radius.sm,
          backgroundColor: color.muted,
        }}
      >
        <Label truncate size={text.micro} color={color.tertiary}>
          {status.branch}
        </Label>
        {dirty ? (
          <div
            style={{
              width: 5,
              height: 5,
              flexShrink: 0,
              borderRadius: 3,
              backgroundColor: color.danger,
            }}
          />
        ) : null}
      </div>
    </Explain>
  )
}

function PaneHeader({
  state,
  index,
  needsInset,
  focused,
  onPeek,
  canPin,
}: {
  state: AppState
  index: number
  needsInset: boolean
  focused: boolean
  onPeek?: () => void
  canPin?: boolean
}) {
  const sessionId = state.panes[index]?.sessionId ?? null
  const session = findSession(state, sessionId)
  const workspace = findWorkspace(state, session?.workspaceId ?? null)
  const split = state.panes.length > 1

  return (
    <div testId={`pane-band-${index}`} style={{ flexShrink: 0 }}>
      <div
        testId={`pane-header-${index}`}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          ...titlebarBand,
          paddingLeft: needsInset ? TRAFFIC_LIGHT_INSET : PANE_PADDING,
          paddingRight: space.lg,
          userSelect: "none",
        }}
      >
        {onPeek && index === 0 ? (
          <IconButton
            icon="panelLeft"
            tooltip={canPin ? "Show sidebar  ⌘B" : "Open sidebar"}
            testId="show-sidebar"
            onClick={
              canPin
                ? () => setState((current) => ({ ...current, sidebarCollapsed: false }))
                : onPeek
            }
          />
        ) : null}

        {workspace ? (
          <Label size={text.small} color={focused ? color.faint : color.ghost}>
            {workspace.name}
          </Label>
        ) : null}
        {session ? (
          <>
            <Label size={text.small} color={color.ghost}>
              /
            </Label>
            <div
              testId={`session-title-${index}`}
              onClick={() =>
                setDialog({ kind: "rename-session", sessionId: session.id, value: session.title })
              }
              style={{
                display: "flex",
                minWidth: 0,
                flexShrink: 1,
                paddingLeft: space.xs,
                paddingRight: space.xs,
                borderRadius: radius.sm,
                cursor: "pointer",
                hover: { backgroundColor: color.hover },
              }}
            >
              <Label truncate size={text.body} color={focused ? color.text : color.faint}>
                {session.title}
              </Label>
            </div>
          </>
        ) : (
          <Label size={text.body} color={color.ghost}>
            Empty pane
          </Label>
        )}

        {workspace ? <BranchChip key={workspace.id} workspaceId={workspace.id} /> : null}

        {session?.status === "running" ? <Badge tone={color.text}>running</Badge> : null}
        {session?.status === "error" ? <Badge tone={color.danger}>error</Badge> : null}

        <div style={{ flexGrow: 1, minWidth: 0 }} />

        {index === 0 ? (
          <IconButton
            icon="columns"
            tooltip={split ? "Close split view  ⌘\\" : "Split view  ⌘\\"}
            testId="toggle-split"
            active={split}
            onClick={() => setSplit(!split)}
          />
        ) : (
          <IconButton
            icon="panelRightClose"
            tooltip="Close this pane  ⌘\"
            testId="close-split"
            onClick={() => setSplit(false)}
          />
        )}
      </div>
    </div>
  )
}

function Pane({
  state,
  index,
  needsInset,
  grow,
  paneWidth,
  onPeek,
  canPin,
}: {
  state: AppState
  index: number
  needsInset: boolean
  onPeek?: () => void
  canPin?: boolean
  grow: number
  paneWidth: number
}) {
  const focused = state.focusedPane === index || state.panes.length === 1
  const sessionId = state.panes[index]?.sessionId ?? null
  const session = findSession(state, sessionId)
  const workspace = findWorkspace(
    state,
    session?.workspaceId ?? state.activeWorkspaceId,
  )

  return (
    <div
      testId={`pane-${index}`}
      onMouseDown={() =>
        setState((current) =>
          current.focusedPane === index
            ? current
            : { ...current, focusedPane: index },
        )
      }
      style={{
        flexGrow: grow,
        flexBasis: 0,
        minWidth: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: color.background,
      }}
    >
      <PaneHeader
        state={state}
        index={index}
        needsInset={needsInset}
        focused={focused}
        onPeek={onPeek}
        canPin={canPin}
      />

      {session && workspace ? (
        <>
          <Transcript session={session} paneWidth={paneWidth} />
          <Composer
            session={session}
            root={workspace.path}
            paneWidth={paneWidth}
            onSend={(prompt, images) => void send(session.id, prompt, images)}
            onStop={() => cancel(session.id)}
          />
        </>
      ) : (
        <NoSession
          workspace={workspace}
          onAddWorkspace={() =>
            setDialog({ kind: "add-workspace", value: process.cwd(), error: null })
          }
        />
      )}
    </div>
  )
}

function SplitDivider({ dragging, onStart }: { dragging: boolean; onStart: () => void }) {
  return (
    <div
      testId="split-divider"
      onMouseDown={onStart}
      style={{
        width: DIVIDER_WIDTH,
        height: "100%",
        flexShrink: 0,
        display: "flex",
        justifyContent: "center",
        cursor: "col-resize",
      }}
    >
      <div
        style={{
          width: 1,
          height: "100%",
          backgroundColor: dragging ? color.text : color.border,
          pointerEvents: "none",
        }}
      />
    </div>
  )
}

export function onWindowKeyDown(event: EventPayload): void {
  const state = getState()

  if (event.key === "escape") {
    if (state.overlay) {
      setOverlay(null)
      return
    }
    if (state.settingsOpen) setSettings(false)
    return
  }
  if (!event.modifiers?.cmd) return

  const focusedSessionId = state.panes[state.focusedPane]?.sessionId ?? null

  switch (event.key) {
    case "k":
      setPalette(state.overlay?.kind !== "palette")
      return
    case ",":
      setSettings(!state.settingsOpen)
      return
    case "n": {
      const workspaceId = state.activeWorkspaceId ?? state.workspaces[0]?.id
      if (workspaceId) startSession(workspaceId)
      else setDialog({ kind: "add-workspace", value: process.cwd(), error: null })
      return
    }
    case "o":
      if (event.modifiers.shift) {
        setDialog({ kind: "add-workspace", value: process.cwd(), error: null })
      }
      return
    case "b":
      setState((current) => ({
        ...current,
        sidebarCollapsed: !current.sidebarCollapsed,
      }))
      return
    case "\\":
      setSplit(state.panes.length === 1)
      return
    case ".":
      if (focusedSessionId) cancel(focusedSessionId)
      return
    case "v":
      if (CAN_PICK_IMAGES && focusedSessionId && !state.settingsOpen) {
        void pasteImage(focusedSessionId)
      }
      return
  }
}

const SIDEBAR_MIN_WINDOW = 720

export function FxApp() {
  const state = useApp()
  const size = useWindowSize()
  const [peeking, setPeeking] = useState(false)
  const [dragging, setDragging] = useState(false)

  const cramped = size.width < SIDEBAR_MIN_WINDOW
  const sidebarHidden = state.sidebarCollapsed || cramped

  const contentLeft = sidebarHidden ? 0 : SIDEBAR_WIDTH

  const split = state.panes.length > 1

  const available = Math.max(0, size.width - contentLeft - (split ? DIVIDER_WIDTH : 0))
  const paneWidths = split
    ? [
        Math.round(available * state.splitRatio),
        available - Math.round(available * state.splitRatio),
      ]
    : [available]

  const resizeTo = (x: number | undefined) => {
    if (x === undefined) return
    const width = Math.max(1, size.width - contentLeft)
    const splitRatio = Math.min(
      1 - MIN_SPLIT_RATIO,
      Math.max(MIN_SPLIT_RATIO, (x - contentLeft) / width),
    )
    setState((current) => ({ ...current, splitRatio }))
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: color.background,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            flexGrow: 1,
            minHeight: 0,
          }}
        >
          <motion.div
            initial={false}
            animate={{ width: sidebarHidden ? 0 : SIDEBAR_WIDTH }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            style={{
              display: "flex",
              flexDirection: "row",
              height: "100%",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            <Sidebar state={state} />
          </motion.div>

          {state.settingsOpen ? (
            <SettingsPage
              state={state}
              needsInset={sidebarHidden}
              width={available}
            />
          ) : (
            <>
          <Pane
            state={state}
            index={0}
            needsInset={sidebarHidden}
            onPeek={sidebarHidden ? () => setPeeking(true) : undefined}
            canPin={!cramped}
            grow={split ? state.splitRatio : 1}
            paneWidth={paneWidths[0]}
          />

          {split ? (
            <>
              <SplitDivider dragging={dragging} onStart={() => setDragging(true)} />
              <Pane
                state={state}
                index={1}
                needsInset={false}
                grow={1 - state.splitRatio}
                paneWidth={paneWidths[1]}
              />
            </>
          ) : null}
            </>
          )}
        </div>

        {sidebarHidden && peeking ? (
          <anchored deferred position={{ x: 0, y: 0 }} anchor="topLeft" occlude>
            <motion.div
              onMouseDownOutside={() => setPeeking(false)}
              initial={{ width: 0 }}
              animate={{ width: SIDEBAR_WIDTH }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              style={{
                height: size.height,
                display: "flex",
                flexDirection: "row",
                overflow: "hidden",
                pointerEvents: "auto",
                borderRightWidth: 1,
                borderColor: color.border,
                boxShadow: {
                  offsetX: 8,
                  offsetY: 0,
                  blurRadius: 24,
                  spreadRadius: -8,
                  color: "#000000cc",
                },
              }}
            >
              <Sidebar state={state} />
            </motion.div>
          </anchored>
        ) : null}

        {state.overlay?.kind === "palette" ? <CommandPalette state={state} /> : null}
        <Dialogs state={state} />

        {dragging ? (
          <div
            onMouseMove={(event: EventPayload) => resizeTo(event.x)}
            onMouseUp={() => setDragging(false)}
            onMouseLeave={() => setDragging(false)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              cursor: "col-resize",
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

const isEntryPoint =
  typeof Bun !== "undefined"
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof window !== "undefined"

function inheritLoginPath(): void {
  if (process.env.TERM) return
  const marker = "__fx_path__"
  const { stdout } = spawnSync(
    process.env.SHELL || "/bin/zsh",
    ["-ilc", `printf '${marker}%s${marker}' "$PATH"`],
    { encoding: "utf8", timeout: 5_000 },
  )
  const found = stdout?.split(marker)[1]
  if (found) process.env.PATH = found
}

if (isEntryPoint) {
  inheritLoginPath()
  void refreshCredentials()
  process.on("exit", () => {
    flushState()
    stopAllBackgroundCommands()
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      flushState()
      void closeAll().finally(() => process.exit(0))
    })
  }

  render(<FxApp />, {
    title: "fx",
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    titlebarTransparent: true,
    windowBackground: "opaque",
    trafficLightX: 18,
    trafficLightY: 24,
    onKeyDown: onWindowKeyDown,
    focus: typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
  })
}
