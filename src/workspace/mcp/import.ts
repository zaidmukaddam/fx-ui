import { existsSync } from "node:fs"
import path from "node:path"

import { HOME_DIR, newId } from "../../store"
import { MCP_CONFIG_FILE, isRemote, readMcpConfig, readMcpDocument, writeMcpDocument, type ServerConfig } from "./config"

export type McpImportEntry = {
  id: string
  name: string
  config: ServerConfig | null
  problem: string | null
}

export type McpImportSource = {
  id: string
  label: string
  file: string
  entries: McpImportEntry[]
  problem: string | null
}

const NAME = /^[A-Za-z0-9_-]+$/
const variables = /\$\{([^}]+)\}/g

function scriptArgument(command: string, args: string[]): string | undefined {
  const runtime = path.basename(command).replace(/^python[\d.]*$/, "python")
  const options: Record<string, string[]> = {
    node: ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--input-type", "--inspect-port", "--title"],
    bun: ["-r", "--require", "--preload", "--import", "--cwd", "--env-file", "--config", "--tsconfig-override", "--define", "--port", "--origin"],
    python: ["-W", "-X", "--check-hash-based-pycs"],
    ruby: ["-I", "-r", "-C", "-F", "-E", "-K"],
    deno: ["-c", "--config", "--import-map", "--lock", "--cert", "--location", "--v8-flags"],
  }
  const takesValue = options[runtime]
  if (!Array.isArray(takesValue)) return undefined
  let flags = true
  let subcommand = runtime === "bun" || runtime === "deno"
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-") return undefined
    if (flags) {
      if (arg === "--") {
        flags = false
        continue
      }
      const inline = runtime === "python" ? /^-[cm]/ : runtime === "ruby" ? /^-e/ : /^-[ep]|^--(?:eval|print)(?:=|$)/
      if (runtime !== "deno" && inline.test(arg)) return undefined
      if (takesValue.includes(arg)) {
        i++
        continue
      }
      if (arg.startsWith("-")) continue
      if (subcommand) {
        subcommand = false
        if (arg === "run") continue
        if ((runtime === "deno" && arg === "eval") || (runtime === "bun" && arg === "x")) return undefined
      }
    }
    return arg
  }
  return undefined
}

function normalize(raw: unknown, directory: string, home: string): ServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("This server entry must be an object.")
  const entry = raw as Record<string, unknown>
  if ([entry.auth, entry.oauthClientId, entry.oauthClientSecret, entry.oauthResource].some((value) => value !== undefined)) {
    throw new Error("Custom OAuth settings are not supported by fx yet.")
  }
  if (entry.enabledTools !== undefined || (entry.disabledTools !== undefined && (!Array.isArray(entry.disabledTools) || entry.disabledTools.length > 0))) {
    throw new Error("This server has tool restrictions that fx cannot preserve yet.")
  }
  if ([entry.disabled, entry.enabled].some((value) => value !== undefined && typeof value !== "boolean")) {
    throw new Error("Enabled and disabled flags must be booleans.")
  }
  const type = entry.transport ?? entry.type
  if (type !== undefined && !["stdio", "http", "streamable-http"].includes(String(type))) {
    throw new Error("This server transport is not supported by fx yet.")
  }
  const textValue = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("Command arguments, environment values, and headers must be strings.")
    return value.replace(variables, (match, variable: string) => {
      if (variable === "userHome") return home
      if (variable === "pathSeparator" || variable === "/") return path.sep
      if (/^env:[A-Za-z_][A-Za-z0-9_.-]*$/.test(variable)) return match
      if (variable.startsWith("file:")) {
        const file = variable.slice(5).replace(/^~(?=\/|$)/, home)
        if (!path.isAbsolute(file)) throw new Error("File variables need an absolute path.")
        return `\${file:${file}}`
      }
      throw new Error(variable.startsWith("workspaceFolder")
        ? "This server needs a workspace. Importing workspace configs is not supported yet."
        : "This server uses a variable that fx cannot resolve.")
    })
  }
  const fields = (value: unknown): Record<string, string> | undefined => {
    if (value === undefined) return undefined
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Environment values and headers must be objects.")
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, textValue(value)]))
  }
  const disabled = entry.disabled === true || entry.enabled === false ? { disabled: true } : {}
  const address = entry.url ?? entry.serverUrl
  if (address !== undefined) {
    if (entry.command !== undefined || type === "stdio" || entry.envFile !== undefined) throw new Error("This server mixes local and remote settings.")
    const url = textValue(address)
    if (!url.includes("${")) {
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error()
      } catch {
        throw new Error("The server URL must use HTTP or HTTPS.")
      }
    }
    return { url, headers: fields(entry.headers), ...disabled }
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) throw new Error("This server has no command or URL.")
  if (type !== undefined && type !== "stdio") throw new Error("This server transport needs a URL.")
  if (entry.args !== undefined && !Array.isArray(entry.args)) throw new Error("Command arguments must be an array.")
  const absolute = (value: unknown) => {
    const expanded = textValue(value).replace(/^~(?=\/|$)/, home)
    return expanded.includes("${") ? expanded : path.resolve(directory, expanded)
  }
  const cwd = entry.cwd !== undefined ? absolute(entry.cwd) : undefined
  const localPath = (value: string) => {
    const expanded = textValue(value).replace(/^~(?=\/|$)/, home)
    if (/^\.{1,2}(\/|$)/.test(expanded)) {
      if (!cwd || cwd.includes("${")) throw new Error("Relative paths need an explicit working directory (cwd).")
      return path.resolve(cwd, expanded)
    }
    return expanded
  }
  const command = localPath(entry.command)
  if (command.includes(path.sep) && !path.isAbsolute(command) && !command.includes("${")) {
    if (!cwd || cwd.includes("${")) throw new Error("Relative commands need an explicit working directory (cwd).")
  }
  const args = ((entry.args ?? []) as string[]).map(localPath)
  const script = scriptArgument(command, args)
  if (!cwd && script && !path.isAbsolute(script) && !script.includes("${") && !/^(?:https?|file|npm|jsr):/.test(script)) {
    throw new Error("Relative scripts need an explicit working directory (cwd).")
  }
  return {
    command,
    args,
    env: fields(entry.env),
    ...(cwd ? { cwd } : {}),
    ...(entry.envFile !== undefined ? { envFile: absolute(entry.envFile) } : {}),
    ...disabled,
  }
}

