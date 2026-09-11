import { forwardRef, useRef, useState } from "react"
import { motion, useGpuix, type MotionTransition, type PublicInstance } from "@gpuix/react"
import type { EventPayload } from "@gpuix/native"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@gpuix/react/select"

import { Icon } from "../../ui/icons"
import { color, radius, space, text } from "../../ui/theme"
import { Button, Explain, Label, overlayStyle } from "../../ui/ui"
import { forgetGrants, stopBackgroundCommand } from "../../tools"
import { mcpGrantLabel } from "../../workspace/mcp"
import { attachImages, chooseImages, pasteImage } from "../../workspace/images"
import {
  DEFAULT_MODEL,
  canAnswer,
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

const Chip = forwardRef<
  PublicInstance,
  {
    testId?: string
    active?: boolean
    width?: number
    justify?: "flex-start" | "center"
    onClick?: () => void
    children: React.ReactNode
  }
>(function Chip({ testId, active, width, justify = "flex-start", onClick, children }, ref) {
  return (
    <div
      ref={ref}
      testId={testId}
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: justify,
        gap: space.sm,
        height: 24,
        flexShrink: 0,
        ...(width ? { width } : null),
        paddingLeft: space.sm,
        paddingRight: space.sm,
        borderRadius: radius.sm,
        cursor: "pointer",
        userSelect: "none",
        backgroundColor: active ? color.selected : undefined,
        hover: { backgroundColor: active ? color.selected : color.hover },
      }}
    >
      {children}
    </div>
  )
})

