import { useState } from "react"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@gpuix/react/combobox"

import { Icon } from "../ui/icons"
import { color, nativeTheme, radius, space, text } from "../ui/theme"
import { Label, fieldStyle, overlayStyle } from "../ui/ui"
import { loadModels } from "../agent/credentials"
import { useT } from "../ui/i18n"
import { answerable, useApp, type Chosen, type Model } from "../store"
import { rank } from "./composer/shared"

const MODEL_RESULTS = 80
const MODEL_ROW_HEIGHT = 28
const MODEL_LIST_HEIGHT = MODEL_ROW_HEIGHT * 8

const AUTOMATIC = ""

export function modelKey(model: Model): string {
  return model.provider ? `${model.provider}:${model.id}` : model.id
}

export function keyOf(chosen: Chosen | null): string | null {
  if (!chosen) return null
  return chosen.provider ? `${chosen.provider}:${chosen.id}` : chosen.id
}

function hintFor(model: Model | undefined): string {
  if (!model || model.provider) return ""
  return model.id === model.name ? "" : model.id
}

export function chosenFrom(key: string, models: Model[]): Chosen {
  const match = /^(grok|codex|kiro):(.+)$/.exec(key)
  return {
    id: match ? match[2]! : key,
    provider: match ? (match[1] as "grok" | "codex" | "kiro") : null,
    name: models.find((model) => modelKey(model) === key)?.name ?? null,
  }
}

export function ModelChoice({
  value,
  label,
  maxWidth,
  size = text.small,
  testId,
  automatic,
  onChange,
}: {
  value: string | null
  label: string
  maxWidth: number
  size?: number
  testId: string
  automatic?: string
  onChange: (chosen: Chosen | null) => void
}) {
  const [query, setQuery] = useState("")
  const t = useT()
  const state = useApp()
  const models = state.models.filter((model) => answerable(state, model.provider ?? null))

  const byKey = new Map(models.map((model) => [modelKey(model), model]))
  const haystack = new Map(
    models.map((model) => [modelKey(model), `${model.name} ${model.id}`]),
  )
  const matched = rank(
    models.map(modelKey),
    query,
    MODEL_RESULTS,
    (key) => haystack.get(key) ?? key,
  )
  const items = automatic !== undefined ? [AUTOMATIC, ...matched] : matched

  return (
    <Combobox
      style={{ flexShrink: 1, minWidth: 0 }}
      items={items}
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      value={value ?? AUTOMATIC}
      onValueChange={(next) => {
        if (typeof next !== "string") return
        onChange(next === AUTOMATIC ? null : chosenFrom(next, models))
        setQuery("")
      }}
      onOpenChange={(open) => {
        if (!open) return
        setQuery("")
        void loadModels()
      }}
    >
      <ComboboxTrigger asChild>
        <div
          testId={testId}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            height: 24,
            flexShrink: 1,
            minWidth: 0,
            maxWidth,
            paddingLeft: space.sm,
            paddingRight: space.sm,
            borderRadius: radius.sm,
            cursor: "pointer",
            userSelect: "none",
            hover: { backgroundColor: color.hover },
          }}
        >
          <Label grow truncate size={size} color={color.tertiary}>
            {(value !== null ? byKey.get(value)?.name : undefined) ?? label}
          </Label>
          <Icon name="chevronDown" size={11} color={color.ghost} />
        </div>
      </ComboboxTrigger>

      <ComboboxContent
        side="top"
        align="start"
        sideOffset={8}
        style={{ ...overlayStyle(space.xs, space.xs), width: 340 }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            height: 32,
            paddingLeft: space.md,
            paddingRight: space.md,
            marginBottom: space.xs,
            borderBottomWidth: 1,
            borderColor: color.border,
          }}
        >
          <Icon name="search" size={12} color={color.ghost} />
          <div style={fieldStyle(text.small).box}>
            <ComboboxInput
              placeholder={t("modelPicker.search")}
              theme={nativeTheme}
              style={fieldStyle(text.small).text}
            />
          </div>
        </div>

        <ComboboxList
          style={{
            display: "flex",
            flexDirection: "column",
            maxHeight: MODEL_LIST_HEIGHT,
            overflowY: "scroll",
          }}
        >
          {(item: string) => (
            <ComboboxItem
              key={item}
              value={item}
              testId={item === AUTOMATIC ? "model-automatic" : `model-${item}`}
              style={(state) => ({
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                height: MODEL_ROW_HEIGHT,
                flexShrink: 0,
                paddingLeft: space.md,
                paddingRight: space.md,
                borderRadius: radius.sm,
                cursor: "pointer",
                backgroundColor: state.highlighted ? color.selected : undefined,
              })}
            >
              {(state) => {
                const hint =
                  item === AUTOMATIC ? (automatic ?? "") : hintFor(byKey.get(item))
                return (
                  <>
                    <Label truncate size={text.small} color={color.text}>
                      {item === AUTOMATIC ? t("modelPicker.automatic") : (byKey.get(item)?.name ?? item)}
                    </Label>
                    {hint ? (
                      <Label grow truncate size={text.micro} color={color.ghost}>
                        {hint}
                      </Label>
                    ) : (
                      <div style={{ flexGrow: 1, minWidth: 0 }} />
                    )}
                    {state.selected ? (
                      <Icon name="check" size={11} color={color.text} />
                    ) : null}
                  </>
                )
              }}
            </ComboboxItem>
          )}
        </ComboboxList>

        <ComboboxEmpty
          style={{ display: "flex", alignItems: "center", height: 28, paddingLeft: space.md }}
        >
          <Label size={text.small} color={color.ghost}>
            {t("modelPicker.noMatch")}
          </Label>
        </ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
