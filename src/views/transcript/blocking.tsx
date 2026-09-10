import { useState } from "react"

import { Icon } from "../../ui/icons"
import { color, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { Button, Label } from "../../ui/ui"
import { resolveApproval, resolveQuestion } from "../../tools"
import { type Message } from "../../store"
import { COLLAPSED_LINES, GUTTER, Row } from "./shared"

export function Question({
  sessionId,
  message,
}: {
  sessionId: string
  message: Extract<Message, { kind: "question" }>
}) {
  const [draft, setDraft] = useState("")

  if (message.answer !== null) {
    return (
      <Row>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            height: 22,
          }}
        >
          <div style={{ width: GUTTER - space.md, flexShrink: 0, display: "flex", justifyContent: "center" }}>
            <Icon name="message" size={12} color={color.faint} />
          </div>
          <Label truncate size={text.small} color={color.tertiary}>
            {message.answer ? `${message.question} → ${message.answer}` : `Dismissed · ${message.question}`}
          </Label>
        </div>
      </Row>
    )
  }

  return (
    <Row>
      <div
        testId={`question-${message.questionId}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: space.lg,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.raised,
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Icon name="message" size={13} color={color.text} />
          <Label grow size={text.body} color={color.text}>
            {message.question}
          </Label>
        </div>

        {message.options.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              flexWrap: "wrap",
            }}
          >
            {message.options.map((option, index) => (
              <Button
                key={option}
                label={option}
                variant={index === 0 ? "primary" : "secondary"}
                size="sm"
                testId={`answer-${message.questionId}-${option}`}
                onClick={() => resolveQuestion(sessionId, message.questionId, option)}
              />
            ))}
            <Button
              label="Dismiss"
              variant="ghost"
              size="sm"
              testId={`dismiss-${message.questionId}`}
              onClick={() => resolveQuestion(sessionId, message.questionId, null)}
            />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
            <div
              style={{
                display: "flex",
                flexGrow: 1,
                minWidth: 0,
                height: 26,
                paddingLeft: space.md,
                paddingRight: space.md,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: color.border,
                backgroundColor: color.background,
                overflow: "hidden",
              }}
            >
              <textarea
                testId={`answer-${message.questionId}`}
                value={draft}
                placeholder="Your answer"
                minRows={1}
                maxRows={4}
                theme={nativeTheme}
                onChange={(event) => setDraft(event.value ?? "")}
                onSubmit={() =>
                  draft.trim() && resolveQuestion(sessionId, message.questionId, draft.trim())
                }
                style={{
                  flexGrow: 1,
                  minWidth: 0,
                  fontSize: text.small,
                  fontFamily: FONT,
                  marginTop: -6,
                  color: color.text,
                }}
              />
            </div>
            <Button
              label="Answer"
              variant="primary"
              size="sm"
              disabled={!draft.trim()}
              testId={`submit-${message.questionId}`}
              onClick={() => resolveQuestion(sessionId, message.questionId, draft.trim())}
            />
          </div>
        )}
      </div>
    </Row>
  )
}

export function Approval({
  sessionId,
  message,
}: {
  sessionId: string
  message: Extract<Message, { kind: "approval" }>
}) {
  if (message.decision !== "pending") {
    if (message.decision !== "granted") return null
    return (
      <Row>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            height: 22,
          }}
        >
          <div
            style={{
              width: GUTTER - space.md,
              flexShrink: 0,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <Icon name="check" size={11} color={color.faint} />
          </div>
          <Label size={text.small} color={color.ghost}>
            {`Won't ask again · ${message.title}`}
          </Label>
        </div>
      </Row>
    )
  }

  return (
    <Row>
      <div
        testId={`approval-${message.approvalId}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: space.lg,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border,
          borderLeftWidth: 2,
          backgroundColor: color.raised,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
          }}
        >
          <Icon name="shieldAlert" size={13} color={color.text} />
          <Label grow truncate size={text.body} color={color.text}>
            {message.title}
          </Label>
          <Label size={text.micro} color={color.ghost}>
            {message.toolName}
          </Label>
        </div>

        {message.patch ? (
          <diff patch={message.patch} wordDiff maxLines={COLLAPSED_LINES} theme={nativeTheme} />
        ) : (
          <code
            code={message.detail}
            language={message.language ?? "bash"}
            theme={nativeTheme}
            style={{
              padding: space.lg,
              borderRadius: radius.md,
              backgroundColor: color.background,
            }}
          />
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
          }}
        >
          <Button
            label="Yes"
            variant="primary"
            size="sm"
            testId={`approve-${message.approvalId}`}
            onClick={() => resolveApproval(sessionId, message.approvalId, "allowed")}
          />
          <Button
            label="Yes, and don't ask again"
            size="sm"
            testId={`grant-${message.approvalId}`}
            onClick={() => resolveApproval(sessionId, message.approvalId, "granted")}
          />
          <div style={{ flexGrow: 1 }} />
          <Button
            label="No"
            variant="danger"
            size="sm"
            testId={`deny-${message.approvalId}`}
            onClick={() => resolveApproval(sessionId, message.approvalId, "denied")}
          />
        </div>
      </div>
    </Row>
  )
}
