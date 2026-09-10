import type { McpClient } from "libfx/mcp"

import { accessTokenFor } from "./auth"
import {
  CALL_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type RemoteServer,
} from "./config"

export class NeedsSignIn extends Error {
  constructor(
    readonly server: string,
    readonly endpoint: string,
    readonly challenge: string | null,
  ) {
    super(`${server} needs you to sign in`)
  }
}

function messageFrom(payload: unknown): unknown {
  const message = payload as { result?: unknown; error?: { message?: string } }
  if (message?.error) {
    throw new Error(message.error.message ?? "the MCP server returned an error")
  }
  return message?.result
}

function fromEventStream(body: string): unknown {
  let last: unknown
  for (const frame of body.split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("")
    if (!data) continue
    try {
      const parsed = JSON.parse(data) as { id?: unknown }
      if (parsed?.id !== undefined) last = parsed
    } catch {
    }
  }
  if (last === undefined) throw new Error("the MCP server sent no response")
  return last
}

export class HttpClient implements McpClient {
  private session: string | null = null
  private initialised = false
  private nextId = 1
  private closed = false

  constructor(
    private readonly name: string,
    private readonly config: RemoteServer,
  ) {}

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`${this.name} is closed`)

    const token = await accessTokenFor(this.name)
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        ...this.config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...(this.initialised ? { "mcp-protocol-version": PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })

    if (response.status === 401 || response.status === 403) {
      throw new NeedsSignIn(
        this.name,
        this.config.url,
        response.headers.get("www-authenticate"),
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `${this.name} answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }

    const issued = response.headers.get("mcp-session-id")
    if (issued) this.session = issued

    const type = response.headers.get("content-type") ?? ""
    const body = await response.text()
    if (!body.trim()) return undefined
    return messageFrom(
      type.includes("text/event-stream") ? fromEventStream(body) : JSON.parse(body),
    )
  }

  private async notify(method: string): Promise<void> {
    if (this.closed) return
    const token = await accessTokenFor(this.name)
    await fetch(this.config.url, {
      method: "POST",
      headers: {
        ...this.config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    }).catch(() => {})
  }

  async initialize(): Promise<void> {
    await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "fx-ui", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    )
    this.initialised = true
    await this.notify("notifications/initialized")
  }

  listTools(params?: unknown): Promise<unknown> {
    return this.rpc("tools/list", params ?? {}, HANDSHAKE_TIMEOUT_MS)
  }

  callTool(params: unknown, _resultSchema?: unknown, options?: unknown): Promise<unknown> {
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal
    if (signal?.aborted) return Promise.reject(new Error("cancelled"))
    return this.rpc("tools/call", params, CALL_TIMEOUT_MS, signal)
  }

  readResource(params: { uri: string }): Promise<unknown> {
    return this.rpc("resources/read", params, HANDSHAKE_TIMEOUT_MS)
  }

  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<unknown> {
    return this.rpc("prompts/get", params, HANDSHAKE_TIMEOUT_MS)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.session) return
    await fetch(this.config.url, {
      method: "DELETE",
      headers: {
        ...this.config.headers,
        "mcp-session-id": this.session,
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    }).catch(() => {})
  }
}
