import { existsSync, realpathSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { ATTACHMENT_DIR } from "../store"

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
])

const MAX_INDEXED_FILES = 4_000
const MAX_INDEX_DEPTH = 8
const INDEX_TTL_MS = 5_000

const indexes = new Map<string, { at: number; files: string[] }>()

export function isAttachment(candidate: string): boolean {
  return path.resolve(candidate).startsWith(ATTACHMENT_DIR + path.sep)
}

export function resolveInside(root: string, candidate: string): string {
  const target = path.resolve(root, candidate || ".")
  const realRoot = realpathSync(root)

  let probe = target
  while (!existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe
  const resolved = path.join(realProbe, path.relative(probe, target))

  const relative = path.relative(realRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path is outside the workspace: ${candidate}. Only paths under ${root} are available.`,
    )
  }
  return resolved
}

export function display(root: string, target: string): string {
  const relative = path.relative(root, target)
  return relative === "" ? "." : relative
}

export function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const cached = indexes.get(root)
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.files

  const files: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_INDEX_DEPTH || files.length >= MAX_INDEXED_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) return
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"))
      }
    }
  }

  await walk(root, 1)
  indexes.set(root, { at: Date.now(), files })
  return files
}

export function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (let at = 0; at < pattern.length; at += 1) {
    const character = pattern[at]!
    if (character === "*") {
      if (pattern[at + 1] === "*") {
        if (pattern[at + 2] === "/") {
          source += "(?:.*/)?"
          at += 2
        } else {
          source += ".*"
          at += 1
        }
      } else {
        source += "[^/]*"
      }
    } else if (character === "?") {
      source += "[^/]"
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`)
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".css": "css",
  ".go": "go",
  ".html": "html",
  ".js": "js",
  ".json": "json",
  ".jsx": "jsx",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".sh": "bash",
  ".toml": "toml",
  ".ts": "ts",
  ".tsx": "tsx",
  ".yaml": "yaml",
  ".yml": "yaml",
}

export function languageOf(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}
