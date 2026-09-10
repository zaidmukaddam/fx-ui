import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { capture, isMissingProgram } from "../workspace/run"
import { requestApproval } from "./approvals"
import { recordEdit } from "./edits"
import {
  DENIED_PREFIX,
  clip,
  defineTool,
  field,
  optionalNumber,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import {
  IGNORED_DIRECTORIES,
  display,
  globToRegExp,
  languageOf,
  listWorkspaceFiles,
  resolveInside,
} from "./paths"

const MAX_READ_LINES = 2_000
const MAX_LIST_ENTRIES = 400

async function unifiedDiff(
  relativePath: string,
  before: string,
  after: string,
): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const beforeFile = path.join(os.tmpdir(), `fx-before-${stamp}`)
  const afterFile = path.join(os.tmpdir(), `fx-after-${stamp}`)
  writeFileSync(beforeFile, before)
  writeFileSync(afterFile, after)
  try {
    const { stdout } = await capture(
      "diff",
      ["-u", "-L", `a/${relativePath}`, "-L", `b/${relativePath}`, beforeFile, afterFile],
      {},
    )
    if (!stdout.trim()) return ""
    return `diff --git a/${relativePath} b/${relativePath}\n${stdout}`
  } finally {
    for (const file of [beforeFile, afterFile]) {
      try {
        unlinkSync(file)
      } catch {
      }
    }
  }
}

function countChanges(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1
  }
  return { added, removed }
}

