import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"

import { DIR, newId } from "../../store"
import { resolveMcpConfig } from "./variables"

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

export type Connection = {
  id: string
  name: string
  config: ServerConfig
}

export function isRemote(config: ServerConfig): config is RemoteServer {
  return "url" in config
}

function connectionIdOf(name: string, raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const id = (raw as { id?: unknown }).id
    if (typeof id === "string" && id) return id
  }
  return name
}

function serversOf(document: Record<string, unknown>): Record<string, unknown> {
  const servers = document.mcpServers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {}
  return servers as Record<string, unknown>
}

export function readWorkspaceBindings(file = MCP_CONFIG_FILE): Record<string, string[]> {
  let document: Record<string, unknown>
  try {
    document = readMcpDocument(file)
  } catch {
    return {}
  }
  const raw = document.workspaceConnections
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [workspace, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue
    out[workspace] = ids.filter((id): id is string => typeof id === "string" && id.length > 0)
  }
  return out
}

export function readConnections(file = MCP_CONFIG_FILE): Connection[] {
  const config = readMcpConfig(file)
  let document: Record<string, unknown>
  try {
    document = readMcpDocument(file)
  } catch {
    return Object.entries(config).map(([name, entry]) => ({ id: name, name, config: entry }))
  }
  const servers = serversOf(document)
  return Object.entries(config).map(([name, entry]) => ({
    id: connectionIdOf(name, servers[name]),
    name,
    config: entry,
  }))
}

export function connectionsToLoad(file = MCP_CONFIG_FILE, workspacePath?: string): Connection[] {
  const all = readConnections(file).filter((connection) => !connection.config.disabled)
  if (!workspacePath) return all
  const bound = readWorkspaceBindings(file)[workspacePath]
  if (!bound) return all
  const allowed = new Set(bound)
  return all.filter((connection) => allowed.has(connection.id))
}

export function connectionFingerprint(resolved: ServerConfig): string {
  const material = isRemote(resolved)
    ? JSON.stringify(["url", resolved.url])
    : JSON.stringify(["cmd", resolved.command, resolved.args, path.resolve(resolved.cwd ?? process.cwd())])
  return createHash("sha256").update(material).digest("hex").slice(0, 12)
}

// Use the same resolved configuration snapshot that opens the connection.
export function mcpGrantScope(id: string, resolved: ServerConfig): string {
  return `mcp:${id}:${connectionFingerprint(resolved)}`
}

export function liveMcpGrantScopes(file = MCP_CONFIG_FILE): Set<string> {
  const scopes = new Set<string>()
  for (const connection of readConnections(file)) {
    try {
      scopes.add(mcpGrantScope(connection.id, resolveMcpConfig(connection.config)))
    } catch {
      // An unresolvable connection cannot retain approval; loadMcp reports its error.
    }
  }
  return scopes
}

export function pruneMcpGrants(grants: string[], file = MCP_CONFIG_FILE): string[] {
  const live = liveMcpGrantScopes(file)
  return grants.filter((grant) => !grant.startsWith("mcp:") || live.has(grant))
}

export function mcpGrantLabel(scope: string, file = MCP_CONFIG_FILE): string {
  if (!scope.startsWith("mcp:")) return scope
  const rest = scope.slice(4)
  const fingerprinted = /^(.+):([0-9a-f]{12})$/.exec(rest)
  const id = fingerprinted?.[1] ?? rest
  const found = readConnections(file).find((connection) => connection.id === id || connection.name === id)
  return `Use ${found?.name ?? id} tools`
}

export function setConnectionUsed(
  workspacePath: string,
  id: string,
  used: boolean,
  file = MCP_CONFIG_FILE,
): void {
  if (!workspacePath) return
  const document = readMcpDocument(file)
  const connections = readConnections(file)
  const bindings = readWorkspaceBindings(file)
  const current = bindings[workspacePath]
  const next = new Set(current ?? connections.map((connection) => connection.id))
  if (used) {
    if (connections.some((connection) => connection.id === id)) next.add(id)
  } else {
    next.delete(id)
  }
  const ordered = connections.filter((connection) => next.has(connection.id)).map((connection) => connection.id)
  writeMcpDocument({ ...document, workspaceConnections: { ...bindings, [workspacePath]: ordered } }, file)
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
  writeMcpDocument({ ...document, mcpServers: { ...servers, [trimmed]: { id: newId(), ...serverFrom(source) } } }, file)
}

export function removeMcpServer(name: string, file = MCP_CONFIG_FILE): void {
  const document = readMcpDocument(file)
  const servers = { ...serversOf(document) }
  if (!Object.hasOwn(servers, name)) return
  const removed = connectionIdOf(name, servers[name])
  delete servers[name]
  const next: Record<string, unknown> = { ...document, mcpServers: servers }
  if (document.workspaceConnections !== undefined) {
    const bindings = readWorkspaceBindings(file)
    next.workspaceConnections = Object.fromEntries(
      Object.entries(bindings).map(([workspace, ids]) => [workspace, ids.filter((id) => id !== removed)]),
    )
  }
  writeMcpDocument(next, file)
}

export function setMcpDisabled(name: string, disabled: boolean, file = MCP_CONFIG_FILE): void {
  const document = readMcpDocument(file)
  const servers = { ...(document.mcpServers ?? {}) as Record<string, unknown> }
  const entry = servers[name]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
  servers[name] = { ...entry, disabled }
  writeMcpDocument({ ...document, mcpServers: servers }, file)
}
