import { type ReactNode } from "react"
import { existsSync } from "node:fs"
import { useWindowSize } from "@gpuix/react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@gpuix/react/tooltip"

import { Icon, type IconName } from "./icons"
import { color, FONT, nativeTheme, radius, space, text } from "./theme"

export { TooltipProvider }

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

export function Backdrop({ width, top, children }: {
  width: number
  top: number
  children: ReactNode
}) {
  const size = useWindowSize()
  return (
    <anchored
      deferred
      position={{ x: Math.max(0, Math.round((size.width - width) / 2)), y: top }}
      anchor="topLeft"
      occlude
      style={{ borderRadius: radius.lg }}
    >
      {children}
    </anchored>
  )
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


export function TextField({
  value,
  placeholder,
  onChange,
  onSubmit,
  testId,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onSubmit: () => void
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
