import { useState } from "react"
import os from "node:os"

import { Icon } from "../ui/icons"
import {
  color,
  radius,
  space,
  text,
  titlebarBand,
  TRAFFIC_LIGHT_INSET,
} from "../ui/theme"
import { Button, Explain, IconButton, Label } from "../ui/ui"
import {
  credential,
  createSession,
  openSession,
  setDialog,
  setPalette,
  setSettings,
  setState,
  type AppState,
  type Session,
  type Workspace,
} from "../store"

export const SIDEBAR_WIDTH = 244

function shortPath(full: string): string {
  const home = os.homedir()
  return full.startsWith(home) ? `~${full.slice(home.length)}` : full
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function WorkspaceRow({
  workspace,
  sessionCount,
  active,
  onSelect,
}: {
  workspace: Workspace
  sessionCount: number
  active: boolean
  onSelect: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      testId={`workspace-${workspace.id}`}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        paddingTop: space.xs,
        paddingBottom: space.xs,
        paddingLeft: space.md,
        paddingRight: space.xs,
        borderRadius: radius.md,
        cursor: "pointer",
        userSelect: "none",
        hover: { backgroundColor: color.hover },
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          height: 22,
        }}
      >
        <Icon
          name={active ? "chevronDown" : "chevronRight"}
          size={11}
          color={color.ghost}
        />
        <Label grow truncate size={text.body} color={active ? color.text : color.secondary}>
          {workspace.name}
        </Label>
        {hovered ? (
          <IconButton
            icon="x"
            size={18}
            tooltip="Remove workspace"
            testId={`remove-workspace-${workspace.id}`}
            onClick={() =>
              setDialog({ kind: "remove-workspace", workspaceId: workspace.id })
            }
          />
        ) : (
          <div style={{ paddingRight: space.sm }}>
            <Label size={text.micro} color={color.ghost}>
              {String(sessionCount)}
            </Label>
          </div>
        )}
      </div>
      {active ? (
        <div style={{ paddingLeft: 11 + space.sm, paddingBottom: 2 }}>
          <Label truncate size={text.micro} color={color.ghost}>
            {shortPath(workspace.path)}
          </Label>
        </div>
      ) : null}
    </div>
  )
}

function SessionRow({
  session,
  paneIndex,
  splitOpen,
  onOpen,
}: {
  session: Session
  paneIndex: number
  splitOpen: boolean
  onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const open = paneIndex >= 0
  const asking = session.messages.find(
    (message) =>
      (message.kind === "approval" && message.decision === "pending") ||
      (message.kind === "question" && message.answer === null),
  )
  return (
    <div
      testId={`session-${session.id}`}
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        height: 26,
        marginLeft: space.lg,
        paddingLeft: space.md,
        paddingRight: space.xs,
        borderRadius: radius.md,
        backgroundColor: open ? color.muted : undefined,
        cursor: "pointer",
        userSelect: "none",
        hover: open ? undefined : { backgroundColor: color.hover },
      }}
    >
      <div
        testId={asking ? `waiting-${session.id}` : undefined}
        style={{
          width: 10,
          flexShrink: 0,
          display: "flex",
          justifyContent: "center",
        }}
      >
        {asking ? (
          <Icon
            name={asking.kind === "approval" ? "shieldAlert" : "message"}
            size={11}
            color={color.text}
          />
        ) : session.status === "running" ? (
          <div
            style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.text }}
          />
        ) : session.status === "error" ? (
          <Icon name="circleAlert" size={11} color={color.danger} />
        ) : (
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: open ? color.tertiary : color.border,
            }}
          />
        )}
      </div>

      <Label grow truncate size={text.small} color={open ? color.text : color.tertiary}>
        {session.title}
      </Label>

      {hovered ? (
        <IconButton
          icon="trash"
          size={18}
          tooltip="Delete session"
          testId={`delete-session-${session.id}`}
          onClick={() => setDialog({ kind: "delete-session", sessionId: session.id })}
        />
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingRight: space.sm,
          }}
        >
          {open && splitOpen ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 13,
                height: 13,
                borderRadius: radius.sm,
                backgroundColor: color.selected,
              }}
            >
              <Label size={text.micro} color={color.tertiary}>
                {String(paneIndex + 1)}
              </Label>
            </div>
          ) : null}
          <Label size={text.micro} color={color.ghost}>
            {ago(session.updatedAt)}
          </Label>
        </div>
      )}
    </div>
  )
}

