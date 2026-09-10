import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import type { LocalServer } from "./config"
import type { Wire } from "./session"

type Pending = {
  resolve: (message: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class StdioWire implements Wire {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private buffer = ""

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
    let message: { id?: number }
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
    pending.resolve(message)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("cancelled"))
    const id = body.id as number
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error("cancelled"))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        reject(new Error(`${this.name} did not answer ${body.method as string} in time`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(message)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
        timer,
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      this.child.stdin.write(`${JSON.stringify(body)}\n`)
    })
  }

  async notify(body: Record<string, unknown>): Promise<void> {
    this.child.stdin.write(`${JSON.stringify(body)}\n`)
  }

  async close(): Promise<void> {
    this.failAll(new Error(`${this.name} is closed`))
    this.child.stdin.end()
    this.child.kill()
  }
}
