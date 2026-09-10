import { useState, type ReactNode } from "react"
import { existsSync } from "node:fs"
import { motion } from "@gpuix/react"
import type { MotionTransition } from "@gpuix/react"
import type { EventPayload } from "@gpuix/native"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@gpuix/react/tooltip"

import { Icon, type IconName } from "./icons"
import { color, FONT, nativeTheme, radius, space, text } from "./theme"

export { TooltipProvider }

const DIAL_TRACK_WIDTH = 208
const DIAL_TRACK_HEIGHT = 26
const DIAL_TRACK_PAD = 13
const DIAL_HANDLE = 20

export function Label({
  children,
  size = text.body,
  color: textColor = color.text,
  weight,
  grow,
  truncate,
  lines,
}: {
  children: ReactNode
  size?: number
  color?: string
  weight?: number
  grow?: boolean
  truncate?: boolean
  lines?: number
}) {
  return (
    <text
      style={{
        fontSize: size,
        fontFamily: FONT,
        fontWeight: weight,
        color: textColor,
        lineHeight: Math.round(size * 1.5),
        ...(grow ? { flexGrow: 1, minWidth: 0 } : null),
        ...(truncate
          ? { whiteSpace: "nowrap" as const, textOverflow: "ellipsis" as const }
          : null),
        ...(lines ? { lineClamp: lines } : null),
      }}
    >
      {children}
    </text>
  )
}

export function Paragraph({
  children,
  size = text.body,
  color: textColor = color.secondary,
  align,
}: {
  children: ReactNode
  size?: number
  color?: string
  align?: "left" | "center"
}) {
  return (
    <text
      style={{
        fontSize: size,
        fontFamily: FONT,
        color: textColor,
        lineHeight: Math.round(size * 1.55),
        textAlign: align,
      }}
    >
      {children}
    </text>
  )
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

const BUTTON_STYLES: Record<
  ButtonVariant,
  { background?: string; border?: string; text: string; hover: string; active: string }
> = {
  primary: {
    background: color.primary,
    text: color.onPrimary,
    hover: color.primaryHover,
    active: color.secondary,
  },
  secondary: {
    background: color.muted,
    border: color.border,
    text: color.text,
    hover: color.selected,
    active: "#1f1f1f",
  },
  ghost: {
    text: color.secondary,
    hover: color.hover,
    active: color.hoverStrong,
  },
  danger: {
    background: color.dangerSurface,
    text: color.danger,
    hover: "#f363562e",
    active: "#f3635640",
  },
}

export function Button({
  label,
  icon,
  onClick,
  variant = "secondary",
  size = "md",
  disabled,
  testId,
  hint,
}: {
  label: string
  icon?: IconName
  onClick?: () => void
  variant?: ButtonVariant
  size?: "sm" | "md"
  disabled?: boolean
  testId?: string
  hint?: string
}) {
  const palette = BUTTON_STYLES[variant]
  const height = size === "sm" ? 26 : 30
  const padding = size === "sm" ? space.md : space.lg
  return (
    <div
      testId={testId}
      onClick={disabled ? undefined : onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        height,
        paddingLeft: padding,
        paddingRight: padding,
        borderRadius: radius.md,
        borderWidth: palette.border ? 1 : 0,
        borderColor: palette.border,
        backgroundColor: palette.background,
        flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        userSelect: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        ...(disabled
          ? null
          : {
              hover: { backgroundColor: palette.hover },
              active: { backgroundColor: palette.active },
            }),
      }}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 12 : 13} color={palette.text} /> : null}
      <Label size={size === "sm" ? text.small : text.body} color={palette.text}>
        {label}
      </Label>
      {hint ? (
        <Label size={text.micro} color={palette.text}>
          {hint}
        </Label>
      ) : null}
    </div>
  )
}

