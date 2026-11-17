
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

import { capture, isMissingProgram, type Captured } from "./run"
import { findWorkspace, getState, setState } from "../store"

const GIT_TIMEOUT_MS = 10_000
const MAX_UNTRACKED_BYTES = 512 * 1024
export const MAX_UNTRACKED_PATCHES = 50

export type ChangedFile = {
  /** Path relative to the workspace root ("../x" when it lives outside it). */
  path: string
  /** Path relative to the repository root, used for git commands. */
  repoPath: string
  /** Display letter: "M", "A", "D", "R", "?" or "U". */
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  added: number | null
  deleted: number | null
}

export type GitStatus = {
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  /** Repository root, when the workspace sits inside a working tree. */
  top: string
  files: ChangedFile[]
}

/** Which patch a file row shows: its staged part, its unstaged part, or a
 *  synthesized new-file patch for untracked paths. */
export type DiffScope = "staged" | "worktree" | "untracked"

export type DiffTab = {
  key: string
  file: ChangedFile
  scope: DiffScope
  patch: string | null
  error: string | null
  seq: number
}

export type DiffView = {
  tabs: DiffTab[]
  active: string | null
  combined: { patch: string | null; error: string | null; seq: number } | null
}

export function isClean(status: GitStatus): boolean {
  return status.staged + status.unstaged + status.untracked === 0
}

export async function runGit(
  root: string,
  args: string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Captured | null> {
  try {
    return await capture("git", args, {
      cwd: root,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      env: options.env,
    })
  } catch (error) {
    if (isMissingProgram(error)) return null
    throw error
  }
}

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Captured | null> {
  return runGit(root, args, { signal })
}

function statusCode(xy: string, untracked: boolean): string {
  if (untracked) return "?"
  if (xy === "UU" || xy.startsWith("U") || xy.endsWith("U") || xy === "AA") return "U"
  const x = xy[0]
  const y = xy[1]
  return x && x !== "." ? x : y && y !== "." ? y : "M"
}

function numstatByPath(output: string): Map<string, { added: number; deleted: number }> {
  const stats = new Map<string, { added: number; deleted: number }>()
  const fields = output.split("\0")
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]!
    const firstTab = record.indexOf("\t")
    if (firstTab < 0) continue
    const added = Number(record.slice(0, firstTab))
    const rest = record.slice(firstTab + 1)
    const secondTab = rest.indexOf("\t")
    if (secondTab < 0) continue
    const deleted = Number(rest.slice(0, secondTab))
    let path = rest.slice(secondTab + 1)
    if (path === "") {
      // Rename: counts record is followed by the old then new path fields.
      path = fields[index + 2] ?? ""
      index += 2
    }
    if (!path || Number.isNaN(added) || Number.isNaN(deleted)) continue
    const entry = stats.get(path) ?? { added: 0, deleted: 0 }
    entry.added += added
    entry.deleted += deleted
    stats.set(path, entry)
  }
  return stats
}

