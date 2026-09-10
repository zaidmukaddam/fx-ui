import { useRef, useState } from "react"
import { useGpuix, type PublicInstance } from "@gpuix/react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@gpuix/react/select"

import { Icon } from "../../ui/icons"
import { color, radius, space, text } from "../../ui/theme"
import { Button, EffortDial, Explain, Label, overlayStyle } from "../../ui/ui"
import { stopBackgroundCommand } from "../../tools"
import { attachImages, chooseImages, pasteImage } from "../../workspace/images"
import {
  DEFAULT_MODEL,
  sessionModel,
  updateSession,
  useApp,
  type PermissionMode,
  type Session,
} from "../../store"
import { ModelChoice, keyOf } from "../models"

const MONOSPACE_ADVANCE = 0.6

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Every edit and command asks" },
  { value: "auto", label: "Auto", hint: "Edits run, commands ask" },
  {
    value: "full-access",
    label: "Full access",
    hint: "Accept all permissions",
  },
]

export function ModelPicker({ session, compact }: { session: Session; compact: boolean }) {
  return (
    <ModelChoice
      testId="model-picker"
      value={keyOf({
        id: session.model ?? DEFAULT_MODEL.id,
        provider: session.provider ?? null,
        name: null,
      })}
      label={session.modelName ?? DEFAULT_MODEL.name}
      maxWidth={compact ? 160 : 320}
      size={text.micro}
      onChange={(chosen) => {
        if (!chosen) return
        updateSession(session.id, (current) => ({
          ...current,
          model: chosen.id,
          provider: chosen.provider,
          modelName: chosen.name,
        }))
      }}
    />
  )
}

function effortTriggerWidth(options: string[]): number {
  const widest = options.reduce((longest, option) => Math.max(longest, option.length), 0)
  return Math.ceil(widest * MONOSPACE_ADVANCE * text.micro) + space.sm * 2
}

export function FastToggle({ session }: { session: Session }) {
  const tier = sessionModel(useApp(), session)?.fast
  if (!tier) return null
  const on = session.fast ?? false

  return (
    <Explain lines={[tier.label, tier.detail, "Changing it restarts the conversation."]}>
      <div
        testId="fast-toggle"
        onClick={() =>
          updateSession(session.id, (current) => ({ ...current, fast: !on }))
        }
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          height: 24,
          flexShrink: 0,
          paddingLeft: space.sm,
          paddingRight: space.sm,
          borderRadius: radius.sm,
          backgroundColor: on ? color.selected : undefined,
          cursor: "pointer",
          userSelect: "none",
          hover: { backgroundColor: on ? color.selected : color.hover },
        }}
      >
        <Label size={text.micro} color={on ? color.text : color.ghost}>
          {tier.label}
        </Label>
      </div>
    </Explain>
  )
}

export function EffortPicker({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const chosen = sessionModel(useApp(), session)
  const options = chosen?.efforts ?? []
  const value =
    session.effort ?? chosen?.defaultEffort ?? options[Math.floor(options.length / 2)] ?? ""
  if (options.length < 2) return null

  return (
    <Select open={open} onOpenChange={setOpen} value="effort" onValueChange={() => {}}>
      <SelectTrigger asChild>
        <div
          testId="effort-trigger"
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            height: 24,
            flexShrink: 0,
            width: effortTriggerWidth(options),
            paddingLeft: space.sm,
            paddingRight: space.sm,
            borderRadius: radius.sm,
            cursor: "pointer",
            userSelect: "none",
            hover: { backgroundColor: color.hover },
          }}
        >
          <Label size={text.micro} color={color.tertiary}>
            {value}
          </Label>
        </div>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="end"
        sideOffset={8}
        style={{ ...overlayStyle(space.lg, space.lg), gap: space.md }}
      >
        <EffortDial
          testId="effort"
          value={value}
          options={options}
          onChange={(effort: string) =>
            updateSession(session.id, (current) => ({ ...current, effort }))
          }
        />
      </SelectContent>
    </Select>
  )
}

