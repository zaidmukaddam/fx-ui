import { memo, useState } from "react"

import { color, columnFor, FONT, space, text } from "../../ui/theme"
import { EmptyState, FX_MARK } from "../../ui/ui"
import {
  createSession,
  openSession,
  type Message,
  type Session,
  type Workspace,
} from "../../store"
import { Approval, Question } from "./blocking"
import { AssistantMessage, Notice, UserMessage } from "./messages"
import { ColumnWidth, HoldTail } from "./shared"
import { ToolResult } from "./tool"

const SCROLL_FADE_HEIGHT = 32

function hasRow(message: Message): boolean {
  return !(
    message.kind === "approval" &&
    message.decision !== "pending" &&
    message.decision !== "granted"
  )
}

function gapBefore(message: Message, previous: Message | undefined): number {
  if (!previous) return 0
  const dense =
    (message.kind === "tool" || message.kind === "notice") &&
    (previous.kind === "tool" || previous.kind === "notice")
  return dense ? space.xs : space.xl
}

const MessageRow = memo(function MessageRow({
  sessionId,
  message,
}: {
  sessionId: string
  message: Message
}) {
  switch (message.kind) {
    case "user":
      return <UserMessage message={message} />
    case "assistant":
      return <AssistantMessage message={message} />
    case "tool":
      return <ToolResult message={message} />
    case "approval":
      return <Approval sessionId={sessionId} message={message} />
    case "question":
      return <Question sessionId={sessionId} message={message} />
    case "notice":
      return <Notice sessionId={sessionId} message={message} />
  }
})

export function Transcript({
  session,
  paneWidth,
}: {
  session: Session
  paneWidth: number
}) {
  const { column, gutter } = columnFor(paneWidth)
  const rows = session.messages.filter(hasRow)
  const [heldAt, setHeldAt] = useState<number | null>(null)
  const holdTail = () => setHeldAt(rows.length)

  if (session.messages.length === 0) {
    return (
      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text
          testId="session-art"
          style={{
            fontSize: text.small,
            fontFamily: FONT,
            lineHeight: Math.round(text.small * 1.05),
            color: color.faint,
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          {FX_MARK}
        </text>
      </div>
    )
  }

  return (
    <ColumnWidth.Provider value={column}>
      <HoldTail.Provider value={holdTail}>
      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
      <virtual-list
        alignment="top"
        followTail={heldAt !== rows.length}
        estimatedItemHeight={90}
        overdraw={600}
        style={{ flexGrow: 1, minHeight: 0 }}
      >
        {rows.map((message, index) => (
          <div
            key={message.id}
            style={{
              display: "flex",
              flexDirection: "column",
              paddingLeft: gutter,
              paddingRight: gutter,
              paddingTop:
                gapBefore(message, rows[index - 1]) +
                (index === 0 ? SCROLL_FADE_HEIGHT / 2 : 0),
              ...(index === rows.length - 1
                ? { paddingBottom: SCROLL_FADE_HEIGHT }
                : null),
            }}
          >
            <MessageRow sessionId={session.id} message={message} />
          </div>
        ))}
      </virtual-list>

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: SCROLL_FADE_HEIGHT,
          pointerEvents: "none",
          background: {
            type: "linear-gradient",
            angle: 0,
            stops: [
              { color: "#00000000", position: 0 },
              { color: color.background, position: 1 },
            ],
          },
        }}
      />

      <div
          style={{
            height: SCROLL_FADE_HEIGHT,
            flexShrink: 0,
            marginTop: -SCROLL_FADE_HEIGHT,
            pointerEvents: "none",
            background: {
              type: "linear-gradient",
              angle: 180,
              stops: [
                { color: "#00000000", position: 0 },
                { color: color.background, position: 1 },
              ],
            },
          }}
        />
      </div>
      </HoldTail.Provider>
    </ColumnWidth.Provider>
  )
}

export function NoSession({
  workspace,
  onAddWorkspace,
}: {
  workspace: Workspace | null
  onAddWorkspace: () => void
}) {
  if (!workspace) {
    return (
      <EmptyState
        icon="folderPlus"
        art={FX_MARK}
        title="Add a workspace"
        description="A workspace is the directory the agent works in. Everything it reads, edits, and runs stays inside it."
        action={{
          label: "Add workspace",
          icon: "folderPlus",
          onClick: onAddWorkspace,
          testId: "empty-add-workspace",
        }}
        hints={[
          { keys: "⌘⇧O", label: "add workspace" },
          { keys: "⌘K", label: "commands" },
        ]}
      />
    )
  }
  return (
    <EmptyState
      icon="message"
      art={FX_MARK}
      title="No session open"
      description={`Start a conversation in ${workspace.name}. Type @ to attach a file, / to run a skill.`}
      action={{
        label: "New session",
        icon: "plus",
        onClick: () => openSession(createSession(workspace.id).id),
        testId: "empty-new-session",
      }}
      hints={[
        { keys: "⌘N", label: "new session" },
        { keys: "⌘K", label: "commands" },
        { keys: "⌘\\", label: "split" },
      ]}
    />
  )
}
