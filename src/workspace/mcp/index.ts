import { createMcpAdapter } from "libfx/mcp"

import type { HostTool } from "../../tools"
import { authorisedServers } from "./auth"
import { MCP_CONFIG_FILE, isRemote, readMcpConfig, type ServerConfig } from "./config"
import { HttpWire, NeedsSignIn } from "./http"
import { McpSession } from "./session"
import { StdioWire } from "./stdio"

export {
  MCP_CONFIG_FILE,
  addMcpServer,
  isRemote,
  readMcpConfig,
  removeMcpServer,
  serverFrom,
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

export type ServerTool = { server: string; tool: HostTool }

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

function clientFor(name: string, config: ServerConfig): McpSession {
  return new McpSession(name, isRemote(config) ? new HttpWire(name, config) : new StdioWire(name, config))
}

export async function loadMcp(file = MCP_CONFIG_FILE): Promise<LoadedMcp> {
  const config = readMcpConfig(file)
  const names = Object.keys(config)
  if (names.length === 0) return EMPTY

  const tools: ServerTool[] = []
  const instructions: string[] = []
  const connected: string[] = []
  const problems: LoadedMcp["problems"] = []
  const closers: (() => Promise<void>)[] = []

  await Promise.all(
    names.map(async (name) => {
      let client: McpSession | null = null
      try {
        client = clientFor(name, config[name]!)
        await client.initialize()
        const adapter = await createMcpAdapter(client, {
          prefix: name.replace(/[^A-Za-z0-9_-]/g, "_"),
        })
        for (const tool of adapter.tools as HostTool[]) tools.push({ server: name, tool })
        if (adapter.instructions) instructions.push(adapter.instructions)
        connected.push(name)
        closers.push(() => adapter.close())
      } catch (error) {
        await client?.close().catch(() => {})
        problems.push({
          server: name,
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
    instructions: instructions.join("\n\n"),
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

let pool: Pool | null = null

export async function acquireMcp(file = MCP_CONFIG_FILE): Promise<McpLease> {
  if (!pool) pool = { loaded: loadMcp(file), leases: 0, live: null }
  const current = pool
  current.leases += 1

  let loaded: LoadedMcp
  try {
    loaded = await current.loaded
    if (pool === current) current.live = loaded
  } catch (error) {
    current.leases -= 1
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
      current.leases -= 1
      if (current.leases <= 0 && pool === current) {
        pool = null
        await loaded.close()
      }
    },
  }
}

export function listMcpTools(): HostTool[] {
  return (pool?.live?.tools ?? []).map((entry) => entry.tool)
}

export function listMcpServers(file = MCP_CONFIG_FILE): {
  name: string
  url: string | null
  signedIn: boolean
  tools: number
  toolNames: string[]
}[] {
  const config = readMcpConfig(file)
  const authorised = new Set(authorisedServers())
  const live = pool?.live
  return Object.entries(config).map(([name, entry]) => {
    const toolNames = (live?.tools ?? [])
      .filter((tool) => tool.server === name)
      .map((tool) => tool.tool.name)
    return {
      name,
      url: isRemote(entry) ? entry.url : null,
      signedIn: authorised.has(name),
      tools: toolNames.length,
      toolNames,
    }
  })
}

export async function resetMcp(): Promise<void> {
  const current = pool
  pool = null
  if (!current) return
  try {
    await (await current.loaded).close()
  } catch {
  }
}