export async function gitStatus(
  root: string,
  signal?: AbortSignal,
): Promise<GitStatus | null> {
  const [result, topResult] = await Promise.all([
    git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], signal),
    git(root, ["rev-parse", "--show-toplevel"], signal),
  ])
  if (!result || result.code !== 0 || !topResult || topResult.code !== 0) return null

  const top = topResult.stdout.trim()
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {
  }
  const status: GitStatus = {
    branch: "detached",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    top,
    files: [],
  }

  const fields = result.stdout.split("\0")
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index]!
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim()
      if (head && head !== "(detached)") status.branch = head
    } else if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice("# branch.ab ".length).trim().split(" ")
      status.ahead = Math.abs(Number(ahead ?? 0)) || 0
      status.behind = Math.abs(Number(behind ?? 0)) || 0
    } else if (line.startsWith("? ")) {
      const repoPath = line.slice(2)
      status.untracked += 1
      status.files.push({
        path: displayPath(realRoot, top, repoPath),
        repoPath,
        code: "?",
        staged: false,
        unstaged: false,
        untracked: true,
        added: null,
        deleted: null,
      })
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const kind = line[0]!
      const parts = line.split(" ")
      const xy = parts[1] ?? ".."
      const repoPath =
        kind === "1"
          ? parts.slice(8).join(" ")
          : kind === "2"
            ? parts.slice(9).join(" ")
            : parts.slice(10).join(" ")
      if (kind === "2") index += 1
      if (!repoPath) continue
      const staged = Boolean(xy[0] && xy[0] !== ".")
      const unstaged = Boolean(xy[1] && xy[1] !== ".")
      if (staged) status.staged += 1
      if (unstaged) status.unstaged += 1
      status.files.push({
        path: displayPath(realRoot, top, repoPath),
        repoPath,
        code: statusCode(xy, false),
        staged,
        unstaged,
        untracked: false,
        added: null,
        deleted: null,
      })
    }
  }

  if (status.files.length > 0) {
    const [worktree, staged] = await Promise.all([
      git(top, ["diff", "--numstat", "-z"], signal),
      git(top, ["diff", "--staged", "--numstat", "-z"], signal),
    ])
    const stats = new Map<string, { added: number; deleted: number }>()
    for (const output of [worktree?.stdout, staged?.stdout]) {
      if (!output) continue
      for (const [key, value] of numstatByPath(output)) {
        const entry = stats.get(key) ?? { added: 0, deleted: 0 }
        entry.added += value.added
        entry.deleted += value.deleted
        stats.set(key, entry)
      }
    }
    for (const file of status.files) {
      const entry = stats.get(file.repoPath)
      if (entry) {
        file.added = entry.added
        file.deleted = entry.deleted
      }
    }
  }

  return status
}

function displayPath(root: string, top: string, repoPath: string): string {
  const relative = path.relative(root, path.join(top, repoPath))
  return relative === "" ? repoPath : relative
}

