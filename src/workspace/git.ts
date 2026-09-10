
import { capture, isMissingProgram } from "./run"
import { findWorkspace, getState, setState } from "../store"

const GIT_TIMEOUT_MS = 10_000

export type GitStatus = {
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

export function isClean(status: GitStatus): boolean {
  return status.staged + status.unstaged + status.untracked === 0
}

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number } | null> {
  try {
    return await capture("git", args, {
      cwd: root,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
    })
  } catch (error) {
    if (isMissingProgram(error)) return null
    throw error
  }
}

export async function gitStatus(
  root: string,
  signal?: AbortSignal,
): Promise<GitStatus | null> {
  const result = await git(root, ["status", "--porcelain=v2", "--branch"], signal)
  if (!result || result.code !== 0) return null

  const status: GitStatus = {
    branch: "detached",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  }

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim()
      if (head && head !== "(detached)") status.branch = head
    } else if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice("# branch.ab ".length).trim().split(" ")
      status.ahead = Math.abs(Number(ahead ?? 0)) || 0
      status.behind = Math.abs(Number(behind ?? 0)) || 0
    } else if (line.startsWith("? ")) {
      status.untracked += 1
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const code = line.split(" ")[1] ?? ".."
      if (code[0] && code[0] !== ".") status.staged += 1
      if (code[1] && code[1] !== ".") status.unstaged += 1
    }
  }

  return status
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

export async function refreshGitStatus(workspaceId: string): Promise<void> {
  const workspace = findWorkspace(getState(), workspaceId)
  if (!workspace) return
  let status: GitStatus | null = null
  try {
    status = await gitStatus(workspace.path)
  } catch {
  }
  setState((current) => ({
    ...current,
    git: { ...current.git, [workspaceId]: status },
  }))
}

function gitError(stderr: string): string {
  const first = stderr.trim().split("\n")[0] ?? "git failed"
  return first.replace(/^fatal:\s*/, "")
}
