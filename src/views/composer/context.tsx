import { Select, SelectContent, SelectTrigger } from "@gpuix/react/select"

import { color, radius, space, text } from "../../ui/theme"
import { Label, overlayStyle } from "../../ui/ui"
import { sessionModel, useApp, type Session } from "../../store"
import { useT, type Translate } from "../../ui/i18n"
import type { Limit } from "../../agent/providers"

const RING_SIZE = 14
const RING_RADIUS = 6
const NEARLY_FULL = 0.9

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

function ring(share: number): string {
  const circumference = 2 * Math.PI * RING_RADIUS
  const drawn = (Math.round(share * 100) / 100) * circumference
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="2.5"><circle cx="8" cy="8" r="${RING_RADIUS}" stroke-opacity="0.3"/><circle cx="8" cy="8" r="${RING_RADIUS}" stroke-dasharray="${drawn.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`
}

function resetIn(at: number, t: Translate): string {
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000))
  if (minutes >= 1440) {
    return t("context.resetDays", { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60) })
  }
  if (minutes >= 60) return t("context.resetHours", { h: Math.floor(minutes / 60), m: minutes % 60 })
  return t("context.resetMinutes", { m: minutes })
}

function LimitRow({ limit }: { limit: Limit }) {
  const t = useT()
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Label grow size={text.small} color={color.secondary}>
          {limit.label}
        </Label>
        <Label size={text.small} color={color.tertiary}>
          {t("context.percentUsed", { percent: limit.usedPercent })}
        </Label>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          height: 4,
          borderRadius: 2,
          backgroundColor: color.border,
        }}
      >
        <div
          style={{
            width: 0,
            flexGrow: limit.usedPercent,
            borderRadius: 2,
            backgroundColor:
              limit.usedPercent >= NEARLY_FULL * 100 ? color.danger : color.secondary,
          }}
        />
        <div style={{ width: 0, flexGrow: Math.max(0, 100 - limit.usedPercent) }} />
      </div>
      {limit.resetsAt ? (
        <Label size={text.micro} color={color.tertiary}>
          {resetIn(limit.resetsAt, t)}
        </Label>
      ) : null}
    </div>
  )
}

export function ContextMeter({ session }: { session: Session }) {
  const t = useT()
  const state = useApp()
  const capacity = sessionModel(state, session)?.contextWindow
  const plan = session.provider ? state.limits[session.provider] : undefined
  const { used, system, tools, mcp, skills } = session.context
  if (used === 0) return null

  const whole = Math.max(capacity ?? used, used)
  const share = capacity ? used / whole : 0
  const parts = [
    { label: t("context.messages"), tokens: used - system - tools - mcp - skills, tint: "#8ab4f8" },
    { label: t("context.systemPrompt"), tokens: system, tint: color.tertiary },
    { label: t("context.tools"), tokens: tools, tint: "#c7a2ff" },
    { label: t("context.mcpTools"), tokens: mcp, tint: "#7cd07c" },
    { label: t("context.skills"), tokens: skills, tint: "#f5a623" },
    { label: t("context.freeSpace"), tokens: whole - used, tint: color.border },
  ].filter((part) => part.tokens > 0)

  return (
    <Select value="context" onValueChange={() => {}}>
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
            {t("context.window")}
          </Label>
          <Label size={text.small} color={color.tertiary}>
            {capacity
              ? `${COUNT.format(used)} / ${COUNT.format(capacity)} (${Math.round(share * 100)}%)`
              : t("context.used", { used: COUNT.format(used) })}
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

        {plan ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              paddingTop: space.md,
              borderTopWidth: 1,
              borderColor: color.border,
            }}
          >
            <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Label grow size={text.small} color={color.text}>
                {t("context.planUsage")}
              </Label>
              {plan.plan ? (
                <Label size={text.small} color={color.tertiary}>
                  {`${plan.plan[0]!.toUpperCase()}${plan.plan.slice(1)}`}
                </Label>
              ) : null}
            </div>
            {plan.limits.map((limit) => (
              <LimitRow key={limit.label} limit={limit} />
            ))}
          </div>
        ) : null}
      </SelectContent>
    </Select>
  )
}
