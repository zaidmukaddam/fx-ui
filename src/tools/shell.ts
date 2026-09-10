import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import { newId, setBackground, type BackgroundCommand } from "../store"
import { capture } from "../workspace/run"
import { requestApproval } from "./approvals"
import {
  DENIED_PREFIX,
  defineTool,
  field,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import { resolveInside } from "./paths"

const COMMAND_TIMEOUT_MS = 120_000
const MAX_PENDING_CHARS = 200_000

type Running = {
  command: string
  child: ChildProcessWithoutNullStreams
  pending: string
  exit: number | null
}

const running = new Map<string, Running>()

function end(child: ChildProcessWithoutNullStreams): void {
  if (child.pid) {
    try {
      globalThis.process.kill(-child.pid, "SIGTERM")
      return
    } catch {}
  }
  child.kill()
}

function publish(sessionId: string): void {
  const live: BackgroundCommand[] = []
  for (const [handle, process] of running) {
    if (!handle.startsWith(`${sessionId}:`)) continue
    live.push({ handle, command: process.command, exit: process.exit })
  }
  setBackground(sessionId, live)
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

  const process: Running = { command, child, pending: "", exit: null }
  const collect = (chunk: Buffer) => {
    process.pending = `${process.pending}${chunk.toString()}`.slice(-MAX_PENDING_CHARS)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  child.on("error", (error) => {
    process.pending += `\n${error.message}\n`
    process.exit = -1
  })
  child.on("close", (code) => {
    process.exit = code ?? 0
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
          const handle = field(input, "handle")
          const stdin = field(input, "input")
          if (kind !== "run" && typeof handle !== "string") {
            throw new Error(`\`handle\` is required for ${kind}.`)
          }
          return {
            action: kind,
            command: kind === "run" ? requireString(input, "command") : "",
            cwd: typeof field(input, "cwd") === "string" ? (field(input, "cwd") as string) : ".",
            background: field(input, "background") === true,
            handle: typeof handle === "string" ? handle : undefined,
            input: typeof stdin === "string" ? stdin : undefined,
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

          const approved = await requestApproval({
            sessionId: ctx.sessionId,
            toolName: "shell",
            title: input.background ? "Start a background command" : "Run a command",
            detail: input.command,
            language: "bash",
            scope: `cmd:${program}`,
            routine: false,
          })
          if (!approved) throw new Error(`${DENIED_PREFIX}: the command was not run.`)

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
                `Still running. Handle "${handle}" — use shell with action interact or stop.`,
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
