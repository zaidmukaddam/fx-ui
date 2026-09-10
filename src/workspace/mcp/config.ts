import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { DIR } from "../../store"

export const MCP_CONFIG_FILE = path.join(DIR, "mcp.json")

export const PROTOCOL_VERSION = "2025-06-18"
export const HANDSHAKE_TIMEOUT_MS = 20_000
export const CALL_TIMEOUT_MS = 120_000

export type LocalServer = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type RemoteServer = {
  url: string
  headers?: Record<string, string>
}

export type ServerConfig = LocalServer | RemoteServer

export function isRemote(config: ServerConfig): config is RemoteServer {
  return "url" in config
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
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers
  if (!servers || typeof servers !== "object") return {}

  const valid: Record<string, ServerConfig> = {}
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const entry = raw as Partial<LocalServer & RemoteServer> | null
    if (!entry || typeof entry !== "object") continue

    if (typeof entry.url === "string" && entry.url) {
      try {
        const url = new URL(entry.url)
        if (url.protocol !== "http:" && url.protocol !== "https:") continue
      } catch {
        continue
      }
      valid[name] = { url: entry.url, headers: strings(entry.headers) }
      continue
    }

    if (typeof entry.command === "string" && entry.command) {
      valid[name] = {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: strings(entry.env),
      }
    }
  }
  return valid
}

export function writeMcpConfig(
  servers: Record<string, ServerConfig>,
  file = MCP_CONFIG_FILE,
): void {
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>
  } catch {
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`)
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
  const servers = readMcpConfig(file)
  if (servers[trimmed]) throw new Error(`${trimmed} is already configured.`)
  writeMcpConfig({ ...servers, [trimmed]: serverFrom(source) }, file)
}

export function removeMcpServer(name: string, file = MCP_CONFIG_FILE): void {
  const servers = readMcpConfig(file)
  if (!servers[name]) return
  delete servers[name]
  writeMcpConfig(servers, file)
}