export function Sidebar({ state }: { state: AppState }) {
  const paneOf = (sessionId: string) =>
    state.panes.findIndex((pane) => pane.sessionId === sessionId)
  const splitOpen = state.panes.length > 1
  const status = credential(state)

  const newSession = (workspaceId: string) => openSession(createSession(workspaceId).id)

  return (
    <div
      style={{
        width: SIDEBAR_WIDTH,
        height: "100%",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: color.raised,
        borderRightWidth: 1,
        borderColor: color.border,
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            ...titlebarBand,
            paddingLeft: TRAFFIC_LIGHT_INSET || space.lg,
            paddingRight: space.md,
            userSelect: "none",
          }}
        >
          <Icon name="fxMark" size={16} color={color.text} />
          <div style={{ flexGrow: 1 }} />
          <IconButton
            icon="search"
            size={24}
            tooltip="Command palette  ⌘K"
            testId="open-palette"
            onClick={() => setPalette(true)}
          />
          <IconButton
            icon="plus"
            size={24}
            tooltip="New session  ⌘N"
            testId="new-session"
            onClick={() => {
              const workspaceId = state.activeWorkspaceId ?? state.workspaces[0]?.id
              if (!workspaceId) {
                setDialog({ kind: "add-workspace", value: process.cwd(), error: null })
                return
              }
              newSession(workspaceId)
            }}
          />
        </div>
      </div>

      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: "scroll",
          paddingLeft: space.md,
          paddingRight: space.md,
          paddingBottom: space.lg,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            height: 26,
            paddingLeft: space.md,
            paddingRight: space.xs,
            userSelect: "none",
          }}
        >
          <Label grow size={text.micro} color={color.ghost}>
            Workspaces
          </Label>
          <IconButton
            icon="folderPlus"
            size={18}
            tooltip="Add workspace  ⌘⇧O"
            testId="add-workspace"
            onClick={() => setDialog({ kind: "add-workspace", value: process.cwd(), error: null })}
          />
        </div>

        {state.workspaces.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.md,
              paddingLeft: space.md,
              paddingRight: space.md,
              paddingTop: space.md,
            }}
          >
            <Label size={text.small} color={color.ghost}>
              No workspaces yet.
            </Label>
            <Button
              label="Add a directory"
              icon="folderPlus"
              size="sm"
              testId="sidebar-add-workspace"
              onClick={() =>
                setDialog({ kind: "add-workspace", value: process.cwd(), error: null })
              }
            />
          </div>
        ) : null}

        {state.workspaces.map((workspace) => {
          const sessions = state.sessions.filter(
            (session) => session.workspaceId === workspace.id,
          )
          const active = workspace.id === state.activeWorkspaceId
          return (
            <div
              key={workspace.id}
              style={{ display: "flex", flexDirection: "column", gap: 1 }}
            >
              <WorkspaceRow
                workspace={workspace}
                sessionCount={sessions.length}
                active={active}
                onSelect={() =>
                  setState((current) => ({
                    ...current,
                    activeWorkspaceId: active ? null : workspace.id,
                  }))
                }
              />
              {active
                ? sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      paneIndex={paneOf(session.id)}
                      splitOpen={splitOpen}
                      onOpen={() => openSession(session.id)}
                    />
                  ))
                : null}
              {active ? (
                <div
                  testId={`new-session-${workspace.id}`}
                  onClick={() => newSession(workspace.id)}
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    height: 26,
                    marginLeft: space.lg,
                    paddingLeft: space.md,
                    borderRadius: radius.md,
                    cursor: "pointer",
                    userSelect: "none",
                    hover: { backgroundColor: color.hover },
                  }}
                >
                  <div style={{ width: 10, display: "flex", justifyContent: "center" }}>
                    <Icon name="plus" size={11} color={color.ghost} />
                  </div>
                  <Label size={text.small} color={color.ghost}>
                    New session
                  </Label>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          height: 38,
          paddingLeft: space.md,
          paddingRight: space.md,
          flexShrink: 0,
          borderTopWidth: 1,
          borderColor: color.border,
          userSelect: "none",
        }}
      >
        <Explain lines={status.detail}>
          <div
            testId="gateway-status"
            onClick={() => setSettings(true)}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              flexGrow: 1,
              minWidth: 0,
              height: 26,
              paddingLeft: space.sm,
              paddingRight: space.sm,
              borderRadius: radius.md,
              cursor: "pointer",
              hover: { backgroundColor: color.hover },
            }}
          >
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: 3,
                flexShrink: 0,
                backgroundColor: status.ready ? color.tertiary : color.danger,
              }}
            />
            <Label grow truncate size={text.small} color={color.tertiary}>
              {status.label}
            </Label>
          </div>
        </Explain>
        <IconButton
          icon="settings"
          size={22}
          tooltip="Settings  ⌘,"
          testId="open-settings"
          active={state.settingsOpen}
          onClick={() => setSettings(!state.settingsOpen)}
        />
      </div>
    </div>
  )
}
