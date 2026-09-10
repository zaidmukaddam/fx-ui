import { gitDiff, gitLog, gitStatus, summarise } from "../workspace/git"
import { defineTool, type HostTool, type ToolContext } from "./kit"
import { display, resolveInside } from "./paths"

export function vcsTools(context: ToolContext): HostTool[] {
  return [
    defineTool<Record<string, never>>(
      {
        name: "git_status",
        description:
          "The workspace's current branch and what is uncommitted in it. Use it before proposing a commit, or to see what you have already changed.",
        inputSchema: { type: "object", properties: {} },
        parse: () => ({}),
        label: () => "git status",
        run: async (_input, ctx) => {
          const status = await gitStatus(ctx.root, ctx.signal)
          if (!status) {
            return { text: "This workspace is not a git repository.", label: "not a repo" }
          }
          const lines = [
            `branch ${status.branch}`,
            `staged ${status.staged}`,
            `modified ${status.unstaged}`,
            `untracked ${status.untracked}`,
            `ahead ${status.ahead}`,
            `behind ${status.behind}`,
          ]
          return { text: lines.join("\n"), label: summarise(status) }
        },
      },
      context,
    ),

    defineTool<{ staged: boolean; path?: string }>(
      {
        name: "git_diff",
        description:
          "The workspace's uncommitted changes as a unified patch. Set staged to read the index instead of the working tree.",
        inputSchema: {
          type: "object",
          properties: {
            staged: {
              type: "boolean",
              description: "Read staged changes rather than unstaged ones.",
            },
            path: {
              type: "string",
              description: "Limit the diff to one file or directory.",
            },
          },
        },
        parse: (raw) => {
          const input = (raw ?? {}) as { staged?: unknown; path?: unknown }
          return {
            staged: input.staged === true,
            path: typeof input.path === "string" && input.path ? input.path : undefined,
          }
        },
        label: (input) =>
          `git diff${input.staged ? " --staged" : ""}${input.path ? ` ${input.path}` : ""}`,
        run: async (input, ctx) => {
          const patch = await gitDiff(ctx.root, {
            staged: input.staged,
            path: input.path && display(ctx.root, resolveInside(ctx.root, input.path)),
            signal: ctx.signal,
          })
          if (!patch.trim()) {
            return { text: "No changes.", label: "no changes" }
          }
          return { text: patch, patch, language: "diff" }
        },
      },
      context,
    ),

    defineTool<{ limit: number; path?: string }>(
      {
        name: "git_log",
        description:
          "Recent commits, most recent first, as `hash date author subject`. Use it to learn a file's history or the project's commit conventions.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "How many commits to return. 1 to 100, defaults to 20.",
            },
            path: {
              type: "string",
              description: "Limit the history to one file or directory.",
            },
          },
        },
        parse: (raw) => {
          const input = (raw ?? {}) as { limit?: unknown; path?: unknown }
          const limit = typeof input.limit === "number" ? Math.floor(input.limit) : 20
          return {
            limit: Math.min(100, Math.max(1, limit)),
            path: typeof input.path === "string" && input.path ? input.path : undefined,
          }
        },
        label: (input) => `git log -${input.limit}${input.path ? ` ${input.path}` : ""}`,
        run: async (input, ctx) => {
          const log = await gitLog(ctx.root, {
            limit: input.limit,
            path: input.path && display(ctx.root, resolveInside(ctx.root, input.path)),
            signal: ctx.signal,
          })
          return { text: log.trim() || "No commits yet.", label: `${input.limit} commits` }
        },
      },
      context,
    ),
  ]
}
