import { readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs"
import path from "node:path"

import { forgetEdits } from "../tools/edits"
import { runGit } from "./git"

const SNAPSHOT_MS = 30_000

type Snapshot = {
  root: string
  beforeWork: string
  beforeIndex: string
  afterWork: string
  afterIndex: string
  changed: number
}

const snapshots = new Map<string, Snapshot>()
const pending = new Map<string, Omit<Snapshot, "afterWork" | "afterIndex" | "changed">>()

function withIndex(file: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_INDEX_FILE: file }
}

function gitMessage(stderr: string | undefined, fallback: string): string {
  const first = (stderr ?? fallback).trim().split("\n")[0] ?? fallback
  return first.replace(/^fatal:\s*/, "")
}

async function repoGitDir(root: string): Promise<string | null> {
  const top = await runGit(root, ["rev-parse", "--show-toplevel"])
  if (!top || top.code !== 0) return null
  try {
    if (realpathSync(root) !== realpathSync(top.stdout.trim())) return null
  } catch {
    return null
  }
  const dir = await runGit(root, ["rev-parse", "--absolute-git-dir"])
  if (!dir || dir.code !== 0) return null
  const resolved = dir.stdout.trim()
  return resolved || null
}

async function indexTree(root: string): Promise<string | null> {
  const result = await runGit(root, ["write-tree"])
  if (!result || result.code !== 0) return null
  return result.stdout.trim() || null
}

function dropIndex(file: string): void {
  try {
    unlinkSync(file)
  } catch {
  }
  try {
    unlinkSync(`${file}.lock`)
  } catch {
  }
}

async function worktreeTree(root: string, gitDir: string): Promise<string | null> {
  const index = path.join(gitDir, `fx-ui-${crypto.randomUUID()}`)
  try {
    const add = await runGit(root, ["add", "-A", "--", "."], {
      env: withIndex(index),
      timeoutMs: SNAPSHOT_MS,
    })
    if (!add || add.code !== 0) return null
    const tree = await runGit(root, ["write-tree"], {
      env: withIndex(index),
      timeoutMs: SNAPSHOT_MS,
    })
    if (!tree || tree.code !== 0) return null
    return tree.stdout.trim() || null
  } finally {
    dropIndex(index)
  }
}

async function treeFiles(root: string, tree: string): Promise<string[]> {
  const result = await runGit(root, ["ls-tree", "-r", "--name-only", "-z", tree])
  if (!result || result.code !== 0) return []
  return result.stdout.split("\0").filter(Boolean)
}

async function changedFiles(root: string, before: string, after: string): Promise<number> {
  if (before === after) return 0
  const result = await runGit(root, ["diff", "--name-only", "-z", before, after])
  if (!result || result.code !== 0) return 0
  return result.stdout.split("\0").filter(Boolean).length
}

function removeAdded(root: string, relative: string): void {
  const target = path.join(root, relative)
  rmSync(target, { force: true })
  let dir = path.dirname(target)
  while (dir !== root) {
    if (!dir.startsWith(root + path.sep)) break
    try {
      if (readdirSync(dir).length > 0) break
      rmdirSync(dir)
    } catch {
      break
    }
    dir = path.dirname(dir)
  }
}

export async function beginTurn(sessionId: string, root: string): Promise<void> {
  pending.delete(sessionId)
  try {
    const gitDir = await repoGitDir(root)
    if (!gitDir) return
    const beforeWork = await worktreeTree(root, gitDir)
    const beforeIndex = await indexTree(root)
    if (!beforeWork || !beforeIndex) return
    pending.set(sessionId, { root, beforeWork, beforeIndex })
  } catch {
    pending.delete(sessionId)
  }
}

export async function endTurn(sessionId: string, root: string): Promise<void> {
  const started = pending.get(sessionId)
  pending.delete(sessionId)
  if (!started || started.root !== root) return
  try {
    const gitDir = await repoGitDir(root)
    if (!gitDir) return
    const afterWork = await worktreeTree(root, gitDir)
    const afterIndex = await indexTree(root)
    if (!afterWork || !afterIndex) return
    const files = await changedFiles(root, started.beforeWork, afterWork)
    const changed = files + (started.beforeIndex === afterIndex ? 0 : files === 0 ? 1 : 0)
    if (changed === 0) return
    snapshots.set(sessionId, { ...started, afterWork, afterIndex, changed })
  } catch {
  }
}

export function lastTurn(sessionId: string): number | null {
  if (pending.has(sessionId)) return null
  return snapshots.get(sessionId)?.changed ?? null
}

export function forgetTurn(sessionId: string): void {
  pending.delete(sessionId)
  snapshots.delete(sessionId)
}

export async function restoreTurn(sessionId: string): Promise<string> {
  const current = snapshots.get(sessionId)
  if (!current) throw new Error("Nothing to restore: this turn did not change the workspace.")

  const gitDir = await repoGitDir(current.root)
  if (!gitDir) throw new Error("This workspace is not a git repository.")

  const nowWork = await worktreeTree(current.root, gitDir)
  const nowIndex = await indexTree(current.root)
  if (nowWork !== current.afterWork || nowIndex !== current.afterIndex) {
    throw new Error(
      "The workspace changed after that turn, so restoring it would throw the newer change away.",
    )
  }

  const beforeFiles = new Set(await treeFiles(current.root, current.beforeWork))
  const afterFiles = await treeFiles(current.root, current.afterWork)
  const index = path.join(gitDir, `fx-ui-${crypto.randomUUID()}`)
  try {
    const read = await runGit(current.root, ["read-tree", current.beforeWork], {
      env: withIndex(index),
    })
    if (!read || read.code !== 0) {
      throw new Error(gitMessage(read?.stderr, "Could not read the turn snapshot."))
    }
    const checkout = await runGit(current.root, ["checkout-index", "--all", "--force"], {
      env: withIndex(index),
    })
    if (!checkout || checkout.code !== 0) {
      throw new Error(gitMessage(checkout?.stderr, "Could not restore the worktree."))
    }
  } finally {
    dropIndex(index)
  }

  for (const file of afterFiles) {
    if (!beforeFiles.has(file)) removeAdded(current.root, file)
  }

  const reset = await runGit(current.root, ["read-tree", current.beforeIndex])
  if (!reset || reset.code !== 0) {
    throw new Error(gitMessage(reset?.stderr, "Could not restore the index."))
  }

  forgetEdits(sessionId)
  forgetTurn(sessionId)
  return current.changed === 1
    ? "Restored 1 file to how it was before this turn."
    : `Restored ${current.changed} files to how they were before this turn.`
}