export async function gitDiff(
  root: string,
  options: { staged?: boolean; path?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const args = ["diff", "--no-color"]
  if (options.staged) args.push("--staged")
  if (options.path) args.push("--", options.path)

  const result = await git(root, args, options.signal)
  if (!result) throw new Error("git is not installed, so there is no diff to read.")
  if (result.code !== 0) throw new Error(gitError(result.stderr))
  return result.stdout
}

function untrackedPatch(top: string, file: ChangedFile): string {
  const target = path.join(top, file.repoPath)
  let size = 0
  try {
    size = statSync(target).size
  } catch {
    throw new Error(`${file.path} is no longer on disk.`)
  }
  if (size > MAX_UNTRACKED_BYTES) {
    throw new Error(`${file.path} is too large to preview.`)
  }
  const content = readFileSync(target)
  if (content.includes(0)) {
    throw new Error(`${file.path} is a binary file, so there is no diff to show.`)
  }
  const text = content.toString("utf8")
  const lines = text === "" ? [] : text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const header = [
    `diff --git a/${file.repoPath} b/${file.repoPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${file.repoPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ]
  return lines.length === 0 ? header.join("\n") : `${header.join("\n")}\n${lines.map((line) => `+${line}`).join("\n")}`
}

export async function gitFileDiff(
  status: GitStatus,
  file: ChangedFile,
  scope: DiffScope,
  signal?: AbortSignal,
): Promise<string> {
  if (scope === "untracked") return untrackedPatch(status.top, file)
  const args = ["diff", "--no-color"]
  if (scope === "staged") args.push("--staged")
  args.push("--", file.repoPath)
  const result = await git(status.top, args, signal)
  if (!result) throw new Error("git is not installed, so there is no diff to read.")
  if (result.code !== 0) throw new Error(gitError(result.stderr))
  return result.stdout
}

/** Every uncommitted change as one patch: `git diff HEAD` merges staged and
 *  unstaged work per file, then synthesized new-file patches cover untracked
 *  paths. In a repo with no commits yet the index diffs against the empty
 *  tree instead. */
export async function gitCombinedDiff(status: GitStatus): Promise<string> {
  const head = await git(status.top, ["rev-parse", "--verify", "HEAD"])
  let patch = ""
  if (head && head.code === 0) {
    const result = await git(status.top, ["diff", "--no-color", "HEAD"])
    if (!result) throw new Error("git is not installed, so there is no diff to read.")
    if (result.code !== 0) throw new Error(gitError(result.stderr))
    patch = result.stdout
  } else {
    const [unstaged, staged] = await Promise.all([
      git(status.top, ["diff", "--no-color"]),
      git(status.top, ["diff", "--no-color", "--staged"]),
    ])
    if (!unstaged || !staged) throw new Error("git is not installed, so there is no diff to read.")
    if (unstaged.code !== 0) throw new Error(gitError(unstaged.stderr))
    if (staged.code !== 0) throw new Error(gitError(staged.stderr))
    patch = [unstaged.stdout, staged.stdout].filter(Boolean).join("")
  }
  // ponytail: first N untracked files only, reads are sync; stream them if big trees matter.
  const untracked = status.files.filter((entry) => entry.untracked)
  for (const file of untracked.slice(0, MAX_UNTRACKED_PATCHES)) {
    try {
      const extra = untrackedPatch(status.top, file)
      patch = patch === "" ? extra : `${patch}\n${extra}`
    } catch {
    }
  }
  return patch
}

export async function gitLog(
  root: string,
  options: { limit?: number; path?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const args = [
    "log",
    `--max-count=${options.limit ?? 20}`,
    "--no-color",
    "--date=short",
    "--pretty=format:%h  %ad  %an  %s",
  ]
  if (options.path) args.push("--", options.path)

  const result = await git(root, args, options.signal)
  if (!result) throw new Error("git is not installed, so there is no history to read.")
  if (result.code !== 0) throw new Error(gitError(result.stderr))
  return result.stdout
}

export function summarise(status: GitStatus): string {
  const parts: string[] = []
  if (status.staged > 0) parts.push(`${status.staged} staged`)
  if (status.unstaged > 0) parts.push(`${status.unstaged} modified`)
  if (status.untracked > 0) parts.push(`${status.untracked} untracked`)
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`)
  if (status.behind > 0) parts.push(`${status.behind} behind`)
  return parts.length > 0 ? `${status.branch} · ${parts.join(", ")}` : `${status.branch} · clean`
}

let diffSeq = 0

export function diffKey(scope: DiffScope, file: ChangedFile): string {
  return `${scope}:${file.repoPath}`
}

async function loadPatch(workspaceId: string, key: string): Promise<void> {
  const workspace = findWorkspace(getState(), workspaceId)
  const status = workspace ? (getState().git[workspaceId] ?? null) : null
  const tab = getState().diffView[workspaceId]?.tabs.find((entry) => entry.key === key)
  if (!workspace || !status || !tab) return
  const seq = tab.seq
  const write = (fields: { patch?: string | null; error?: string | null }) =>
    setState((current) => {
      const view = current.diffView[workspaceId]
      const found = view?.tabs.find((entry) => entry.key === key)
      if (!view || !found || found.seq !== seq) return current
      return {
        ...current,
        diffView: {
          ...current.diffView,
          [workspaceId]: {
            ...view,
            tabs: view.tabs.map((entry) =>
              entry.key === key ? { ...entry, ...fields } : entry,
            ),
          },
        },
      }
    })
  try {
    write({ patch: await gitFileDiff(status, tab.file, tab.scope), error: null })
  } catch (error) {
    write({ error: error instanceof Error ? error.message : String(error) })
  }
}

function staleTab(status: GitStatus | null, tab: DiffTab): ChangedFile | null {
  const match = status?.files.find((file) => file.repoPath === tab.file.repoPath)
  if (!match) return null
  if (tab.scope === "staged" && !match.staged) return null
  if (tab.scope === "worktree" && !match.unstaged) return null
  if (tab.scope === "untracked" && !match.untracked) return null
  return match
}

async function loadCombined(workspaceId: string): Promise<void> {
  const workspace = findWorkspace(getState(), workspaceId)
  const status = workspace ? (getState().git[workspaceId] ?? null) : null
  const combined = getState().diffView[workspaceId]?.combined
  if (!workspace || !status || !combined) return
  const seq = combined.seq
  const write = (fields: { patch?: string | null; error?: string | null }) =>
    setState((current) => {
      const slot = current.diffView[workspaceId]?.combined
      if (!slot || slot.seq !== seq) return current
      const view = current.diffView[workspaceId]!
      return {
        ...current,
        diffView: {
          ...current.diffView,
          [workspaceId]: { ...view, combined: { ...slot, ...fields } },
        },
      }
    })
  try {
    write({ patch: await gitCombinedDiff(status), error: null })
  } catch (error) {
    write({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function ensureCombinedDiff(workspaceId: string): void {
  setState((current) => {
    const view = current.diffView[workspaceId]
    if (view?.combined) return current
    return {
      ...current,
      diffView: {
        ...current.diffView,
        [workspaceId]: {
          tabs: view?.tabs ?? [],
          active: view?.active ?? null,
          combined: { patch: null, error: null, seq: ++diffSeq },
        },
      },
    }
  })
  void loadCombined(workspaceId)
}

export function viewDiff(workspaceId: string, file: ChangedFile, scope: DiffScope): void {
  const key = diffKey(scope, file)
  setState((current) => {
    const view = current.diffView[workspaceId] ?? {
      tabs: [],
      active: null,
      combined: null,
    }
    const tabs = view.tabs.some((tab) => tab.key === key)
      ? view.tabs.map((tab) => (tab.key === key ? { ...tab, file, seq: ++diffSeq } : tab))
      : [...view.tabs, { key, file, scope, patch: null, error: null, seq: ++diffSeq }]
    return {
      ...current,
      diffView: {
        ...current.diffView,
        [workspaceId]: { tabs, active: key, combined: view.combined },
      },
    }
  })
  void loadPatch(workspaceId, key)
}

export function activateDiff(workspaceId: string, key: string | null): void {
  setState((current) => {
    const view = current.diffView[workspaceId]
    if (!view || view.active === key) return current
    if (key !== null && !view.tabs.some((tab) => tab.key === key)) return current
    return {
      ...current,
      diffView: { ...current.diffView, [workspaceId]: { ...view, active: key } },
    }
  })
}

export function closeDiffTab(workspaceId: string, key: string): void {
  setState((current) => {
    const view = current.diffView[workspaceId]
    const index = view?.tabs.findIndex((tab) => tab.key === key) ?? -1
    if (!view || index < 0) return current
    const tabs = view.tabs.filter((tab) => tab.key !== key)
    if (tabs.length === 0 && !view.combined) {
      const diffView = { ...current.diffView }
      delete diffView[workspaceId]
      return { ...current, diffView }
    }
    const active =
      view.active === key
        ? (tabs[index - 1]?.key ?? tabs[index]?.key ?? null)
        : view.active
    return {
      ...current,
      diffView: { ...current.diffView, [workspaceId]: { ...view, tabs, active } },
    }
  })
}

export async function refreshGitStatus(workspaceId: string): Promise<void> {
  const workspace = findWorkspace(getState(), workspaceId)
  if (!workspace) return
  let status: GitStatus | null = null
  try {
    status = await gitStatus(workspace.path)
  } catch {
  }

  let reload: DiffTab[] = []
  let reloadCombined = false
  setState((current) => {
    const view = current.diffView[workspaceId]
    const diffView = { ...current.diffView }
    reload = []
    reloadCombined = false
    if (view) {
      const kept = view.tabs
        .map((tab) => {
          const match = staleTab(status, tab)
          if (!match) return null
          const next = { ...tab, file: match, seq: ++diffSeq }
          reload.push(next)
          return next
        })
        .filter((tab): tab is DiffTab => tab !== null)
      const combined = view.combined ? { ...view.combined, seq: ++diffSeq } : null
      reloadCombined = combined !== null
      if (kept.length === 0 && !combined) {
        delete diffView[workspaceId]
      } else {
        diffView[workspaceId] = {
          tabs: kept,
          active:
            view.active && kept.some((tab) => tab.key === view.active)
              ? view.active
              : null,
          combined,
        }
      }
    }
    return { ...current, git: { ...current.git, [workspaceId]: status }, diffView }
  })
  for (const tab of reload) void loadPatch(workspaceId, tab.key)
  if (reloadCombined) void loadCombined(workspaceId)
}

function gitError(stderr: string): string {
  const first = stderr.trim().split("\n")[0] ?? "git failed"
  return first.replace(/^fatal:\s*/, "")
}
