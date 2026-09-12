import { useContext, useRef, useState } from "react"
import { useGpuix, type PublicInstance } from "@gpuix/react"
import type { EventPayload } from "@gpuix/native"

import { Icon, type IconName } from "../../ui/icons"
import { color, nativeTheme, radius, space, text } from "../../ui/theme"
import { Label } from "../../ui/ui"
import { type Message, type SubagentStep } from "../../store"
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

function toolSummary(steps: SubagentStep[] | undefined): string {
  if (!steps || steps.length === 0) return ""
  const counts = new Map<string, number>()
  for (const step of steps) counts.set(step.name, (counts.get(step.name) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ")
}

function stepTone(state: SubagentStep["state"]): string {
  if (state === "error") return color.danger
  if (state === "denied") return color.tertiary
  return color.faint
}

function SubagentStepRow({
  step,
  rows,
  onMoveFocus,
}: {
  step: SubagentStep
  rows: React.RefObject<Map<string, PublicInstance>>
  onMoveFocus: (from: string, delta: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const holdTail = useContext(HoldTail)
  const hasBody = Boolean(step.output.trim())
  const tone = stepTone(step.state)

  const toggle = () => {
    setOpen((value) => !value)
    holdTail()
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div
        testId={`subagent-step-${step.id}`}
        ref={(node: PublicInstance | null) => {
          if (node) rows.current.set(step.id, node)
          else rows.current.delete(step.id)
        }}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={hasBody ? toggle : undefined}
        onKeyDown={(event: EventPayload) => {
          if (event.key === "enter" || event.key === "space") {
            if (hasBody) toggle()
            return
          }
          if (event.key === "down") onMoveFocus(step.id, 1)
          else if (event.key === "up") onMoveFocus(step.id, -1)
        }}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          height: 22,
          paddingLeft: space.sm + 12 + space.md,
          paddingRight: space.md,
          borderRadius: radius.sm,
          cursor: hasBody ? "pointer" : "default",
          userSelect: "none",
          backgroundColor: focused ? color.hover : undefined,
          hover: hasBody ? { backgroundColor: color.hover } : undefined,
        }}
      >
        <Icon name={TOOL_ICONS[step.name] ?? "box"} size={11} color={color.ghost} />
        <Label size={text.micro} color={color.tertiary}>
          {step.name}
        </Label>
        <Label grow truncate size={text.micro} color={color.faint}>
          {step.label !== step.name ? step.label : ""}
        </Label>
        {step.state === "running" ? (
          <div style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.text }} />
        ) : (
          <Icon name={step.state === "error" ? "circleAlert" : "check"} size={10} color={tone} />
        )}
      </div>
      {open ? (
        <div
          style={{
            paddingLeft: space.sm + 12 + space.lg,
            paddingRight: space.md,
            paddingBottom: space.xs,
            maxHeight: 160,
            overflowY: "scroll",
          }}
        >
          <code code={step.output || "(no output)"} language="text" theme={nativeTheme} />
        </div>
      ) : null}
    </div>
  )
}

function SubagentCard({ message }: { message: Extract<Message, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false)
  const holdTail = useContext(HoldTail)
  const renderer = useGpuix().renderer
  const rows = useRef<Map<string, PublicInstance>>(new Map())
  const running = message.state === "running"
  const steps = message.steps ?? []
  const summary = toolSummary(steps)
  const elapsed = duration(message.at, message.endedAt ?? Date.now())
  const result = outcome(message)

  const moveFocus = (from: string, delta: number) => {
    const at = steps.findIndex((step) => step.id === from)
    const next = steps[at + delta]
    if (!next) return
    const node = rows.current.get(next.id)
    if (node) renderer?.focusElement?.(node.id)
  }

  return (
    <Row>
      <div
        testId={`tool-${message.id}`}
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          marginRight: space.md,
          borderWidth: 1,
          borderColor: color.border,
          borderRadius: radius.md,
          backgroundColor: color.raised,
        }}
      >
        <div
          onClick={() => {
            setExpanded(!expanded)
            holdTail()
          }}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            height: 28,
            paddingLeft: space.sm,
            paddingRight: space.md,
            cursor: "pointer",
            userSelect: "none",
            hover: { backgroundColor: color.hover },
          }}
        >
          <Icon
            name="bot"
            size={12}
            color={message.state === "error" ? color.danger : color.secondary}
          />
          <Label size={text.small} color={color.secondary}>
            subagent
          </Label>
          <Label grow truncate size={text.small} color={color.text}>
            {message.label.replace(/ · [^·]+$/, "")}
          </Label>
          <Label size={text.micro} color={result.tone}>
            {`${elapsed}${result.label && result.label !== elapsed ? ` · ${result.label}` : ""}`}
          </Label>
          <Icon
            name={expanded ? "chevronDown" : "chevronRight"}
            size={12}
            color={color.ghost}
          />
        </div>

        {!expanded && summary ? (
          <div
            style={{
              display: "flex",
              paddingLeft: space.sm + 12 + space.md,
              paddingRight: space.md,
              paddingBottom: space.xs,
            }}
          >
            <Label truncate size={text.micro} color={color.faint}>
              {summary}
            </Label>
          </div>
        ) : null}

        {expanded ? (
          <div
            style={{
              minWidth: 0,
              paddingTop: space.xs,
              paddingBottom: space.sm,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            {steps.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {steps.map((step) => (
                  <SubagentStepRow
                    key={step.id}
                    step={step}
                    rows={rows}
                    onMoveFocus={moveFocus}
                  />
                ))}
              </div>
            ) : running ? (
              <div style={{ paddingLeft: space.md, paddingRight: space.md }}>
                <Label size={text.small} color={color.tertiary}>
                  Starting…
                </Label>
              </div>
            ) : null}

            <div
              style={{
                minWidth: 0,
                paddingLeft: space.md,
                paddingRight: space.md,
                paddingTop: steps.length > 0 ? space.sm : 0,
              }}
            >
              {running && steps.length === 0 ? null : running ? (
                <Label size={text.small} color={color.tertiary}>
                  Working…
                </Label>
              ) : message.output ? (
                <markdown
                  source={message.output}
                  theme={nativeTheme}
                  style={{ color: color.text }}
                />
              ) : (
                <Label size={text.small} color={color.tertiary}>
                  No answer returned.
                </Label>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Row>
  )
}

export function ToolResult({
  message,
}: {
  message: Extract<Message, { kind: "tool" }>
}) {
  if (message.name === "subagent") return <SubagentCard message={message} />
  return <ToolRow message={message} />
}

function ToolRow({
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
