import { useState } from "react"

import {
  activeCommand,
  activeMention,
  applyMention,
  rankFiles,
  type Trigger,
} from "../../workspace/files"
import { listWorkspaceFiles } from "../../tools"
import { loadSkills, type SkillCommand } from "../../workspace/skills"
import { MENTION_RESULTS, rank } from "./shared"
import { useT } from "../../ui/i18n"
import type { Suggestion } from "./tokens"

type Index = { root: string; files: string[] }
type Commands = { root: string; entries: SkillCommand[] }

export type TokenPicker = {
  open: Trigger | null
  suggestions: Suggestion[]
  empty: string
  highlighted: number
  onDraftChange: (next: string) => void
  pick: (value: string) => void
  attach: () => void
  onKeyDown: (event: { key?: string }) => void
  reset: () => void
}

export function useTokenPicker(
  draft: string,
  setDraft: (value: string) => void,
  root: string,
): TokenPicker {
  const [index, setIndex] = useState<Index | null>(null)
  const [commands, setCommands] = useState<Commands | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const t = useT()

  const files = index?.root === root ? index.files : null
  const skills = commands?.root === root ? commands.entries : []

  const mention = dismissed ? null : activeMention(draft)
  const command = dismissed ? null : activeCommand(draft)
  const open: Trigger | null = mention ? "@" : command ? "/" : null

  const suggestions: Suggestion[] =
    open === "@"
      ? files
        ? rankFiles(files, mention!.query, MENTION_RESULTS).map((file) => ({
            value: file,
            label: file,
            icon: "fileText" as const,
          }))
        : []
      : open === "/"
        ? rank(
            skills.map((entry) => entry.name),
            command!.query,
            MENTION_RESULTS,
          ).map((name) => ({
            value: name,
            label: `/${name}`,
            detail: skills.find((entry) => entry.name === name)?.description,
            icon: "sparkle" as const,
          }))
        : []

  const empty =
    open === "@"
      ? files === null
        ? t("mention.reading")
        : mention?.query
          ? t("mention.noFileMatch", { query: mention.query })
          : t("mention.noFiles")
      : command?.query
        ? t("mention.noSkillMatch", { query: command.query })
        : t("mention.noSkills")

  const readWorkspace = () => {
    void listWorkspaceFiles(root).then((found) => setIndex({ root, files: found }))
  }
  const readCommands = () => {
    void loadSkills(root).then((loaded) => setCommands({ root, entries: loaded.commands }))
  }

  const pick = (value: string) => {
    setDraft(open === "/" ? `/${value} ` : applyMention(draft, value))
    setHighlighted(0)
  }

  const attach = () => {
    setDraft(draft.length === 0 || draft.endsWith(" ") ? `${draft}@` : `${draft} @`)
    setDismissed(false)
    setHighlighted(0)
    readWorkspace()
  }

  const onDraftChange = (next: string) => {
    const before = activeMention(draft)
    const after = activeMention(next)
    const commandBefore = activeCommand(draft)
    const commandAfter = activeCommand(next)
    if (after && !before) readWorkspace()
    if (commandAfter && !commandBefore) readCommands()
    if (after?.query !== before?.query || commandAfter?.query !== commandBefore?.query) {
      setHighlighted(0)
      if (!after && !commandAfter) setDismissed(false)
    }
    setDraft(next)
  }

  const onKeyDown = (event: { key?: string }) => {
    if (!open) return
    if (event.key === "escape") {
      setDismissed(true)
      return
    }
    if (suggestions.length === 0) return
    if (event.key === "down") setHighlighted((at) => (at + 1) % suggestions.length)
    else if (event.key === "up")
      setHighlighted((at) => (at - 1 + suggestions.length) % suggestions.length)
    else if (event.key === "tab")
      pick(suggestions[Math.min(highlighted, suggestions.length - 1)]!.value)
  }

  const reset = () => {
    setDismissed(false)
    setHighlighted(0)
  }

  return {
    open,
    suggestions,
    empty,
    highlighted: Math.min(highlighted, Math.max(0, suggestions.length - 1)),
    onDraftChange,
    pick,
    attach,
    onKeyDown,
    reset,
  }
}
