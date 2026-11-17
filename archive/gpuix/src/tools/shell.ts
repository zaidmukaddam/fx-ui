import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import { newId, setBackground, type BackgroundCommand } from "../store"
import { capture } from "../workspace/run"
import {
  defineTool,
  field,
  gate,
  optionalString,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import { resolveInside } from "./paths"

const COMMAND_TIMEOUT_MS = 120_000
const MAX_PENDING_CHARS = 200_000
const MAX_LOG_CHARS = 40_000
const PUBLISHED_LOG_CHARS = 6_000
const PUBLISH_EVERY_MS = 500

const URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'<>)\]]*)?/gi
const MAX_URLS = 4
const URL_CONTEXT_CHARS = 256

type Running = {
  command: string
  child: ChildProcessWithoutNullStreams
  pending: string
  log: string
  startedAt: number
  endedAt: number | null
  exit: number | null
  urls: string[]
  urlTail: string
}

const running = new Map<string, Running>()
const flushing = new Set<string>()

function end(child: ChildProcessWithoutNullStreams): void {
  if (child.pid) {
    try {
      globalThis.process.kill(-child.pid, "SIGTERM")
      return
    } catch {}
  }
  child.kill()
}

function collectUrls(process: Running, chunk: string): void {
  if (process.urls.length < MAX_URLS) {
    const scanned = `${process.urlTail}${chunk}`
    URL_PATTERN.lastIndex = 0
    for (const match of scanned.matchAll(URL_PATTERN)) {
      // A match touching the end may be cut off mid-chunk; the tail rescans it next time.
      if (match.index + match[0].length === scanned.length) continue
      const normalized = match[0].replace(/^https?:\/\/(?:0\.0\.0\.0|\[::1\])/, (head) =>
        head.replace(/0\.0\.0\.0|\[::1\]/, "localhost"),
      )
      if (!process.urls.includes(normalized)) process.urls.push(normalized)
      if (process.urls.length >= MAX_URLS) break
    }
  }
  process.urlTail = chunk.slice(-URL_CONTEXT_CHARS)
}

function publish(sessionId: string): void {
  const live: BackgroundCommand[] = []
  for (const [handle, process] of running) {
    if (!handle.startsWith(`${sessionId}:`)) continue
    live.push({
      handle,
      command: process.command,
      exit: process.exit,
      startedAt: process.startedAt,
      endedAt: process.endedAt,
      log: process.log.slice(-PUBLISHED_LOG_CHARS),
      urls: [...process.urls],
    })
  }
  setBackground(sessionId, live)
}

function publishSoon(sessionId: string): void {
  if (flushing.has(sessionId)) return
  flushing.add(sessionId)
  setTimeout(() => {
    flushing.delete(sessionId)
    publish(sessionId)
  }, PUBLISH_EVERY_MS)
}

function sessionOf(handle: string): string {
  return handle.slice(0, handle.indexOf(":"))
}

export function stopBackgroundCommand(handle: string): void {
  const process = running.get(handle)
  if (!process) return
  if (process.exit === null) end(process.child)
  running.delete(handle)
  publish(sessionOf(handle))
}

function startBackground(
  sessionId: string,
  command: string,
  cwd: string,
): { handle: string; process: Running } {
  const child = spawn("bash", ["-lc", command], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  }) as ChildProcessWithoutNullStreams

  const process: Running = {
    command,
    child,
    pending: "",
    log: "",
    startedAt: Date.now(),
    endedAt: null,
    exit: null,
    urls: [],
    urlTail: "",
  }
  const collect = (chunk: Buffer) => {
    const text = chunk.toString()
    process.pending = `${process.pending}${text}`.slice(-MAX_PENDING_CHARS)
    process.log = `${process.log}${text}`.slice(-MAX_LOG_CHARS)
    collectUrls(process, text)
    publishSoon(sessionId)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  child.on("error", (error) => {
    process.pending += `\n${error.message}\n`
    process.log += `\n${error.message}\n`
    process.exit = -1
    process.endedAt ??= Date.now()
  })
  child.on("close", (code) => {
    process.exit = code ?? 0
    process.endedAt ??= Date.now()
    publish(sessionId)
  })

  const handle = `${sessionId}:${newId()}`
  running.set(handle, process)
  publish(sessionId)
  return { handle, process }
}

export function stopBackgroundCommands(sessionId: string): void {
  for (const [handle, process] of running) {
    if (!handle.startsWith(`${sessionId}:`)) continue
    if (process.exit === null) end(process.child)
    running.delete(handle)
  }
  publish(sessionId)
}

export function stopAllBackgroundCommands(): void {
  for (const process of running.values()) {
    if (process.exit === null) end(process.child)
  }
  running.clear()
}

function drain(process: Running): string {
  const pending = process.pending
  process.pending = ""
  return pending.trim() || "(no new output)"
}

export function shellTools(context: ToolContext): HostTool[] {
  return [
    defineTool<{
      action: "run" | "interact" | "stop"
      command: string
      cwd: string
      background: boolean
      handle?: string
      input?: string
    }>(
      {
        name: "shell",
        description:
          "Run a shell command in the workspace. `run` starts one and returns its output; with background true it returns a handle instead and keeps running, which is how to start a dev server or a watcher. `interact` reads a background command's new output and can send it input. `stop` ends it.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["run", "interact", "stop"],
              description: "Defaults to run.",
            },
            command: { type: "string", description: "The command line, executed with bash." },
            cwd: { type: "string", description: "Directory relative to the workspace root." },
            background: {
              type: "boolean",
              description: "Keep the command running and return a handle instead of waiting.",
            },
            handle: { type: "string", description: "For interact and stop." },
            input: { type: "string", description: "For interact: text to write to stdin." },
          },
        },
        parse: (input) => {
          const action = field(input, "action")
          const kind =
            action === "interact" || action === "stop" ? action : ("run" as const)
          const handle = optionalString(input, "handle")
          if (kind !== "run" && handle === undefined) {
            throw new Error(`\`handle\` is required for ${kind}.`)
          }
          return {
            action: kind,
            command: kind === "run" ? requireString(input, "command") : "",
            cwd: optionalString(input, "cwd", "."),
            background: field(input, "background") === true,
            handle,
            input: optionalString(input, "input"),
          }
        },
        label: (input) =>
          input.action === "run" ? input.command : `${input.action} ${input.handle}`,
        run: async (input, ctx) => {
          if (input.action !== "run") {
            const process = running.get(input.handle!)
            if (!process || !input.handle!.startsWith(`${ctx.sessionId}:`)) {
              throw new Error("That handle is not a running command of this session.")
            }

            if (input.action === "stop") {
              stopBackgroundCommand(input.handle!)
              return {
                text: `Stopped: ${process.command}`,
                label: `stopped ${process.command}`,
              }
            }

            if (input.input !== undefined) process.child.stdin.write(input.input)
            await new Promise((resolve) => setTimeout(resolve, 250))
            const output = drain(process)
            const state = process.exit === null ? "running" : `exited ${process.exit}`
            if (process.exit !== null) {
              running.delete(input.handle!)
              publish(ctx.sessionId)
            }
            return {
              text: `${output}\n\n[${state}]`,
              language: "bash",
              label: `${process.command} · ${state}`,
            }
          }

          const cwd = resolveInside(ctx.root, input.cwd)
          const program = input.command.trim().split(/\s+/)[0] ?? input.command

          await gate(ctx, {
            title: input.background ? "Start a background command" : "Run a command",
            detail: input.command,
            language: "bash",
            scope: `cmd:${program}`,
            denied: "the command was not run.",
          })

          if (input.background) {
            const { handle, process } = startBackground(ctx.sessionId, input.command, cwd)
            await new Promise((resolve) => setTimeout(resolve, 400))
            const output = drain(process)
            if (process.exit !== null) {
              running.delete(handle)
              publish(ctx.sessionId)
              return {
                text: `$ ${input.command}\n${output}\n\nexited ${process.exit} immediately`,
                language: "bash",
                label: `${input.command} · exited ${process.exit}`,
              }
            }
            return {
              text: [
                `$ ${input.command}`,
                output,
                "",
                `Still running. Handle "${handle}". Use shell with action interact or stop.`,
              ].join("\n"),
              language: "bash",
              label: `${input.command} · running`,
            }
          }

          const { stdout, stderr, code } = await capture("bash", ["-lc", input.command], {
            cwd,
            signal: ctx.signal,
            timeoutMs: COMMAND_TIMEOUT_MS,
          })
          const body = [stdout, stderr].filter((part) => part.trim()).join("\n")
          return {
            text: `$ ${input.command}\n${body || "(no output)"}\n\nexit ${code}`,
            language: "bash",
            label: `${input.command} · exit ${code}`,
          }
        },
      },
      context,
    ),
  ]
}
