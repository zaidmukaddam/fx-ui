import { spawn } from "node:child_process"
import { useContext, useState } from "react"

import { Icon } from "../../ui/icons"
import { color, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { Button, IconButton, Label, Thumbnail } from "../../ui/ui"
import { openExternally } from "../../agent/oauth"
import { removeMessage, setSettings, type Message } from "../../store"
import { GUTTER, Gutter, HoldTail, Row } from "./shared"

const IMAGE_SIZE = 80

export function UserMessage({ message }: { message: Extract<Message, { kind: "user" }> }) {
  return (
    <Row>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.md,
        }}
      >
        <text
          style={{
            width: GUTTER - space.md,
            flexShrink: 0,
            fontSize: text.body,
            fontFamily: FONT,
            color: color.tertiary,
            lineHeight: 21,
            userSelect: "none",
          }}
        >
          ❯
        </text>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.sm,
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          {message.text ? (
            <text
              style={{
                fontSize: text.body,
                fontFamily: FONT,
                color: color.text,
                lineHeight: 21,
              }}
            >
              {message.text}
            </text>
          ) : null}
          {message.images ? (
            <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {message.images.map((file, at) => (
                <Thumbnail
                  key={file}
                  file={file}
                  size={IMAGE_SIZE}
                  testId={`message-image-${message.id}-${at}`}
                  onClick={() => void openExternally(file)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Row>
  )
}

function Reasoning({ body }: { body: string }) {
  const [open, setOpen] = useState(false)
  const holdTail = useContext(HoldTail)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      <div
        testId="reasoning-toggle"
        onClick={() => {
          setOpen((current) => !current)
          holdTail()
        }}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          height: 22,
          alignSelf: "flex-start",
          paddingRight: space.md,
          borderRadius: radius.sm,
          cursor: "pointer",
          userSelect: "none",
          hover: { backgroundColor: color.hover },
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={11} color={color.ghost} />
        <Label size={text.small} color={color.ghost}>
          Reasoning
        </Label>
      </div>
      {open ? (
        <div
          style={{
            paddingLeft: space.lg,
            borderLeftWidth: 1,
            borderColor: color.border,
          }}
        >
          <markdown
            source={body}
            theme={{ ...nativeTheme, text: color.faint }}
            style={{ color: color.faint }}
          />
        </div>
      ) : null}
    </div>
  )
}

const COPIED_MS = 1500

export function copyText(value: string): void {
  const child = spawn("pbcopy")
  child.on("error", () => {})
  child.stdin.end(value)
}

export function AssistantMessage({
  message,
  copyable = false,
}: {
  message: Extract<Message, { kind: "assistant" }>
  copyable?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Row>
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        {message.reasoning ? <Reasoning body={message.reasoning} /> : null}
        {message.text ? (
          <markdown source={message.text} theme={nativeTheme} style={{ color: color.text }} />
        ) : null}
        {copyable && message.text ? (
          <div style={{ display: "flex", flexDirection: "row" }}>
            <IconButton
              icon={copied ? "check" : "copy"}
              size={22}
              tooltip={copied ? "Copied" : "Copy"}
              testId={`copy-${message.id}`}
              tone={color.ghost}
              onClick={() => {
                copyText(message.text)
                setCopied(true)
                setTimeout(() => setCopied(false), COPIED_MS)
              }}
            />
          </div>
        ) : null}
      </div>
    </Row>
  )
}

export function Notice({
  sessionId,
  message,
}: {
  sessionId: string
  message: Extract<Message, { kind: "notice" }>
}) {
  const tone = message.tone === "error" ? color.danger : color.ghost
  return (
    <Row>
      <div
        testId={`notice-${message.id}`}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.md,
          paddingRight: space.xs,
          borderRadius: radius.sm,
        }}
      >
        <Gutter top={3}>
          <Icon
            name={message.tone === "error" ? "circleAlert" : "info"}
            size={11}
            color={tone}
          />
        </Gutter>
        <text
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontSize: text.small,
            fontFamily: FONT,
            color: tone,
            lineHeight: 19,
          }}
        >
          {message.text}
        </text>
        {message.action === "settings" ? (
          <Button
            label="Settings"
            size="sm"
            testId={`notice-settings-${message.id}`}
            onClick={() => setSettings(true)}
          />
        ) : null}
        <IconButton
          icon="x"
          size={18}
          tooltip="Dismiss"
          testId={`notice-dismiss-${message.id}`}
          tone={color.ghost}
          onClick={() => removeMessage(sessionId, message.id)}
        />
      </div>
    </Row>
  )
}