export function ModelPicker({ session, compact }: { session: Session; compact: boolean }) {
  const state = useApp()
  const ready = canAnswer(state, session)
  const implied =
    session.model != null
      ? {
          id: session.model,
          provider: session.provider,
          name: session.modelName,
        }
      : ready
        ? { id: DEFAULT_MODEL.id, provider: null, name: DEFAULT_MODEL.name }
        : null

  return (
    <ModelChoice
      testId="model-picker"
      value={implied ? keyOf(implied) : null}
      label={implied?.name ?? "No model"}
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
  const on = session.fast

  return (
    <Explain lines={[tier.label, tier.detail, "Changing it restarts the conversation."]}>
      <Chip
        testId="fast-toggle"
        active={on}
        onClick={() => updateSession(session.id, (current) => ({ ...current, fast: !on }))}
      >
        <Label size={text.micro} color={on ? color.text : color.ghost}>
          {tier.label}
        </Label>
      </Chip>
    </Explain>
  )
}

const DIAL_TRACK_WIDTH = 208
const DIAL_TRACK_HEIGHT = 26
const DIAL_TRACK_PAD = 13
const DIAL_HANDLE = 20

function EffortDial({
  value,
  options,
  onChange,
  testId,
}: {
  value: string
  options: string[]
  onChange: (value: string) => void
  testId?: string
}) {
  const [drag, setDrag] = useState<{ from: number; at: number; offset: number } | null>(null)

  const index = Math.max(0, options.indexOf(value))
  const last = Math.max(1, options.length - 1)
  const inner = DIAL_TRACK_WIDTH - DIAL_TRACK_PAD * 2
  const step = inner / last
  const dotAt = (at: number) => DIAL_TRACK_PAD + Math.round(step * at)

  const ahead = DIAL_TRACK_PAD - DIAL_HANDLE / 2
  const centre = drag
    ? Math.min(
        DIAL_TRACK_WIDTH - DIAL_TRACK_PAD,
        Math.max(DIAL_TRACK_PAD, dotAt(drag.from) + drag.offset),
      )
    : dotAt(index)

  const settle: MotionTransition = drag
    ? { duration: 0 }
    : { duration: 0.15, ease: [0.23, 1, 0.32, 1] }

  const begin = (at: number, x: number | undefined) => {
    if (options[at] !== value) onChange(options[at]!)
    if (x !== undefined) setDrag({ from: at, at: x, offset: 0 })
  }

  const move = (x: number | undefined) => {
    if (!drag || x === undefined) return
    const offset = x - drag.at
    setDrag({ ...drag, offset })
    const to = Math.min(
      last,
      Math.max(0, Math.round((dotAt(drag.from) + offset - DIAL_TRACK_PAD) / step)),
    )
    if (options[to] !== value) onChange(options[to]!)
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
        }}
      >
        <Label size={text.small} color={color.tertiary}>
          Effort
        </Label>
        <Label grow size={text.small} color={color.text}>
          {value}
        </Label>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Label size={text.micro} color={color.ghost}>
          Faster
        </Label>
        <Label size={text.micro} color={color.ghost}>
          Smarter
        </Label>
      </div>

      <div
        testId={testId}
        onMouseLeave={() => setDrag(null)}
        style={{
          position: "relative",
          width: DIAL_TRACK_WIDTH,
          height: DIAL_TRACK_HEIGHT,
          flexShrink: 0,
          borderRadius: DIAL_TRACK_HEIGHT / 2,
          backgroundColor: color.muted,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div
          testId={testId ? `${testId}-trail` : undefined}
          style={{ position: "absolute", top: 0, bottom: 0, left: 0 }}
        >
          <motion.div
            initial={false}
            animate={{
              width: Math.min(
                DIAL_TRACK_WIDTH,
                Math.round(centre + DIAL_HANDLE / 2 + ahead),
              ),
            }}
            transition={settle}
            style={{
              height: "100%",
              borderRadius: DIAL_TRACK_HEIGHT / 2,
              backgroundColor: color.pressed,
            }}
          />
        </div>
        {options.map((option, at) => (
          <div
            key={`dot-${option}`}
            style={{
              position: "absolute",
              top: Math.round((DIAL_TRACK_HEIGHT - 3) / 2),
              left: dotAt(at) - 1,
              width: 3,
              height: 3,
              borderRadius: 2,
              backgroundColor: at <= index ? color.tertiary : color.faint,
            }}
          />
        ))}
        <motion.div
          initial={false}
          animate={{ left: Math.round(centre - DIAL_HANDLE / 2) }}
          transition={settle}
          style={{
            position: "absolute",
            top: Math.round((DIAL_TRACK_HEIGHT - DIAL_HANDLE) / 2),
            width: DIAL_HANDLE,
            height: DIAL_HANDLE,
            borderRadius: DIAL_HANDLE / 2,
            backgroundColor: color.text,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "row",
          }}
        >
          {options.map((option, at) => (
            <div
              key={option}
              testId={testId ? `${testId}-${option}` : undefined}
              onMouseDown={(event: EventPayload) => begin(at, event.x)}
              onMouseMove={(event: EventPayload) => move(event.x)}
              onMouseUp={() => setDrag(null)}
              onClick={() => {
                setDrag(null)
                if (option !== value) onChange(option)
              }}
              style={{ flexGrow: 1, flexBasis: 0, height: "100%" }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function EffortPicker({ session }: { session: Session }) {
  const chosen = sessionModel(useApp(), session)
  const options = chosen?.efforts ?? []
  const value =
    session.effort ?? chosen?.defaultEffort ?? options[Math.floor(options.length / 2)] ?? ""
  if (options.length < 2) return null

  return (
    <Select value="effort" onValueChange={() => {}}>
      <SelectTrigger asChild>
        <Chip testId="effort-trigger" width={effortTriggerWidth(options)} justify="center">
          <Label size={text.micro} color={color.tertiary}>
            {value}
          </Label>
        </Chip>
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
  const running = useApp().background[session.id] ?? []
  const live = running.filter((entry) => entry.exit === null)
  if (live.length === 0) return null

  return (
    <Select value="background" onValueChange={() => {}}>
      <SelectTrigger asChild>
        <Chip testId="background-chip">
          <div
            style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.tertiary }}
          />
          <Label size={text.micro} color={color.tertiary}>
            {`${live.length} running`}
          </Label>
        </Chip>
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

function grantLabel(scope: string): string {
  if (scope === "write") return "Edit and create files"
  if (scope === "install_skill") return "Install skills"
  if (scope === "web:search") return "Search the web"
  if (scope.startsWith("mcp:")) return mcpGrantLabel(scope)
  const [, kind, target] = /^(cmd|web):(.+)$/.exec(scope) ?? []
  if (kind === "cmd") return `Run ${target}`
  if (kind === "web") return `Fetch from ${target}`
  return scope
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
        <Chip testId="permission-mode">
          <Label size={text.micro} color={color.tertiary}>
            {current.label}
          </Label>
          {session.grants.length > 0 ? (
            <Icon name="shieldAlert" size={11} color={color.ghost} />
          ) : null}
          <Icon name="chevronDown" size={11} color={color.ghost} />
        </Chip>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="start"
        sideOffset={8}
        style={{ ...overlayStyle(space.xs, space.xs), width: 300 }}
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
        {session.grants.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              marginTop: space.xs,
              paddingTop: space.xs,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingLeft: space.md,
              }}
            >
              <Label grow size={text.micro} color={color.tertiary}>
                Allowed without asking
              </Label>
              <Button
                label="Forget all"
                size="sm"
                variant="ghost"
                testId="forget-grants"
                onClick={() => forgetGrants(session.id)}
              />
            </div>
            {session.grants.map((scope) => (
              <div
                key={scope}
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  paddingLeft: space.md,
                  minWidth: 0,
                }}
              >
                <Label grow truncate size={text.small} color={color.text}>
                  {grantLabel(scope)}
                </Label>
                <Button
                  label="Forget"
                  size="sm"
                  variant="ghost"
                  testId={`forget-grant-${scope}`}
                  onClick={() => forgetGrants(session.id, scope)}
                />
              </div>
            ))}
          </div>
        ) : null}
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
