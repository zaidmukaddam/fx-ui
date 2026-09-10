import { useContext, useState } from "react"

import { Icon, type IconName } from "../../ui/icons"
import { color, nativeTheme, radius, space, text } from "../../ui/theme"
import { Label } from "../../ui/ui"
import { type Message } from "../../store"
import { COLLAPSED_LINES, GUTTER, Gutter, HoldTail, Row } from "./shared"

const TOOL_ICONS: Record<string, IconName> = {
  ask_user_question: "message",
  capability_search: "search",
  edit_file: "filePen",
  git_diff: "fileDiff",
  git_log: "history",
  git_status: "gitBranch",
  glob_files: "fileSearch",
  grep_files: "search",
  install_skill: "download",
  list_files: "list",
  mcp_features: "plug",
  mcp_select_tool: "plug",
  read_file: "fileText",
  read_tool_result: "scrollText",
  shell: "terminal",
  skill: "sparkle",
  subagent: "bot",
  vision: "image",
  web_fetch: "link",
  web_search: "globe",
  write_file: "filePen",
  x_search: "search",
}

function duration(from: number, to: number | undefined): string {
  if (!to) return ""
  const seconds = (to - from) / 1000
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`
}

function outcome(message: Extract<Message, { kind: "tool" }>): {
  label: string
  tone: string
} {
  switch (message.state) {
    case "running":
      return { label: "running", tone: color.faint }
    case "denied":
      return { label: "denied", tone: color.tertiary }
    case "error":
      return { label: "error", tone: color.danger }
    default:
      return { label: duration(message.at, message.endedAt), tone: color.ghost }
  }
}

export function ToolResult({
  message,
}: {
  message: Extract<Message, { kind: "tool" }>
}) {
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState(false)
  const holdTail = useContext(HoldTail)
  const hasBody = Boolean(message.patch || message.output)

  const lines = message.output ? message.output.split("\n") : []
  const clipped = !full && lines.length > COLLAPSED_LINES
  const hidden = clipped ? lines.length - COLLAPSED_LINES : 0

  const toggle = () => {
    setExpanded((current) => !current)
    holdTail()
  }

  const nameColor =
    message.state === "error"
      ? color.danger
      : message.state === "denied"
        ? color.tertiary
        : color.secondary
  const result = outcome(message)

  return (
    <Row>
      <div
        testId={`tool-${message.id}`}
        onClick={hasBody ? toggle : undefined}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          height: 26,
          paddingRight: space.md,
          borderRadius: radius.sm,
          userSelect: "none",
          cursor: hasBody ? "pointer" : "default",
          hover: hasBody ? { backgroundColor: color.hover } : undefined,
        }}
      >
        <Gutter>
          <Icon
            name={TOOL_ICONS[message.name] ?? "box"}
            size={12}
            color={message.state === "error" ? color.danger : color.faint}
          />
        </Gutter>
        <Label size={text.small} color={nameColor}>
          {message.name}
        </Label>
        <Label grow truncate size={text.small} color={color.faint}>
          {message.label}
        </Label>
        <Label size={text.micro} color={result.tone}>
          {result.label}
        </Label>
        {hasBody ? (
          <Icon
            name={expanded ? "chevronDown" : "chevronRight"}
            size={12}
            color={color.ghost}
          />
        ) : null}
      </div>

      {expanded ? (
        <div
          style={{
            marginLeft: GUTTER - space.md + space.xs,
            marginTop: space.sm,
            marginBottom: space.sm,
            paddingLeft: space.lg,
            borderLeftWidth: 1,
            borderColor: color.border,
            minWidth: 0,
          }}
        >
          {message.patch ? (
            <diff
              patch={message.patch}
              wordDiff
              maxLines={full ? undefined : COLLAPSED_LINES}
              onShowMore={() => {
                setFull(true)
                holdTail()
              }}
              theme={nativeTheme}
            />
          ) : (
            <code
              code={clipped ? lines.slice(0, COLLAPSED_LINES).join("\n") : message.output}
              language={message.language ?? "bash"}
              theme={nativeTheme}
              style={{ paddingTop: space.xs, paddingBottom: space.xs }}
            />
          )}
          {clipped ? (
            <div
              testId={`show-more-${message.id}`}
              onClick={() => {
                setFull(true)
                holdTail()
              }}
              style={{
                display: "flex",
                alignItems: "center",
                height: 22,
                alignSelf: "flex-start",
                paddingRight: space.md,
                borderRadius: radius.sm,
                cursor: "pointer",
                userSelect: "none",
                hover: { backgroundColor: color.hover },
              }}
            >
              <Label size={text.micro} color={color.tertiary}>
                {`Show ${hidden.toLocaleString()} more line${hidden === 1 ? "" : "s"}`}
              </Label>
            </div>
          ) : null}
        </div>
      ) : null}
    </Row>
  )
}
