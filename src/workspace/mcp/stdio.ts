import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import type { McpClient } from "libfx/mcp"

import {
  CALL_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type LocalServer,
} from "./config"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class StdioClient implements McpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private buffer = ""
  private nextId = 1
  private closed = false

  constructor(
    private readonly name: string,
    config: LocalServer,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: config.env ? { ...process.env, ...config.env } : process.env,
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
    this.child.on("error", (error) => this.failAll(error))
    this.child.on("close", () =>
      this.failAll(new Error(`the ${this.name} MCP server exited`)),
    )
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
      newline = this.buffer.indexOf("\n")
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id !== "number") return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "the MCP server returned an error"))
    } else {
      pending.resolve(message.result)
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  async initialize(): Promise<void> {
    await this.send(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "fx-ui", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    )
    this.notify("notifications/initialized")
  }

  listTools(params?: unknown): Promise<unknown> {
    return this.send("tools/list", params ?? {}, HANDSHAKE_TIMEOUT_MS)
  }

  callTool(params: unknown, _resultSchema?: unknown, options?: unknown): Promise<unknown> {
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal
    if (signal?.aborted) return Promise.reject(new Error("cancelled"))
    const call = this.send("tools/call", params, CALL_TIMEOUT_MS)
    if (!signal) return call
    return Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      }),
    ])
  }

  readResource(params: { uri: string }): Promise<unknown> {
    return this.send("resources/read", params, HANDSHAKE_TIMEOUT_MS)
  }

  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<unknown> {
    return this.send("prompts/get", params, HANDSHAKE_TIMEOUT_MS)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error(`${this.name} is closed`))
    this.child.stdin.end()
    this.child.kill()
  }
}
