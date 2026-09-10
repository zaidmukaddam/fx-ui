import { credential, PROVIDERS, type ProviderId } from "./oauth"

export const GATEWAY_LANGUAGE_MODEL_URL =
  "https://ai-gateway.vercel.sh/v3/ai/language-model"
export const GATEWAY_MODELS_PATH = "/coding-agent/v1/models"

const ENDPOINTS: Record<ProviderId, string> = {
  grok: "https://cli-chat-proxy.grok.com/v1/responses",
  codex: "https://chatgpt.com/backend-api/codex/responses",
}

const CATALOGUES: Record<ProviderId, string> = {
  grok: "https://cli-chat-proxy.grok.com/v1/models",
  codex: "https://chatgpt.com/backend-api/codex/models",
}

const GROK_MODALITIES = "https://api.x.ai/v1/language-models"

export type ProviderModel = {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  efforts: string[]
  defaultEffort?: string
  fast?: { label: string; detail: string }
  vision: boolean
  search: boolean
}

export type SearchStep = {
  id: string
  done: boolean
  action: string
  label: string
  sources: string[]
}

export type Route = {
  provider?: ProviderId | null
  effort?: string | null
  fast?: boolean
  search?: boolean
  onSearch?: (step: SearchStep) => void
  onUsage?: (tokens: number) => void
  onLimits?: (limits: PlanLimits) => void
}

export type Limit = { label: string; usedPercent: number; resetsAt: number | null }

export type PlanLimits = { plan: string | null; limits: Limit[] }

const WINDOW_LABELS: Record<number, string> = { 300: "5-hour limit", 10080: "Weekly limit" }

function limitsFrom(provider: ProviderId, headers: Headers): PlanLimits | null {
  const limits: Limit[] =
    provider === "codex"
      ? ["primary", "secondary"].flatMap((window) => {
          const minutes = Number(headers.get(`x-codex-${window}-window-minutes`))
          const used = Number(headers.get(`x-codex-${window}-used-percent`))
          if (!minutes || !Number.isFinite(used)) return []
          const reset = Number(headers.get(`x-codex-${window}-reset-at`))
          return [
            {
              label: WINDOW_LABELS[minutes] ?? `${Math.round(minutes / 60)}-hour limit`,
              usedPercent: used,
              resetsAt: reset ? reset * 1000 : null,
            },
          ]
        })
      : ["requests", "tokens"].flatMap((kind) => {
          const limit = Number(headers.get(`x-ratelimit-limit-${kind}`))
          const remaining = Number(headers.get(`x-ratelimit-remaining-${kind}`))
          if (!limit || !Number.isFinite(remaining)) return []
          return [
            {
              label: kind === "requests" ? "Requests" : "Tokens",
              usedPercent: Math.round(100 * (1 - remaining / limit)),
              resetsAt: null,
            },
          ]
        })
  if (limits.length === 0) return null
  return { plan: provider === "codex" ? headers.get("x-codex-plan-type") : null, limits }
}

const CATALOGUE_TTL_MS = 10 * 60 * 1000
const catalogues = new Map<ProviderId, { at: number; models: ProviderModel[] }>()

const VERSION_URLS: Record<ProviderId, string> = {
  codex: "https://registry.npmjs.org/@openai/codex/latest",
  grok: "https://x.ai/cli/stable",
}

const versions = new Map<ProviderId, Promise<string | null>>()

function clientVersion(
  provider: ProviderId,
  base: typeof globalThis.fetch,
): Promise<string | null> {
  const known = versions.get(provider)
  if (known) return known
  const asked = base(VERSION_URLS[provider])
    .then(async (response) => {
      if (!response.ok) return null
      if (provider === "grok") {
        const text = (await response.text()).trim()
        return /^[\d.]+$/.test(text) ? text : null
      }
      const body = (await response.json()) as { version?: unknown }
      return typeof body.version === "string" ? body.version : null
    })
    .catch(() => null)
  versions.set(provider, asked)
  return asked
}

async function providerHeaders(
  provider: ProviderId,
  auth: { token: string; accountId: string | null },
  base: typeof globalThis.fetch,
): Promise<Record<string, string>> {
  const version = await clientVersion(provider, base)
  return {
    authorization: `Bearer ${auth.token}`,
    originator: "fx",
    ...(provider === "grok"
      ? {
          "x-grok-client-identifier": "fx",
          ...(version ? { "x-grok-client-version": version } : {}),
        }
      : {}),
    ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
  }
}

async function catalogueUrl(
  provider: ProviderId,
  base: typeof globalThis.fetch,
): Promise<string> {
  if (provider !== "codex") return CATALOGUES[provider]
  const version = await clientVersion("codex", base)
  if (!version) throw new Error("Could not read the Codex client version from npm.")
  return `${CATALOGUES.codex}?client_version=${encodeURIComponent(version)}`
}

