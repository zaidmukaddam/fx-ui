import { useContext, useState } from "react"

import { Icon } from "../../ui/icons"
import { color, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { Label, Thumbnail } from "../../ui/ui"
import { openExternally } from "../../agent/oauth"
import { removeMessage, type Message } from "../../store"
import { GUTTER, HoldTail, Row } from "./shared"

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

export function AssistantMessage({
  message,
}: {
  message: Extract<Message, { kind: "assistant" }>
}) {
  return (
    <Row>
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        {message.reasoning ? <Reasoning body={message.reasoning} /> : null}
        {message.text ? (
          <markdown source={message.text} theme={nativeTheme} style={{ color: color.text }} />
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
        onClick={() => removeMessage(sessionId, message.id)}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.md,
          paddingRight: space.md,
          borderRadius: radius.sm,
          cursor: "pointer",
          hover: { backgroundColor: color.hover },
        }}
      >
        <div
          style={{
            width: GUTTER - space.md,
            flexShrink: 0,
            display: "flex",
            justifyContent: "center",
            paddingTop: 3,
          }}
        >
          <Icon
            name={message.tone === "error" ? "circleAlert" : "info"}
            size={11}
            color={tone}
          />
        </div>
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
      </div>
    </Row>
  )
}
