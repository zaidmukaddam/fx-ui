import { useState } from "react"

import { color, columnFor, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { IconButton, Thumbnail } from "../../ui/ui"
import { canAnswer, setAttachments, useApp, type Session } from "../../store"
import { CAN_PICK_IMAGES } from "../../workspace/images"
import { useT } from "../../ui/i18n"
import { ContextMeter } from "./context"
import {
  AttachMenu,
  BackgroundChip,
  EffortPicker,
  FastToggle,
  ModePicker,
  ModelPicker,
} from "./pickers"
import { useTokenPicker } from "./picker"
import { TokenPicker } from "./tokens"

const PROMPT_ROW_HEIGHT = 15
const PROMPT_LIFT = -6

const CARD_PADDING = space.lg
const CARD_PADDING_Y = space.sm

const THUMBNAIL_SIZE = 56

export const COMPOSER_CARD_INSET = CARD_PADDING + 1

const ADVANCE_RATIO = 0.619

const SEND_SIZE = 24

const PROMPT_CHROME = (CARD_PADDING + 1) * 2 + SEND_SIZE + space.md

function fitsOneRow(draft: string, column: number): boolean {
  if (draft.includes("\n")) return false
  const perRow = Math.floor((column - PROMPT_CHROME) / (text.body * ADVANCE_RATIO)) - 2
  return draft.length <= Math.max(8, perRow)
}

export function Composer({
  session,
  root,
  paneWidth,
  onSend,
  onStop,
}: {
  session: Session
  root: string
  paneWidth: number
  onSend: (prompt: string, images: string[]) => void
  onStop: () => void
}) {
  const { column, gutter } = columnFor(paneWidth)
  const t = useT()
  const [draft, setDraft] = useState("")
  const picker = useTokenPicker(draft, setDraft, root)
  const state = useApp()
  const running = session.status === "running"
  const attached = state.attachments[session.id] ?? []
  const ready = (draft.trim().length > 0 || attached.length > 0) && !running
  const readyToAnswer = canAnswer(state, session)

  const tight = column < 340
  const oneRow = fitsOneRow(draft, column)

  const submit = () => {
    if (picker.open && picker.suggestions.length > 0) {
      picker.pick(picker.suggestions[picker.highlighted]!.value)
      return
    }
    if (!ready) return
    onSend(draft, attached)
    setAttachments(session.id, [])
    setDraft("")
    picker.reset()
  }

  const sendAffordance = running ? (
    <IconButton
      icon="square"
      size={SEND_SIZE}
      tooltip={t("composer.stopTip")}
      testId="stop"
      tooltipSide="top"
      tooltipAlign="end"
      tone={color.danger}
      onClick={onStop}
    />
  ) : (
    <IconButton
      glyph="⏎"
      size={SEND_SIZE}
      tooltip={t("composer.sendTip")}
      testId="send"
      tooltipSide="top"
      tooltipAlign="end"
      tone={ready ? color.text : color.ghost}
      onClick={submit}
    />
  )

  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        paddingLeft: gutter,
        paddingRight: gutter,
        paddingBottom: space.lg,
      }}
    >
      {picker.open ? (
        <div style={{ height: 0, minWidth: 0 }}>
          <div style={{ position: "absolute", bottom: space.xs, left: 0, right: 0 }}>
            <TokenPicker
              suggestions={picker.suggestions}
              empty={picker.empty}
              highlighted={picker.highlighted}
              onPick={picker.pick}
            />
          </div>
        </div>
      ) : null}

      <div
        testId="composer-column"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          minWidth: 0,
          paddingLeft: CARD_PADDING,
          paddingRight: CARD_PADDING,
          paddingTop: CARD_PADDING_Y,
          paddingBottom: CARD_PADDING_Y,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.raised,
          boxShadow: {
            offsetX: 0,
            offsetY: 4,
            blurRadius: 16,
            spreadRadius: -4,
            color: "#000000cc",
          },
        }}
      >
        {attached.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              gap: space.md,
              paddingTop: space.sm,
            }}
          >
            {attached.map((file, at) => (
              <Thumbnail
                key={file}
                file={file}
                size={THUMBNAIL_SIZE}
                testId={`attachment-${at}`}
                onRemove={() =>
                  setAttachments(
                    session.id,
                    attached.filter((entry) => entry !== file),
                  )
                }
              />
            ))}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: oneRow ? "center" : "flex-end",
            gap: space.md,
          }}
        >
          <div
            style={{
              display: "flex",
              flexGrow: 1,
              minWidth: 0,
              height: oneRow ? PROMPT_ROW_HEIGHT : undefined,
              overflow: "hidden",
            }}
          >
          <textarea
            testId="composer"
            value={draft}
            placeholder={
              running
                ? t("composer.running")
                : readyToAnswer
                  ? t("composer.ask")
                  : t("composer.addKey")
            }
            minRows={1}
            maxRows={12}
            autoFocus
            theme={nativeTheme}
            onChange={(event) => picker.onDraftChange(event.value ?? "")}
            onKeyDown={picker.onKeyDown}
            onSubmit={submit}
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: text.body,
              fontFamily: FONT,
              marginTop: oneRow ? PROMPT_LIFT : 0,
              color: color.text,
            }}
          />
          </div>
          <div style={{ marginRight: -space.sm, flexShrink: 0 }}>{sendAffordance}</div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          minWidth: 0,
          paddingTop: space.md,
        }}
      >
        <ModePicker session={session} />
        <div style={{ marginLeft: -2, flexShrink: 0 }}>
          {CAN_PICK_IMAGES ? (
            <AttachMenu session={session} onMention={picker.attach} />
          ) : (
            <IconButton
              icon="plus"
              size={24}
              tooltip={t("composer.attachTip")}
              testId="attach-file"
              tooltipSide="top"
              tooltipAlign="start"
              onClick={picker.attach}
            />
          )}
        </div>

        <BackgroundChip session={session} />

        <div style={{ flexGrow: 1, minWidth: 0 }} />

        <ModelPicker session={session} compact={tight} />
        {tight ? null : <FastToggle session={session} />}
        {tight ? null : <EffortPicker session={session} />}
        <ContextMeter session={session} />
      </div>
    </div>
  )
}
