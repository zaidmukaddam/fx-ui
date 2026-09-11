// Build a Kiro (CodeWhisperer) `conversationState` request from the Gateway
// prompt the fx-ui core produces.
//
// The core speaks one wire format (Vercel AI Gateway): a `prompt` array of
// messages whose `content` holds {type:"text"}, {type:"tool-call"} and
// {type:"tool-result"} parts, plus a `tools` array. Kiro speaks its own
// `conversationState` with alternating user/assistant turns, tool results on
// the following user message, and tool specs under
// `userInputMessageContext.tools`.
//
// This adapts the message-merging, alternation and tool-schema sanitising from
// the dsh-kiro-subscription reference (which consumed dsh's GenerateOptions)
// onto fx-ui's Gateway shape. Images are NOT handled here: the fx-ui core
// refuses image prompt blocks, so Kiro image input goes through the direct
// vision path (see describeImageKiro in providers.ts), exactly as Grok/Codex do.

import { randomUUID } from "node:crypto"

import type { Json } from "./responses"

const PLACEHOLDER = "(empty placeholder)"
const TOOL_DESCRIPTION_LIMIT = 10_000

type PromptPart = {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: { type?: string; value?: unknown }
}

type PromptMessage = { role: string; content: string | PromptPart[] }

type GatewayTool = { name?: string; description?: string; inputSchema?: unknown }

interface NormalizedMessage {
  role: "user" | "assistant"
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  toolResults: Array<{ id: string; text: string; isError: boolean }>
}

function partsOf(content: string | PromptPart[]): PromptPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content
}

function outputText(part: PromptPart): string {
  const value = part.output?.value
  if (typeof value === "string") return value
  return value === undefined ? "" : JSON.stringify(value)
}

function textOf(parts: PromptPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function combineText(...values: string[]): string {
  return values.filter(Boolean).join("\n\n")
}

/**
 * Fold the Gateway prompt into per-role messages. A "tool" role carries tool
 * results, which Kiro attaches to the following user message; assistant tool
 * calls stay on the assistant message.
 */
function normalize(prompt: PromptMessage[]): {
  system: string
  messages: NormalizedMessage[]
} {
  const system: string[] = []
  const messages: NormalizedMessage[] = []

  for (const message of prompt) {
    const parts = partsOf(message.content)
    if (message.role === "system") {
      system.push(textOf(parts))
      continue
    }
    if (message.role === "tool") {
      const results = parts
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          id: String(part.toolCallId ?? ""),
          text: outputText(part) || "(empty result)",
          isError: false,
        }))
      messages.push({ role: "user", text: "", toolCalls: [], toolResults: results })
      continue
    }
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user"
    const toolCalls = parts
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        id: String(part.toolCallId ?? ""),
        name: String(part.toolName ?? ""),
        arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
      }))
    messages.push({ role, text: textOf(parts), toolCalls, toolResults: [] })
  }

  return { system: system.join("\n\n"), messages }
}

/** Merge same-role runs and force strict user/assistant alternation. */
function alternate(messages: NormalizedMessage[]): NormalizedMessage[] {
  const merged: NormalizedMessage[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (previous?.role === message.role) {
      previous.text = combineText(previous.text, message.text)
      previous.toolCalls.push(...message.toolCalls)
      previous.toolResults.push(...message.toolResults)
    } else {
      merged.push({
        ...message,
        toolCalls: [...message.toolCalls],
        toolResults: [...message.toolResults],
      })
    }
  }
  if (merged[0]?.role === "assistant") {
    merged.unshift({ role: "user", text: PLACEHOLDER, toolCalls: [], toolResults: [] })
  }
  const out: NormalizedMessage[] = []
  for (const message of merged) {
    const previous = out.at(-1)
    if (previous?.role === message.role) {
      out.push({
        role: message.role === "user" ? "assistant" : "user",
        text: PLACEHOLDER,
        toolCalls: [],
        toolResults: [],
      })
    }
    out.push(message)
  }
  return out
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema)
  if (value === null || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties" || key === "strict") continue
    if (key === "required" && Array.isArray(child) && child.length === 0) continue
    output[key] = sanitizeSchema(child)
  }
  return output
}

