import { useState } from "react"
import { Select, SelectContent, SelectTrigger } from "@gpuix/react/select"

import { color, radius, space, text } from "../../ui/theme"
import { Label, overlayStyle } from "../../ui/ui"
import { sessionModel, useApp, type Session } from "../../store"

const RING_SIZE = 14
const RING_RADIUS = 6
const NEARLY_FULL = 0.9

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

function ring(share: number): string {
  const circumference = 2 * Math.PI * RING_RADIUS
  const drawn = (Math.round(share * 100) / 100) * circumference
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="2.5"><circle cx="8" cy="8" r="${RING_RADIUS}" stroke-opacity="0.3"/><circle cx="8" cy="8" r="${RING_RADIUS}" stroke-dasharray="${drawn.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`
}

export function ContextMeter({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const capacity = sessionModel(useApp(), session)?.contextWindow
  const { used, system, tools, mcp, skills } = session.context
  if (used === 0) return null

  const whole = Math.max(capacity ?? used, used)
  const share = capacity ? used / whole : 0
  const parts = [
    { label: "Messages", tokens: used - system - tools - mcp - skills, tint: "#8ab4f8" },
    { label: "System prompt", tokens: system, tint: color.tertiary },
    { label: "Tools", tokens: tools, tint: "#c7a2ff" },
    { label: "MCP tools", tokens: mcp, tint: "#7cd07c" },
    { label: "Skills", tokens: skills, tint: "#f5a623" },
    { label: "Free space", tokens: whole - used, tint: color.border },
  ].filter((part) => part.tokens > 0)

  return (
    <Select open={open} onOpenChange={setOpen} value="context" onValueChange={() => {}}>
      <SelectTrigger asChild>
        <div
          testId="context-meter"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: radius.sm,
            cursor: "pointer",
            hover: { backgroundColor: color.hover },
          }}
        >
          <svg
            source={ring(share)}
            style={{
              width: RING_SIZE,
              height: RING_SIZE,
              color: share >= NEARLY_FULL ? color.danger : color.secondary,
            }}
          />
        </div>
      </SelectTrigger>

      <SelectContent
        side="top"
        align="end"
        sideOffset={8}
        style={{ ...overlayStyle(space.lg, space.lg), gap: space.md, width: 300 }}
      >
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Label grow size={text.small} color={color.text}>
            Context window
          </Label>
          <Label size={text.small} color={color.tertiary}>
            {capacity
              ? `${COUNT.format(used)} / ${COUNT.format(capacity)} (${Math.round(share * 100)}%)`
              : `${COUNT.format(used)} used`}
          </Label>
        </div>

        <div style={{ display: "flex", flexDirection: "row", gap: 2, height: 6 }}>
          {parts.map((part) => (
            <div
              key={part.label}
              style={{
                width: 0,
                minWidth: 2,
                flexGrow: part.tokens,
                borderRadius: 3,
                backgroundColor: part.tint,
              }}
            />
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {parts.map((part) => (
            <div
              key={part.label}
              style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  flexShrink: 0,
                  borderRadius: 2,
                  backgroundColor: part.tint,
                }}
              />
              <Label grow size={text.small} color={color.secondary}>
                {part.label}
              </Label>
              <div style={{ display: "flex", justifyContent: "flex-end", width: 56, flexShrink: 0 }}>
                <Label size={text.small} color={color.tertiary}>
                  {COUNT.format(part.tokens)}
                </Label>
              </div>
              {capacity ? (
                <div
                  style={{ display: "flex", justifyContent: "flex-end", width: 48, flexShrink: 0 }}
                >
                  <Label size={text.small} color={color.text}>
                    {`${((part.tokens / whole) * 100).toFixed(1)}%`}
                  </Label>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </SelectContent>
    </Select>
  )
}
