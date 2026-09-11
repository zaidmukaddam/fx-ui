import { credential, PROVIDERS, type ProviderId } from "./oauth"
import { dataOf, sseEvents, toResponsesRequest, translateStream, type Json } from "./responses"

export const GATEWAY_LANGUAGE_MODEL_URL =
  "https://ai-gateway.vercel.sh/v3/ai/language-model"
export const GATEWAY_MODELS_PATH = "/coding-agent/v1/models"

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
  onCompaction?: (active: boolean) => void
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

const versions = new Map<ProviderId, Promise<string | null>>()

function clientVersion(
  provider: ProviderId,
  base: typeof globalThis.fetch,
): Promise<string | null> {
  const known = versions.get(provider)
  if (known) return known
  const asked = base(PROVIDERS[provider].versionUrl)
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
  const spec = PROVIDERS[provider]
  const version = spec.versionHeader ? await clientVersion(provider, base) : null
  return {
    authorization: `Bearer ${auth.token}`,
    originator: "fx",
    ...spec.staticHeaders,
    ...(version && spec.versionHeader ? { [spec.versionHeader]: version } : {}),
    ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
  }
}

async function catalogueUrl(
  provider: ProviderId,
  base: typeof globalThis.fetch,
): Promise<string> {
  const spec = PROVIDERS[provider]
  if (!spec.versionedCatalogue) return spec.catalogue
  const version = await clientVersion(provider, base)
  if (!version) throw new Error(`Could not read the ${spec.label} client version from npm.`)
  return `${spec.catalogue}?client_version=${encodeURIComponent(version)}`
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
  const modalitiesUrl = PROVIDERS[provider].modalitiesUrl
  const modalities = modalitiesUrl
    ? await base(modalitiesUrl, {
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
  const rows = (body[PROVIDERS[provider].catalogueField] as Json[] | undefined) ?? []
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

  const response = await base(PROVIDERS[provider].endpoint, {
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

  let text = ""
  for await (const event of sseEvents(response.body)) {
    if (event.type === "response.output_text.delta" && event.delta) {
      text += String(event.delta)
    }
  }
  return text.trim()
}

function requestBody(init?: RequestInit): Json {
  return JSON.parse(
    typeof init?.body === "string" ? init.body : Buffer.from(init?.body as never).toString("utf8"),
  ) as Json
}

function isCompactionRequest(body: Json): boolean {
  if (!Array.isArray(body.prompt)) return false
  const prefix = "You are writing a summary for a separate assistant to continue later, not continuing the recorded conversation yourself."
  return body.prompt.some((message) => {
    if (message?.role !== "system") return false
    const content = message.content
    if (typeof content === "string") return content.startsWith(prefix)
    return Array.isArray(content) && content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(prefix))
  })
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
    const observedBody = route.onCompaction ? requestBody(init) : undefined
    if (observedBody) route.onCompaction?.(isCompactionRequest(observedBody))
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

    const body = observedBody ?? requestBody(init)

    const response = await base(PROVIDERS[provider].endpoint, {
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

    return new Response(translateStream(response.body, route), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  return Object.assign(shim, { preconnect: base.preconnect?.bind(base) }) as typeof fetch
}
