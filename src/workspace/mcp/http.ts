import { accessTokenFor } from "./auth"
import { HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION, type RemoteServer } from "./config"
import type { Wire } from "./session"

export class NeedsSignIn extends Error {
  constructor(
    readonly server: string,
    readonly endpoint: string,
    readonly challenge: string | null,
  ) {
    super(`${server} needs you to sign in`)
  }
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

export class HttpWire implements Wire {
  private session: string | null = null
  private initialised = false

  constructor(
    private readonly name: string,
    private readonly config: RemoteServer,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await accessTokenFor(this.name)
    return {
      ...this.config.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.session ? { "mcp-session-id": this.session } : {}),
      ...(this.initialised ? { "mcp-protocol-version": PROTOCOL_VERSION } : {}),
    }
  }

  async request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
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
    this.initialised = true

    const type = response.headers.get("content-type") ?? ""
    const text = await response.text()
    if (!text.trim()) return undefined
    return type.includes("text/event-stream") ? fromEventStream(text) : JSON.parse(text)
  }

  async notify(body: Record<string, unknown>): Promise<void> {
    await fetch(this.config.url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    }).catch(() => {})
  }

  async close(): Promise<void> {
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
