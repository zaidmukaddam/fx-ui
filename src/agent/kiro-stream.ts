// Kiro (CodeWhisperer) streaming response parser.
//
// Ported verbatim from the dsh-kiro-subscription reference: this only reads
// Kiro's byte stream and reassembles content / tool calls, independent of the
// host format. The provider fetch shim maps the events it yields onto the
// Gateway SSE the fx-ui core expects.

export type KiroStreamEvent =
  | { type: "content"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "usage"; credits: number }
  | { type: "context-usage"; percentage: number }

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

const EVENT_PREFIXES = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"followupPrompt":',
  '{"usage":',
  '{"contextUsagePercentage":',
]

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function earliestPrefix(text: string): number {
  let earliest = -1
  for (const prefix of EVENT_PREFIXES) {
    const index = text.indexOf(prefix)
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index
  }
  return earliest
}

function inputFragment(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    return Object.keys(input as Record<string, unknown>).length === 0 ? "" : JSON.stringify(input)
  }
  return ""
}

export class KiroEventParser {
  private readonly decoder = new TextDecoder()
  private buffer = ""
  private currentTool?: PendingToolCall
  private readonly completed: PendingToolCall[] = []
  private lastContent?: string

  feed(chunk: Uint8Array): KiroStreamEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const events: KiroStreamEvent[] = []
    while (true) {
      const start = earliestPrefix(this.buffer)
      if (start < 0) {
        if (this.buffer.length > 256) this.buffer = this.buffer.slice(-256)
        break
      }
      const end = matchingBrace(this.buffer, start)
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.slice(start)
        break
      }
      const candidate = this.buffer.slice(start, end + 1)
      this.buffer = this.buffer.slice(end + 1)
      let value: Record<string, unknown>
      try {
        value = JSON.parse(candidate) as Record<string, unknown>
      } catch {
        continue
      }
      this.process(value, events)
    }
    return events
  }

  finish(): KiroStreamEvent[] {
    const tail = this.decoder.decode()
    const events = tail ? this.feed(new TextEncoder().encode(tail)) : []
    this.finalizeTool()
    for (const tool of this.deduplicatedTools()) {
      events.push({ type: "tool-call", id: tool.id, name: tool.name, arguments: normalizeArguments(tool.arguments) })
    }
    return events
  }

  private process(value: Record<string, unknown>, events: KiroStreamEvent[]): void {
    if (typeof value.content === "string" && value.followupPrompt !== true) {
      if (value.content !== this.lastContent) {
        this.lastContent = value.content
        events.push({ type: "content", text: value.content })
      }
      return
    }
    if (value.stop === true) {
      this.finalizeTool()
      return
    }
    if (typeof value.name === "string") {
      const id = typeof value.toolUseId === "string" && value.toolUseId ? value.toolUseId : undefined
      if (this.currentTool && id && this.currentTool.id === id) {
        if (Object.hasOwn(value, "input")) {
          this.currentTool.arguments += inputFragment(value.input)
        }
        return
      }
      this.finalizeTool()
      this.currentTool = {
        id: id ?? `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
        name: value.name,
        arguments: Object.hasOwn(value, "input") ? inputFragment(value.input) : "",
      }
      return
    }
    if (Object.hasOwn(value, "input") && this.currentTool) {
      this.currentTool.arguments += inputFragment(value.input)
      return
    }
    if (typeof value.usage === "number") {
      events.push({ type: "usage", credits: value.usage })
      return
    }
    if (typeof value.contextUsagePercentage === "number") {
      events.push({ type: "context-usage", percentage: value.contextUsagePercentage })
    }
  }

  private finalizeTool(): void {
    if (!this.currentTool) return
    this.completed.push(this.currentTool)
    this.currentTool = undefined
  }

  private deduplicatedTools(): PendingToolCall[] {
    const byId = new Map<string, PendingToolCall>()
    for (const tool of this.completed) {
      const previous = byId.get(tool.id)
      if (!previous || tool.arguments.length > previous.arguments.length) byId.set(tool.id, tool)
    }
    return [...byId.values()]
  }
}

function normalizeArguments(raw: string): string {
  if (!raw.trim()) return "{}"
  try {
    const value: unknown = JSON.parse(raw)
    return JSON.stringify(value)
  } catch {
    return "{}"
  }
}

export async function* parseKiroStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<KiroStreamEvent> {
  const parser = new KiroEventParser()
  const reader = body.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      for (const event of parser.feed(result.value)) yield event
    }
    for (const event of parser.finish()) yield event
  } finally {
    reader.releaseLock()
  }
}
