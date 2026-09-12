import { useState } from "react"
import type { EventPayload } from "@gpuix/native"

import {
  activeCommand,
  activeMention,
  applyMention,
  rankFiles,
  type Trigger,
} from "../../workspace/files"
import { forkSessionReporting } from "../../agent/agent"
import { lastEdit, listWorkspaceFiles, undoLastEdit } from "../../tools"
import { loadSkills, type SkillCommand } from "../../workspace/skills"
import {
  answerable,
  notice,
  openChangesPane,
  setDialog,
  startSession,
  updateSession,
  useApp,
  type Session,
} from "../../store"
import { MENTION_RESULTS, rank } from "./shared"
import { MODES } from "./pickers"
import { modelKey } from "../models"
import { copyText } from "../transcript/messages"
import type { Suggestion } from "./tokens"

type Index = { root: string; files: string[] }
type Commands = { root: string; entries: SkillCommand[] }

const SUB_COMMAND = /^\/(model|permissions)\s+([\s\S]*)$/

export type TokenPicker = {
  open: Trigger | null
  suggestions: Suggestion[]
  empty: string
  highlighted: number
  onDraftChange: (next: string) => void
  pick: (suggestion: Suggestion) => void
  attach: () => void
  onKeyDown: (event: EventPayload) => void
  reset: () => void
}

