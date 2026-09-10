import { Icon, type IconName } from "../../ui/icons"
import { color, radius, space, text } from "../../ui/theme"
import { Label, overlayStyle } from "../../ui/ui"
import { MENTION_RESULTS } from "./shared"

const MENTION_ROW_HEIGHT = 26

export type Suggestion = {
  value: string
  label: string
  detail?: string
  icon: IconName
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
  onPick: (value: string) => void
}) {
  return (
    <div
      testId="mention-picker"
      style={{
        ...overlayStyle(space.xs, space.xs),
        maxHeight: MENTION_ROW_HEIGHT * MENTION_RESULTS,
        overflowY: "scroll",
      }}
    >
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.value}
          testId={`mention-${suggestion.value}`}
          onClick={() => onPick(suggestion.value)}
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
      ) : null}
    </div>
  )
}