export async function listProviderModels(
  provider: ProviderId,
  base: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderModel[]> {
  const cached = catalogues.get(provider)
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.models

  const auth = await credential(provider)
  if (!auth) return []
  const response = await base(await catalogueUrl(provider, base), {
    headers: {
      ...(await providerHeaders(provider, auth, base)),
      accept: "application/json",
    },
  })
  if (!response.ok) throw new Error(`${PROVIDERS[provider].label} listed no models (HTTP ${response.status})`)
  const body = (await response.json()) as Json
  const modalities =
    provider === "grok"
      ? await base(GROK_MODALITIES, {
          headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" },
        })
          .then((answer) => (answer.ok ? (answer.json() as Promise<Json>) : {}))
          .catch(() => ({}))
      : {}
  const models = parseCatalogue(provider, body, modalities)
  catalogues.set(provider, { at: Date.now(), models })
  return models
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

export function parseCatalogue(
  provider: ProviderId,
  body: Json,
  modalityBody: Json = {},
): ProviderModel[] {
  const rows = ((provider === "codex" ? body.models : body.data) as Json[] | undefined) ?? []
  const modalities = new Map<string, string[]>()
  for (const entry of (modalityBody.models as Json[] | undefined) ?? []) {
    const row = entry as Json
    const id = typeof row.id === "string" ? row.id : ""
    if (id) modalities.set(id, stringsOf(row.input_modalities))
  }
  const out: ProviderModel[] = []
  for (const row of rows) {
    if (provider === "codex") {
      if (row.visibility !== "list") continue
      const id = typeof row.slug === "string" ? row.slug : ""
      if (!id) continue
      out.push({
        id,
        name: typeof row.display_name === "string" ? row.display_name : id,
        contextWindow: positive(row.context_window),
        maxTokens: positive(row.max_output_tokens),
        efforts: efforts(row.supported_reasoning_levels),
        defaultEffort:
          typeof row.default_reasoning_level === "string"
            ? row.default_reasoning_level
            : undefined,
        fast: fastTier(row),
        vision: stringsOf(row.input_modalities).includes("image"),
        search: row.supports_search_tool === true,
      })
      continue
    }
    if (row.api_backend !== "responses") continue
    const id = typeof row.model === "string" ? row.model : typeof row.id === "string" ? row.id : ""
    if (!id) continue
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : id,
      contextWindow: positive(row.context_window),
      maxTokens: positive(row.max_completion_tokens),
      efforts: row.supports_reasoning_effort === true ? efforts(row.reasoning_efforts) : [],
      defaultEffort: defaultEffort(row.reasoning_efforts, row.reasoning_effort),
      vision: modalities.get(id)?.includes("image") ?? false,
      search: row.supports_backend_search === true,
    })
  }
  return out
}

function fastTier(row: Json): { label: string; detail: string } | undefined {
  const tiers = row.service_tiers
  if (!Array.isArray(tiers)) return undefined
  for (const entry of tiers) {
    const tier = entry as Json
    if (tier?.id !== "priority") continue
    return {
      label: typeof tier.name === "string" ? tier.name : "Fast",
      detail: typeof tier.description === "string" ? tier.description : "",
    }
  }
  return undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"]

function efforts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : typeof (entry as Json)?.effort === "string"
          ? String((entry as Json).effort)
          : typeof (entry as Json)?.value === "string"
            ? String((entry as Json).value)
            : "",
    )
    .filter(Boolean)
  return [...new Set(names)].sort(
    (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
  )
}

function defaultEffort(list: unknown, fallback: unknown): string | undefined {
  if (Array.isArray(list)) {
    for (const entry of list) {
      const row = entry as Json
      if (row?.default === true && typeof row.value === "string") return row.value
    }
  }
  return typeof fallback === "string" ? fallback : undefined
}

export function asGatewayCatalogue(models: ProviderModel[]): Json {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      type: "language",
      released: 1,
      tags: ["tool-use", ...(model.efforts.length > 0 ? ["reasoning"] : []), "implicit-caching"],
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
    })),
  }
}

export function bareModel(model: string): string {
  return model.replace(/^[a-z0-9-]+\//i, "")
}

type Json = Record<string, unknown>

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
  if (route.search) tools.push({ type: "web_search" })
  if (route.search && route.provider === "grok") tools.push({ type: "x_search" })

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
}