export function useTokenPicker(
  draft: string,
  setDraft: (value: string) => void,
  session: Session,
  root: string,
): TokenPicker {
  const [index, setIndex] = useState<Index | null>(null)
  const [commands, setCommands] = useState<Commands | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const state = useApp()

  const files = index?.root === root ? index.files : null
  const skills = commands?.root === root ? commands.entries : []

  const mention = dismissed ? null : activeMention(draft)
  const command = dismissed ? null : activeCommand(draft)
  const sub = dismissed ? null : SUB_COMMAND.exec(draft)
  const open: Trigger | null = mention ? "@" : command || sub ? "/" : null

  const lastReply = [...session.messages]
    .reverse()
    .find((message) => message.kind === "assistant" && message.text.trim())
  const undoable = lastEdit(session.id)

  const actions: Suggestion[] = [
    {
      value: "new",
      label: "/new",
      detail: "Start a new session in this pane",
      icon: "plus",
      group: "Commands",
      run: () => startSession(session.workspaceId),
    },
    {
      value: "rename",
      label: "/rename",
      detail: "Rename this session",
      icon: "filePen",
      group: "Commands",
      run: () =>
        setDialog({ kind: "rename-session", sessionId: session.id, value: session.title }),
    },
    ...(lastReply
      ? [
          {
            value: "copy",
            label: "/copy",
            detail: "Copy the last reply",
            icon: "copy" as const,
            group: "Commands",
            run: () => copyText(lastReply.kind === "assistant" ? lastReply.text : ""),
          },
        ]
      : []),
    ...(undoable
      ? [
          {
            value: "undo",
            label: "/undo",
            detail: `Undo the edit to ${undoable}`,
            icon: "history" as const,
            group: "Commands",
            run: () => {
              try {
                notice(session.id, "info", undoLastEdit(session.id))
              } catch (error) {
                notice(
                  session.id,
                  "error",
                  error instanceof Error ? error.message : String(error),
                )
              }
            },
          },
        ]
      : []),
    {
      value: "fork",
      label: "/fork",
      detail: "Copy this session into a second pane",
      icon: "gitBranch",
      group: "Commands",
      run: () => void forkSessionReporting(session.id, session.id),
    },
    {
      value: "changes",
      label: "/changes",
      detail: "Review changed files in a pane",
      icon: "fileDiff",
      group: "Commands",
      run: () => openChangesPane(session.workspaceId),
    },
    {
      value: "model",
      label: "/model",
      detail: "Pick the model for this session",
      icon: "bot",
      group: "Commands",
      stay: "/model ",
    },
    {
      value: "permissions",
      label: "/permissions",
      detail: "Ask, auto, or full access",
      icon: "shieldAlert",
      group: "Commands",
      stay: "/permissions ",
    },
  ]

  const subSuggestions = (kind: string, query: string): Suggestion[] => {
    if (kind === "model") {
      const models = state.models.filter((model) =>
        answerable(state, model.provider ?? null),
      )
      const haystack = new Map(models.map((model) => [modelKey(model), model]))
      const keys = rank(
        models.map(modelKey),
        query,
        MENTION_RESULTS - 1,
        (key) => `${haystack.get(key)?.name ?? ""} ${key}`,
      )
      return [
        {
          value: "auto",
          label: "Automatic",
          detail: "The workspace default",
          icon: "bot",
          group: "Models",
          run: () =>
            updateSession(session.id, (current) => ({
              ...current,
              model: null,
              provider: null,
              modelName: null,
            })),
        },
        ...keys.map((key) => {
          const model = haystack.get(key)!
          return {
            value: key,
            label: model.name,
            detail: model.id,
            icon: "bot" as const,
            group: "Models",
            run: () =>
              updateSession(session.id, (current) => ({
                ...current,
                model: model.id,
                provider: model.provider ?? null,
                modelName: model.name,
              })),
          }
        }),
      ]
    }
    return rank(
      MODES.map((mode) => mode.value),
      query,
      MENTION_RESULTS,
      (value) => `${MODES.find((mode) => mode.value === value)?.label ?? ""} ${value}`,
    ).map((value) => {
      const mode = MODES.find((entry) => entry.value === value)!
      return {
        value,
        label: mode.label,
        detail: mode.hint,
        icon: "shieldAlert" as const,
        group: "Permissions",
        run: () =>
          updateSession(session.id, (current) => ({
            ...current,
            mode: mode.value,
          })),
      }
    })
  }

  const suggestions: Suggestion[] =
    open === "@"
      ? files
        ? rankFiles(files, mention!.query, MENTION_RESULTS).map((file) => ({
            value: file,
            label: file,
            icon: "fileText" as const,
          }))
        : []
      : sub
        ? subSuggestions(sub[1]!, sub[2] ?? "")
        : open === "/"
          ? [
              ...rank(
                actions.map((entry) => entry.value),
                command!.query,
                actions.length,
                (value) => actions.find((entry) => entry.value === value)?.label ?? value,
              ).map((value) => actions.find((entry) => entry.value === value)!),
              ...rank(
                skills.map((entry) => entry.name),
                command!.query,
                MENTION_RESULTS,
              ).map((name) => ({
                value: name,
                label: `/${name}`,
                detail: skills.find((entry) => entry.name === name)?.description,
                icon: "sparkle" as const,
                group: "Skills",
              })),
            ]
          : []

  const empty =
    open === "@"
      ? files === null
        ? "Reading the workspace…"
        : mention?.query
          ? `No file matches ${mention.query}`
          : "No files in this workspace"
      : sub
        ? sub[1] === "model"
          ? `No model named ${sub[2]?.trim() || "…"}`
          : `No permission mode named ${sub[2]?.trim() || "…"}`
        : command?.query
          ? `Nothing matches ${command.query}`
          : "Nothing to run"

  const readWorkspace = () => {
    void listWorkspaceFiles(root).then((found) => setIndex({ root, files: found }))
  }
  const readCommands = () => {
    void loadSkills(root).then((loaded) => setCommands({ root, entries: loaded.commands }))
  }

  const pick = (suggestion: Suggestion) => {
    if (open === "/" && suggestion.run) {
      suggestion.run()
      setDraft("")
    } else if (open === "/" && suggestion.stay !== undefined) {
      setDraft(suggestion.stay)
    } else {
      setDraft(open === "/" ? `/${suggestion.value} ` : applyMention(draft, suggestion.value))
    }
    setHighlighted(0)
  }

  const attach = () => {
    setDraft(draft.length === 0 || draft.endsWith(" ") ? `${draft}@` : `${draft} @`)
    setDismissed(false)
    setHighlighted(0)
    readWorkspace()
  }

  const onDraftChange = (next: string) => {
    const tabAt = next.length === draft.length + 1 ? next.indexOf("\t") : -1
    if (open && tabAt >= 0 && next.slice(0, tabAt) + next.slice(tabAt + 1) === draft) {
      if (suggestions.length > 0) {
        pick(suggestions[Math.min(highlighted, suggestions.length - 1)]!)
      }
      return
    }
    const before = activeMention(draft)
    const after = activeMention(next)
    const commandBefore = activeCommand(draft)
    const commandAfter = activeCommand(next)
    if (after && !before) readWorkspace()
    if (commandAfter && !commandBefore) readCommands()
    if (
      after?.query !== before?.query ||
      commandAfter?.query !== commandBefore?.query ||
      SUB_COMMAND.exec(next)?.[2] !== SUB_COMMAND.exec(draft)?.[2]
    ) {
      setHighlighted(0)
      if (!after && !commandAfter) setDismissed(false)
    }
    setDraft(next)
  }

  const onKeyDown = (event: EventPayload) => {
    if (!open) return
    if (event.key === "escape") {
      setDismissed(true)
      return
    }
    if (suggestions.length === 0) return
    const next = event.key === "down" || (event.key === "n" && event.modifiers?.ctrl)
    const previous = event.key === "up" || (event.key === "p" && event.modifiers?.ctrl)
    if (next) setHighlighted((at) => (at + 1) % suggestions.length)
    else if (previous) setHighlighted((at) => (at - 1 + suggestions.length) % suggestions.length)
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
