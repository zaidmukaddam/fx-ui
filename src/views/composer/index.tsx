import { useState } from "react"

import {
  activeCommand,
  activeMention,
  applyMention,
  rankFiles,
  type Trigger,
} from "../../workspace/files"
import { listWorkspaceFiles } from "../../tools"
import { loadSkills, type SkillCommand } from "../../workspace/skills"
import { color, columnFor, FONT, nativeTheme, radius, space, text } from "../../ui/theme"
import { IconButton, Thumbnail } from "../../ui/ui"
import { setAttachments, useApp, type Session } from "../../store"
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
import { MENTION_RESULTS, rank } from "./shared"
import { TokenPicker, type Suggestion } from "./tokens"

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
  const [draft, setDraft] = useState("")
  const [index, setIndex] = useState<{ root: string; files: string[] } | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [commands, setCommands] = useState<SkillCommand[]>([])
  const running = session.status === "running"
  const attached = useApp().attachments[session.id] ?? []
  const ready = (draft.trim().length > 0 || attached.length > 0) && !running

  const tight = column < 340
  const oneRow = fitsOneRow(draft, column)

  const files = index?.root === root ? index.files : null
  const mention = dismissed ? null : activeMention(draft)
  const command = dismissed ? null : activeCommand(draft)
  const open: Trigger | null = mention ? "@" : command ? "/" : null

  const suggestions: Suggestion[] =
    open === "@"
      ? files
        ? rankFiles(files, mention!.query, MENTION_RESULTS).map((file) => ({
            value: file,
            label: file,
            icon: "fileText" as const,
          }))
        : []
      : open === "/"
        ? rank(
            commands.map((entry) => entry.name),
            command!.query,
            MENTION_RESULTS,
          ).map((name) => ({
            value: name,
            label: `/${name}`,
            detail: commands.find((entry) => entry.name === name)?.description,
            icon: "sparkle" as const,
          }))
        : []

  const empty =
    open === "@"
      ? files === null
        ? "Reading the workspace…"
        : mention?.query
          ? `No file matches ${mention.query}`
          : "No files in this workspace"
      : command?.query
        ? `No skill named ${command.query}`
        : "No skills in this workspace"

  const readWorkspace = () => {
    void listWorkspaceFiles(root).then((found) => setIndex({ root, files: found }))
  }
  const readCommands = () => {
    void loadSkills(root).then((loaded) => setCommands(loaded.commands))
  }

  const pick = (value: string) => {
    setDraft(open === "/" ? `/${value} ` : applyMention(draft, value))
    setHighlighted(0)
  }

  const attach = () => {
    setDraft(draft.length === 0 || draft.endsWith(" ") ? `${draft}@` : `${draft} @`)
    setDismissed(false)
    setHighlighted(0)
    readWorkspace()
  }

  const submit = () => {
    if (open && suggestions.length > 0) {
      pick(suggestions[Math.min(highlighted, suggestions.length - 1)]!.value)
      return
    }
    if (!ready) return
    onSend(draft, attached)
    setAttachments(session.id, [])
    setDraft("")
    setDismissed(false)
    setHighlighted(0)
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
      tone={ready ? color.text : color.ghost}
      onClick={submit}
    />
  )

  const onKeyDown = (event: { key?: string }) => {
    if (!open) return
    if (event.key === "escape") {
      setDismissed(true)
      return
    }
    if (suggestions.length === 0) return
    if (event.key === "down") setHighlighted((at) => (at + 1) % suggestions.length)
    else if (event.key === "up")
      setHighlighted((at) => (at - 1 + suggestions.length) % suggestions.length)
    else if (event.key === "tab")
      pick(suggestions[Math.min(highlighted, suggestions.length - 1)]!.value)
  }

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
      {open ? (
        <div style={{ height: 0, minWidth: 0 }}>
          <div style={{ position: "absolute", bottom: space.xs, left: 0, right: 0 }}>
            <TokenPicker
              suggestions={suggestions}
              empty={empty}
              highlighted={Math.min(highlighted, Math.max(0, suggestions.length - 1))}
              onPick={pick}
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
            placeholder={running ? "Running · ⌘. to stop" : "Ask fx to change something"}
            minRows={1}
            maxRows={12}
            autoFocus
            theme={nativeTheme}
            onChange={(event) => {
              const next = event.value ?? ""
              const before = activeMention(draft)
              const after = activeMention(next)
              const commandBefore = activeCommand(draft)
              const commandAfter = activeCommand(next)
              if (after && !before) readWorkspace()
              if (commandAfter && !commandBefore) readCommands()
              if (
                after?.query !== before?.query ||
                commandAfter?.query !== commandBefore?.query
              ) {
                setHighlighted(0)
                if (!after && !commandAfter) setDismissed(false)
              }
              setDraft(next)
            }}
            onKeyDown={onKeyDown}
            onSubmit={submit}
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: text.body,
              fontFamily: FONT,
              marginTop: PROMPT_LIFT,
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
            <AttachMenu session={session} onMention={attach} />
          ) : (
            <IconButton
              icon="plus"
              size={24}
              tooltip="Attach a file  @"
              testId="attach-file"
              tooltipSide="top"
              tooltipAlign="start"
              onClick={attach}
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
