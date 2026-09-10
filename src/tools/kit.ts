import { appendMessage, newId, patchMessage } from "../store"
import { type SearchStep } from "../agent/providers"
import { requestApproval, type ApprovalRequest } from "./approvals"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type HostTool = {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
  execute(
    input: unknown,
    context: { signal: AbortSignal },
  ): Promise<JsonValue | undefined>
}

export type ToolContext = {
  sessionId: string
  root: string
  depth?: number
  search?: boolean
}

export type ToolOutput = {
  text: string
  patch?: string
  language?: string
  label?: string
}

export type ToolSpec<Input> = {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
  parse: (input: unknown) => Input
  label: (input: Input) => string
  run: (
    input: Input,
    context: ToolContext & { signal: AbortSignal; name: string },
  ) => Promise<ToolOutput>
}

export const DENIED_PREFIX = "Denied by the user"

export async function gate(
  ctx: ToolContext & { name: string },
  ask: Omit<ApprovalRequest, "sessionId" | "toolName" | "routine"> & {
    routine?: boolean
    denied: string
  },
): Promise<void> {
  const { denied, routine, ...rest } = ask
  const allowed = await requestApproval({
    ...rest,
    routine: routine ?? false,
    sessionId: ctx.sessionId,
    toolName: ctx.name,
  })
  if (!allowed) throw new Error(`${DENIED_PREFIX}: ${denied}`)
}

export const MAX_OUTPUT_CHARS = 24_000

const PREVIEW_CHARS = 2_000

export function clip(value: string, limit = MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) return value
  const dropped = value.length - limit
  return `${value.slice(0, limit)}\n… ${dropped.toLocaleString()} more characters truncated`
}

export function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined
}

export function requireString(input: unknown, key: string): string {
  const value = field(input, key)
  if (typeof value !== "string" || value === "") {
    throw new Error(`\`${key}\` is required and must be a non-empty string.`)
  }
  return value
}

export function optionalString(input: unknown, key: string): string | undefined
export function optionalString(input: unknown, key: string, fallback: string): string
export function optionalString(
  input: unknown,
  key: string,
  fallback?: string,
): string | undefined {
  const value = field(input, key)
  if (value === undefined || value === null) return fallback
  if (typeof value !== "string") throw new Error(`\`${key}\` must be a string.`)
  return value
}

export function optionalNumber(input: unknown, key: string): number | undefined {
  const value = field(input, key)
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`\`${key}\` must be a number.`)
  return parsed
}

const retained = new Map<string, { tool: string; text: string }>()

function retain(sessionId: string, tool: string, text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text

  const handle = `${sessionId}:${newId()}`
  retained.set(handle, { tool, text })
  return [
    text.slice(0, PREVIEW_CHARS),
    "",
    `… ${(text.length - PREVIEW_CHARS).toLocaleString()} more characters retained.`,
    `Call read_tool_result with handle "${handle}" to read a range or search it.`,
  ].join("\n")
}

export function readRetained(handle: string): { tool: string; text: string } | undefined {
  return retained.get(handle)
}

export function forgetToolResults(sessionId: string): void {
  for (const handle of retained.keys()) {
    if (handle.startsWith(`${sessionId}:`)) retained.delete(handle)
  }
}

export function defineTool<Input>(
  spec: ToolSpec<Input>,
  context: ToolContext,
): HostTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async execute(rawInput, { signal }) {
      const messageId = newId()
      appendMessage(context.sessionId, {
        id: messageId,
        kind: "tool",
        at: Date.now(),
        callId: messageId,
        name: spec.name,
        label: spec.name,
        state: "running",
        output: "",
      })
      try {
        const input = spec.parse(rawInput)
        patchMessage(context.sessionId, messageId, { label: spec.label(input) })
        const result = await spec.run(input, { ...context, signal, name: spec.name })
        patchMessage(context.sessionId, messageId, {
          state: "ok",
          ...(result.label ? { label: result.label } : {}),
          output: result.text,
          patch: result.patch,
          language: result.language,
          endedAt: Date.now(),
        })
        return retain(context.sessionId, spec.name, result.text)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        patchMessage(context.sessionId, messageId, {
          state: text.startsWith(DENIED_PREFIX) ? "denied" : "error",
          output: text,
          endedAt: Date.now(),
        })
        throw error instanceof Error ? error : new Error(text)
      }
    },
  }
}

function summarise(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input ?? "")
  const parts = Object.entries(input as Record<string, unknown>).map(
    ([key, value]) =>
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  )
  return clip(parts.join(" "), 120)
}

function textOf(result: unknown): string {
  if (typeof result === "string") return result
  return result === undefined ? "" : JSON.stringify(result, null, 2)
}

export function adopt(
  tool: HostTool,
  context: ToolContext,
  approval?: { title: string; scope: string },
): HostTool {
  return defineTool<unknown>(
    {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      parse: (input) => input,
      label: summarise,
      run: async (input, ctx) => {
        if (approval) {
          await gate(ctx, {
            title: approval.title,
            detail: summarise(input),
            scope: approval.scope,
            denied: `${tool.name} was not run.`,
          })
        }
        return { text: textOf(await tool.execute(input, { signal: ctx.signal })) }
      },
    },
    context,
  )
}

function searchName(action: string): string {
  if (action === "open_page") return "web_fetch"
  return action === "x_search" ? "x_search" : "web_search"
}

function searchLabel(step: SearchStep): string {
  return step.label || (step.action === "x_search" ? "X" : "the web")
}

export function searchRows(sessionId: string): (step: SearchStep) => void {
  const rows = new Map<string, string>()
  return (step) => {
    const open = rows.get(step.id)
    if (!open) {
      const id = newId()
      rows.set(step.id, id)
      appendMessage(sessionId, {
        id,
        kind: "tool",
        at: Date.now(),
        callId: step.id,
        name: searchName(step.action),
        label: searchLabel(step),
        state: "running",
        output: "",
      })
      return
    }
    if (!step.done) return
    rows.delete(step.id)
    patchMessage(sessionId, open, {
      name: searchName(step.action),
      state: "ok",
      label: step.label || "the web",
      output: step.sources.join("\n"),
      endedAt: Date.now(),
    })
  }
}
