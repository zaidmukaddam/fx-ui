import { createContext, useContext } from "react"

import { Icon, type IconName } from "../../ui/icons"
import { CONTENT_WIDTH, color, radius, space } from "../../ui/theme"

export const COLLAPSED_LINES = 16
export const GUTTER = 20

export const ColumnWidth = createContext(CONTENT_WIDTH)

export const HoldTail = createContext<() => void>(() => {})

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: useContext(ColumnWidth),
        minWidth: 0,
      }}
    >
      {children}
    </div>
  )
}

export function Gutter({ children, top }: { children?: React.ReactNode; top?: number }) {
  return (
    <div
      style={{
        width: GUTTER - space.md,
        flexShrink: 0,
        display: "flex",
        justifyContent: "center",
        ...(top ? { paddingTop: top } : null),
      }}
    >
      {children}
    </div>
  )
}

export function SummaryRow({
  icon,
  size = 11,
  tone = color.faint,
  children,
}: {
  icon: IconName
  size?: number
  tone?: string
  children: React.ReactNode
}) {
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
        <Gutter>
          <Icon name={icon} size={size} color={tone} />
        </Gutter>
        {children}
      </div>
    </Row>
  )
}

export function Card({
  testId,
  accent,
  children,
}: {
  testId?: string
  accent?: boolean
  children: React.ReactNode
}) {
  return (
    <Row>
      <div
        testId={testId}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: space.lg,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border,
          ...(accent ? { borderLeftWidth: 2 } : null),
          backgroundColor: color.raised,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </Row>
  )
}
