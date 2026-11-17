import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "node:util"

import { HOME_DIR } from "../../store"
import type { ServerConfig } from "./config"

function readSmallFile(file: string): string {
  const stat = statSync(file)
  if (!stat.isFile() || stat.size > 64_000) throw new Error("An MCP variable file must be smaller than 64 KB.")
  return readFileSync(file, "utf8")
}

export function expandMcpValue(value: string, env: NodeJS.ProcessEnv = process.env, home = HOME_DIR): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, variable: string) => {
    if (variable === "userHome") return home
    if (variable === "pathSeparator" || variable === "/") return path.sep
    if (variable.startsWith("env:")) {
      const name = variable.slice(4)
      if (env[name] === undefined) throw new Error(`Set the ${name} environment variable before connecting.`)
      return env[name]!
    }
    if (variable.startsWith("file:")) {
      const file = variable.slice(5).replace(/^~(?=\/|$)/, home)
      if (!path.isAbsolute(file)) throw new Error("MCP file variables need an absolute path.")
      try {
        return readSmallFile(file).trim()
      } catch {
        throw new Error("An MCP variable file could not be read.")
      }
    }
    return match
  })
}

export function resolveMcpConfig(config: ServerConfig, env: NodeJS.ProcessEnv = process.env, home = HOME_DIR): ServerConfig {
  const fileValues = !("url" in config) && config.envFile
    ? parseEnv(readSmallFile(expandMcpValue(config.envFile, env, home).replace(/^~(?=\/|$)/, home)))
    : {}
  const fromFile = Object.fromEntries(Object.entries(fileValues).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const environment = { ...env, ...fromFile }
  const expand = (value: string) => expandMcpValue(value, environment, home)
  const fields = (values: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, expand(value)]))
  if ("url" in config) {
    const url = expand(config.url)
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("An MCP URL must use HTTP or HTTPS.")
    return { ...config, url, headers: fields(config.headers) }
  }
  return {
    ...config,
    command: expand(config.command).replace(/^~(?=\/|$)/, home),
    args: config.args.map(expand),
    env: { ...fromFile, ...fields(config.env) },
    ...(config.cwd ? { cwd: expand(config.cwd).replace(/^~(?=\/|$)/, home) } : {}),
  }
}
