import { spawn } from "node:child_process"

export type Captured = { stdout: string; stderr: string; code: number }

export function capture(
  program: string,
  args: string[],
  options: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
  },
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }))
  })
}

export function isMissingProgram(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT"
}