function connectionKey(config: ServerConfig): string {
  const ordered = (fields: Record<string, string> | undefined) => Object.entries(fields ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(isRemote(config)
    ? [config.url, ordered(config.headers)]
    : [config.command, config.args, ordered(config.env), config.cwd ?? "", config.envFile ?? ""])
}

export function sameMcpImport(left: McpImportEntry, right: McpImportEntry): boolean {
  return left.name === right.name || !!(left.config && right.config && connectionKey(left.config) === connectionKey(right.config))
}

function duplicate(name: string, config: ServerConfig, raw: Record<string, unknown>, known: Record<string, ServerConfig>): boolean {
  return Object.keys(raw).some((existing) => existing.replace(/[^A-Za-z0-9_-]/g, "_") === name)
    || Object.values(known).some((existing) => connectionKey(existing) === connectionKey(config))
}

export function discoverMcpImports(home = HOME_DIR, target = MCP_CONFIG_FILE): McpImportSource[] {
  const configHome = home === HOME_DIR && !process.env.FX_UI_HOME && process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, ".config")
  const devin = path.join(configHome, "devin", "mcp_config.json")
  const sources = [
    { id: "cursor", label: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
    { id: "devin", label: "Devin", file: existsSync(devin) ? devin : path.join(configHome, "devin", "config.json") },
    { id: "windsurf", label: "Windsurf / Cascade", file: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
  ]
  const existing = readMcpDocument(target)
  const raw = (existing.mcpServers ?? {}) as Record<string, unknown>
  const known = readMcpConfig(target)
  return sources.filter((source) => existsSync(source.file)).map((source) => {
    try {
      const document = readMcpDocument(source.file)
      const entries = Object.entries((document.mcpServers ?? {}) as Record<string, unknown>).map(([name, value]): McpImportEntry => {
        const id = `${source.id}:${name}`
        try {
          if (!NAME.test(name)) throw new Error("Rename this server using letters, digits, underscores, or hyphens.")
          const config = normalize(value, path.dirname(source.file), home)
          return { id, name, config, problem: duplicate(name, config, raw, known) ? "Already configured in fx." : null }
        } catch (error) {
          return { id, name, config: null, problem: error instanceof Error ? error.message : "This entry cannot be imported." }
        }
      })
      return { ...source, entries, problem: null }
    } catch {
      return { ...source, entries: [], problem: "This config could not be read. Check its JSON and file permissions." }
    }
  })
}

export function importMcpServers(entries: McpImportEntry[], file = MCP_CONFIG_FILE): { imported: string[]; skipped: string[] } {
  const document = readMcpDocument(file)
  const raw: Record<string, unknown> = Object.assign(Object.create(null), document.mcpServers ?? {})
  const known = readMcpConfig(file)
  const imported: string[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    if (!entry.config || entry.problem || duplicate(entry.name, entry.config, raw, known)) {
      skipped.push(entry.name)
      continue
    }
    raw[entry.name] = { id: newId(), ...entry.config }
    known[entry.name] = entry.config
    imported.push(entry.name)
  }
  if (imported.length) writeMcpDocument({ ...document, mcpServers: raw }, file)
  return { imported, skipped }
}