function newStreamState(onSearch?: (step: SearchStep) => void): StreamState {
  return { open: new Set(), calls: 0, onSearch }
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

function dataOf(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("")
}

function totalOf(count: unknown): number {
  const value = typeof count === "object" && count ? (count as Json).total : count
  return typeof value === "number" ? value : 0
}

function watchUsage(response: Response, onUsage?: (tokens: number) => void): Response {
  if (!onUsage || !response.ok || !response.body) return response
  const decoder = new TextDecoder()
  let buffer = ""
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        buffer += decoder.decode(chunk, { stream: true })
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          if (!frame.includes('"finish"')) continue
          try {
            const usage = ((JSON.parse(dataOf(frame)) as Json).usage ?? {}) as Json
            const tokens = totalOf(usage.inputTokens) + totalOf(usage.outputTokens)
            if (tokens > 0) onUsage(tokens)
          } catch {}
        }
      },
    }),
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function translateStream(
  source: ReadableStream<Uint8Array>,
  onSearch?: (step: SearchStep) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state = newStreamState(onSearch)
  let buffer = ""
  let finished = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      const emit = (text: string) => controller.enqueue(encoder.encode(text))
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split = buffer.indexOf("\n\n")
          while (split >= 0) {
            const data = dataOf(buffer.slice(0, split))
            buffer = buffer.slice(split + 2)
            if (data && data !== "[DONE]") {
              try {
                const event = JSON.parse(data) as Json
                for (const line of translateEvent(event, state)) {
                  if (line.includes('"finish"')) finished = true
                  emit(line)
                }
              } catch {
              }
            }
            split = buffer.indexOf("\n\n")
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
      } finally {
        reader.releaseLock()
      }
    },
  })
}

export async function describeImage(
  provider: ProviderId,
  model: string,
  prompt: string,
  dataUrl: string,
  signal?: AbortSignal,
  base: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const auth = await credential(provider)
  if (!auth) throw new Error(`Not signed in to ${PROVIDERS[provider].label}.`)

  const response = await base(ENDPOINTS[provider], {
    method: "POST",
    headers: {
      ...(await providerHeaders(provider, auth, base)),
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
    },
    body: JSON.stringify({
      model: bareModel(model),
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", detail: "auto", image_url: dataUrl },
          ],
        },
      ],
      stream: true,
      store: false,
    }),
    signal,
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `${PROVIDERS[provider].label} answered HTTP ${response.status}${
        detail ? `: ${detail.slice(0, 200)}` : ""
      }`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf("\n\n")
    while (split >= 0) {
      const data = dataOf(buffer.slice(0, split))
      buffer = buffer.slice(split + 2)
      if (data && data !== "[DONE]") {
        try {
          const event = JSON.parse(data) as Json
          if (event.type === "response.output_text.delta" && event.delta) {
            text += String(event.delta)
          }
        } catch {}
      }
      split = buffer.indexOf("\n\n")
    }
  }
  return text.trim()
}

export function providerFetch(
  base: typeof globalThis.fetch = globalThis.fetch,
  route: Route = {},
): typeof globalThis.fetch {
  const provider = route.provider ?? null
  const shim = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String((input as Request)?.url ?? input)
    const headers = new Headers(init?.headers ?? (input as Request)?.headers ?? {})
    const model = headers.get("ai-language-model-id")

    if (provider && new URL(url).pathname === GATEWAY_MODELS_PATH) {
      try {
        return Response.json(asGatewayCatalogue(await listProviderModels(provider, base)))
      } catch {
        return Response.json({ object: "list", data: [] })
      }
    }

    if (!url.startsWith(GATEWAY_LANGUAGE_MODEL_URL)) return base(input as RequestInfo, init)
    if (!provider || !model) {
      return watchUsage(await base(input as RequestInfo, init), route.onUsage)
    }

    const auth = await credential(provider)
    if (!auth) {
      return new Response(
        JSON.stringify({ error: { message: `Not signed in to ${PROVIDERS[provider].label}.` } }),
        { status: 401, headers: { "content-type": "application/json" } },
      )
    }

    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : Buffer.from(init?.body as never).toString("utf8"),
    ) as Json

    const response = await base(ENDPOINTS[provider], {
      method: "POST",
      headers: {
        ...(await providerHeaders(provider, auth, base)),
        "content-type": "application/json",
        accept: "text/event-stream",
        "openai-beta": "responses=experimental",
      },
      body: JSON.stringify(toResponsesRequest(body, bareModel(model), route)),
      signal: init?.signal ?? undefined,
    })

    const limits = limitsFrom(provider, response.headers)
    if (limits) route.onLimits?.(limits)

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      return new Response(
        JSON.stringify({
          error: {
            message: `${PROVIDERS[provider].label} answered HTTP ${response.status}${
              detail ? `: ${detail.slice(0, 300)}` : ""
            }`,
          },
        }),
        { status: response.status, headers: { "content-type": "application/json" } },
      )
    }

    return watchUsage(
      new Response(translateStream(response.body, route.onSearch), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      route.onUsage,
    )
  }
  return Object.assign(shim, { preconnect: base.preconnect?.bind(base) }) as typeof fetch
}