export function IconButton({
  icon,
  glyph,
  tooltip,
  onClick,
  testId,
  active,
  tone = color.tertiary,
  size = 26,
  tooltipSide = "bottom",
  tooltipAlign = "center",
}: {
  icon?: IconName
  glyph?: string
  tooltip: string
  onClick?: () => void
  testId?: string
  active?: boolean
  tone?: string
  size?: number
  tooltipSide?: "top" | "bottom" | "left" | "right"
  tooltipAlign?: "start" | "center" | "end"
}) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <div
          testId={testId}
          onClick={onClick}
          style={{
            width: size,
            height: size,
            flexShrink: 0,
            borderRadius: radius.md,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: active ? color.selected : undefined,
            cursor: "pointer",
            hover: { backgroundColor: color.hover },
            active: { backgroundColor: color.pressed },
          }}
        >
          {glyph ? (
            <Label size={Math.round(size * 0.55)} color={active ? color.text : tone}>
              {glyph}
            </Label>
          ) : icon ? (
            <Icon name={icon} size={Math.round(size * 0.55)} color={active ? color.text : tone} />
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side={tooltipSide}
        align={tooltipAlign}
        sideOffset={6}
        style={overlayStyle(space.md, 5)}
      >
        <Label size={text.small} color={color.secondary}>
          {tooltip}
        </Label>
      </TooltipContent>
    </Tooltip>
  )
}

