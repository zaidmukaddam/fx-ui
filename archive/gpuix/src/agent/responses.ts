import { PROVIDERS } from "./oauth"
import type { Route, SearchStep } from "./providers"

export type Json = Record<string, unknown>

type PromptPart = {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: { type?: string; value?: unknown }
}

type PromptMessage = { role: string; content: string | PromptPart[] }

function textOf(content: string | PromptPart[]): string {
  if (typeof content === "string") return content
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function outputText(part: PromptPart): string {
  const value = part.output?.value
  if (typeof value === "string") return value
  return value === undefined ? "" : JSON.stringify(value)
}

export function toResponsesRequest(body: Json, model: string, route: Route = {}): Json {
  const prompt = (body.prompt as PromptMessage[] | undefined) ?? []
  const instructions: string[] = []
  const input: Json[] = []

  for (const message of prompt) {
    if (message.role === "system") {
      instructions.push(textOf(message.content))
      continue
    }
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content } as PromptPart]
      : message.content

    if (message.role === "tool") {
      for (const part of parts) {
        if (part.type !== "tool-result") continue
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: outputText(part),
        })
      }
      continue
    }

    const said = textOf(parts)
    if (said) {
      input.push({
        type: "message",
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: said,
          },
        ],
      })
    }
    for (const part of parts) {
      if (part.type !== "tool-call") continue
      input.push({
        type: "function_call",
        call_id: part.toolCallId,
        name: part.toolName,
        arguments:
          typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
      })
    }
  }

  const tools: Json[] = ((body.tools as Json[] | undefined) ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
  }))
  if (route.search) {
    const searchTools = route.provider ? PROVIDERS[route.provider].searchTools : ["web_search"]
    for (const type of searchTools) tools.push({ type })
  }

  const choice = (body.toolChoice as { type?: string } | undefined)?.type
  return {
    model,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
    ...(tools.length > 0 ? { tools } : {}),
    ...(choice === "required" || choice === "none" ? { tool_choice: choice } : {}),
    ...(route.effort ? { reasoning: { effort: route.effort } } : {}),
    ...(route.fast ? { service_tier: "priority" } : {}),
    stream: true,
    store: false,
  }
}

const FINISH: Record<string, string> = {
  completed: "stop",
  incomplete: "length",
  failed: "error",
}

function part(value: Json): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

type StreamState = {
  open: Set<string>
  calls: number
  onSearch?: (step: SearchStep) => void
  onUsage?: (tokens: number) => void
}

function newStreamState(route: Route): StreamState {
  return { open: new Set(), calls: 0, onSearch: route.onSearch, onUsage: route.onUsage }
}

function isProviderSearch(item: Json | undefined): item is Json {
  if (item?.type === "web_search_call") return true
  return item?.type === "custom_tool_call" && String(item.name ?? "").startsWith("x_")
}

function searchStep(item: Json, done: boolean): SearchStep {
  if (item.type === "custom_tool_call") {
    let input: Json = {}
    try {
      input = JSON.parse(String(item.input || "{}")) as Json
    } catch {}
    return {
      id: String(item.id ?? ""),
      done,
      action: "x_search",
      label: typeof input.query === "string" ? input.query : "",
      sources: [],
    }
  }
  const action = (item.action as Json | undefined) ?? {}
  const query = typeof action.query === "string" ? action.query : ""
  const url = typeof action.url === "string" ? action.url : ""
  const sources = Array.isArray(action.sources)
    ? action.sources
        .map((entry) => String((entry as Json)?.url ?? ""))
        .filter(Boolean)
    : []
  return {
    id: String(item.id ?? ""),
    done,
    action: typeof action.type === "string" ? action.type : "search",
    label: query || url,
    sources,
  }
}

function translateEvent(event: Json, state: StreamState): string[] {
  const type = String(event.type ?? "")
  const open = state.open
  const out: string[] = []

  if (type === "response.output_text.delta" && event.delta) {
    out.push(part({ type: "text-delta", delta: String(event.delta) }))
  } else if (type === "response.reasoning_summary_text.delta" && event.delta) {
    out.push(part({ type: "reasoning-delta", delta: String(event.delta) }))
  } else if (type === "response.output_item.added") {
    const item = event.item as Json | undefined
    if (item?.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "")
      if (id) {
        open.add(id)
        out.push(part({ type: "tool-input-start", id, toolName: String(item.name ?? "") }))
      }
    } else if (isProviderSearch(item)) {
      state.onSearch?.(searchStep(item, false))
    }
  } else if (type === "response.function_call_arguments.delta") {
    const id = String(event.item_id ?? "")
    if (open.has(id) && event.delta) {
      out.push(part({ type: "tool-input-delta", id, delta: String(event.delta) }))
    }
  } else if (type === "response.output_item.done") {
    const item = event.item as Json | undefined
    if (item?.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "")
      const args = String(item.arguments ?? "{}")
      if (open.has(id)) {
        out.push(part({ type: "tool-input-end", id }))
        open.delete(id)
      }
      let input: unknown = {}
      try {
        input = JSON.parse(args || "{}")
      } catch {
        input = {}
      }
      state.calls += 1
      out.push(
        part({ type: "tool-call", toolCallId: id, toolName: String(item.name ?? ""), input }),
      )
    } else if (isProviderSearch(item)) {
      state.onSearch?.(searchStep(item, true))
    }
  } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = (event.response as Json | undefined) ?? {}
    const usage = (response.usage as Json | undefined) ?? {}
    const inputDetails = (usage.input_tokens_details as Json | undefined) ?? {}
    const outputDetails = (usage.output_tokens_details as Json | undefined) ?? {}
    const reason =
      state.calls > 0 && type === "response.completed"
        ? "tool-calls"
        : (FINISH[type.slice("response.".length)] ?? "stop")
    const totalTokens = Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)
    if (totalTokens > 0) state.onUsage?.(totalTokens)
    out.push(
      part({
        type: "finish",
        finishReason: { unified: reason },
        usage: {
          inputTokens: {
            total: Number(usage.input_tokens ?? 0),
            cacheRead: Number(inputDetails.cached_tokens ?? 0),
          },
          outputTokens: {
            total: Number(usage.output_tokens ?? 0),
            reasoning: Number(outputDetails.reasoning_tokens ?? 0),
          },
        },
      }),
    )
  } else if (type === "error") {
    out.push(part({ type: "error", error: event.error ?? event }))
  }
  return out
}

export function dataOf(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("")
}

export async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf("\n\n")
      while (split >= 0) {
        const data = dataOf(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as Json
          } catch {}
        }
        split = buffer.indexOf("\n\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function translateStream(
  source: ReadableStream<Uint8Array>,
  route: Route,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const state = newStreamState(route)
  let finished = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (text: string) => controller.enqueue(encoder.encode(text))
      try {
        for await (const event of sseEvents(source)) {
          for (const line of translateEvent(event, state)) {
            if (line.includes('"finish"')) finished = true
            emit(line)
          }
        }
        if (!finished) {
          emit(part({ type: "finish", finishReason: { unified: "stop" } }))
        }
        emit("data: [DONE]\n\n")
        controller.close()
      } catch (error) {
        emit(
          part({
            type: "error",
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        )
        emit(part({ type: "finish", finishReason: { unified: "error" } }))
        emit("data: [DONE]\n\n")
        controller.close()
      }
    },
  })
}