export function BackgroundChip({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const running = useApp().background[session.id] ?? []
  const live = running.filter((entry) => entry.exit === null)
  if (live.length === 0) return null

  return (
    <Select open={open} onOpenChange={setOpen} value="background" onValueChange={() => {}}>
      <SelectTrigger asChild>
        <div
          testId="background-chip"
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            height: 24,
            flexShrink: 0,
            paddingLeft: space.sm,
            paddingRight: space.sm,
            borderRadius: radius.sm,
            cursor: "pointer",
            userSelect: "none",
            hover: { backgroundColor: color.hover },
          }}
        >
          <div
            style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.tertiary }}
          />
          <Label size={text.micro} color={color.tertiary}>
            {`${live.length} running`}
          </Label>
        </div>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="start"
        sideOffset={8}
        style={{ ...overlayStyle(space.md, space.md), gap: space.sm, width: 380 }}
      >
        {live.map((entry) => (
          <div
            key={entry.handle}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              minWidth: 0,
            }}
          >
            <Label grow truncate size={text.small} color={color.text}>
              {entry.command}
            </Label>
            <Button
              label="Stop"
              size="sm"
              variant="ghost"
              testId={`stop-background-${entry.handle}`}
              onClick={() => stopBackgroundCommand(entry.handle)}
            />
          </div>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ModePicker({ session }: { session: Session }) {
  const current = MODES.find((mode) => mode.value === session.mode) ?? MODES[0]!

  return (
    <Select
      value={session.mode}
      onValueChange={(value) =>
        updateSession(session.id, (entry) => ({
          ...entry,
          mode: value as PermissionMode,
        }))
      }
    >
      <SelectTrigger asChild>
        <div
          testId="permission-mode"
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            height: 24,
            flexShrink: 0,
            paddingLeft: space.sm,
            paddingRight: space.sm,
            borderRadius: radius.sm,
            cursor: "pointer",
            userSelect: "none",
            hover: { backgroundColor: color.hover },
          }}
        >
          <Label size={text.micro} color={color.tertiary}>
            {current.label}
          </Label>
          <Icon name="chevronDown" size={11} color={color.ghost} />
        </div>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="start"
        sideOffset={8}
        style={{ ...overlayStyle(space.xs, space.xs), width: 260 }}
      >
        {MODES.map((mode) => (
          <SelectItem
            key={mode.value}
            value={mode.value}
            testId={`permission-mode-${mode.value}`}
            style={(state) => ({
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              flexShrink: 0,
              paddingLeft: space.md,
              paddingRight: space.md,
              paddingTop: space.sm,
              paddingBottom: space.sm,
              borderRadius: radius.sm,
              cursor: "pointer",
              backgroundColor: state.highlighted ? color.selected : undefined,
            })}
          >
            {(state) => (
              <>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    flexGrow: 1,
                    minWidth: 0,
                  }}
                >
                  <Label size={text.small} color={color.text}>
                    {mode.label}
                  </Label>
                  <Label size={text.micro} color={color.tertiary}>
                    {mode.hint}
                  </Label>
                </div>
                {state.selected ? (
                  <Icon name="check" size={11} color={color.text} />
                ) : null}
              </>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const ATTACH_ACTIONS = [
  { value: "choose", label: "Choose images…", hint: "From your Mac" },
  { value: "paste", label: "Paste image", hint: "⌘V" },
  { value: "mention", label: "Mention a file", hint: "@" },
]

type FilePanel = { promptForPaths?: (elementId: number, multiple: boolean) => void }

export function AttachMenu({ session, onMention }: { session: Session; onMention: () => void }) {
  const panel = useGpuix().renderer as unknown as FilePanel | null
  const trigger = useRef<PublicInstance>(null)

  const choose = () => {
    if (panel?.promptForPaths && trigger.current) panel.promptForPaths(trigger.current.id, true)
    else void chooseImages(session.id)
  }

  return (
    <Select
      value=""
      onValueChange={(action) => {
        if (action === "choose") choose()
        else if (action === "paste") void pasteImage(session.id)
        else onMention()
      }}
    >
      <SelectTrigger asChild>
        <div
          ref={trigger}
          testId="attach-file"
          onChange={(event: { value?: string }) =>
            attachImages(session.id, (event.value ?? "").split("\n").filter(Boolean))
          }
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: radius.md,
            cursor: "pointer",
            hover: { backgroundColor: color.hover },
            active: { backgroundColor: color.pressed },
          }}
        >
          <Icon name="plus" size={13} color={color.tertiary} />
        </div>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="start"
        sideOffset={8}
        style={{ ...overlayStyle(space.xs, space.xs), width: 240 }}
      >
        {ATTACH_ACTIONS.map((action) => (
          <SelectItem
            key={action.value}
            value={action.value}
            testId={`attach-${action.value}`}
            style={(state) => ({
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              flexShrink: 0,
              paddingLeft: space.md,
              paddingRight: space.md,
              paddingTop: space.sm,
              paddingBottom: space.sm,
              borderRadius: radius.sm,
              cursor: "pointer",
              backgroundColor: state.highlighted ? color.selected : undefined,
            })}
          >
            {() => (
              <>
                <Label grow size={text.small} color={color.text}>
                  {action.label}
                </Label>
                <Label size={text.micro} color={color.ghost}>
                  {action.hint}
                </Label>
              </>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
