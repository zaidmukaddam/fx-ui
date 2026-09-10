import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { listMcpServers, listMcpTools } from "../workspace/mcp"
import { loadSkills } from "../workspace/skills"
import { requestApproval } from "./approvals"
import {
  DENIED_PREFIX,
  defineTool,
  field,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import { display } from "./paths"

export function extensionTools(context: ToolContext): HostTool[] {
  return [
    defineTool<{ name: string }>(
      {
        name: "skill",
        description:
          "Read a skill in full before doing work it covers: one from the skills list in your instructions, or one capability_search found.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The skill's name." },
          },
          required: ["name"],
        },
        parse: (input) => ({ name: requireString(input, "name") }),
        label: (input) => input.name,
        run: async (input, ctx) => {
          const { commands } = await loadSkills(ctx.root)
          const skill = commands.find((entry) => entry.name === input.name)
          if (!skill) {
            const known = commands.map((entry) => entry.name).join(", ")
            throw new Error(
              known
                ? `No skill named ${input.name}. Available: ${known}.`
                : `No skill named ${input.name}, and this workspace has none.`,
            )
          }
          return {
            text: skill.description
              ? `${skill.description}\n\n${skill.instructions}`
              : skill.instructions,
            label: `${skill.name} · loaded`,
          }
        },
      },
      context,
    ),

    defineTool<{ name: string; source: string }>(
      {
        name: "install_skill",
        description:
          "Save a skill into the workspace so later sessions have it. `source` is a URL to a Markdown skill file, or the Markdown itself.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "File name for the skill, without .md." },
            source: {
              type: "string",
              description: "An https URL to fetch, or the skill's Markdown.",
            },
          },
          required: ["name", "source"],
        },
        parse: (input) => ({
          name: requireString(input, "name"),
          source: requireString(input, "source"),
        }),
        label: (input) => input.name,
        run: async (input, ctx) => {
          if (!/^[A-Za-z0-9_-]+$/.test(input.name)) {
            throw new Error("A skill name may only contain letters, digits, `_` and `-`.")
          }

          const fromUrl = /^https:\/\//.test(input.source)
          const approved = await requestApproval({
            sessionId: ctx.sessionId,
            toolName: "install_skill",
            title: `Install the skill ${input.name}`,
            detail: fromUrl ? input.source : input.source.slice(0, 2_000),
            scope: "install_skill",
            routine: false,
          })
          if (!approved) throw new Error(`${DENIED_PREFIX}: ${input.name} was not installed.`)

          let body = input.source
          if (fromUrl) {
            const response = await fetch(input.source, { signal: ctx.signal })
            if (!response.ok) {
              throw new Error(`Could not fetch the skill: ${response.status}.`)
            }
            body = await response.text()
          }

          const directory = path.join(ctx.root, ".fx", "skills")
          mkdirSync(directory, { recursive: true })
          const file = path.join(directory, `${input.name}.md`)
          writeFileSync(file, body)
          return {
            text: `Installed ${display(ctx.root, file)}. It loads on the next session, or after Reload skills.`,
            label: `${input.name} · installed`,
          }
        },
      },
      context,
    ),

    defineTool<{ query: string }>(
      {
        name: "capability_search",
        description:
          "Find what this workspace can do beyond the built-in tools: its installed skills and the tools its MCP servers provide. Search before assuming a capability is missing.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What you are looking for. Omit to list everything.",
            },
          },
        },
        parse: (input) => {
          const query = field(input, "query")
          return { query: typeof query === "string" ? query : "" }
        },
        label: (input) => input.query || "everything",
        run: async (input, ctx) => {
          const needle = input.query.trim().toLowerCase()
          const matches = (haystack: string) =>
            !needle || haystack.toLowerCase().includes(needle)

          const { commands } = await loadSkills(ctx.root)
          const skills = commands
            .filter((skill) => matches(`${skill.name} ${skill.description}`))
            .map((skill) => `skill  ${skill.name} — ${skill.description || "no description"}`)

          const servers = listMcpTools()
            .filter((tool) => matches(`${tool.name} ${tool.description}`))
            .map((tool) => `mcp    ${tool.name} — ${tool.description}`)

          const found = [...skills, ...servers]
          return {
            text:
              found.length > 0
                ? found.join("\n")
                : needle
                  ? `Nothing installed matches ${input.query}.`
                  : "No skills or MCP tools are installed.",
            label: `${input.query || "everything"} · ${found.length} found`,
          }
        },
      },
      context,
    ),

    defineTool<Record<string, never>>(
      {
        name: "mcp_features",
        description:
          "Report which MCP servers are connected and how many tools each provides.",
        inputSchema: { type: "object", properties: {} },
        parse: () => ({}),
        label: () => "mcp features",
        run: async () => {
          const servers = listMcpServers()
          if (servers.length === 0) {
            return {
              text: "No MCP servers are connected. They are configured in ~/.fx-ui/mcp.json.",
              label: "none connected",
            }
          }
          const lines = servers.map(
            (server) => `${server.name} — ${server.tools} tools: ${server.toolNames.join(", ")}`,
          )
          return { text: lines.join("\n"), label: `${servers.length} servers` }
        },
      },
      context,
    ),

    defineTool<{ name: string }>(
      {
        name: "mcp_select_tool",
        description:
          "Show one MCP tool's full input schema, so a call to it can be built correctly.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The tool's name, as capability_search or mcp_features reports it.",
            },
          },
          required: ["name"],
        },
        parse: (input) => ({ name: requireString(input, "name") }),
        label: (input) => input.name,
        run: async (input) => {
          const tool = listMcpTools().find((entry) => entry.name === input.name)
          if (!tool) {
            const known = listMcpTools().map((entry) => entry.name)
            throw new Error(
              known.length > 0
                ? `No MCP tool named ${input.name}. Available: ${known.join(", ")}.`
                : `No MCP tool named ${input.name}, and no servers are connected.`,
            )
          }
          return {
            text: [
              `${tool.name} — ${tool.description}`,
              "",
              "It is already available; call it directly. Input schema:",
              JSON.stringify(tool.inputSchema, null, 2),
            ].join("\n"),
            language: "json",
            label: `${tool.name} · schema`,
          }
        },
      },
      context,
    ),
  ]
}
