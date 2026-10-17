import { gitDiff, gitLog, gitStatus, runGit, summarise } from "../workspace/git"
import { repoGitDir } from "../workspace/turns"
import {
  clip,
  defineTool,
  field,
  gate,
  optionalNumber,
  optionalString,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import { display, resolveInside } from "./paths"

/** What `git commit` would take: the staged changes, or with `all` every change to
 *  tracked files. A repository with no commits yet has no HEAD to diff against. */
async function committable(
  root: string,
  all: boolean,
  signal: AbortSignal,
): Promise<{ patch: string; stat: string }> {
  const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { signal })
  const range = all && head?.code === 0 ? ["HEAD"] : ["--cached"]
  const [patch, stat] = await Promise.all([
    runGit(root, ["diff", "--no-color", "--binary", ...range], { signal }),
    runGit(root, ["diff", "--no-color", "--stat", ...range], { signal }),
  ])
  return { patch: patch?.stdout ?? "", stat: stat?.stdout.trimEnd() ?? "" }
}

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
        parse: (input) => ({
          staged: field(input, "staged") === true,
          path: optionalString(input, "path") || undefined,
        }),
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
        parse: (input) => ({
          limit: Math.min(100, Math.max(1, Math.floor(optionalNumber(input, "limit") ?? 20))),
          path: optionalString(input, "path") || undefined,
        }),
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

    defineTool<{ message: string; all: boolean }>(
      {
        name: "git_commit",
        description:
          "Commit in the workspace's repository once the user approves. Commits what is staged, or with all, every change to tracked files too. New files must be staged first. Check git_status for what will go in and git_log for the project's message conventions.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The commit message: a subject line, optionally a blank line and a body.",
            },
            all: {
              type: "boolean",
              description: "Also commit unstaged changes to tracked files, like git commit -a.",
            },
          },
          required: ["message"],
        },
        parse: (input) => ({
          message: requireString(input, "message").trim(),
          all: field(input, "all") === true,
        }),
        label: (input) => input.message.split("\n")[0] ?? "",
        run: async (input, ctx) => {
          if (!input.message) throw new Error("Give a commit message.")
          if (!(await repoGitDir(ctx.root))) {
            throw new Error("This workspace is not the root of a git repository, so fx will not commit in it.")
          }
          const pending = await committable(ctx.root, input.all, ctx.signal)
          if (!pending.patch.trim()) {
            throw new Error(
              input.all
                ? "There is nothing to commit."
                : "Nothing is staged. Stage files first, or set all to include changes to tracked files.",
            )
          }

          await gate(ctx, {
            title: input.all ? "Commit all changes to tracked files" : "Commit the staged changes",
            detail: `${input.message}\n\n${pending.stat}`,
            language: "text",
            scope: "write",
            routine: true,
            denied: "Nothing was committed.",
          })

          // The approval showed one set of changes; refuse to commit a different one.
          const now = await committable(ctx.root, input.all, ctx.signal)
          if (now.patch !== pending.patch) {
            throw new Error("The changes to commit moved while approval was pending. Nothing was committed.")
          }

          const result = await runGit(
            ctx.root,
            ["commit", ...(input.all ? ["-a"] : []), "-m", input.message],
            // An editor or a credential prompt from a hook must not hang the app.
            { signal: ctx.signal, env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" } },
          )
          if (!result) throw new Error("git is not installed.")
          if (result.code !== 0) {
            const reason = (result.stderr || result.stdout).trim().split("\n")[0] ?? "git commit failed."
            throw new Error(reason.replace(/^fatal:\s*/, ""))
          }
          const head = await runGit(ctx.root, ["log", "-1", "--format=%h %s"], { signal: ctx.signal })
          const summary = head?.stdout.trim() ?? ""
          return { text: clip(`Committed ${summary}\n${pending.stat}`), label: summary }
        },
      },
      context,
    ),
  ]
}
