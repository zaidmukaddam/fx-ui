import { memo, useState } from "react"
import { motion } from "@gpuix/react"

import { type IconName } from "../../ui/icons"
import { color, columnFor, FONT, space, text } from "../../ui/theme"
import { Button, Kbd, Label, Paragraph } from "../../ui/ui"
import {
  startSession,
  type Message,
  type Session,
  type Workspace,
} from "../../store"
import { Approval, Question } from "./blocking"
import { AssistantMessage, Notice, UserMessage } from "./messages"
import { ColumnWidth, HoldTail } from "./shared"
import { ToolResult } from "./tool"

const SCROLL_FADE_HEIGHT = 32

const FX_MARK = [
  " ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀",
  " ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  " ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆",
  " ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀",
  " ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀",
  " ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀",
  " ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀",
  " ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦",
  "  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  " ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
].join("\n")

function Mark({ testId }: { testId?: string }) {
  return (
    <text
      testId={testId}
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
  )
}

function EmptyState({
  title,
  description,
  action,
  hints,
}: {
  title: string
  description: string
  action?: { label: string; icon?: IconName; onClick: () => void; testId?: string }
  hints?: { keys: string; label: string }[]
}) {
  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.lg,
        paddingLeft: space.xxl,
        paddingRight: space.xxl,
      }}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <Mark testId="empty-art" />
      </motion.div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: space.sm,
          maxWidth: 460,
        }}
      >
        <Label size={text.title} color={color.text}>
          {title}
        </Label>
        <Paragraph align="center" color={color.faint}>
          {description}
        </Paragraph>
      </div>
      {action ? (
        <Button
          label={action.label}
          icon={action.icon}
          onClick={action.onClick}
          testId={action.testId}
          variant="secondary"
        />
      ) : null}
      {hints && hints.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.lg,
            paddingTop: space.sm,
          }}
        >
          {hints.map((hint) => (
            <div
              key={hint.keys}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <Kbd keys={hint.keys} />
              <Label size={text.micro} color={color.ghost}>
                {hint.label}
              </Label>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

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

function copyableIds(rows: Message[], running: boolean): Set<string> {
  const ids = new Set<string>()
  let after: Message["kind"] | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind === "assistant" && (after === "user" || (after === null && !running))) {
      ids.add(row.id)
    }
    if (row.kind !== "notice") after = row.kind
  }
  return ids
}

const MessageRow = memo(function MessageRow({
  sessionId,
  message,
  copyable,
}: {
  sessionId: string
  message: Message
  copyable: boolean
}) {
  switch (message.kind) {
    case "user":
      return <UserMessage message={message} />
    case "assistant":
      return <AssistantMessage message={message} copyable={copyable} />
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
  const copyable = copyableIds(rows, session.status === "running")
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
        <Mark testId="session-art" />
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
            <MessageRow
              sessionId={session.id}
              message={message}
              copyable={copyable.has(message.id)}
            />
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
      title="No session open"
      description={`Start a conversation in ${workspace.name}. Type @ to attach a file, / to run a skill.`}
      action={{
        label: "New session",
        icon: "plus",
        onClick: () => startSession(workspace.id),
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
