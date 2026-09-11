// Kiro (CodeWhisperer) network layer for fx-ui.
//
// Bridges the fx-ui core's Gateway wire format to Kiro's runtime:
//   - listKiroModels: dynamic model discovery (ListAvailableModels, 1h cache)
//   - kiroLanguageModel: takes a Gateway language-model request body and
//     returns a Gateway-SSE Response, translating through Kiro's
//     conversationState / event stream
//   - describeImageKiro: the direct image (vision) path, since the core will
//     not carry image prompt blocks
//
// Ported from dsh-kiro-subscription, retargeted from dsh's LlmAdapter onto the
// Gateway request/response shapes fx-ui uses.

import { KiroAuthManager } from "./kiro-auth"
import { parseKiroStream } from "./kiro-stream"
import { kiroEventsToGatewaySse } from "./kiro-sse"
import { buildKiroPayload } from "./kiro-payload"
import { runtimeModelId } from "./kiro-model-id"
import type { Json } from "./responses"

export { runtimeModelId }

export type KiroModel = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

const DEFAULT_CONTEXT_WINDOW = 200_000

export const DEFAULT_KIRO_MODELS: readonly KiroModel[] = [
  { id: "auto-kiro", name: "Auto", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000 },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
]

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000
let cache: { at: number; models: readonly KiroModel[] } | undefined
let fetching: Promise<readonly KiroModel[]> | undefined

function fingerprintAgent(auth: KiroAuthManager): string {
  return `aws-sdk-js/1.0.27 ua/2.1 lang/js md/nodejs api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${auth.fingerprint}`
}

function kiroHeaders(auth: KiroAuthManager, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-amz-json-1.0",
    accept: "application/vnd.amazon.eventstream",
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "user-agent": fingerprintAgent(auth),
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${auth.fingerprint}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=3",
  }
}

export async function listKiroModels(
  auth: KiroAuthManager,
  base: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly KiroModel[]> {
  if (cache && Date.now() - cache.at < MODEL_CACHE_TTL_MS) return cache.models
  if (!fetching) {
    fetching = fetchKiroModels(auth, base).finally(() => (fetching = undefined))
  }
  return fetching
}

async function fetchKiroModels(
  auth: KiroAuthManager,
  base: typeof globalThis.fetch,
): Promise<readonly KiroModel[]> {
  try {
    const token = await auth.getAccessToken()
    const qHost = `https://q.${auth.apiRegion}.amazonaws.com`
    const params = new URLSearchParams({ origin: "AI_EDITOR" })
    if (auth.profileArn) params.set("profileArn", auth.profileArn)
    const response = await base(`${qHost}/ListAvailableModels?${params}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-amz-json-1.0",
        "user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${auth.fingerprint}`,
        "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${auth.fingerprint}`,
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as {
      models?: Array<{ modelId: string; modelName?: string; tokenLimits?: { maxInputTokens?: number } }>
    }
    const models: KiroModel[] = (data.models ?? []).map((m) => ({
      id: m.modelId === "auto" ? "auto-kiro" : m.modelId,
      name: m.modelName ?? m.modelId,
      contextWindow: m.tokenLimits?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    }))
    const autoIdx = models.findIndex((m) => m.id === "auto-kiro")
    if (autoIdx > 0) models.unshift(...models.splice(autoIdx, 1))
    if (models.length === 0) return cache?.models ?? DEFAULT_KIRO_MODELS
    cache = { at: Date.now(), models }
    return models
  } catch {
    return cache?.models ?? DEFAULT_KIRO_MODELS
  }
}

/**
 * Handle one Gateway language-model request against Kiro. Returns a Response
 * whose body is Gateway SSE. Retries once on 403 after a forced token refresh.
 */
export async function kiroLanguageModel(
  auth: KiroAuthManager,
  body: Json,
  model: string,
  effort: string | null | undefined,
  base: typeof globalThis.fetch,
  signal?: AbortSignal,
  onUsage?: (tokens: number) => void,
): Promise<Response> {
  const payload = buildKiroPayload(body, runtimeModelId(model), auth.profileArn ?? "", effort)
  const endpoint = `${auth.apiHost}/generateAssistantResponse`

  const request = async (token: string) =>
    base(endpoint, {
      method: "POST",
      headers: kiroHeaders(auth, token),
      body: JSON.stringify(payload),
      signal,
    })

  let token: string
  try {
    token = await auth.getAccessToken()
  } catch (error) {
    return errorResponse(401, error instanceof Error ? error.message : "Kiro authentication failed")
  }

  let response = await request(token)
  if (response.status === 403) {
    try {
      response = await request(await auth.forceRefresh())
    } catch (error) {
      return errorResponse(401, error instanceof Error ? error.message : "Kiro authentication failed")
    }
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    return errorResponse(
      response.status,
      `Kiro answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    )
  }

  return new Response(kiroEventsToGatewaySse(response.body, onUsage), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const IMAGE_FORMAT_BY_MEDIA_TYPE: Record<string, "gif" | "jpeg" | "png" | "webp"> = {
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
}

/**
 * The direct image path for Kiro: sends a single user message with an image to
 * generateAssistantResponse and returns the text. Used by the vision tool,
 * mirroring describeImage for Grok/Codex.
 */
export async function describeImageKiro(
  auth: KiroAuthManager,
  model: string,
  prompt: string,
  mediaType: string,
  base64: string,
  signal?: AbortSignal,
  base: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const format = IMAGE_FORMAT_BY_MEDIA_TYPE[mediaType]
  if (!format) throw new Error(`Kiro cannot read ${mediaType} images.`)

  const token = await auth.getAccessToken()
  const payload: Json = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: prompt,
          modelId: runtimeModelId(model),
          origin: "AI_EDITOR",
          images: [{ format, source: { bytes: base64 } }],
        },
      },
    },
    ...(auth.profileArn ? { profileArn: auth.profileArn } : {}),
  }

  const endpoint = `${auth.apiHost}/generateAssistantResponse`
  let response = await base(endpoint, {
    method: "POST",
    headers: kiroHeaders(auth, token),
    body: JSON.stringify(payload),
    signal,
  })
  if (response.status === 403) {
    response = await base(endpoint, {
      method: "POST",
      headers: kiroHeaders(auth, await auth.forceRefresh()),
      body: JSON.stringify(payload),
      signal,
    })
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Kiro answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }

  let text = ""
  for await (const event of parseKiroStream(response.body)) {
    if (event.type === "content") text += event.text
  }
  return text.trim()
}
