import { useRef } from "react"
import { useGpuix, type PublicInstance } from "@gpuix/react"

import { Icon, type IconName } from "../../ui/icons"
import { color, radius, space, text } from "../../ui/theme"
import { Kbd, Label, overlayStyle } from "../../ui/ui"
import { MENTION_RESULTS } from "./shared"

const MENTION_ROW_HEIGHT = 26

export type Suggestion = {
  value: string
  label: string
  detail?: string
  icon: IconName
  group?: string
  run?: () => void
  stay?: string
}

export function TokenPicker({
  suggestions,
  empty,
  highlighted,
  onPick,
}: {
  suggestions: Suggestion[]
  empty: string
  highlighted: number
  onPick: (suggestion: Suggestion) => void
}) {
  const renderer = useGpuix().renderer
  const containerRef = useRef<PublicInstance | null>(null)
  const synced = useRef("")

  const signature = `${highlighted}:${suggestions.length}`
  if (signature !== synced.current) {
    synced.current = signature
    setTimeout(() => {
      const container = containerRef.current
      if (container) renderer?.scrollToItem?.(container.id, highlighted, 0)
    }, 0)
  }

  return (
    <div
      ref={containerRef}
      testId="mention-picker"
      style={{
        ...overlayStyle(space.xs, space.xs),
        maxHeight: MENTION_ROW_HEIGHT * MENTION_RESULTS,
        overflowY: "scroll",
      }}
    >
      {suggestions.map((suggestion, index) => (
        <div key={`${suggestion.group ?? ""}:${suggestion.value}`}>
          {index === 0 || suggestions[index - 1]!.group !== suggestion.group ? (
            suggestion.group ? (
              <div
                style={{
                  paddingLeft: space.md,
                  paddingTop: index === 0 ? space.xs : space.sm,
                  paddingBottom: 2,
                }}
              >
                <Label size={text.micro} color={color.faint}>
                  {suggestion.group}
                </Label>
              </div>
            ) : null
          ) : null}
          <div
          testId={`mention-${suggestion.value}`}
          onClick={() => onPick(suggestion)}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            height: MENTION_ROW_HEIGHT,
            flexShrink: 0,
            paddingLeft: space.md,
            paddingRight: space.md,
            borderRadius: radius.sm,
            cursor: "pointer",
            backgroundColor: index === highlighted ? color.selected : undefined,
            hover: { backgroundColor: color.hover },
          }}
        >
          <Icon name={suggestion.icon} size={11} color={color.ghost} />
          <Label truncate size={text.small} color={color.text}>
            {suggestion.label}
          </Label>
          {suggestion.detail ? (
            <Label grow truncate size={text.micro} color={color.ghost}>
              {suggestion.detail}
            </Label>
          ) : (
            <div style={{ flexGrow: 1, minWidth: 0 }} />
          )}
          </div>
        </div>
      ))}
      {suggestions.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: MENTION_ROW_HEIGHT,
            paddingLeft: space.md,
          }}
        >
          <Label size={text.small} color={color.ghost}>
            {empty}
          </Label>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            height: 22,
            flexShrink: 0,
            paddingLeft: space.md,
            paddingTop: 2,
            borderTopWidth: 1,
            borderColor: color.border,
          }}
        >
          <Kbd keys="^n" />
          <Kbd keys="^p" />
          <Label size={text.micro} color={color.ghost}>
            navigate
          </Label>
        </div>
      )}
    </div>
  )
}