export function fileTools(context: ToolContext): HostTool[] {
  return [
    defineTool<{ path: string; depth: number }>(
      {
        name: "list_files",
        description:
          "List files and directories inside the workspace. Use it before reading or editing to learn the layout.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory relative to the workspace root. Defaults to the root.",
            },
            depth: {
              type: "number",
              description: "How many levels to descend. 1 to 4, defaults to 2.",
            },
          },
        },
        parse: (input) => ({
          path: typeof field(input, "path") === "string" ? (field(input, "path") as string) : ".",
          depth: Math.min(4, Math.max(1, optionalNumber(input, "depth") ?? 2)),
        }),
        label: (input) => input.path,
        run: async (input, ctx) => {
          const start = resolveInside(ctx.root, input.path)
          const lines: string[] = []
          let truncated = false

          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > input.depth || truncated) return
            const entries = await readdir(dir, { withFileTypes: true })
            entries.sort((a, b) =>
              a.isDirectory() === b.isDirectory()
                ? a.name.localeCompare(b.name)
                : a.isDirectory()
                  ? -1
                  : 1,
            )
            for (const entry of entries) {
              if (entry.name.startsWith(".") && entry.name !== ".env.example") continue
              if (lines.length >= MAX_LIST_ENTRIES) {
                truncated = true
                return
              }
              const full = path.join(dir, entry.name)
              const relative = display(ctx.root, full)
              if (entry.isDirectory()) {
                lines.push(`${relative}/`)
                if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full, depth + 1)
              } else {
                lines.push(relative)
              }
            }
          }

          await walk(start, 1)
          const text = lines.join("\n") || "(empty directory)"
          return {
            text: truncated ? `${text}\n… listing truncated` : text,
            label: `${input.path} · ${lines.length} entries`,
          }
        },
      },
      context,
    ),

    defineTool<{ path: string; offset: number; limit: number }>(
      {
        name: "read_file",
        description:
          "Read a UTF-8 text file from the workspace. Returns numbered lines so edits can quote them exactly.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the workspace root." },
            offset: { type: "number", description: "First line to return, 1-based." },
            limit: { type: "number", description: "How many lines to return." },
          },
          required: ["path"],
        },
        parse: (input) => ({
          path: requireString(input, "path"),
          offset: Math.max(1, optionalNumber(input, "offset") ?? 1),
          limit: Math.min(MAX_READ_LINES, optionalNumber(input, "limit") ?? MAX_READ_LINES),
        }),
        label: (input) => input.path,
        run: async (input, ctx) => {
          const target = resolveInside(ctx.root, input.path)
          const raw = readFileSync(target, "utf8")
          if (raw.includes("\0")) throw new Error("That file is binary, not text.")

          const all = raw.split("\n")
          const slice = all.slice(input.offset - 1, input.offset - 1 + input.limit)
          const numbered = slice
            .map((line, index) => `${input.offset + index}\t${line}`)
            .join("\n")
          const remaining = all.length - (input.offset - 1 + slice.length)
          return {
            text:
              remaining > 0
                ? `${numbered}\n… ${remaining} more lines. Read again with offset ${input.offset + slice.length}.`
                : numbered,
            language: languageOf(target),
            label: `${display(ctx.root, target)} · ${all.length} lines`,
          }
        },
      },
      context,
    ),

    defineTool<{ pattern: string; path: string }>(
      {
        name: "grep_files",
        description:
          "Search file contents in the workspace with a regular expression. Returns matching lines with their paths.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression to search for." },
            path: { type: "string", description: "Directory or file to search. Defaults to the root." },
          },
          required: ["pattern"],
        },
        parse: (input) => ({
          pattern: requireString(input, "pattern"),
          path: typeof field(input, "path") === "string" ? (field(input, "path") as string) : ".",
        }),
        label: (input) => input.pattern,
        run: async (input, ctx) => {
          const target = resolveInside(ctx.root, input.path)
          const options = { cwd: ctx.root, signal: ctx.signal }
          const search = () =>
            capture(
              "rg",
              ["--line-number", "--no-heading", "--color", "never", "--max-count", "20", "--", input.pattern, target],
              options,
            ).catch((error) => {
              if (!isMissingProgram(error)) throw error
              return capture(
                "grep",
                ["-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules", "-e", input.pattern, target],
                options,
              )
            })

          const { stdout } = await search()
          const cleaned = stdout.split(`${ctx.root}/`).join("")
          const matches = cleaned.trim() ? cleaned.trimEnd().split("\n").length : 0
          return {
            text: cleaned.trim() ? clip(cleaned) : "No matches.",
            label: `${input.pattern} · ${matches} matches`,
          }
        },
      },
      context,
    ),

    defineTool<{ pattern: string }>(
      {
        name: "glob_files",
        description:
          "Find files by path pattern. `*` matches within one segment, `**` across segments, `?` one character — for example `src/**/*.ts`. Use it to locate files by name; use search to find text inside them.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Glob relative to the workspace root, e.g. `src/**/*.tsx`.",
            },
          },
          required: ["pattern"],
        },
        parse: (input) => ({ pattern: requireString(input, "pattern") }),
        label: (input) => input.pattern,
        run: async (input, ctx) => {
          const matcher = globToRegExp(input.pattern)
          const files = (await listWorkspaceFiles(ctx.root)).filter((file) =>
            matcher.test(file),
          )
          return {
            text: files.length > 0 ? files.join("\n") : "No files match.",
            label: `${input.pattern} · ${files.length} files`,
          }
        },
      },
      context,
    ),

    defineTool<{ path: string; content: string }>(
      {
        name: "write_file",
        description:
          "Create a file or replace its entire contents. Prefer edit_file for a change to an existing file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the workspace root." },
            content: { type: "string", description: "The complete new contents." },
          },
          required: ["path", "content"],
        },
        parse: (input) => ({
          path: requireString(input, "path"),
          content: String(field(input, "content") ?? ""),
        }),
        label: (input) => input.path,
        run: async (input, ctx) => {
          const target = resolveInside(ctx.root, input.path)
          const relative = display(ctx.root, target)
          const before = existsSync(target) ? readFileSync(target, "utf8") : ""
          const patch = await unifiedDiff(relative, before, input.content)
          if (!patch) return { text: `${relative} already had those contents.`, label: relative }

          const approved = await requestApproval({
            sessionId: ctx.sessionId,
            toolName: "write_file",
            title: existsSync(target) ? `Overwrite ${relative}` : `Create ${relative}`,
            detail: relative,
            patch,
            scope: "write",
            routine: true,
          })
          if (!approved) throw new Error(`${DENIED_PREFIX}: ${relative} was not written.`)

          const existed = existsSync(target)
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, input.content)
          recordEdit(
            ctx.sessionId,
            target,
            relative,
            existed ? before : null,
            input.content,
          )
          const { added, removed } = countChanges(patch)
          return {
            text: `Wrote ${relative} (+${added} −${removed}).`,
            patch,
            label: `${relative} +${added} −${removed}`,
          }
        },
      },
      context,
    ),

    defineTool<{ path: string; oldText: string; newText: string; all: boolean }>(
      {
        name: "edit_file",
        description:
          "Replace an exact string in a file. The old text must appear exactly once unless replace_all is set.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the workspace root." },
            old_text: { type: "string", description: "Exact text to replace, including indentation." },
            new_text: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of failing." },
          },
          required: ["path", "old_text", "new_text"],
        },
        parse: (input) => ({
          path: requireString(input, "path"),
          oldText: requireString(input, "old_text"),
          newText: String(field(input, "new_text") ?? ""),
          all: field(input, "replace_all") === true,
        }),
        label: (input) => input.path,
        run: async (input, ctx) => {
          const target = resolveInside(ctx.root, input.path)
          const relative = display(ctx.root, target)
          const before = readFileSync(target, "utf8")
          const occurrences = before.split(input.oldText).length - 1
          if (occurrences === 0) {
            throw new Error(`That text does not appear in ${relative}. Read the file and quote it exactly.`)
          }
          if (occurrences > 1 && !input.all) {
            throw new Error(
              `That text appears ${occurrences} times in ${relative}. Quote more context, or set replace_all.`,
            )
          }
          const after = input.all
            ? before.split(input.oldText).join(input.newText)
            : before.replace(input.oldText, input.newText)
          const patch = await unifiedDiff(relative, before, after)

          const approved = await requestApproval({
            sessionId: ctx.sessionId,
            toolName: "edit_file",
            title: `Edit ${relative}`,
            detail: relative,
            patch,
            scope: "write",
            routine: true,
          })
          if (!approved) throw new Error(`${DENIED_PREFIX}: ${relative} was not edited.`)

          writeFileSync(target, after)
          recordEdit(ctx.sessionId, target, relative, before, after)
          const { added, removed } = countChanges(patch)
          return {
            text: `Edited ${relative} (+${added} −${removed}).`,
            patch,
            label: `${relative} +${added} −${removed}`,
          }
        },
      },
      context,
    ),
  ]
}
