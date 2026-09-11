import { createMcpAdapter } from "libfx/mcp"

import type { HostTool } from "../../tools"
import { authorisedServers } from "./auth"
import {
  MCP_CONFIG_FILE,
  connectionsToLoad,
  isRemote,
  mcpGrantScope,
  readConnections,
  readWorkspaceBindings,
  type Connection,
} from "./config"
import { HttpWire, NeedsSignIn } from "./http"
import { McpSession } from "./session"
import { StdioWire } from "./stdio"
import { resolveMcpConfig } from "./variables"

export {
  MCP_CONFIG_FILE,
  addMcpServer,
  connectionsToLoad,
  isRemote,
  mcpGrantLabel,
  mcpGrantScope,
  pruneMcpGrants,
  readConnections,
  readMcpConfig,
  readWorkspaceBindings,
  removeMcpServer,
  setConnectionUsed,
  setMcpDisabled,
  serverFrom,
  type Connection,
  type LocalServer,
  type RemoteServer,
  type ServerConfig,
} from "./config"
export {
  authorisedServers,
  beginServerSignIn,
  signOutOfServer,
  storedAuth,
  type PendingServerSignIn,
} from "./auth"
export { NeedsSignIn } from "./http"

export type ServerTool = { server: string; id: string; scope: string; tool: HostTool }

export type LoadedMcp = {
  tools: ServerTool[]
  instructions: string
  names: string[]
  problems: { server: string; reason: string; needsSignIn: boolean }[]
  close(): Promise<void>
}

const EMPTY: LoadedMcp = {
  tools: [],
  instructions: "",
  names: [],
  problems: [],
  close: async () => {},
}

function clientFor(connection: Connection): McpSession {
  const resolved = resolveMcpConfig(connection.config)
  return new McpSession(
    connection.name,
    isRemote(resolved)
      ? new HttpWire(connection.id, connection.name, resolved)
      : new StdioWire(connection.name, resolved),
  )
}

export async function loadMcp(file = MCP_CONFIG_FILE, workspacePath?: string): Promise<LoadedMcp> {
  const connections = connectionsToLoad(file, workspacePath)
  if (connections.length === 0) return EMPTY

  const tools: ServerTool[] = []
  const instructions: string[] = []
  const connected: string[] = []
  const problems: LoadedMcp["problems"] = []
  const closers: (() => Promise<void>)[] = []

  await Promise.all(
    connections.map(async (connection) => {
      let client: McpSession | null = null
      try {
        client = clientFor(connection)
        await client.initialize()
        const adapter = await createMcpAdapter(client, {
          prefix: connection.name.replace(/[^A-Za-z0-9_-]/g, "_"),
          maxTools: 1024,
        })
        const scope = mcpGrantScope(connection.id, connection.config)
        for (const tool of adapter.tools as HostTool[]) {
          tools.push({ server: connection.name, id: connection.id, scope, tool })
        }
        if (adapter.instructions) instructions.push(adapter.instructions)
        connected.push(connection.name)
        closers.push(() => adapter.close())
      } catch (error) {
        await client?.close().catch(() => {})
        problems.push({
          server: connection.name,
          reason:
            error instanceof NeedsSignIn
              ? "needs you to sign in, from settings"
              : error instanceof Error
                ? error.message
                : "could not be started",
          needsSignIn: error instanceof NeedsSignIn,
        })
      }
    }),
  )

  return {
    tools,
    instructions: [
      connected.length ? `Connected MCP servers: ${connected.join(", ")}. Find their tools with capability_search, inspect inputs with mcp_select_tool, and run them with mcp_call_tool.` : "",
      ...instructions,
    ].filter(Boolean).join("\n\n"),
    names: connected,
    problems,
    close: async () => {
      await Promise.all(closers.map((close) => close().catch(() => {})))
    },
  }
}

export type McpLease = Omit<LoadedMcp, "close"> & {
  release(): Promise<void>
}

type Pool = { loaded: Promise<LoadedMcp>; leases: number; live: LoadedMcp | null }

const pools = new Map<string, Pool>()

function poolKey(file: string, workspacePath?: string): string {
  return `${file}\0${workspacePath ?? ""}`
}

function liveSets(workspacePath?: string): LoadedMcp[] {
  const all = [...pools.values()].map((pool) => pool.live).filter((live): live is LoadedMcp => live !== null)
  if (!workspacePath) return all
  const matched = [...pools.entries()]
    .filter(([key]) => key.endsWith(`\0${workspacePath}`))
    .map(([, pool]) => pool.live)
    .filter((live): live is LoadedMcp => live !== null)
  return matched.length ? matched : all
}

export async function acquireMcp(file = MCP_CONFIG_FILE, workspacePath?: string): Promise<McpLease> {
  const key = poolKey(file, workspacePath)
  let current = pools.get(key)
  if (!current) {
    current = { loaded: loadMcp(file, workspacePath), leases: 0, live: null }
    pools.set(key, current)
  }
  const pool = current
  pool.leases += 1

  let loaded: LoadedMcp
  try {
    loaded = await pool.loaded
    if (pools.get(key) === pool) pool.live = loaded
  } catch (error) {
    pool.leases -= 1
    if (pool.leases <= 0 && pools.get(key) === pool) pools.delete(key)
    throw error
  }

  let released = false
  return {
    tools: loaded.tools,
    instructions: loaded.instructions,
    names: loaded.names,
    problems: loaded.problems,
    release: async () => {
      if (released) return
      released = true
      pool.leases -= 1
      if (pool.leases <= 0 && pools.get(key) === pool) {
        pools.delete(key)
        await loaded.close()
      }
    },
  }
}

export function listMcpTools(workspacePath?: string): HostTool[] {
  return liveSets(workspacePath).flatMap((live) => live.tools.map((entry) => entry.tool))
}

export function findMcpTool(name: string, workspacePath?: string): ServerTool | undefined {
  const matches = liveSets(workspacePath).flatMap((live) => live.tools.filter((entry) => entry.tool.name === name))
  if (matches.length > 1) {
    throw new Error(`MCP tool name ${name} is shared by multiple servers. Rename a server in Settings before calling it.`)
  }
  return matches[0]
}

export function listMcpServers(file = MCP_CONFIG_FILE, workspacePath?: string): {
  id: string
  name: string
  url: string | null
  signedIn: boolean
  disabled: boolean
  used: boolean
  tools: number
  toolNames: string[]
}[] {
  const connections = readConnections(file)
  const bound = workspacePath ? readWorkspaceBindings(file)[workspacePath] : undefined
  const authorised = new Set(authorisedServers())
  const live = pools.get(poolKey(file, workspacePath))?.live
    ?? (workspacePath ? undefined : liveSets()[0])
  return connections.map((connection) => {
    const toolNames = (live?.tools ?? [])
      .filter((tool) => tool.server === connection.name)
      .map((tool) => tool.tool.name)
    return {
      id: connection.id,
      name: connection.name,
      url: isRemote(connection.config) ? connection.config.url : null,
      signedIn: authorised.has(connection.id) || authorised.has(connection.name),
      disabled: !!connection.config.disabled,
      used: !bound || bound.includes(connection.id),
      tools: toolNames.length,
      toolNames,
    }
  })
}

export async function resetMcp(): Promise<void> {
  const closing = [...pools.values()]
  pools.clear()
  await Promise.all(closing.map(async (current) => {
    try {
      await (await current.loaded).close()
    } catch {
    }
  }))
}
