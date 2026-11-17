import { readFileSync, statSync } from "node:fs"
import path from "node:path"

import { IMAGE_TYPES, resolveInside } from "../tools"

const MAX_MENTION_CHARS = 24_000
const MAX_MENTION_BYTES = 2_000_000

const MENTION = /(^|\s)@([^\s@]+)/g

const TRAILING_PUNCTUATION = /[,.;:!?)\]}'"]+$/

export function parseMentions(draft: string): string[] {
  const found: string[] = []
  for (const match of draft.matchAll(MENTION)) {
    const candidate = (match[2] ?? "").replace(TRAILING_PUNCTUATION, "")
    if (candidate && !found.includes(candidate)) found.push(candidate)
  }
  return found
}

export type Trigger = "@" | "/"

export type ActiveToken = { query: string; start: number }

export function activeToken(draft: string, trigger: Trigger): ActiveToken | null {
  const pattern = trigger === "@" ? /(^|\s)@([^\s@]*)$/ : /(^|\s)\/([^\s/]*)$/
  const match = pattern.exec(draft)
  if (!match) return null
  const query = match[2] ?? ""
  return { query, start: draft.length - query.length - 1 }
}

export function activeMention(draft: string): ActiveToken | null {
  return activeToken(draft, "@")
}

export function activeCommand(draft: string): ActiveToken | null {
  if (!/^\/[^\s/]*$/.test(draft)) return null
  return { query: draft.slice(1), start: 0 }
}

export function applyToken(draft: string, trigger: Trigger, value: string): string {
  const active = activeToken(draft, trigger)
  if (!active) return draft
  return `${draft.slice(0, active.start)}${trigger}${value} `
}

export function applyMention(draft: string, file: string): string {
  return applyToken(draft, "@", file)
}

export function rankFiles(files: string[], query: string, limit = 20): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return files.slice(0, limit)

  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const haystack = file.toLowerCase()
    const direct = haystack.indexOf(needle)
    let score: number
    if (direct >= 0) {
      const base = haystack.lastIndexOf("/") + 1
      score = (direct >= base ? 0 : 1_000) + direct
    } else {
      const spread = subsequence(haystack, needle)
      if (spread < 0) continue
      score = 10_000 + spread
    }
    scored.push({ file, score: score + file.length / 1_000 })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((entry) => entry.file)
}

function subsequence(haystack: string, needle: string): number {
  let at = -1
  let first = -1
  for (const character of needle) {
    at = haystack.indexOf(character, at + 1)
    if (at < 0) return -1
    if (first < 0) first = at
  }
  return at - first
}

export type MentionBlock =
  | { type: "resource"; resource: { uri: string; text: string } }
  | { type: "text"; text: string }

export type MentionProblem = { path: string; reason: string }

export function imageBlock(image: string): MentionBlock {
  return {
    type: "text",
    text: `The user attached the image ${image}. Read it with the vision tool before answering.`,
  }
}

export function mentionBlocks(
  root: string,
  draft: string,
): { blocks: MentionBlock[]; problems: MentionProblem[] } {
  const blocks: MentionBlock[] = []
  const problems: MentionProblem[] = []

  for (const mention of parseMentions(draft)) {
    try {
      const target = resolveInside(root, mention)
      const stats = statSync(target)
      if (stats.isDirectory()) {
        problems.push({ path: mention, reason: "is a directory" })
        continue
      }
      if (path.extname(target).toLowerCase() in IMAGE_TYPES) {
        blocks.push(imageBlock(mention))
        continue
      }
      if (stats.size > MAX_MENTION_BYTES) {
        problems.push({ path: mention, reason: "is too large to attach" })
        continue
      }
      const raw = readFileSync(target, "utf8")
      if (raw.includes("\0")) {
        problems.push({ path: mention, reason: "is binary, not text" })
        continue
      }
      const dropped = raw.length - MAX_MENTION_CHARS
      const text =
        dropped > 0
          ? `${raw.slice(0, MAX_MENTION_CHARS)}\n… ${dropped.toLocaleString()} more characters truncated`
          : raw
      blocks.push({
        type: "resource",
        resource: { uri: `file://${target}`, text },
      })
    } catch (error) {
      problems.push({
        path: mention,
        reason: error instanceof Error ? error.message : "could not be read",
      })
    }
  }

  return { blocks, problems }
}
