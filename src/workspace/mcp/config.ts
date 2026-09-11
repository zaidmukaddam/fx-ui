import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"

import { DIR } from "../../store"

export const MCP_CONFIG_FILE = path.join(DIR, "mcp.json")

export const PROTOCOL_VERSION = "2025-06-18"
export const HANDSHAKE_TIMEOUT_MS = 20_000
export const CALL_TIMEOUT_MS = 120_000

export type LocalServer = {
  command: string
  args: string[]
  env?: Record<string, string>
  envFile?: string
  cwd?: string
  disabled?: boolean
}

export type RemoteServer = {
  url: string
  headers?: Record<string, string>
  disabled?: boolean
}

export type ServerConfig = LocalServer | RemoteServer

export function isRemote(config: ServerConfig): config is RemoteServer {
  return "url" in config
}

export function readMcpDocument(file = MCP_CONFIG_FILE): Record<string, unknown> {
  let source: string
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error("The MCP config must be a JSON file smaller than 2 MB.")
    source = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  const errors: ParseError[] = []
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The MCP config contains invalid JSON.")
  }
  const document = parsed as Record<string, unknown>
  if (document.mcpServers !== undefined && (!document.mcpServers || typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers))) {
    throw new Error("mcpServers must be an object.")
  }
  return document
}

export function writeMcpDocument(document: Record<string, unknown>, file = MCP_CONFIG_FILE): void {
  const target = existsSync(file) ? realpathSync(file) : file
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function strings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function readMcpConfig(file = MCP_CONFIG_FILE): Record<string, ServerConfig> {
  let parsed: unknown
  try {
    parsed = readMcpDocument(file)
  } catch {
    return {}
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers
  if (!servers || typeof servers !== "object") return {}

  const valid: Record<string, ServerConfig> = Object.create(null)
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const entry = raw as Partial<LocalServer & RemoteServer> | null
    if (!entry || typeof entry !== "object") continue

    if (typeof entry.url === "string" && entry.url) {
      try {
        if (!entry.url.includes("${")) {
          const url = new URL(entry.url)
          if (url.protocol !== "http:" && url.protocol !== "https:") continue
        }
      } catch {
        continue
      }
      valid[name] = { url: entry.url, headers: strings(entry.headers), ...(entry.disabled ? { disabled: true } : {}) }
      continue
    }

    if (typeof entry.command === "string" && entry.command) {
      valid[name] = {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: strings(entry.env),
        ...(typeof entry.envFile === "string" ? { envFile: entry.envFile } : {}),
        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
        ...(entry.disabled ? { disabled: true } : {}),
      }
    }
  }
  return valid
}

export function writeMcpConfig(
  servers: Record<string, ServerConfig>,
  file = MCP_CONFIG_FILE,
): void {
  writeMcpDocument({ ...readMcpDocument(file), mcpServers: servers }, file)
}

export function serverFrom(source: string): ServerConfig {
  const trimmed = source.trim()
  if (!trimmed) throw new Error("Give a URL, or the command that starts the server.")

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed)
    } catch {
      throw new Error(`${trimmed} is not a URL this can reach.`)
    }
    return { url: trimmed }
  }

  const parts = trimmed.split(/\s+/)
  return { command: parts[0]!, args: parts.slice(1) }
}

const NAME = /^[A-Za-z0-9_-]+$/

export function addMcpServer(
  name: string,
  source: string,
  file = MCP_CONFIG_FILE,
): void {
  const trimmed = name.trim()
  if (!NAME.test(trimmed)) {
    throw new Error("A name may only hold letters, digits, `_` and `-`.")
  }
  const document = readMcpDocument(file)
  const servers = (document.mcpServers ?? {}) as Record<string, unknown>
  if (Object.hasOwn(servers, trimmed)) throw new Error(`${trimmed} is already configured.`)
  writeMcpDocument({ ...document, mcpServers: { ...servers, [trimmed]: serverFrom(source) } }, file)
}

export function removeMcpServer(name: string, file = MCP_CONFIG_FILE): void {
  const document = readMcpDocument(file)
  const servers = { ...(document.mcpServers ?? {}) as Record<string, unknown> }
  if (!Object.hasOwn(servers, name)) return
  delete servers[name]
  writeMcpDocument({ ...document, mcpServers: servers }, file)
}

export function setMcpDisabled(name: string, disabled: boolean, file = MCP_CONFIG_FILE): void {
  const document = readMcpDocument(file)
  const servers = { ...(document.mcpServers ?? {}) as Record<string, unknown> }
  const entry = servers[name]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
  servers[name] = { ...entry, disabled }
  writeMcpDocument({ ...document, mcpServers: servers }, file)
}