export function Explain({
  lines,
  side = "top",
  children,
}: {
  lines: string[]
  side?: "top" | "bottom" | "left" | "right"
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        style={{ ...overlayStyle(space.lg, space.md), maxWidth: 300, gap: space.xs }}
      >
        {lines.map((line, index) => (
          <Label
            key={line}
            size={index === 0 ? text.small : text.micro}
            color={index === 0 ? color.text : color.tertiary}
          >
            {line}
          </Label>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

const FIELD_INK_TOP = 6

export function fieldStyle(size: number) {
  return {
    box: {
      display: "flex",
      flexGrow: 1,
      minWidth: 0,
      height: Math.round(size * 1.15),
      overflow: "hidden" as const,
    },
    text: {
      flexGrow: 1,
      minWidth: 0,
      fontSize: size,
      fontFamily: FONT,
      color: color.text,
      marginTop: -FIELD_INK_TOP,
    },
  }
}

export function overlayStyle(paddingX: number, paddingY: number) {
  return {
    display: "flex",
    flexDirection: "column" as const,
    paddingLeft: paddingX,
    paddingRight: paddingX,
    paddingTop: paddingY,
    paddingBottom: paddingY,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    overflow: "hidden",
    backgroundColor: color.raised,
    boxShadow: {
      offsetX: 0,
      offsetY: 8,
      blurRadius: 24,
      spreadRadius: -6,
      color: "#000000cc",
    },
  }
}

export function Kbd({ keys }: { keys: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 18,
        minWidth: 18,
        paddingLeft: 5,
        paddingRight: 5,
        borderRadius: radius.sm,
        backgroundColor: color.muted,
        borderWidth: 1,
        borderColor: color.border,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <Label size={text.micro} color={color.tertiary}>
        {keys}
      </Label>
    </div>
  )
}

export function Badge({
  children,
  tone = color.secondary,
}: {
  children: string
  tone?: string
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 18,
        paddingLeft: space.sm,
        paddingRight: space.sm,
        borderRadius: radius.sm,
        backgroundColor: color.muted,
        flexShrink: 0,
      }}
    >
      <Label size={text.micro} color={tone}>
        {children}
      </Label>
    </div>
  )
}

export const FX_MARK = [
  " \u2800\u2800\u2800\u2800\u2800\u2800\u28e0\u28fe\u28ff\u28ff\u28ff\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800",
  " \u2800\u2800\u2800\u2800\u2800\u28b0\u28ff\u287f\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800",
  " \u2800\u2800\u2800\u28e0\u28f6\u28ff\u28ff\u28f7\u28f6\u2876\u28f6\u28f6\u28c6\u2800\u2800\u2800\u28f4\u28f6\u28f6\u2806",
  " \u2800\u2800\u2800\u2809\u28b9\u28ff\u28ff\u2809\u2809\u2800\u2818\u28bf\u28ff\u28e7\u28c0\u28fe\u28ff\u287f\u2803\u2800",
  " \u2800\u2800\u2800\u2800\u28fc\u28ff\u284f\u2800\u2800\u2800\u2800\u2800\u283b\u28ff\u28ff\u28ff\u281f\u2800\u2800\u2800",
  " \u2800\u2800\u2800\u2880\u28ff\u28ff\u2803\u2800\u2800\u2800\u2800\u28a0\u28e6\u2818\u28bf\u28ff\u28f7\u2840\u2800\u2800",
  " \u2800\u2800\u2800\u28f8\u28ff\u285f\u2800\u2800\u2800\u2800\u28f0\u28ff\u28ff\u2817\u2800\u283b\u28ff\u28ff\u28c4\u2800",
  " \u2800\u2800\u2800\u28ff\u28ff\u2807\u2800\u2800\u2800\u283e\u283f\u283f\u280b\u2800\u2800\u2800\u2818\u283f\u283f\u2826",
  "  \u2800\u28f8\u28ff\u287f\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800",
  " \u28ff\u28ff\u28ff\u281f\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800",
].join("\n")

export function EmptyState({
  icon,
  art,
  title,
  description,
  action,
  hints,
}: {
  icon: IconName
  art?: string
  title: string
  description: string
  action?: { label: string; icon?: IconName; onClick: () => void; testId?: string }
  hints?: { keys: string; label: string }[]
}) {
  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.lg,
        paddingLeft: space.xxl,
        paddingRight: space.xxl,
      }}
    >
      {art ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        >
        <text
          testId="empty-art"
          style={{
            fontSize: text.small,
            fontFamily: FONT,
            lineHeight: Math.round(text.small * 1.05),
            color: color.faint,
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          {art}
        </text>
        </motion.div>
      ) : (
        <Icon name={icon} size={20} color={color.faint} />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: space.sm,
          maxWidth: 460,
        }}
      >
        <Label size={text.title} color={color.text}>
          {title}
        </Label>
        <Paragraph align="center" color={color.faint}>
          {description}
        </Paragraph>
      </div>
      {action ? (
        <Button
          label={action.label}
          icon={action.icon}
          onClick={action.onClick}
          testId={action.testId}
          variant="secondary"
        />
      ) : null}
      {hints && hints.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.lg,
            paddingTop: space.sm,
          }}
        >
          {hints.map((hint) => (
            <div
              key={hint.keys}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <Kbd keys={hint.keys} />
              <Label size={text.micro} color={color.ghost}>
                {hint.label}
              </Label>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TextField({
  value,
  placeholder,
  onChange,
  onSubmit,
  secret,
  testId,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onSubmit: () => void
  secret?: boolean
  testId: string
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        height: 34,
        paddingLeft: space.lg,
        paddingRight: space.lg,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: color.border,
        backgroundColor: color.background,
      }}
    >
      <div style={fieldStyle(text.body).box}>
        <input
          testId={testId}
          value={value}
          placeholder={placeholder}
          autoFocus
          theme={nativeTheme}
          onChange={(event) => onChange(event.value ?? "")}
          onSubmit={onSubmit}
          style={fieldStyle(text.body).text}
        />
      </div>
    </div>
  )
}

export function EffortDial({
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

export function Thumbnail({
  file,
  size,
  testId,
  onClick,
  onRemove,
}: {
  file: string
  size: number
  testId: string
  onClick?: () => void
  onRemove?: () => void
}) {
  return (
    <div style={{ width: size, height: size, flexShrink: 0 }}>
      <div
        testId={testId}
        onClick={onClick}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.muted,
          cursor: onClick ? "pointer" : "default",
        }}
      >
        {existsSync(file) ? (
          <img
            src={file}
            objectFit="cover"
            style={{ width: size - 2, height: size - 2, borderRadius: radius.lg - 1 }}
          />
        ) : (
          <Icon name="image" size={Math.round(size / 3)} color={color.ghost} />
        )}
      </div>
      {onRemove ? (
        <div
          testId={`${testId}-remove`}
          onClick={onRemove}
          style={{
            position: "absolute",
            top: -space.sm,
            right: -space.sm,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 1,
            borderColor: color.border,
            backgroundColor: color.raised,
            cursor: "pointer",
            hover: { backgroundColor: color.selected },
          }}
        >
          <Icon name="x" size={10} color={color.secondary} />
        </div>
      ) : null}
    </div>
  )
}
