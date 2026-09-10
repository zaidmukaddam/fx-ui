import { createContext, useContext } from "react"

import { CONTENT_WIDTH } from "../../ui/theme"

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
