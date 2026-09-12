import { useState } from "react"

import { estimateContext } from "../../agent/agent"
import { useMountEffect } from "../../ui/hooks"
import { color, columnFor, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { IconButton, Label, Thumbnail } from "../../ui/ui"
import {
  canAnswer,
  removeQueued,
  setAttachments,
  useApp,
  type QueuedPrompt,
  type Session,
} from "../../store"
import { CAN_PICK_IMAGES } from "../../workspace/images"
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

function queuedLabel(item: QueuedPrompt): string {
  const line = item.text.trim().split("\n")[0] ?? ""
  if (line) return line
  if (item.images.length === 1) return "1 image"
  if (item.images.length > 1) return `${item.images.length} images`
  return "Queued"
}

function Queue({ sessionId, items }: { sessionId: string; items: QueuedPrompt[] }) {
  if (items.length === 0) return null

  return (
    <div
      testId="queue"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.xs,
        paddingTop: space.sm,
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          testId={`queue-${item.id}`}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            minWidth: 0,
          }}
        >
          <Label truncate size={text.small} color={color.faint} grow>
            {queuedLabel(item)}
          </Label>
          <IconButton
            icon="x"
            size={18}
            tooltip="Remove from queue"
            testId={`queue-dismiss-${item.id}`}
            tone={color.ghost}
            onClick={() => removeQueued(sessionId, item.id)}
          />
        </div>
      ))}
    </div>
  )
}

/** Unsent text per session. The composer remounts when its pane opens another
 *  session, so the draft cannot live in its state alone. */
const drafts = new Map<string, string>()

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
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? "")
  const setDraft = (value: string) => {
    if (value) drafts.set(session.id, value)
    else drafts.delete(session.id)
    setDraftState(value)
  }
  const picker = useTokenPicker(draft, setDraft, session, root)
  const state = useApp()
  const running = session.status === "running"

  useMountEffect(() => {
    void estimateContext(session.id)
  })

  const attached = state.attachments[session.id] ?? []
  const queued = state.queue[session.id] ?? []
  const hasContent = draft.trim().length > 0 || attached.length > 0
  const canSend = hasContent || queued.length > 0
  const readyToAnswer = canAnswer(state, session)

  const tight = column < 340
  const oneRow = fitsOneRow(draft, column)

  const submit = () => {
    if (picker.open && picker.suggestions.length > 0) {
      picker.pick(picker.suggestions[picker.highlighted]!)
      return
    }
    if (running) {
      if (!hasContent) return
      onSend(draft, attached)
      setAttachments(session.id, [])
      setDraft("")
      picker.reset()
      return
    }
    if (hasContent) {
      onSend(draft, attached)
      setAttachments(session.id, [])
      setDraft("")
      picker.reset()
      return
    }
    if (queued.length > 0) onSend("", [])
  }

  const sendAffordance = running ? (
    <IconButton
      icon="square"
      size={SEND_SIZE}
      tooltip="Stop  ⌘."
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
      tooltip="Send ⏎"
      testId="send"
      tooltipSide="top"
      tooltipAlign="end"
      tone={!running && canSend ? color.text : color.ghost}
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
      {running && session.compacting ? (
        <div testId="compaction-status" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: space.sm }}>
          <div style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.tertiary }} />
          <Label size={text.small} color={color.tertiary}>Compacting…</Label>
        </div>
      ) : null}
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
        <Queue sessionId={session.id} items={queued} />
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
                ? "Running · ⏎ to queue"
                : !hasContent && queued.length > 0
                  ? "⏎ sends the next queued prompt"
                  : readyToAnswer
                    ? "Ask fx to change something"
                    : "Add a key in Settings to send"
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
          flexWrap: "wrap",
          rowGap: space.xs,
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
              tooltip="Attach a file  @"
              testId="attach-file"
              tooltipSide="top"
              tooltipAlign="start"
              onClick={picker.attach}
            />
          )}
        </div>

        <BackgroundChip session={session} width={column} />

        <div style={{ flexGrow: 1, minWidth: 0 }} />

        <ModelPicker session={session} maxWidth={tight ? Math.max(96, column - 190) : 320} />
        {tight ? null : <FastToggle session={session} />}
        {tight ? null : <EffortPicker session={session} />}
        <ContextMeter session={session} />
      </div>
    </div>
  )
}