function prepareTools(tools: GatewayTool[]): { tools: Json[]; systemAddition: string } {
  if (!tools.length) return { tools: [], systemAddition: "" }
  const documentation: string[] = []
  const converted: Json[] = []
  for (const tool of tools) {
    const name = tool.name ?? ""
    if (!name || name.length > 64) continue
    let description = tool.description?.trim() || `Tool: ${name}`
    if (description.length > TOOL_DESCRIPTION_LIMIT) {
      documentation.push(`## ${name}\n${description}`)
      description = `Tool: ${name}. Full documentation is included in the system prompt.`
    }
    converted.push({
      toolSpecification: {
        name,
        description,
        inputSchema: { json: sanitizeSchema(tool.inputSchema ?? { type: "object", properties: {} }) },
      },
    })
  }
  return {
    tools: converted,
    systemAddition: documentation.length
      ? `\n\n<tool_documentation>\n${documentation.join("\n\n")}\n</tool_documentation>`
      : "",
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value }
  } catch {
    return {}
  }
}

function userInput(message: NormalizedMessage, model: string, tools?: Json[]): Json {
  const context: Json = {}
  if (tools?.length) context.tools = tools
  if (message.toolResults.length) {
    context.toolResults = message.toolResults.map((result) => ({
      content: [{ text: result.text || "(empty result)" }],
      status: result.isError ? "error" : "success",
      toolUseId: result.id,
    }))
  }
  return {
    content: message.text || PLACEHOLDER,
    modelId: model,
    origin: "AI_EDITOR",
    ...(Object.keys(context).length ? { userInputMessageContext: context } : {}),
  }
}

function assistantResponse(message: NormalizedMessage): Json {
  return {
    content: message.text || PLACEHOLDER,
    ...(message.toolCalls.length
      ? {
          toolUses: message.toolCalls.map((call) => ({
            name: call.name,
            input: parseArguments(call.arguments),
            toolUseId: call.id,
          })),
        }
      : {}),
  }
}

export type KiroRequest = { model: string; effort?: string | null }

/**
 * Turn a Gateway request body into a Kiro `conversationState` payload.
 * `model` is the bare Kiro model id (already mapped by the caller).
 */
export function buildKiroPayload(body: Json, model: string, profileArn: string, effort?: string | null): Json {
  const prompt = (body.prompt as PromptMessage[] | undefined) ?? []
  const { system: baseSystem, messages } = normalize(prompt)
  const prepared = prepareTools((body.tools as GatewayTool[] | undefined) ?? [])
  const normalized = alternate(messages)

  let system = `${baseSystem}${prepared.systemAddition}`.trim()
  if (effort && effort !== "off") {
    system = combineText(
      system,
      `<thinking_mode>Use internal reasoning appropriate for effort ${effort}. Do not expose hidden chain-of-thought; return only concise conclusions.</thinking_mode>`,
    )
  }
  if (normalized.length === 0) {
    normalized.push({ role: "user", text: PLACEHOLDER, toolCalls: [], toolResults: [] })
  }
  if (system) normalized[0]!.text = combineText(system, normalized[0]!.text)

  const historyMessages = normalized.slice(0, -1)
  let current = normalized.at(-1)!
  if (current.role === "assistant") {
    historyMessages.push(current)
    current = { role: "user", text: PLACEHOLDER, toolCalls: [], toolResults: [] }
  }
  const history = historyMessages.map((message) =>
    message.role === "user"
      ? { userInputMessage: userInput(message, model) }
      : { assistantResponseMessage: assistantResponse(message) },
  )

  const payload: Json = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: randomUUID(),
      currentMessage: {
        userInputMessage: userInput(current, model, prepared.tools),
      },
      ...(history.length ? { history } : {}),
    },
  }
  if (profileArn) payload.profileArn = profileArn
  return payload
}
