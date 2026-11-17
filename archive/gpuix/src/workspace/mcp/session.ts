import type { McpClient } from "libfx/mcp"

import { CALL_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION } from "./config"

export type Wire = {
  request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
  notify(body: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

type Reply = { result?: unknown; error?: { message?: string } }

export class McpSession implements McpClient {
  private nextId = 1
  private closed = false

  constructor(
    private readonly name: string,
    private readonly wire: Wire,
  ) {}

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`${this.name} is closed`)
    const reply = (await this.wire.request(
      { jsonrpc: "2.0", id: this.nextId++, method, params },
      timeoutMs,
      signal,
    )) as Reply | undefined
    if (reply?.error) throw new Error(reply.error.message ?? "the MCP server returned an error")
    return reply?.result
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
    if (!this.closed) await this.wire.notify({ jsonrpc: "2.0", method: "notifications/initialized" })
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
    await this.wire.close()
  }
}
