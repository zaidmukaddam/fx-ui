import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import { capture, isMissingProgram } from "../workspace/run"

export type Provider = "grok" | "codex"

export type Runtime = {
  exited: Promise<number>
  readonly error: Error | undefined
  write(data: string): void
  closeStdin(): void
  abortHostEffects(): void
  abort(error?: Error): void
  setLineHandler(handler: LineHandler): void
}

type LineHandler = (message: Record<string, unknown>, size: number) => unknown

export type RuntimeOptions = {
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}

export const FX_BINARY = process.env.FX_BINARY || "fx"

export function cliRuntime(
  options: RuntimeOptions = {},
): Promise<Runtime> {
  const env = { ...process.env, ...stripUndefined(options.env) }
  delete env.AI_GATEWAY_API_KEY

  const child = spawn(FX_BINARY, options.args ?? ["acp"], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let handler: LineHandler | null = null
  let failure: Error | undefined
  let settled = false
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })

  const finish = (code: number, error?: Error) => {
    if (settled) return
    settled = true
    failure ??= error
    resolveExit(code)
  }

  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000)
  })

  attachLines(child, {
    onLine: (line, size) => {
      if (!handler) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      return handler(message, size)
    },
  })

  child.on("error", (error) => {
    finish(
      1,
      isMissingProgram(error)
        ? new Error(
            `\`${FX_BINARY}\` is not on PATH. Install fx, or set FX_BINARY to its path.`,
          )
        : (error as Error),
    )
  })
  child.on("close", (code) => {
    finish(
      code ?? 0,
      code ? new Error(`fx exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`) : undefined,
    )
  })

  return Promise.resolve({
    exited,
    get error() {
      return failure
    },
    write(data: string) {
      child.stdin.write(data)
    },
    closeStdin() {
      child.stdin.end()
    },
    abortHostEffects() {},
    abort(error?: Error) {
      failure ??= error
      child.kill("SIGKILL")
      finish(1, error)
    },
    setLineHandler(next: LineHandler) {
      handler = next
    },
  })
}

function attachLines(
  child: ChildProcessWithoutNullStreams,
  { onLine }: { onLine: (line: string, size: number) => unknown },
): void {
  let buffer = ""
  let draining: Promise<unknown> | null = null

  const pump = async (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) {
        const result = onLine(line, Buffer.byteLength(line) + 1)
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          child.stdout.pause()
          await result
          child.stdout.resume()
        }
      }
      newline = buffer.indexOf("\n")
    }
  }

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    draining = (draining ?? Promise.resolve()).then(() => pump(chunk))
  })
}

function stripUndefined(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export function cliSignedIn(provider: Provider): boolean {
  const home = process.env.HOME
  if (!home) return false
  const file = provider === "grok" ? "grok-auth.json" : "chatgpt-auth.json"
  return existsSync(path.join(home, ".fx", file))
}

export async function fxVersion(): Promise<string | null> {
  try {
    const result = await capture(FX_BINARY, ["--version"], { timeoutMs: 5_000 })
    return result.code === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

export const MIN_ACP_PROVIDER_VERSION = "0.0.7"

export function outdatedForProviders(version: string | null): boolean {
  if (!version) return false
  const parts = (text: string) =>
    text.trim().replace(/^v/, "").split(".").map((piece) => Number.parseInt(piece, 10) || 0)
  const found = parts(version)
  const need = parts(MIN_ACP_PROVIDER_VERSION)
  for (let index = 0; index < need.length; index += 1) {
    const left = found[index] ?? 0
    const right = need[index] ?? 0
    if (left !== right) return left < right
  }
  return false
}

export async function fxStatus(): Promise<string> {
  let result
  try {
    result = await capture(FX_BINARY, ["status"], { timeoutMs: 15_000 })
  } catch (error) {
    if (isMissingProgram(error)) {
      return `\`${FX_BINARY}\` is not on PATH. Install fx, or set FX_BINARY.`
    }
    return error instanceof Error ? error.message : String(error)
  }

  const fields = new Map<string, string>()
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = /^\[status\]\s+([a-z_]+)=(.*)$/.exec(line.trim())
    if (match) fields.set(match[1]!, match[2]!.trim())
  }
  const auth = fields.get("auth")
  if (!auth) return result.code === 0 ? "Signed in" : "Not signed in"

  const model = fields.get("model")
  const stale =
    fields.get("auth_expired") === "true" && fields.get("auth_refreshable") !== "true"
  return [auth, model, stale ? "expired, sign in again" : ""]
    .filter(Boolean)
    .join(" · ")
}

export async function openLogin(): Promise<string> {
  if (process.platform !== "darwin") {
    return `Run \`${FX_BINARY} login\` in a terminal, then come back.`
  }
  try {
    const result = await capture(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${FX_BINARY} login"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { timeoutMs: 10_000 },
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Terminal refused to open.")
    return "Sign in with fx in the terminal that just opened."
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `Could not open a terminal (${reason}). Run \`${FX_BINARY} login\` yourself.`
  }
}
