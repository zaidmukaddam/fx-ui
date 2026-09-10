import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

const MAX_REMEMBERED = 20

type Edit = {
  path: string
  shown: string
  before: string | null
  after: string
}

const edits = new Map<string, Edit[]>()

export function recordEdit(
  sessionId: string,
  path: string,
  shown: string,
  before: string | null,
  after: string,
): void {
  const kept = edits.get(sessionId) ?? []
  kept.push({ path, shown, before, after })
  edits.set(sessionId, kept.slice(-MAX_REMEMBERED))
}

export function lastEdit(sessionId: string): string | null {
  const kept = edits.get(sessionId) ?? []
  return kept[kept.length - 1]?.shown ?? null
}

export function forgetEdits(sessionId: string): void {
  edits.delete(sessionId)
}

export function undoLastEdit(sessionId: string): string {
  const kept = edits.get(sessionId) ?? []
  const edit = kept.pop()
  if (!edit) throw new Error("Nothing to undo: no file has been written this session.")
  edits.set(sessionId, kept)

  const now = existsSync(edit.path) ? readFileSync(edit.path, "utf8") : null
  if (now !== edit.after) {
    throw new Error(
      `${edit.shown} changed after that edit, so undoing it would throw the newer change away.`,
    )
  }

  if (edit.before === null) {
    unlinkSync(edit.path)
    return `Undid the write that created ${edit.shown}, and removed it.`
  }
  writeFileSync(edit.path, edit.before)
  return `Undid the last edit to ${edit.shown}.`
}
