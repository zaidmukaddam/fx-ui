import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import path from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"
import { connectTest } from "@gpuix/react/automation"
import { createTestRoot, hasNativeTestRenderer } from "@gpuix/react/testing"

import { FxApp } from "./app"
import { cleanTitle, fallbackTitle, reloadSkills, send } from "./src/agent/agent"
import { loadModels, refreshCredentials } from "./src/agent/credentials"
import { COMPOSER_CARD_INSET } from "./src/views/composer"
import { gitDiff, gitLog, gitStatus, isClean, summarise } from "./src/workspace/git"
import { loadSkills, splitCommand } from "./src/workspace/skills"
import {
  attachImages,
  CAN_PICK_IMAGES,
  CHOOSE_IMAGES,
  READ_PASTEBOARD,
} from "./src/workspace/images"
import {
  acquireMcp,
  addMcpServer,
  authorisedServers,
  beginServerSignIn,
  loadMcp,
  readMcpConfig,
  removeMcpServer,
  resetMcp,
  signOutOfServer,
  storedAuth,
} from "./src/workspace/mcp"
import {
  activeCommand,
  activeMention,
  applyMention,
  mentionBlocks,
  parseMentions,
  rankFiles,
} from "./src/workspace/files"
import { SIDEBAR_WIDTH } from "./src/views/sidebar"
import { createFxAgent, type Agent } from "libfx"

import { MIN_ACP_PROVIDER_VERSION, outdatedForProviders } from "./src/agent/cli"
import { authorizeUrl, beginSignIn, credential } from "./src/agent/oauth"
import {
  asGatewayCatalogue,
  bareModel,
  listProviderModels,
  parseCatalogue,
  providerFetch,
  toResponsesRequest,
  type SearchStep,
} from "./src/agent/providers"
import { CONTENT_WIDTH, TITLEBAR_CENTER } from "./src/ui/theme"
import {
  createTools,
  globToRegExp,
  htmlToText,
  lastEdit,
  resolveApproval,
  resolveQuestion,
  resolveInside,
  searchRows,
  stopAllBackgroundCommands,
  stopBackgroundCommand,
  undoLastEdit,
  type HostTool,
} from "./src/tools"
import {
  ATTACHMENT_DIR,
  DEFAULT_MODEL,
  DIR,
  appendMessage,
  clearNotices,
  createSession,
  createWorkspace,
  findSession,
  flushState,
  getState,
  nativeSearch,
  openSession,
  removeWorkspace,
  resetState,
  setSettings,
  setSplit,
  setState,
  updateSession,
  type Message,
  type PermissionMode,
  type Session,
} from "./src/store"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function tempDir(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "fx-ui-test-")))
}

function seed(mode: PermissionMode = "ask"): {
  root: string
  session: Session
  tools: Record<string, HostTool>
} {
  const root = tempDir()
  const workspace = createWorkspace(root, path.basename(root))
  const session = createSession(workspace.id)
  updateSession(session.id, (current) => ({ ...current, mode }))
  openSession(session.id, 0)
  const tools = Object.fromEntries(
    createTools({ sessionId: session.id, root }).map((tool) => [tool.name, tool]),
  )
  return { root, session, tools }
}

function run(tool: HostTool, input: unknown): Promise<unknown> {
  return Promise.resolve(tool.execute(input, { signal: new AbortController().signal }))
}

function messagesOf(sessionId: string): Message[] {
  return getState().sessions.find((entry) => entry.id === sessionId)?.messages ?? []
}

function pendingApproval(sessionId: string) {
  const message = messagesOf(sessionId).find(
    (entry) => entry.kind === "approval" && entry.decision === "pending",
  )
  return message?.kind === "approval" ? message : null
}

async function waitForApproval(sessionId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const approval = pendingApproval(sessionId)
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("no approval prompt appeared")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

beforeEach(() => {
  resetState()
})

describe("workspace confinement", () => {
  const root = tempDir()

  it("resolves a path inside the workspace", () => {
    expect(resolveInside(root, "src/app.tsx")).toBe(path.join(root, "src/app.tsx"))
    expect(resolveInside(root, ".")).toBe(root)
  })

  it("refuses every way out of the workspace", () => {
    for (const candidate of [
      "../secrets.txt",
      "src/../../secrets.txt",
      "/etc/passwd",
      `${os.homedir()}/.ssh/id_rsa`,
    ]) {
      expect(() => resolveInside(root, candidate), candidate).toThrow(/outside the workspace/)
    }
  })

  it("refuses a symlink that points out of the workspace", () => {
    const outside = tempDir()
    writeFileSync(path.join(outside, "secret.txt"), "top secret")
    require("node:fs").symlinkSync(outside, path.join(root, "escape"))

    expect(() => resolveInside(root, "escape/secret.txt")).toThrow(/outside the workspace/)
  })
})

describe("read-only tools", () => {
  it("reads a file without asking for approval", async () => {
    const { root, session, tools } = seed()
    writeFileSync(path.join(root, "note.txt"), "alpha\nbeta\ngamma")

    const result = await run(tools.read_file, { path: "note.txt" })

    expect(result).toContain("1\talpha")
    expect(result).toContain("3\tgamma")
    expect(pendingApproval(session.id)).toBeNull()
    const row = messagesOf(session.id).at(-1)
    expect(row?.kind).toBe("tool")
    expect(row?.kind === "tool" && row.state).toBe("ok")
  })

  it("refuses to read outside the workspace, and says so in the row", async () => {
    const { session, tools } = seed()

    await expect(run(tools.read_file, { path: "../../etc/passwd" })).rejects.toThrow(
      /outside the workspace/,
    )
    const row = messagesOf(session.id).at(-1)
    expect(row?.kind === "tool" && row.state).toBe("error")
  })

  it("rejects a malformed call with a message the model can act on", async () => {
    const { session, tools } = seed()

    await expect(run(tools.read_file, {})).rejects.toThrow(/`path` is required/)
    expect(messagesOf(session.id).at(-1)?.kind).toBe("tool")
  })
})

describe("approvals", () => {
  it("holds a command until the prompt is answered, then runs it", async () => {
    const { session, tools } = seed("ask")

    let settled = false
    const promise = run(tools.shell, { command: "echo wired" }).then((value) => {
      settled = true
      return value
    })

    const approval = await waitForApproval(session.id)
    expect(approval.detail).toBe("echo wired")
    expect(settled, "the command must not run before it is approved").toBe(false)

    resolveApproval(session.id, approval.approvalId, "allowed")
    expect(await promise).toContain("wired")
  })

  it("does not run a denied command, and marks the row denied", async () => {
    const { root, session, tools } = seed("ask")
    const canary = path.join(root, "canary.txt")

    const promise = run(tools.shell, { command: `touch ${canary}` })
    const approval = await waitForApproval(session.id)
    resolveApproval(session.id, approval.approvalId, "denied")

    await expect(promise).rejects.toThrow(/Denied by the user/)
    expect(existsSync(canary), "a denied command must not touch the disk").toBe(false)
    const row = messagesOf(session.id).find(
      (entry) => entry.kind === "tool" && entry.name === "shell",
    )
    expect(row?.kind === "tool" && row.state).toBe("denied")
  })

  it("stops asking for the same program after a grant", async () => {
    const { session, tools } = seed("ask")

    const first = run(tools.shell, { command: "echo one" })
    resolveApproval(session.id, (await waitForApproval(session.id)).approvalId, "granted")
    await first
    expect(getState().sessions[0].grants).toContain("cmd:echo")

    const second = run(tools.shell, { command: "echo two" })
    await settle()
    expect(pendingApproval(session.id), "the grant covers echo").toBeNull()
    expect(await second).toContain("two")

    const third = run(tools.shell, { command: "true" })
    expect((await waitForApproval(session.id)).scope).toBe("cmd:true")
    resolveApproval(session.id, pendingApproval(session.id)!.approvalId, "denied")
    await expect(third).rejects.toThrow()
  })

  it("writes a file only after approval, and shows the diff", async () => {
    const { root, session, tools } = seed("ask")

    const promise = run(tools.write_file, { path: "new.ts", content: "export const a = 1\n" })

    const approval = await waitForApproval(session.id)
    expect(approval.patch, "the prompt has to show what changes").toContain(
      "+export const a = 1",
    )
    expect(existsSync(path.join(root, "new.ts")), "nothing lands before yes").toBe(false)

    resolveApproval(session.id, approval.approvalId, "allowed")
    await promise
    expect(readFileSync(path.join(root, "new.ts"), "utf8")).toBe("export const a = 1\n")
  })

  it("edits an exact string and refuses an ambiguous one", async () => {
    const { root, session, tools } = seed("full-access")
    writeFileSync(path.join(root, "a.ts"), "let x = 1\nlet x = 1\n")

    await expect(
      run(tools.edit_file, { path: "a.ts", old_text: "let x = 1", new_text: "let y = 2" }),
    ).rejects.toThrow(/appears 2 times/)

    await run(tools.edit_file, {
      path: "a.ts",
      old_text: "let x = 1",
      new_text: "let y = 2",
      replace_all: true,
    })
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("let y = 2\nlet y = 2\n")

    const row = messagesOf(session.id).at(-1)
    expect(row?.kind === "tool" && row.patch).toContain("-let x = 1")
  })

  it("auto runs edits and still asks before a command", async () => {
    const { root, session, tools } = seed("auto")

    await run(tools.write_file, { path: "auto.txt", content: "written" })
    expect(readFileSync(path.join(root, "auto.txt"), "utf8")).toBe("written")
    expect(pendingApproval(session.id), "an edit is routine in auto").toBeNull()

    const command = run(tools.shell, { command: "echo nope" })
    const approval = await waitForApproval(session.id)
    expect(approval.scope, "a command is never routine").toBe("cmd:echo")
    resolveApproval(session.id, approval.approvalId, "denied")
    await expect(command).rejects.toThrow()
  })

  it("full access runs a command with no prompt", async () => {
    const { session, tools } = seed("full-access")

    expect(await run(tools.shell, { command: "echo free" })).toContain("free")
    expect(pendingApproval(session.id)).toBeNull()
  })
})

describe("session titles", () => {
  it("names a session from its first prompt until the model does", () => {
    expect(fallbackTitle("Fix the tokenizer loop\nand the tests")).toBe(
      "Fix the tokenizer loop",
    )
    expect(fallbackTitle("   ")).toBe("New session")
  })

  it("strips what a model wraps around a title", () => {
    expect(cleanTitle('"Fix the tokenizer loop"')).toBe("Fix the tokenizer loop")
    expect(cleanTitle("**Fix the tokenizer loop**")).toBe("Fix the tokenizer loop")
    expect(cleanTitle("# Fix the tokenizer loop")).toBe("Fix the tokenizer loop")
    expect(cleanTitle("- Fix the tokenizer loop.")).toBe("Fix the tokenizer loop")
    expect(cleanTitle("\n\nFix the tokenizer loop\n\nHere is why…")).toBe(
      "Fix the tokenizer loop",
    )
    expect(cleanTitle("   ")).toBe("")
  })

  it("caps a rambling title", () => {
    expect(cleanTitle("word ".repeat(40)).length).toBeLessThanOrEqual(56)
  })
})

describe("new tools", () => {
  it("matches globs the way a shell does", () => {
    const files = ["app.tsx", "src/files.ts", "src/ui/button.tsx", "docs/readme.md"]
    const matching = (pattern: string) =>
      files.filter((file) => globToRegExp(pattern).test(file))

    expect(matching("*.tsx")).toEqual(["app.tsx"])
    expect(matching("src/*.ts")).toEqual(["src/files.ts"])
    expect(matching("src/**/*.tsx")).toEqual(["src/ui/button.tsx"])
    expect(matching("**/*.tsx")).toEqual(["app.tsx", "src/ui/button.tsx"])
    expect(matching("app?tsx")).toEqual(["app.tsx"])
    expect(globToRegExp("app.tsx").test("appXtsx")).toBe(false)
    expect(globToRegExp("*.ts").test("src/files.ts")).toBe(false)
  })

  it("reduces a page to its readable text", () => {
    const html = `<html><head><style>body{color:red}</style>
      <script>var x = 1 < 2;</script></head>
      <body><h1>Title</h1><p>First &amp; second.</p><!-- hidden --></body></html>`

    const text = htmlToText(html)
    expect(text).toContain("Title")
    expect(text).toContain("First & second.")
    expect(text).not.toContain("color:red")
    expect(text).not.toContain("var x")
    expect(text).not.toContain("hidden")
  })

  it("finds files by glob without asking for approval", async () => {
    const { root, session, tools } = seed()
    mkdirSync(path.join(root, "src"), { recursive: true })
    writeFileSync(path.join(root, "src", "a.ts"), "")
    writeFileSync(path.join(root, "src", "b.tsx"), "")
    writeFileSync(path.join(root, "top.ts"), "")

    expect(await run(tools.glob_files, { pattern: "src/*.ts" })).toBe("src/a.ts")
    expect(pendingApproval(session.id)).toBeNull()
  })

  it("hands back a handle for a large result, and reads it", async () => {
    const { root, tools } = seed()
    const lines = Array.from({ length: 1_900 }, (_, index) => `line ${index}`)
    lines[1_800] = "NEEDLE here"
    writeFileSync(path.join(root, "big.txt"), lines.join("\n"))

    const preview = String(await run(tools.read_file, { path: "big.txt", limit: 2000 }))
    expect(preview).toContain("more characters retained")
    const handle = /handle "([^"]+)"/.exec(preview)?.[1]
    expect(handle).toBeDefined()

    const found = String(await run(tools.read_tool_result, { handle, query: "NEEDLE" }))
    expect(found).toContain("NEEDLE here")

    const ranged = String(await run(tools.read_tool_result, { handle, offset: 0, limit: 40 }))
    expect(ranged.length).toBeLessThan(120)
  })

  it("refuses a handle from another session", async () => {
    const { root, tools } = seed()
    writeFileSync(path.join(root, "big.txt"), "x".repeat(30_000))
    const preview = String(await run(tools.read_file, { path: "big.txt" }))
    const handle = /handle "([^"]+)"/.exec(preview)?.[1]!

    const other = seed()
    await expect(
      run(other.tools.read_tool_result, { handle }),
    ).rejects.toThrow(/not a retained result of this session/)
  })

  it("keeps a background command running, reads it, and stops it", async () => {
    const { session, tools } = seed("full-access")

    const started = String(
      await run(tools.shell, {
        command: 'echo ready; while true; do sleep 1; done',
        background: true,
      }),
    )
    expect(started).toContain("ready")
    expect(started).toContain("Still running")

    const handle = /Handle "([^"]+)"/.exec(started)?.[1]
    expect(handle).toBeDefined()

    const checked = String(await run(tools.shell, { action: "interact", handle }))
    expect(checked).toContain("[running]")

    const stopped = String(await run(tools.shell, { action: "stop", handle }))
    expect(stopped).toContain("Stopped")
    await expect(run(tools.shell, { action: "stop", handle })).rejects.toThrow(
      /not a running command/,
    )
    expect(pendingApproval(session.id)).toBeNull()
  })

  it("reports a background command that dies immediately", async () => {
    const { tools } = seed("full-access")

    const started = String(
      await run(tools.shell, { command: "exit 3", background: true }),
    )
    expect(started).toContain("exited 3 immediately")
    expect(started).not.toContain("Handle")
  })

  it("stops everything a background command started, and all of them on exit", async () => {
    const { tools } = seed("full-access")
    const pids: number[] = []
    const start = async (seconds: number) => {
      const output = String(
        await run(tools.shell, { command: `sleep ${seconds} & echo $!; wait`, background: true }),
      )
      const pid = Number(/^(\d+)$/m.exec(output)?.[1])
      pids.push(pid)
      return { handle: /Handle "([^"]+)"/.exec(output)?.[1], pid }
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

    try {
      const stopped = await start(305)
      await run(tools.shell, { action: "stop", handle: stopped.handle })
      await settle()
      expect(alive(stopped.pid)).toBe(false)

      const left = await start(306)
      stopAllBackgroundCommands()
      await settle()
      expect(alive(left.pid)).toBe(false)
    } finally {
      for (const pid of pids) if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    }
  })

  it("reads a workspace skill, and names the ones it has when asked for a missing one", async () => {
    const { root, tools } = seed()
    mkdirSync(path.join(root, ".fx", "skills"), { recursive: true })
    writeFileSync(
      path.join(root, ".fx", "skills", "commits.md"),
      "---\nname: commits\ndescription: how we write commits\n---\nOne line, lowercase.",
    )

    const loaded = String(await run(tools.skill, { name: "commits" }))
    expect(loaded).toContain("One line, lowercase.")

    await expect(run(tools.skill, { name: "nope" })).rejects.toThrow(/Available: commits/)
  })

  it("installs a skill into the workspace, and refuses a name that is a path", async () => {
    const { root, session, tools } = seed("ask")

    await expect(
      run(tools.install_skill, { name: "../escape", source: "# nope" }),
    ).rejects.toThrow(/letters, digits/)

    const promise = run(tools.install_skill, {
      name: "review",
      source: "---\nname: review\n---\nCheck the tests.",
    })
    const approval = await waitForApproval(session.id)
    expect(approval.scope).toBe("install_skill")
    resolveApproval(session.id, approval.approvalId, "allowed")
    await promise

    const file = path.join(root, ".fx", "skills", "review.md")
    expect(existsSync(file)).toBe(true)
    expect((await loadSkills(root)).names).toEqual(["review"])
  })

  it("searches installed capabilities rather than guessing at them", async () => {
    const { root, tools } = seed()
    mkdirSync(path.join(root, ".fx", "skills"), { recursive: true })
    writeFileSync(
      path.join(root, ".fx", "skills", "commits.md"),
      "---\nname: commits\ndescription: how we write commits\n---\nOne line.",
    )

    expect(String(await run(tools.capability_search, { query: "commit" }))).toContain(
      "skill  commits",
    )
    expect(String(await run(tools.capability_search, {}))).toContain("commits")
    expect(String(await run(tools.capability_search, { query: "kubernetes" }))).toContain(
      "Nothing installed matches",
    )
  })

  it("refuses to read a file that is not an image", async () => {
    const { root, tools } = seed("full-access")
    writeFileSync(path.join(root, "notes.txt"), "not an image")

    await expect(run(tools.vision, { path: "notes.txt" })).rejects.toThrow(
      /not an image this can read/,
    )
  })

  it("parks the turn on a question until it is answered", async () => {
    const { session, tools } = seed("full-access")

    let settled = false
    const promise = run(tools.ask_user_question, {
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    }).then((value) => {
      settled = true
      return value
    })

    const asked = await (async () => {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const found = messagesOf(session.id).find((entry) => entry.kind === "question")
        if (found?.kind === "question") return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error("no question appeared")
    })()
    expect(asked.options).toEqual(["Postgres", "SQLite"])
    expect(settled, "the tool must not resolve before the user answers").toBe(false)

    resolveQuestion(session.id, asked.questionId, "SQLite")
    expect(await promise).toBe("SQLite")
  })

  it("treats a dismissed question as a denial rather than an empty answer", async () => {
    const { session, tools } = seed("full-access")

    const promise = run(tools.ask_user_question, { question: "Proceed?" })
    const asked = await (async () => {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const found = messagesOf(session.id).find((entry) => entry.kind === "question")
        if (found?.kind === "question") return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error("no question appeared")
    })()
    expect(asked.options).toEqual([])

    resolveQuestion(session.id, asked.questionId, null)
    await expect(promise).rejects.toThrow(/Denied by the user/)
  })

  it("gives a subagent the same tools but will not let it spawn its own", () => {
    const { root, session } = seed()
    const top = createTools({ sessionId: session.id, root }).map((tool) => tool.name)
    const nested = createTools({ sessionId: session.id, root, depth: 1 }).map(
      (tool) => tool.name,
    )

    expect(top).toContain("subagent")
    expect(nested).not.toContain("subagent")
    for (const tool of ["read_file", "write_file", "shell", "grep_files"]) {
      expect(nested, tool).toContain(tool)
    }
  })

  it("asks before searching the web, and needs a key", async () => {
    const { session, tools } = seed("ask")

    setState((current) => ({ ...current, apiKey: null }))
    await expect(run(tools.web_search, { query: "anything" })).rejects.toThrow(
      /AI Gateway, which needs its own key/,
    )
    expect(pendingApproval(session.id)).toBeNull()

    setState((current) => ({ ...current, apiKey: "test-key" }))
    const promise = run(tools.web_search, { query: "vercel ai gateway" })
    const approval = await waitForApproval(session.id)
    expect(approval.scope).toBe("web:search")
    resolveApproval(session.id, approval.approvalId, "denied")
    await expect(promise).rejects.toThrow(/Denied by the user/)
  })

  it("asks before reaching the network, and refuses a non-http URL", async () => {
    const { session, tools } = seed("ask")

    await expect(run(tools.web_fetch, { url: "file:///etc/passwd" })).rejects.toThrow(
      /Only http and https/,
    )

    const promise = run(tools.web_fetch, { url: "https://example.com/docs" })
    const approval = await waitForApproval(session.id)
    expect(approval.scope).toBe("web:example.com")
    resolveApproval(session.id, approval.approvalId, "denied")
    await expect(promise).rejects.toThrow(/Denied by the user/)
  })
})

describe("git", () => {
  function repo(): string {
    const root = tempDir()
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      })
    run(["init", "--initial-branch=trunk"])
    run(["config", "user.email", "test@example.com"])
    run(["config", "user.name", "Test"])
    writeFileSync(path.join(root, "kept.txt"), "one\n")
    run(["add", "."])
    run(["commit", "-m", "first commit"])
    return root
  }

  it("reads the branch and a clean tree", async () => {
    const status = await gitStatus(repo())
    expect(status?.branch).toBe("trunk")
    expect(status && isClean(status)).toBe(true)
    expect(summarise(status!)).toBe("trunk · clean")
  })

  it("counts staged, modified and untracked separately", async () => {
    const root = repo()
    writeFileSync(path.join(root, "kept.txt"), "one\ntwo\n")
    writeFileSync(path.join(root, "fresh.txt"), "new\n")
    execFileSync("git", ["add", "fresh.txt"], { cwd: root, stdio: "ignore" })
    writeFileSync(path.join(root, "loose.txt"), "loose\n")

    const status = await gitStatus(root)
    expect(status?.staged).toBe(1)
    expect(status?.unstaged).toBe(1)
    expect(status?.untracked).toBe(1)
    expect(isClean(status!)).toBe(false)
  })

  it("is null outside a repository, rather than throwing", async () => {
    expect(await gitStatus(tempDir())).toBeNull()
  })

  it("reads a diff and a log", async () => {
    const root = repo()
    writeFileSync(path.join(root, "kept.txt"), "one\nchanged\n")

    const diff = await gitDiff(root)
    expect(diff).toContain("+changed")
    expect(await gitDiff(root, { staged: true })).toBe("")

    const log = await gitLog(root, { limit: 5 })
    expect(log).toContain("first commit")
  })
})

describe("skills", () => {
  function skill(root: string, file: string, body: string): void {
    mkdirSync(path.join(root, ".fx", "skills"), { recursive: true })
    writeFileSync(path.join(root, ".fx", "skills", file), body)
  }

  it("loads a workspace's skills into instructions", async () => {
    const root = tempDir()
    skill(root, "commits.md", "---\nname: commits\ndescription: how we commit\n---\nOne line, lowercase.")

    const loaded = await loadSkills(root)
    expect(loaded.names).toEqual(["commits"])
    expect(loaded.instructions).toContain("One line, lowercase.")
    expect(loaded.problems).toEqual([])
  })

  it("picks up an edited skill on reload, and says what it found", async () => {
    const root = tempDir()
    const workspace = createWorkspace(root, path.basename(root))
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    skill(root, "commits.md", "---\nname: commits\n---\nFirst version.")

    expect((await loadSkills(root)).instructions).toContain("First version.")

    skill(root, "commits.md", "---\nname: commits\n---\nSecond version.")
    skill(root, "review.md", "---\nname: review\n---\nCheck the tests.")
    await reloadSkills()

    const notice = messagesOf(session.id).at(-1)
    expect(notice?.kind).toBe("notice")
    expect(notice?.kind === "notice" && notice.text).toContain("commits, review")
    expect((await loadSkills(root)).instructions).toContain("Second version.")
  })

  it("finds nothing when there is no skills directory", async () => {
    const loaded = await loadSkills(tempDir())
    expect(loaded.names).toEqual([])
    expect(loaded.instructions).toBe("")
  })

  it("reports a broken skill and keeps the working ones", async () => {
    const root = tempDir()
    skill(root, "good.md", "---\nname: good\n---\nFine.")
    skill(root, "bad.md", "---\nname: bad\nUnterminated.")

    const loaded = await loadSkills(root)
    expect(loaded.names).toEqual(["good"])
    expect(loaded.problems).toHaveLength(1)
    expect(loaded.problems[0]?.file).toContain("bad.md")
  })

  it("keeps the skills list in the prompt inside its budget, whatever the count", async () => {
    const root = tempDir()
    for (let index = 0; index < 300; index += 1) {
      const folder = path.join(root, ".claude", "skills", `skill-${index}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(path.join(folder, "SKILL.md"), `---\ndescription: ${"word ".repeat(100)}\n---\nBody.`)
    }

    const loaded = await loadSkills(root)
    expect(loaded.commands).toHaveLength(300)
    expect(loaded.instructions.length).toBeLessThan(16_200)
    expect(loaded.instructions).toContain("- skill-0: word word")
    expect(loaded.instructions).toContain("- skill-299: word word")
  })

  it("offers Claude Code and .agents skills as commands, and lists them in the prompt without their text", async () => {
    const root = tempDir()
    const elsewhere = tempDir()
    const folder = (base: string, name: string, body: string) => {
      mkdirSync(path.join(base, name), { recursive: true })
      writeFileSync(path.join(base, name, "SKILL.md"), body)
    }
    try {
      skill(root, "commits.md", "---\nname: commits\n---\nOne line.")
      folder(
        path.join(root, ".claude", "skills"),
        "review",
        "---\nname: review\ndescription: 'the project''s review'\n---\nRead the diff.",
      )
      folder(
        path.join(root, ".agents", "skills"),
        "deploy",
        "---\ndescription: >-\n  ship\n  it\n---\nRun the deploy.",
      )
      folder(path.join(DIR, ".agents", "skills"), "review", "---\nname: review\n---\nGlobal review.")
      folder(elsewhere, "tidy", "---\nname: tidy\n---\nTidy up.")
      mkdirSync(path.join(DIR, ".claude", "skills"), { recursive: true })
      symlinkSync(path.join(elsewhere, "tidy"), path.join(DIR, ".claude", "skills", "tidy"))

      const loaded = await loadSkills(root)
      expect(loaded.names).toEqual(["commits"])
      expect(loaded.instructions).not.toContain("Read the diff.")
      expect(loaded.instructions).toContain("- deploy: ship it\n- tidy")
      expect(loaded.instructions).not.toContain("- commits")
      expect(loaded.commands.map((command) => command.name)).toEqual([
        "commits",
        "review",
        "deploy",
        "tidy",
      ])
      expect(loaded.commands[1]?.instructions).toBe(
        `Base directory for this skill: ${path.join(root, ".claude", "skills", "review")}\n\nRead the diff.`,
      )
      expect(loaded.commands[1]?.description).toBe("the project's review")
      expect(splitCommand("/deploy now", loaded.commands)?.command.description).toBe("ship it")
    } finally {
      rmSync(path.join(DIR, ".claude"), { recursive: true, force: true })
      rmSync(path.join(DIR, ".agents"), { recursive: true, force: true })
    }
  })
})

describe("mcp", () => {
  it("reads the server map and drops entries with no command", () => {
    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          linear: { command: "npx", args: ["-y", "linear-mcp"] },
          broken: { args: ["no command"] },
        },
      }),
    )

    const config = readMcpConfig(file)
    expect(Object.keys(config)).toEqual(["linear"])
    expect(config.linear).toEqual({ command: "npx", args: ["-y", "linear-mcp"], env: undefined })
  })

  it("treats a missing or malformed config as no servers", () => {
    expect(readMcpConfig(path.join(tempDir(), "absent.json"))).toEqual({})
    const bad = path.join(tempDir(), "bad.json")
    writeFileSync(bad, "{ not json")
    expect(readMcpConfig(bad)).toEqual({})
  })

  it("connects to a server over stdio and adapts its tools", async () => {
    const root = tempDir()
    const server = path.join(root, "server.mjs")
    writeFileSync(
      server,
      `let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } })
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{ name: "echo", description: "Echo a value.", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] })
    } else if (message.method === "tools/call") {
      reply(message.id, { content: [{ type: "text", text: "echoed " + message.params.arguments.value }] })
    }
  }
})
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
}
`,
    )
    const file = path.join(root, "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [server] } } }),
    )

    const loaded = await loadMcp(file)
    try {
      expect(loaded.problems).toEqual([])
      expect(loaded.names).toEqual(["demo"])
      const echo = loaded.tools.find((entry) => entry.tool.name.includes("echo"))?.tool
      expect(echo).toBeDefined()
      expect(loaded.tools.every((entry) => entry.server === "demo")).toBe(true)

      const result = await echo!.execute(
        { value: "hi" },
        { signal: new AbortController().signal },
      )
      expect(JSON.stringify(result)).toContain("echoed hi")
    } finally {
      await loaded.close()
    }
  })

  it("connects to a remote server over http and carries its session id", async () => {
    const seen: { auth: string | null; session: string | null; method: string }[] = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on("end", () => {
        if (request.method === "DELETE") {
          response.writeHead(204).end()
          return
        }
        const message = JSON.parse(body || "{}") as { id?: number; method?: string }
        seen.push({
          auth: request.headers.authorization ?? null,
          session: (request.headers["mcp-session-id"] as string) ?? null,
          method: message.method ?? "",
        })
        if (message.id === undefined) {
          response.writeHead(202).end()
          return
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "remote", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "ping",
                      description: "Ping.",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "pong" }] }
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-1",
        })
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      })
    })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const port = (server.address() as { port: number }).port

    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp` } } }),
    )

    const loaded = await loadMcp(file)
    try {
      expect(loaded.problems).toEqual([])
      expect(loaded.names).toEqual(["remote"])
      const ping = loaded.tools.find((entry) => entry.tool.name.includes("ping"))?.tool
      expect(ping).toBeDefined()

      const result = await ping!.execute({}, { signal: new AbortController().signal })
      expect(JSON.stringify(result)).toContain("pong")

      expect(seen[0]!.method).toBe("initialize")
      expect(seen[0]!.session).toBeNull()
      expect(seen.slice(1).every((entry) => entry.session === "sess-1")).toBe(true)
      expect(seen.every((entry) => entry.auth === null)).toBe(true)
    } finally {
      await loaded.close()
      server.close()
    }
  })

  it("sends the stored token to a signed-in remote server", async () => {
    let sent: string | null = null
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on("end", () => {
        sent = sent ?? (request.headers.authorization as string | undefined) ?? null
        const message = JSON.parse(body || "{}") as { id?: number; method?: string }
        if (message.id === undefined) {
          response.writeHead(202).end()
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
                : { tools: [] },
          }),
        )
      })
    })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const port = (server.address() as { port: number }).port

    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "mcp-auth.json"),
      JSON.stringify({
        authed: {
          accessToken: "tok-abc",
          clientId: "c",
          authorizeEndpoint: "http://127.0.0.1/authorize",
          tokenEndpoint: "http://127.0.0.1/token",
          resource: "http://127.0.0.1/mcp",
        },
      }),
    )

    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { authed: { url: `http://127.0.0.1:${port}/mcp` } } }),
    )

    const loaded = await loadMcp(file)
    try {
      expect(loaded.problems).toEqual([])
      expect(sent).toBe("Bearer tok-abc")
    } finally {
      await loaded.close()
      signOutOfServer("authed")
      server.close()
    }
  })

  it("reports a remote server that wants a sign-in instead of failing the load", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, {
        "www-authenticate":
          'Bearer resource_metadata="https://example.invalid/.well-known/oauth-protected-resource"',
      })
      response.end()
    })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const port = (server.address() as { port: number }).port

    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { guarded: { url: `http://127.0.0.1:${port}/mcp` } } }),
    )

    const loaded = await loadMcp(file)
    try {
      expect(loaded.names).toEqual([])
      expect(loaded.tools).toEqual([])
      expect(loaded.problems).toHaveLength(1)
      expect(loaded.problems[0]!.server).toBe("guarded")
      expect(loaded.problems[0]!.needsSignIn).toBe(true)
    } finally {
      await loaded.close()
      server.close()
    }
  })

  it("signs in to a remote server: discovery, registration, PKCE, token", async () => {
    let registered: Record<string, unknown> | null = null
    let exchanged: URLSearchParams | null = null

    const auth = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      let body = ""
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on("end", () => {
        const origin = `http://127.0.0.1:${(auth.address() as { port: number }).port}`
        const json = (value: unknown) => {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify(value))
        }
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          json({ authorization_servers: [origin], resource: `${origin}/mcp` })
        } else if (url.pathname === "/.well-known/oauth-authorization-server") {
          json({
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
          })
        } else if (url.pathname === "/register") {
          registered = JSON.parse(body) as Record<string, unknown>
          json({ client_id: "client-123" })
        } else if (url.pathname === "/token") {
          exchanged = new URLSearchParams(body)
          json({ access_token: "tok-abc", refresh_token: "ref", expires_in: 3600 })
        } else {
          response.writeHead(404).end()
        }
      })
    })
    await new Promise<void>((ready) => auth.listen(0, "127.0.0.1", ready))
    const origin = `http://127.0.0.1:${(auth.address() as { port: number }).port}`

    let opened = ""
    try {
      const flow = await beginServerSignIn("guarded", `${origin}/mcp`, null, async (url) => {
        opened = url
      })

      const authorize = new URL(opened)
      expect(authorize.origin + authorize.pathname).toBe(`${origin}/authorize`)
      expect(authorize.searchParams.get("client_id")).toBe("client-123")
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorize.searchParams.get("code_challenge")).toBeTruthy()
      expect(authorize.searchParams.get("resource")).toBe(`${origin}/mcp`)

      const redirect = new URL(authorize.searchParams.get("redirect_uri")!)
      const state = authorize.searchParams.get("state")!
      await fetch(`${redirect.origin}${redirect.pathname}?code=code-1&state=${state}`)
      await flow.completed

      const saved = storedAuth("guarded")
      expect(saved?.accessToken).toBe("tok-abc")
      expect(saved?.refreshToken).toBe("ref")
      expect(authorisedServers()).toContain("guarded")

      const sent = exchanged as URLSearchParams | null
      expect(sent?.get("grant_type")).toBe("authorization_code")
      expect(sent?.get("code")).toBe("code-1")
      expect(sent?.get("code_verifier")).toBeTruthy()
      expect((registered as Record<string, unknown> | null)?.client_name).toBe("fx-ui")
    } finally {
      signOutOfServer("guarded")
      auth.close()
    }
  })

  it("adds a server from one line, and keeps the rest of the file", () => {
    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(file, JSON.stringify({ note: "keep me", mcpServers: {} }))

    addMcpServer("linear", "https://mcp.linear.app/mcp", file)
    addMcpServer("files", "  npx -y server-filesystem /tmp ", file)

    expect(readMcpConfig(file)).toEqual({
      linear: { url: "https://mcp.linear.app/mcp", headers: undefined },
      files: { command: "npx", args: ["-y", "server-filesystem", "/tmp"], env: undefined },
    })
    expect(JSON.parse(readFileSync(file, "utf8")).note).toBe("keep me")

    expect(() => addMcpServer("linear", "https://x.example/mcp", file)).toThrow(
      /already configured/,
    )
    expect(() => addMcpServer("bad name", "https://x.example/mcp", file)).toThrow(/name/)
    expect(() => addMcpServer("ok", "   ", file)).toThrow(/URL, or the command/)

    removeMcpServer("linear", file)
    expect(Object.keys(readMcpConfig(file))).toEqual(["files"])
  })

  it("reads a url server and a command server, and rejects a bad url", () => {
    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["x.mjs"] },
          remote: { url: "https://example.com/mcp", headers: { "x-key": "v" } },
          bogus: { url: "ftp://example.com/mcp" },
          empty: {},
        },
      }),
    )
    const config = readMcpConfig(file)
    expect(Object.keys(config)).toEqual(["local", "remote"])
    expect(config.remote).toEqual({
      url: "https://example.com/mcp",
      headers: { "x-key": "v" },
    })
  })

  it("shares one set of servers across leases and stops them with the last", async () => {
    const root = tempDir()
    const log = path.join(root, "starts.log")
    const server = path.join(root, "server.mjs")
    writeFileSync(
      server,
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(log)}, "start\\n")
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } })
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [] })
    }
  }
})
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
}
`,
    )
    const file = path.join(root, "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [server] } } }),
    )

    const [first, second] = await Promise.all([acquireMcp(file), acquireMcp(file)])
    expect(first.names).toEqual(["demo"])
    expect(second.names).toEqual(["demo"])
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)

    await first.release()
    expect(existsSync(log)).toBe(true)

    await second.release()
    const third = await acquireMcp(file)
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
    await third.release()
    await resetMcp()
  })

  it("reports a server that will not start rather than failing the session", async () => {
    const file = path.join(tempDir(), "mcp.json")
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { gone: { command: "definitely-not-a-real-binary" } } }),
    )

    const loaded = await loadMcp(file)
    expect(loaded.names).toEqual([])
    expect(loaded.tools).toEqual([])
    expect(loaded.problems[0]?.server).toBe("gone")
    await loaded.close()
  })
})

describe("slash commands", () => {
  it("only triggers at the start of a draft, so paths and prose are safe", () => {
    expect(activeCommand("/comm")).toEqual({ query: "comm", start: 0 })
    expect(activeCommand("/")).toEqual({ query: "", start: 0 })

    expect(activeCommand("read src/files.ts")).toBeNull()
    expect(activeCommand("this and/or that")).toBeNull()
    expect(activeCommand("/commits and more")).toBeNull()
    expect(activeCommand("look at /etc/passwd")).toBeNull()
  })

  it("splits a known command from the rest, and leaves an unknown one alone", () => {
    const commands = [{ name: "commits", description: "", instructions: "One line." }]

    expect(splitCommand("/commits tidy the history", commands)).toEqual({
      command: commands[0],
      rest: "tidy the history",
    })
    expect(splitCommand("/commits", commands)?.rest).toBe("")
    expect(splitCommand("/nope do a thing", commands)).toBeNull()
    expect(splitCommand("no command here", commands)).toBeNull()
  })

  it("offers the workspace's skills when a draft starts with /", async () => {
    const root = tempDir()
    mkdirSync(path.join(root, ".fx", "skills"), { recursive: true })
    writeFileSync(
      path.join(root, ".fx", "skills", "commits.md"),
      "---\nname: commits\ndescription: how we write commits\n---\nOne line.",
    )
    const workspace = createWorkspace(root, path.basename(root))
    openSession(createSession(workspace.id).id, 0)

    const { app } = await mount()
    await app.getByTestId("composer").waitFor()

    await app.getByTestId("composer").fill("/comm")
    await app.getByTestId("mention-commits").waitFor()
    expect(await app.getByTestId("mention-picker").textContent()).toContain(
      "how we write commits",
    )

    await app.close()
  })
})

describe("@ mentions", () => {
  it("opens on a trailing @ token and closes once the word is finished", () => {
    expect(activeMention("look at @src/comp")).toEqual({ query: "src/comp", start: 8 })
    expect(activeMention("@")).toEqual({ query: "", start: 0 })
    expect(activeMention("look at @src/composer.tsx ")).toBeNull()
    expect(activeMention("mail me at zaid@scira")).toBeNull()
    expect(activeMention("plain text")).toBeNull()
  })

  it("replaces the token it is completing and leaves room for the next word", () => {
    expect(applyMention("look at @src/comp", "src/composer.tsx")).toBe(
      "look at @src/composer.tsx ",
    )
    expect(applyMention("@", "app.tsx")).toBe("@app.tsx ")
  })

  it("collects every distinct mention in a draft", () => {
    expect(parseMentions("diff @a.ts against @b.ts, then @a.ts again")).toEqual([
      "a.ts",
      "b.ts",
    ])
    expect(parseMentions("no mentions here")).toEqual([])
  })

  it("ranks a literal hit above a scattered one, and the basename above a prefix", () => {
    const files = ["src/composer.tsx", "src/store.ts", "docs/compose-notes.md", "cmp.ts"]

    expect(rankFiles(files, "compos")[0]).toBe("src/composer.tsx")
    expect(rankFiles(files, "srcstore")).toEqual(["src/store.ts"])
    expect(rankFiles(files, "zzz")).toEqual([])
    expect(rankFiles(files, "", 2)).toHaveLength(2)
  })

  it("attaches a mentioned file as a resource block and reports one it cannot", () => {
    const root = tempDir()
    writeFileSync(path.join(root, "schema.sql"), "CREATE TABLE users (id INTEGER);")

    const { blocks, problems } = mentionBlocks(root, "explain @schema.sql and @gone.sql")

    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type === "resource" && block.resource.text).toBe(
      "CREATE TABLE users (id INTEGER);",
    )
    expect(block.type === "resource" && block.resource.uri).toBe(
      `file://${path.join(root, "schema.sql")}`,
    )
    expect(problems.map((problem) => problem.path)).toEqual(["gone.sql"])
  })

  it("opens a session on its newest messages, not its oldest", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    for (let index = 0; index < 30; index += 1) {
      appendMessage(session.id, {
        id: `m${index}`,
        kind: "user",
        at: Date.now(),
        text: `message number ${index}`,
      })
    }

    const { renderer, app } = await mount(1100, 700)
    try {
      renderer.flush()
      const painted = renderer.getPaintedText().join("\n")
      expect(painted).toContain("message number 29")
      expect(painted).not.toContain("message number 0\n")
    } finally {
      await app.close()
    }
  })

  it("keeps an expanding row where it was instead of pushing it up the pane", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    for (let index = 0; index < 12; index += 1) {
      appendMessage(session.id, {
        id: `u${index}`,
        kind: "user",
        at: Date.now(),
        text: `question number ${index}`,
      })
    }
    toolRow(session.id, "grown", Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\n"))
    for (let index = 0; index < 6; index += 1) {
      appendMessage(session.id, {
        id: `t${index}`,
        kind: "user",
        at: Date.now(),
        text: `later question ${index}`,
      })
    }

    const { renderer, app } = await mount(1100, 700)
    try {
      renderer.flush()
      const before = await app.getByTestId("tool-grown").bounds()

      await app.getByTestId("tool-grown").click()
      await settle()
      renderer.flush()

      const after = await app.getByTestId("tool-grown").bounds()
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(8)
    } finally {
      await app.close()
    }
  })

  it("follows the tail again once a new message arrives after an expansion", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    for (let index = 0; index < 12; index += 1) {
      appendMessage(session.id, {
        id: `u${index}`,
        kind: "user",
        at: Date.now(),
        text: `question number ${index}`,
      })
    }
    toolRow(session.id, "grown", Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\n"))

    const { renderer, app } = await mount(1100, 700)
    try {
      await app.getByTestId("tool-grown").click()
      await settle()
      renderer.flush()

      appendMessage(session.id, {
        id: "fresh",
        kind: "user",
        at: Date.now(),
        text: "the newest question",
      })
      await settle()
      renderer.flush()

      expect(renderer.getPaintedText().join("\n")).toContain("the newest question")
    } finally {
      await app.close()
    }
  })

  it("undoes the last write, and refuses once the file has moved on", async () => {
    const { session, tools, root } = seed("full-access")
    const file = path.join(root, "note.md")

    await run(tools.write_file, { path: "note.md", content: "first\n" })
    expect(readFileSync(file, "utf8")).toBe("first\n")
    expect(lastEdit(session.id)).toBe("note.md")

    await run(tools.edit_file, { path: "note.md", old_text: "first", new_text: "second" })
    expect(readFileSync(file, "utf8")).toBe("second\n")

    expect(undoLastEdit(session.id)).toContain("note.md")
    expect(readFileSync(file, "utf8")).toBe("first\n")

    writeFileSync(file, "changed by someone else\n")
    expect(() => undoLastEdit(session.id)).toThrow(/changed after that edit/)
    expect(readFileSync(file, "utf8")).toBe("changed by someone else\n")

    expect(lastEdit(session.id)).toBeNull()
    expect(() => undoLastEdit(session.id)).toThrow(/Nothing to undo/)
  })

  it("undoing a file the write created removes it again", async () => {
    const { session, tools, root } = seed("full-access")

    await run(tools.write_file, { path: "fresh.txt", content: "hello" })
    expect(existsSync(path.join(root, "fresh.txt"))).toBe(true)

    expect(undoLastEdit(session.id)).toContain("removed")
    expect(existsSync(path.join(root, "fresh.txt"))).toBe(false)
  })

  it("publishes a background command so it can be seen and stopped", async () => {
    const { session, tools } = seed("full-access")

    const started = await run(tools.shell, {
      command: "sleep 30",
      background: true,
    })
    expect(String(started)).toContain("Still running")

    const live = getState().background[session.id] ?? []
    expect(live).toHaveLength(1)
    expect(live[0]!.command).toBe("sleep 30")
    expect(live[0]!.exit).toBeNull()

    stopBackgroundCommand(live[0]!.handle)
    expect(getState().background[session.id]).toEqual([])
  })

  it("hands a mentioned image to the vision tool instead of refusing it as binary", () => {
    const root = tempDir()
    writeFileSync(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    const { blocks, problems } = mentionBlocks(root, "why is @shot.png misaligned")

    expect(problems).toEqual([])
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.type).toBe("text")
    expect(block.type === "text" && block.text).toContain("shot.png")
    expect(block.type === "text" && block.text).toContain("vision")
  })

  it("refuses a mention that points outside the workspace", () => {
    const root = tempDir()
    const { blocks, problems } = mentionBlocks(root, "read @../../etc/passwd")

    expect(blocks).toEqual([])
    expect(problems[0]?.reason).toMatch(/outside the workspace/)
  })
})

describe("panes", () => {
  it("opens a second pane and keeps the focused one when it closes", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const first = createSession(workspace.id)
    const second = createSession(workspace.id)

    setSplit(true)
    expect(getState().panes).toHaveLength(2)
    expect(getState().focusedPane).toBe(1)

    openSession(first.id, 0)
    openSession(second.id, 1)
    expect(getState().panes.map((pane) => pane.sessionId)).toEqual([first.id, second.id])

    setSplit(false)
    expect(getState().panes).toHaveLength(1)
    expect(getState().panes[0].sessionId).toBe(second.id)
  })

  it("empties a pane whose workspace was removed", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)

    removeWorkspace(workspace.id)
    expect(getState().sessions).toHaveLength(0)
    expect(getState().panes[0].sessionId).toBeNull()
  })

  it("drops a session nothing was sent in once no pane shows it", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const ids = () => getState().sessions.map((session) => session.id)
    const sent = createSession(workspace.id)
    openSession(sent.id, 0)
    appendMessage(sent.id, { id: "prompt", kind: "user", at: Date.now(), text: "hi" })

    const unsent = createSession(workspace.id)
    openSession(unsent.id, 0)
    expect(ids()).toEqual([unsent.id, sent.id])

    const fresh = createSession(workspace.id)
    openSession(fresh.id, 0)
    expect(ids()).toEqual([fresh.id, sent.id])

    setSplit(true)
    const other = createSession(workspace.id)
    openSession(other.id, 1)
    openSession(sent.id, 0)
    setSplit(false)
    expect(ids()).toEqual([sent.id])
  })
})

function toolRow(sessionId: string, id: string, output: string): void {
  appendMessage(sessionId, {
    id,
    kind: "tool",
    at: Date.now(),
    endedAt: Date.now(),
    callId: id,
    name: "read_file",
    label: `${id}.ts`,
    state: "ok",
    output,
  })
}

async function mount(width = 1280, height = 800) {
  const { render, renderer } = createTestRoot({ width, height })
  render(<FxApp />)
  return { renderer, app: await connectTest(renderer) }
}

describeNative("fx app", () => {
  it("walks from an empty window to an open session", async () => {
    const workspacePath = tempDir()
    const { renderer, app } = await mount()

    expect(renderer.getPaintedText()).toContain("Add a workspace")

    await app.getByTestId("empty-add-workspace").click()
    await app.getByTestId("workspace-path").fill(workspacePath)
    await app.getByTestId("confirm-add-workspace").click()

    await app.getByTestId("composer").waitFor()
    expect(renderer.getPaintedText()).toContain(path.basename(workspacePath))
    expect(getState().workspaces).toHaveLength(1)
    expect(getState().sessions).toHaveLength(1)

    await app.close()
  })

  it("refuses a workspace path that is not a directory", async () => {
    const { renderer, app } = await mount()

    await app.getByTestId("empty-add-workspace").click()
    await app.getByTestId("workspace-path").fill("/definitely/not/here")
    await app.getByTestId("confirm-add-workspace").click()

    expect(renderer.getPaintedText().join("\n")).toContain("not a directory")
    expect(getState().workspaces).toHaveLength(0)

    await app.close()
  })

  it("answers an approval from the transcript and runs the command", async () => {
    const { session, tools } = seed("ask")
    const { renderer, app } = await mount()

    const promise = run(tools.shell, { command: "echo from-the-ui" })
    const approval = await waitForApproval(session.id)
    await settle()
    renderer.flush()

    expect(renderer.getPaintedText().join(" ")).toContain("from-the-ui")
    expect(renderer.getPaintedText()).toContain("Run a command")

    await app.getByTestId(`approve-${approval.approvalId}`).click()
    expect(await promise).toContain("from-the-ui")

    expect(pendingApproval(session.id)).toBeNull()
    const painted = renderer.getPaintedText().join("\n")
    expect(painted).not.toContain("Approved")
    expect(painted).toContain("from-the-ui")

    await app.close()
  })

  it("offers a subscription's models without an API key, and asks the Gateway for none", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setState((current) => ({ ...current, apiKey: null, models: [] }))

    let askedGateway = false
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (url.includes("ai-gateway.vercel.sh")) askedGateway = true
      if (url.includes("cli-chat-proxy.grok.com")) {
        return Response.json({
          data: [
            { model: "grok-4.6", name: "Grok 4.6", api_backend: "responses", context_window: 500_000 },
          ],
        })
      }
      return realFetch(input as RequestInfo, init)
    }) as unknown as typeof fetch

    try {
      await refreshCredentials()
      await loadModels()
    } finally {
      globalThis.fetch = realFetch
    }

    expect(askedGateway).toBe(false)
    expect(getState().models.map((model) => model.id)).toEqual(["grok-4.6"])
    expect(getState().accounts).toEqual([
      { provider: "grok", account: "someone@example.com" },
    ])
  })

  it("keeps the model list across a restart so the picker is never empty", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setState((current) => ({
      ...current,
      models: [
        { id: "grok-4.6", name: "Grok 4.6", provider: "grok", efforts: ["low", "high"] },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      ],
    }))
    flushState()

    const saved = JSON.parse(readFileSync(path.join(DIR, "state.json"), "utf8")) as {
      models?: { id: string }[]
    }
    expect(saved.models?.map((model) => model.id)).toEqual([
      "grok-4.6",
      "anthropic/claude-sonnet-5",
    ])
  })

  it("starts a first session on a subscription's model rather than the Gateway's", () => {
    setState((current) => ({
      ...current,
      models: [
        { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex" },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      ],
    }))
    const session = createSession(createWorkspace(tempDir(), "demo").id)
    expect(session.model).toBe("gpt-6-astra")
    expect(session.provider).toBe("codex")
    expect(session.modelName).toBe("GPT-6-Astra")
  })

  it("carries the provider and its tuning into the next session, not just the model id", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const first = createSession(workspace.id)
    updateSession(first.id, (current) => ({
      ...current,
      model: "gpt-6-astra",
      modelName: "GPT-6-Astra",
      provider: "codex",
      effort: "xhigh",
      fast: true,
      mode: "full-access",
    }))

    const next = createSession(workspace.id)
    expect(next.model).toBe("gpt-6-astra")
    expect(next.provider).toBe("codex")
    expect(next.modelName).toBe("GPT-6-Astra")
    expect(next.effort).toBe("xhigh")
    expect(next.fast).toBe(true)
    expect(next.mode).toBe("full-access")
  })

  it("opens new sessions on the pinned default, whatever the last one used", () => {
    setState((current) => ({
      ...current,
      apiKey: "gateway-key",
      models: [
        { id: "grok-4.6", name: "Grok 4.6", provider: "grok" },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      ],
      defaultModel: { id: "grok-4.6", provider: "grok", name: "Grok 4.6" },
    }))
    const workspace = createWorkspace(tempDir(), "demo")
    const first = createSession(workspace.id)
    updateSession(first.id, (current) => ({
      ...current,
      model: "anthropic/claude-sonnet-5",
      modelName: "Claude Sonnet 5",
      provider: null,
    }))

    const next = createSession(workspace.id)
    expect(next.model).toBe("grok-4.6")
    expect(next.provider).toBe("grok")
    expect(next.modelName).toBe("Grok 4.6")
  })

  it("keeps the pinned default across a restart", () => {
    setState((current) => ({
      ...current,
      defaultModel: { id: "gpt-6-astra", provider: "codex", name: "GPT-6-Astra" },
    }))
    flushState()

    const saved = JSON.parse(readFileSync(path.join(DIR, "state.json"), "utf8")) as {
      defaultModel?: unknown
    }
    expect(saved.defaultModel).toEqual({
      id: "gpt-6-astra",
      provider: "codex",
      name: "GPT-6-Astra",
    })
  })

  it("adds and removes an MCP server from settings", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(path.join(DIR, "mcp.json"), JSON.stringify({ mcpServers: {} }))

    const config = path.join(DIR, "mcp.json")
    const { renderer, app } = await mount(1024, 700)
    const scrollDown = () => app.getByTestId("settings-scroll").wheel(0, -4_000)
    try {
      await app.getByTestId("open-settings").click()
      await settle()
      renderer.flush()

      await scrollDown()
      await app.getByTestId("mcp-add").click()
      await settle()
      renderer.flush()
      await scrollDown()
      await app.getByTestId("mcp-name").fill("unreachable")
      await app.getByTestId("mcp-source").fill("http://127.0.0.1:1/mcp")
      await app.getByTestId("mcp-save").click()

      await app.getByTestId("mcp-remove-unreachable").waitFor({ timeoutMs: 8_000 })
      expect(readMcpConfig(config).unreachable).toEqual({
        url: "http://127.0.0.1:1/mcp",
        headers: undefined,
      })

      await scrollDown()
      await app.getByTestId("mcp-remove-unreachable").click()
      await settle()
      renderer.flush()
      expect(readMcpConfig(config)).toEqual({})
    } finally {
      writeFileSync(config, JSON.stringify({ mcpServers: {} }))
      await app.close()
    }
  }, 20_000)

  it("pins a default model from settings, and lets it go back to automatic", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setState((current) => ({
      ...current,
      models: [{ id: "grok-4.6", name: "Grok 4.6", provider: "grok" }],
    }))

    const { renderer, app } = await mount(1280, 900)
    await app.getByTestId("open-settings").click()
    await settle()
    renderer.flush()
    expect(renderer.getPaintedText().join("\n")).toContain("New sessions start on")

    const page = await app.getByTestId("settings-page").bounds()
    const trigger = await app.getByTestId("default-model").bounds()
    expect(trigger.width).toBeGreaterThan(0)
    expect(trigger.x + trigger.width).toBeLessThanOrEqual(page.x + page.width)

    await app.getByTestId("default-model").click()
    await settle()
    await app.getByTestId("model-grok:grok-4.6").click()
    await settle()
    expect(getState().defaultModel).toEqual({
      id: "grok-4.6",
      provider: "grok",
      name: "Grok 4.6",
    })

    await app.getByTestId("default-model").click()
    await settle()
    await app.getByTestId("model-automatic").click()
    await settle()
    expect(getState().defaultModel).toBeNull()

    await app.close()
  })

  it("moves off an inherited Gateway model that nothing could answer", () => {
    const key = process.env.AI_GATEWAY_API_KEY
    delete process.env.AI_GATEWAY_API_KEY
    try {
      setState((current) => ({
        ...current,
        apiKey: null,
        models: [{ id: "grok-4.6", name: "Grok 4.6", provider: "grok" }],
      }))
      const workspace = createWorkspace(tempDir(), "demo")
      const first = createSession(workspace.id)
      updateSession(first.id, (current) => ({
        ...current,
        model: "anthropic/claude-sonnet-5",
        provider: null,
        mode: "auto",
      }))

      const next = createSession(workspace.id)
      expect(next.model).toBe("grok-4.6")
      expect(next.provider).toBe("grok")
      expect(next.mode).toBe("auto")
    } finally {
      if (key === undefined) delete process.env.AI_GATEWAY_API_KEY
      else process.env.AI_GATEWAY_API_KEY = key
    }
  })

  it("takes a notice off the transcript when it is clicked", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    appendMessage(session.id, {
      id: "n1",
      kind: "notice",
      at: Date.now(),
      tone: "error",
      text: "Codex listed no models (HTTP 400)",
    })
    toolRow(session.id, "keep", "BODY")

    const { renderer, app } = await mount()
    expect(renderer.getPaintedText().join("\n")).toContain("HTTP 400")

    await app.getByTestId("notice-n1").click()
    await settle()
    renderer.flush()

    expect(messagesOf(session.id).some((message) => message.kind === "notice")).toBe(false)
    expect(messagesOf(session.id).some((message) => message.kind === "tool")).toBe(true)
    expect(renderer.getPaintedText().join("\n")).not.toContain("HTTP 400")

    await app.close()
  })

  it("clears a screenful of notices at once", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    for (const id of ["a", "b", "c"]) {
      appendMessage(session.id, {
        id,
        kind: "notice",
        at: Date.now(),
        tone: "info",
        text: `stale ${id}`,
      })
    }
    toolRow(session.id, "keep", "BODY")

    clearNotices(session.id)
    expect(messagesOf(session.id).map((message) => message.kind)).toEqual(["tool"])
  })

  it("collapses a denial into the tool row", async () => {
    const { session, tools } = seed("ask")
    const { renderer, app } = await mount()

    const promise = run(tools.shell, { command: "echo denied-here" })
    const approval = await waitForApproval(session.id)
    await settle()
    renderer.flush()

    await app.getByTestId(`deny-${approval.approvalId}`).click()
    await expect(promise).rejects.toThrow(/Denied by the user/)
    await settle()
    renderer.flush()

    const painted = renderer.getPaintedText().join("\n")
    expect(painted).not.toContain("Denied ·")
    expect(painted).toContain("denied-here")
    expect(painted).toContain("denied")

    await app.close()
  })

  it("expands a tool row and keeps it in view", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    for (let index = 0; index < 12; index += 1) {
      toolRow(
        session.id,
        `row${index}`,
        index === 10
          ? Array.from({ length: 400 }, (_, line) => `${line}\tLONG-BODY`).join("\n")
          : `BODY-${index}`,
      )
    }

    const { renderer, app } = await mount(1280, 800)

    const before = await app.getByTestId("tool-row10").bounds()
    await app.getByTestId("tool-row10").click()

    const after = await app.getByTestId("tool-row10").bounds()
    expect(before.y).toBeGreaterThan(0)
    expect(after.y).toBeGreaterThanOrEqual(0)
    expect(after.y).toBeLessThan(800)
    expect(renderer.getPaintedText().join("\n")).toContain("LONG-BODY")

    expect(renderer.getPaintedText().join("\n")).toContain("Show ")

    await app.getByTestId("tool-row10").click()
    expect(renderer.getPaintedText().join("\n")).not.toContain("LONG-BODY")

    await app.close()
  })

  it("runs a whole turn against a subscription through the request shim", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "tok",
          refreshToken: "ref",
          expiresAt: Date.now() + 3_600_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )

    const requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    let turnsTaken = 0
    const frames = (lines: unknown[]) =>
      new Response(lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })

    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      requests.push({
        url,
        auth: new Headers(init?.headers ?? {}).get("authorization"),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      })
      if (!url.includes("/responses")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "xai/grok-4.6", type: "language", released: 1, tags: ["tool-use"] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      turnsTaken += 1
      if (turnsTaken === 1) {
        return frames([
          { type: "response.output_text.delta", delta: "on it. " },
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "c1", name: "ping" },
          },
          { type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"n":7}' },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "c1", name: "ping", arguments: '{"n":7}' },
          },
          { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 3 } } },
        ])
      }
      return frames([
        { type: "response.output_text.delta", delta: "it said pong." },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 20,
              output_tokens: 6,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ])
    }) as unknown as typeof fetch

    let ran = false
    const perRequest: number[] = []
    const agent = (await createFxAgent({
      apiKey: "unused-by-the-subscription",
      model: "xai/grok-4.6",
      instructions: "be brief",
      tools: [
        {
          name: "ping",
          description: "Returns pong.",
          inputSchema: { type: "object", properties: { n: { type: "number" } } },
          execute: () => {
            ran = true
            return "pong"
          },
        },
      ],
      fetch: providerFetch(stub, {
        provider: "grok",
        onUsage: (tokens) => perRequest.push(tokens),
      }),
    })) as Agent

    const turn = agent.prompt("ping with 7")
    let text = ""
    for await (const event of turn) {
      if (event.type === "text_delta") text += event.delta
    }
    const result = await turn.result
    await agent.close()

    const model = requests.filter((request) => request.url.includes("/responses"))
    expect(model).toHaveLength(2)
    for (const request of model) {
      expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/responses")
      expect(request.auth).toBe("Bearer tok")
      expect(request.body.model).toBe("grok-4.6")
    }
    expect(model[0]!.body.instructions).toContain("be brief")

    expect(ran).toBe(true)
    const followUp = model[1]!.body.input as Record<string, unknown>[]
    expect(followUp.some((item) => item.type === "function_call" && item.call_id === "c1")).toBe(true)
    expect(
      followUp.some((item) => item.type === "function_call_output" && item.call_id === "c1"),
    ).toBe(true)

    expect(text).toBe("on it. it said pong.")
    expect(result.stopReason).toBe("end_turn")
    expect(result.usage.inputTokens).toBe(31)
    expect(result.usage.outputTokens).toBe(9)
    expect(perRequest).toEqual([14, 26])
  })

  it("shows a request the provider turned down as an error, not as the model's reply", async () => {
    const answers: [number, unknown, unknown][] = [
      [401, { error: { message: "Invalid API key" } }, expect.stringContaining("HTTP 401")],
      [400, { error: { message: "Codex answered HTTP 400: busy" } }, "Codex answered HTTP 400: busy"],
    ]
    const realFetch = globalThis.fetch
    try {
      for (const [status, body, shown] of answers) {
        const workspace = createWorkspace(tempDir(), "demo")
        const session = createSession(workspace.id)
        openSession(session.id, 0)
        setState((current) => ({ ...current, apiKey: "gateway-key" }))
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String((input as Request)?.url ?? input)
          if (!url.includes("/language-model")) return Response.json({ object: "list", data: [] })
          return Response.json(body, { status })
        }) as unknown as typeof fetch

        await send(session.id, "hello")

        const messages = messagesOf(session.id)
        expect(messages.some((message) => message.kind === "assistant")).toBe(false)
        expect(
          messages.flatMap((message) =>
            message.kind === "notice" ? [[message.tone, message.text]] : [],
          ),
        ).toEqual([["error", shown]])
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("lists what a session may do without asking, and forgets it", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    updateSession(session.id, (current) => ({ ...current, grants: ["cmd:git", "write"] }))
    const { renderer, app } = await mount()

    await app.getByTestId("permission-mode").click()
    const painted = renderer.getPaintedText().join("\n")
    expect(painted).toContain("Allowed without asking")
    expect(painted).toContain("Run git")
    expect(painted).toContain("Edit and create files")

    await app.getByTestId("forget-grant-cmd:git").click()
    expect(findSession(getState(), session.id)?.grants).toEqual(["write"])
    await app.close()
  })

  it("renames a session from its title in the pane header", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    const { app } = await mount()

    await app.getByTestId("session-title-0").click()
    await app.getByTestId("session-title").fill("Tokenizer work")
    await app.getByTestId("confirm-rename-session").click()

    expect(findSession(getState(), session.id)?.title).toBe("Tokenizer work")
    expect(getState().dialog).toBeNull()
    await app.close()
  })

  it("offers to copy the answer that ends a turn, not the words before a tool", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    appendMessage(session.id, { id: "ask", kind: "user", at: Date.now(), text: "what is in here" })
    appendMessage(session.id, {
      id: "between",
      kind: "assistant",
      at: Date.now(),
      text: "looking.",
      reasoning: "",
    })
    toolRow(session.id, "list", "one.txt")
    appendMessage(session.id, {
      id: "answer",
      kind: "assistant",
      at: Date.now(),
      text: "one file.",
      reasoning: "",
    })
    const { renderer, app } = await mount()

    await app.getByTestId("copy-answer").waitFor()
    expect(renderer.findByTestId("copy-between")).toBeUndefined()
    await app.close()
  })

  function isNaming(init?: RequestInit): boolean {
    const body =
      typeof init?.body === "string"
        ? init.body
        : Buffer.from((init?.body ?? "") as never).toString("utf8")
    return body.includes("You name conversations")
  }

  it("starts a new assistant message after a row lands under the last one", async () => {
    const root = tempDir()
    writeFileSync(path.join(root, "one.txt"), "hello")
    const workspace = createWorkspace(root, "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    setState((current) => ({ ...current, apiKey: "gateway-key" }))

    const frames = (lines: unknown[]) =>
      new Response(
        `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )

    let turns = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (!url.includes("/language-model")) {
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (isNaming(init)) return new Response("{}", { status: 400 })
      turns += 1
      if (turns === 1) {
        return frames([
          { type: "text-delta", delta: "looking. " },
          { type: "tool-input-start", id: "c1", toolName: "list_files" },
          { type: "tool-input-delta", id: "c1", delta: "{}" },
          { type: "tool-input-end", id: "c1" },
          { type: "tool-call", toolCallId: "c1", toolName: "list_files", input: {} },
          { type: "finish", finishReason: { unified: "tool-calls" } },
        ])
      }
      return frames([
        { type: "text-delta", delta: "one file." },
        { type: "finish", finishReason: { unified: "stop" } },
      ])
    }) as unknown as typeof fetch

    try {
      await send(session.id, "what is in here")
    } finally {
      globalThis.fetch = realFetch
    }

    const messages = messagesOf(session.id).filter((message) => message.kind !== "notice")
    const row = messages.findIndex((message) => message.kind === "tool")
    expect(row).toBeGreaterThan(0)
    expect(row).toBeLessThan(messages.length - 1)

    const last = messages[messages.length - 1]!
    expect(last.kind).toBe("assistant")
    expect(last.kind === "assistant" && last.text.endsWith("one file.")).toBe(true)
  })

  it("leaves a Gateway model alone", async () => {
    let sawGateway = false
    const stub = (async (input: RequestInfo | URL) => {
      sawGateway = String((input as Request)?.url ?? input).includes("ai-gateway.vercel.sh")
      return new Response('data: {"type":"finish","finishReason":{"unified":"stop"}}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }) as unknown as typeof fetch

    const agent = (await createFxAgent({
      apiKey: "gateway-key",
      model: "anthropic/claude-sonnet-5",
      fetch: providerFetch(stub, {}),
    })) as Agent
    const turn = agent.prompt("hi")
    for await (const _ of turn) {
    }
    await turn.result
    await agent.close()

    expect(sawGateway).toBe(true)
  })

  it("shows every section of settings, and what is signed in", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "t",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    await refreshCredentials()

    const { renderer, app } = await mount(1280, 900)
    setSettings(true)
    await settle()
    renderer.flush()

    const painted = renderer.getPaintedText().join("\n")
    for (const section of ["MODELS", "RUNTIME", "EXTENSIONS", "ABOUT"]) {
      expect(painted, section).toContain(section)
    }
    expect(await app.getByTestId("settings-page").count()).toBe(1)
    expect(await app.getByTestId("composer").count()).toBe(0)
    expect(painted).toContain("someone@example.com")
    expect(await app.getByTestId("settings-signout-grok").count()).toBe(1)
    expect(await app.getByTestId("settings-signin-codex").count()).toBe(1)

    await app.close()
  })

  it("opens settings from the sidebar and takes a key there", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { renderer, app } = await mount(1280, 900)

    await app.getByTestId("open-settings").click()
    await settle()
    renderer.flush()
    expect(await app.getByTestId("settings-page").count()).toBe(1)

    await app.getByTestId("settings-api-key").click()
    await settle()
    renderer.flush()
    await app.getByTestId("api-key").fill("vck_from_settings")
    await app.getByTestId("settings-save-key").click()
    await settle()

    expect(getState().apiKey).toBe("vck_from_settings")
    expect(getState().dialog).toBeNull()

    openSession(createSession(workspace.id).id, 0)
    await settle()
    renderer.flush()
    expect(await app.getByTestId("settings-page").count()).toBe(0)

    await app.close()
  })

  it("translates a prompt into Responses input items", () => {
    const request = toResponsesRequest(
      {
        prompt: [
          { role: "system", content: "be brief" },
          { role: "user", content: [{ type: "text", text: "read it" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "sure" },
              { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "read_file",
                output: { type: "text", value: "contents" },
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "read_file", description: "d", inputSchema: { type: "object" } }],
        toolChoice: { type: "auto" },
      },
      "grok-4.6",
    )

    expect(request.instructions).toBe("be brief")
    expect(request.model).toBe("grok-4.6")
    expect(request.stream).toBe(true)
    const input = request.input as Record<string, unknown>[]
    expect(input.map((item) => item.type)).toEqual([
      "message",
      "message",
      "function_call",
      "function_call_output",
    ])
    expect((input[0]!.content as Record<string, unknown>[])[0]!.type).toBe("input_text")
    expect((input[1]!.content as Record<string, unknown>[])[0]!.type).toBe("output_text")
    expect(input[2]!.arguments).toBe('{"path":"a"}')
    expect(input[3]!.output).toBe("contents")
    expect(request.tool_choice).toBeUndefined()
  })

  it("builds each provider's authorize URL the way its client id is registered", () => {
    const codex = new URL(
      authorizeUrl("codex", "http://localhost:1455/auth/callback", "chal", "st"),
    )
    expect(codex.origin + codex.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(codex.searchParams.get("id_token_add_organizations")).toBe("true")
    expect(codex.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    expect(codex.searchParams.get("originator")).toBe("fx")

    const grok = new URL(authorizeUrl("grok", "http://127.0.0.1:5000/callback", "chal", "st"))
    expect(grok.origin + grok.pathname).toBe("https://auth.x.ai/oauth2/authorize")
    expect(grok.searchParams.get("referrer")).toBe("fx")

    for (const url of [codex, grok]) {
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBe("chal")
      expect(url.searchParams.get("state")).toBe("st")
    }
  })

  it("lets x.ai's own page finish the sign-in against the loopback listener", async () => {
    const flow = await beginSignIn("grok")
    const redirect = new URL(new URL(flow.url).searchParams.get("redirect_uri")!)
    const callback = `http://127.0.0.1:${redirect.port}/callback`

    const preflight = await fetch(callback, {
      method: "OPTIONS",
      headers: {
        origin: "https://accounts.x.ai",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://accounts.x.ai")
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true")

    const answered = await fetch(`${callback}?code=abc&state=xyz`, {
      headers: { origin: "https://accounts.x.ai" },
    })
    expect(answered.headers.get("access-control-allow-origin")).toBe("https://accounts.x.ai")

    flow.cancel()
  })

  it("offers the loopback to nobody else", async () => {
    const flow = await beginSignIn("grok")
    const redirect = new URL(new URL(flow.url).searchParams.get("redirect_uri")!)
    const refused = await fetch(`http://127.0.0.1:${redirect.port}/callback`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    })
    expect(refused.headers.get("access-control-allow-origin")).toBeNull()
    flow.cancel()
  })

  it("reads each provider's own catalogue rather than a list written here", () => {
    const grok = parseCatalogue("grok", {
      data: [
        {
          id: "grok-4.6",
          model: "grok-4.6",
          name: "Grok 4.6",
          api_backend: "responses",
          context_window: 500_000,
          supports_reasoning_effort: true,
          reasoning_efforts: [
            { value: "high", label: "High Effort", default: true },
            { value: "low", label: "Low Effort", default: false },
          ],
        },
        { model: "grok-2-legacy", api_backend: "chat_completions", context_window: 131_072 },
      ],
    })
    expect(grok).toEqual([
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        contextWindow: 500_000,
        maxTokens: undefined,
        efforts: ["low", "high"],
        defaultEffort: "high",
        vision: false,
        search: false,
      },
    ])

    const codex = parseCatalogue("codex", {
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          visibility: "list",
          supported_in_api: true,
          context_window: 272_000,
          supported_reasoning_levels: [{ effort: "high" }],
        },
        {
          slug: "gpt-5.3-codex-spark",
          display_name: "GPT-5.3 Codex Spark",
          visibility: "list",
          supported_in_api: false,
          context_window: 128_000,
        },
        { slug: "gpt-reserve", visibility: "hide", supported_in_api: true },
        { slug: "codex-auto-review", visibility: "hide", supported_in_api: true },
      ],
    })
    expect(codex.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.3-codex-spark"])
    expect(codex[1]!.contextWindow).toBe(128_000)

    const catalogue = asGatewayCatalogue(grok) as {
      data: { id: string; type: string; tags: string[]; context_window: number }[]
    }
    expect(catalogue.data[0]!.context_window).toBe(500_000)
    expect(catalogue.data[0]!.type).toBe("language")
    expect(catalogue.data[0]!.tags).toContain("tool-use")
  })

  it("asks Codex for its catalogue with the client version it insists on", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        codex: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: "acct_1",
          account: "someone@example.com",
        },
      }),
    )

    const asked: string[] = []
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      asked.push(url)
      if (url.startsWith("https://registry.npmjs.org/")) {
        return Response.json({ version: "0.153.4" })
      }
      if (!new URL(url).searchParams.get("client_version")) {
        return Response.json(
          { error: { message: "[{'loc': ('query', 'client_version')}]" } },
          { status: 400 },
        )
      }
      return Response.json({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6-Astra",
            visibility: "list",
            supported_in_api: true,
            context_window: 272_000,
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      })
    }) as unknown as typeof fetch

    const models = await listProviderModels("codex", stub)
    expect(models).toEqual([
      {
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        contextWindow: 272_000,
        maxTokens: undefined,
        efforts: ["high"],
        defaultEffort: undefined,
        fast: undefined,
        vision: false,
        search: false,
      },
    ])
    expect(asked[0]).toContain("registry.npmjs.org/@openai/codex/latest")
    expect(asked[1]).toContain("client_version=0.153.4")

    expect(asked[1]).toContain("chatgpt.com/backend-api/codex/models")
  })

  it("names a subscription session while its answer is still coming, at the lowest effort", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        codex: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: "acct",
          account: "someone@example.com",
        },
      }),
    )
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    setState((current) => ({
      ...current,
      apiKey: null,
      models: [
        {
          id: "gpt-6-astra",
          name: "GPT-6-Astra",
          provider: "codex",
          efforts: ["low", "medium", "high", "xhigh"],
          vision: false,
        },
      ],
    }))
    updateSession(session.id, (current) => ({
      ...current,
      model: "gpt-6-astra",
      provider: "codex",
      effort: "xhigh",
    }))

    let titles = 0
    let turns = 0
    let titleEffort: string | null = null
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (!url.endsWith("/responses")) return Response.json({ models: [] })
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        instructions?: string
        reasoning?: { effort?: string }
      }
      const naming = String(body.instructions ?? "").startsWith("You name conversations")
      if (naming) {
        titles += 1
        titleEffort = body.reasoning?.effort ?? null
        if (titles === 1) return new Response("busy", { status: 400 })
      } else {
        turns += 1
        if (turns === 2) await held
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: naming ? "Tokenizer loop fix" : "Fixed it." })}\n\n` +
          `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    const title = () => findSession(getState(), session.id)?.title
    const until = async (done: () => boolean) => {
      for (let tries = 0; tries < 200 && !done(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    try {
      await send(session.id, "fix the tokenizer loop")
      await until(() => titles === 1)
      expect(title()).toBe("fix the tokenizer loop")

      const second = send(session.id, "try again")
      await until(() => title() === "Tokenizer loop fix")
      expect(findSession(getState(), session.id)?.status).toBe("running")
      release()
      await second
    } finally {
      release()
      globalThis.fetch = realFetch
      rmSync(path.join(DIR, "providers.json"), { force: true })
    }
    expect(title()).toBe("Tokenizer loop fix")
    expect(titleEffort).toBe("low")
  })

  it("refreshes a sign-in once when two requests need it at the same moment", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "stale",
          refreshToken: "r1",
          expiresAt: Date.now() - 1_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )
    let refreshes = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      refreshes += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 })
    }) as unknown as typeof fetch

    try {
      const [first, second] = await Promise.all([credential("grok"), credential("grok")])
      expect(refreshes).toBe(1)
      expect(first?.token).toBe("fresh")
      expect(second?.token).toBe("fresh")
    } finally {
      globalThis.fetch = realFetch
      rmSync(path.join(DIR, "providers.json"), { force: true })
    }
  })

  it("shows the plan's usage from the headers of the last reply", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        codex: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: "acct",
          account: "someone@example.com",
        },
      }),
    )
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    setState((current) => ({
      ...current,
      apiKey: null,
      models: [
        {
          id: "gpt-6-astra",
          name: "GPT-6-Astra",
          provider: "codex",
          efforts: [],
          vision: false,
          contextWindow: 272_000,
        },
      ],
    }))
    updateSession(session.id, (current) => ({ ...current, model: "gpt-6-astra", provider: "codex" }))

    const resetAt = Math.floor(Date.now() / 1000) + 2 * 86_400 + 600
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String((input as Request)?.url ?? input)
      if (!url.endsWith("/responses")) return Response.json({ models: [] })
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "done." })}\n\n` +
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1_000, output_tokens: 10 } } })}\n\n` +
          "data: [DONE]\n\n",
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-codex-plan-type": "pro",
            "x-codex-primary-used-percent": "47",
            "x-codex-primary-window-minutes": "10080",
            "x-codex-primary-reset-at": String(resetAt),
            "x-codex-secondary-used-percent": "0",
            "x-codex-secondary-window-minutes": "0",
          },
        },
      )
    }) as unknown as typeof fetch
    try {
      await send(session.id, "hello")
    } finally {
      globalThis.fetch = realFetch
      rmSync(path.join(DIR, "providers.json"), { force: true })
    }

    expect(getState().limits.codex).toEqual({
      plan: "pro",
      limits: [{ label: "Weekly limit", usedPercent: 47, resetsAt: resetAt * 1000 }],
    })
    const { renderer, app } = await mount()
    await app.getByTestId("context-meter").click()
    const painted = renderer.getPaintedText().join("\n")
    expect(painted).toContain("Plan usage")
    expect(painted).toContain("Pro")
    expect(painted).toContain("47% used")
    expect(painted).toContain("Resets in 2d 0h")
    await app.close()
  })

  it("keeps one store when a hot reload evaluates the module again", async () => {
    vi.resetModules()
    const reloaded = await import("./src/store")
    expect(reloaded.getState()).toBe(getState())

    const workspace = createWorkspace(tempDir(), "demo")
    reloaded.openSession(reloaded.createSession(workspace.id).id, 0)
    expect(getState().sessions).toHaveLength(1)
  })

  it("picks an effort from the slider and restarts the agent for it", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    updateSession(session.id, (current) => ({
      ...current,
      model: "grok-4.6",
      provider: "grok",
    }))
    setState((current) => ({
      ...current,
      models: [
        {
          id: "grok-4.6",
          name: "Grok 4.6",
          provider: "grok",
          efforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "high",
        },
      ],
    }))

    const { renderer, app } = await mount(1280, 900)
    renderer.flush()

    expect(renderer.getPaintedText().join("\n")).toContain("high")
    expect(getState().sessions[0]!.effort ?? null).toBeNull()

    await app.getByTestId("effort-trigger").click()
    await settle()
    renderer.flush()
    const panel = renderer.getPaintedText().join("\n")
    expect(panel).toContain("Faster")
    expect(panel).toContain("Smarter")
    const track = await app.getByTestId("effort").bounds()

    await app.getByTestId("effort-low").click()
    await settle()
    renderer.clockFastForward(300)
    renderer.flush()
    const first = await app.getByTestId("effort-trail").bounds()
    expect(first.width).toBeGreaterThan(0)
    expect(first.width).toBeLessThan(track.width / 4)

    await app.getByTestId("effort-xhigh").click()
    await settle()
    renderer.clockFastForward(300)
    renderer.flush()
    const full = await app.getByTestId("effort-trail").bounds()
    expect(full.width).toBe(track.width)

    await app.getByTestId("effort-xhigh").click()
    await settle()
    renderer.flush()
    expect(getState().sessions[0]!.effort).toBe("xhigh")
    await app.getByTestId("effort-low").hover()
    await settle()
    expect(getState().sessions[0]!.effort).toBe("xhigh")
    await app.getByTestId("effort-medium").hover()
    await settle()
    expect(getState().sessions[0]!.effort).toBe("xhigh")

    const atLow = await app.getByTestId("effort-trigger").bounds()
    await app.getByTestId("effort-low").click()
    await settle()
    renderer.flush()
    const atXhigh = await app.getByTestId("effort-trigger").bounds()
    expect(atXhigh.width).toBe(atLow.width)

    await app.close()
  })

  it("runs a subscription session with no Gateway key", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    setState((current) => ({ ...current, apiKey: null, useCli: false }))
    updateSession(session.id, (current) => ({
      ...current,
      model: "gpt-6-astra",
      provider: "codex",
    }))

    await send(session.id, "explain this codebase")

    const notices = messagesOf(session.id)
      .filter((message) => message.kind === "notice")
      .map((message) => (message.kind === "notice" ? message.text : ""))
    expect(notices.some((text) => text.includes("credential"))).toBe(false)
    expect(notices.some((text) => text.includes("API key"))).toBe(false)
    expect(getState().settingsOpen).toBe(false)
  })

  it("tells Grok which client it is, or Grok refuses the turn", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )

    let sent: Headers | null = null
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (url === "https://x.ai/cli/stable") return new Response("1.0.25")
      sent = new Headers(init?.headers ?? {})
      return new Response('data: {"type":"response.completed","response":{}}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }) as unknown as typeof fetch

    await providerFetch(stub, { provider: "grok" })(
      "https://ai-gateway.vercel.sh/v3/ai/language-model",
      {
        method: "POST",
        headers: { "ai-language-model-id": "xai/grok-4.6" },
        body: JSON.stringify({ prompt: [] }),
      },
    )

    const headers = sent as Headers | null
    expect(headers?.get("x-grok-client-version")).toBe("1.0.25")
    expect(headers?.get("x-grok-client-identifier")).toBe("fx")
  })

  it("reads which models search on their own side", () => {
    const grok = parseCatalogue("grok", {
      data: [
        { model: "grok-4.6", api_backend: "responses", supports_backend_search: true },
        { model: "grok-4.5", api_backend: "responses" },
      ],
    })
    const codex = parseCatalogue("codex", {
      models: [
        { slug: "gpt-6-astra", visibility: "list", supports_search_tool: true },
        { slug: "gpt-plain", visibility: "list" },
      ],
    })
    expect(grok.map((model) => model.search)).toEqual([true, false])
    expect(codex.map((model) => model.search)).toEqual([true, false])

    const prompt = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    expect(toResponsesRequest(prompt, "grok-4.6", { search: true }).tools).toEqual([
      { type: "web_search" },
    ])
    expect(toResponsesRequest(prompt, "grok-4.6", {}).tools).toBeUndefined()
  })

  it("shows a provider-run search as a row and never hands it to the core", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        grok: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: null,
          account: "someone@example.com",
        },
      }),
    )

    const frames = [
      {
        type: "response.output_item.added",
        item: { id: "ws_1", type: "web_search_call", status: "in_progress" },
      },
      { type: "response.web_search_call.searching", item_id: "ws_1" },
      {
        type: "response.output_item.done",
        item: {
          id: "ws_1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "bun latest release",
            sources: [{ type: "url", url: "https://bun.sh" }],
          },
        },
      },
      {
        type: "response.output_item.added",
        item: {
          id: "ctc_1",
          call_id: "xs_call-1",
          type: "custom_tool_call",
          name: "x_keyword_search",
          input: "",
          status: "in_progress",
        },
      },
      { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", delta: '{"query"' },
      {
        type: "response.output_item.done",
        item: {
          id: "ctc_1",
          call_id: "xs_call-1",
          type: "custom_tool_call",
          name: "x_keyword_search",
          input: '{"query":"from:xai","limit":"1","mode":"Latest"}',
          status: "completed",
        },
      },
      { type: "response.output_text.delta", delta: "1.4.2" },
      { type: "response.completed", response: { usage: {} } },
    ]

    let body: string | null = null
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (url === "https://x.ai/cli/stable") return new Response("1.0.25")
      body = String(init?.body)
      return new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    const steps: SearchStep[] = []
    const answer = await providerFetch(stub, {
      provider: "grok",
      search: true,
      onSearch: (step) => steps.push(step),
    })("https://ai-gateway.vercel.sh/v3/ai/language-model", {
      method: "POST",
      headers: { "ai-language-model-id": "xai/grok-4.6" },
      body: JSON.stringify({ prompt: [] }),
    })
    const stream = await answer.text()

    const sent = JSON.parse((body as string | null) ?? "{}") as { tools?: unknown[] }
    expect(sent.tools).toEqual([{ type: "web_search" }, { type: "x_search" }])
    expect(steps.map((step) => [step.done, step.action, step.label])).toEqual([
      [false, "search", ""],
      [true, "search", "bun latest release"],
      [false, "x_search", ""],
      [true, "x_search", "from:xai"],
    ])
    expect(steps[1]!.sources).toEqual(["https://bun.sh"])
    expect(stream).not.toContain("tool-call")
    expect(stream).toContain('"unified":"stop"')
    expect(stream).toContain("1.4.2")
  })

  it("opens one row per provider search and completes it in place", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    const rows = searchRows(session.id)

    rows({ id: "ws_1", done: false, action: "search", label: "", sources: [] })
    const running = messagesOf(session.id).at(-1)
    expect(running?.kind === "tool" && running.name).toBe("web_search")
    expect(running?.kind === "tool" && running.state).toBe("running")

    rows({
      id: "ws_1",
      done: true,
      action: "search",
      label: "bun latest",
      sources: ["https://bun.sh"],
    })
    const rowCount = messagesOf(session.id).filter((message) => message.kind === "tool").length
    const done = messagesOf(session.id).at(-1)
    expect(rowCount).toBe(1)
    expect(done?.kind === "tool" && done.state).toBe("ok")
    expect(done?.kind === "tool" && done.label).toBe("bun latest")
    expect(done?.kind === "tool" && done.output).toBe("https://bun.sh")

    rows({ id: "ws_2", done: false, action: "search", label: "", sources: [] })
    rows({
      id: "ws_2",
      done: true,
      action: "open_page",
      label: "https://bun.sh/blog",
      sources: [],
    })
    const opened = messagesOf(session.id).at(-1)
    expect(opened?.kind === "tool" && opened.name).toBe("web_fetch")
    expect(opened?.kind === "tool" && opened.label).toBe("https://bun.sh/blog")

    rows({ id: "ctc_1", done: false, action: "x_search", label: "", sources: [] })
    const searching = messagesOf(session.id).at(-1)
    expect(searching?.kind === "tool" && searching.name).toBe("x_search")
    expect(searching?.kind === "tool" && searching.label).toBe("X")
    rows({ id: "ctc_1", done: true, action: "x_search", label: "from:xai", sources: [] })
    const searched = messagesOf(session.id).at(-1)
    expect(searched?.kind === "tool" && searched.label).toBe("from:xai")
  })

  it("asks Grok to search X as well as the web, and Codex only the web", () => {
    const sent = (provider: "grok" | "codex") =>
      toResponsesRequest({ prompt: [] }, "model", { provider, search: true }).tools
    expect(sent("grok")).toEqual([{ type: "web_search" }, { type: "x_search" }])
    expect(sent("codex")).toEqual([{ type: "web_search" }])
  })

  it("searches on the provider only for a model whose catalogue offers it", () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    setState((current) => ({
      ...current,
      models: [
        { id: "grok-4.6", name: "Grok 4.6", provider: "grok", search: true },
        { id: "grok-4.5", name: "Grok 4.5", provider: "grok", search: false },
      ],
    }))
    const asked = () => nativeSearch(getState(), findSession(getState(), session.id))

    updateSession(session.id, (current) => ({
      ...current,
      provider: "grok",
      model: "grok-4.6",
    }))
    expect(asked()).toBe(true)

    updateSession(session.id, (current) => ({ ...current, model: "grok-4.5" }))
    expect(asked()).toBe(false)

    updateSession(session.id, (current) => ({
      ...current,
      provider: null,
      model: "grok-4.6",
    }))
    expect(asked()).toBe(false)
  })

  it("drops the host web_search when the provider runs its own", () => {
    const names = (search: boolean) =>
      createTools({ sessionId: "s", root: tempDir(), search }).map((tool) => tool.name)
    expect(names(false)).toContain("web_search")
    expect(names(true)).not.toContain("web_search")
    expect(names(true)).toContain("web_fetch")
  })

  it("reads an image on the session's subscription, not the Gateway", async () => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(
      path.join(DIR, "providers.json"),
      JSON.stringify({
        codex: {
          accessToken: "tok",
          refreshToken: "r",
          expiresAt: Date.now() + 3_600_000,
          accountId: "acct",
          account: "someone@example.com",
        },
      }),
    )
    const { root, session, tools } = seed("full-access")
    writeFileSync(path.join(root, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"))
    setState((current) => ({
      ...current,
      apiKey: null,
      models: [
        { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex", efforts: [], vision: true },
      ],
    }))
    updateSession(session.id, (current) => ({
      ...current,
      model: "gpt-6-astra",
      provider: "codex",
    }))

    let asked: { url: string; body: Record<string, unknown> } | null = null
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked = {
        url: String((input as Request)?.url ?? input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "a red square" })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    try {
      const answer = await run(tools.vision, { path: "shot.png", question: "what is this?" })
      expect(String(answer)).toContain("a red square")
    } finally {
      globalThis.fetch = realFetch
    }

    const sent = asked as { url: string; body: Record<string, unknown> } | null
    expect(sent?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    const content = (sent?.body.input as Record<string, unknown>[])[0]!.content as Record<
      string,
      unknown
    >[]
    expect(content[1]!.type).toBe("input_image")
    expect(String(content[1]!.image_url)).toMatch(/^data:image\/png;base64,/)
  })

  it("lets a subagent run on the session's subscription", async () => {
    const { session, tools } = seed("full-access")
    setState((current) => ({ ...current, apiKey: null }))
    updateSession(session.id, (current) => ({
      ...current,
      model: "gpt-6-astra",
      provider: "codex",
    }))

    const answer = await run(tools.subagent, { task: "survey the repo" }).catch(
      (error: unknown) => String(error),
    )
    expect(String(answer)).not.toMatch(/credential|Gateway API key/)
  })

  it("offers the provider's own fast tier, and only where it exists", () => {
    const models = parseCatalogue("codex", {
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          service_tiers: [
            { id: "priority", name: "Fast", description: "2x speed, increased usage" },
          ],
        },
        { slug: "gpt-5.3-codex-spark", visibility: "list", service_tiers: [] },
      ],
    })
    expect(models[0]!.fast).toEqual({ label: "Fast", detail: "2x speed, increased usage" })
    expect(models[1]!.fast).toBeUndefined()
  })

  it("asks for the priority tier only when fast is on", () => {
    const prompt = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    expect(toResponsesRequest(prompt, "gpt-6-astra", { fast: true }).service_tier).toBe("priority")
    expect(toResponsesRequest(prompt, "gpt-6-astra", { fast: false }).service_tier).toBeUndefined()
  })

  it("sends the chosen reasoning effort, and nothing when there is none", () => {
    const prompt = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    expect(toResponsesRequest(prompt, "grok-4.6", { effort: "xhigh" }).reasoning).toEqual({
      effort: "xhigh",
    })
    expect(toResponsesRequest(prompt, "grok-4.6", {}).reasoning).toBeUndefined()
  })

  it("orders efforts as the providers rank them, not alphabetically", () => {
    const codex = parseCatalogue("codex", {
      models: [
        {
          slug: "m",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "xhigh" },
            { effort: "low" },
            { effort: "ultra" },
            { effort: "medium" },
          ],
          default_reasoning_level: "medium",
        },
      ],
    })
    expect(codex[0]!.efforts).toEqual(["low", "medium", "xhigh", "ultra"])
    expect(codex[0]!.defaultEffort).toBe("medium")
  })

  it("keeps the vendor prefix out of the provider's model name", () => {
    expect(bareModel("xai/grok-4.6")).toBe("grok-4.6")
    expect(bareModel("openai/gpt-5.1-codex")).toBe("gpt-5.1-codex")
    expect(bareModel("grok-4.6")).toBe("grok-4.6")
  })

  it("spots an fx binary too old to route a subscription", () => {
    expect(outdatedForProviders("0.0.6")).toBe(true)
    expect(outdatedForProviders("v0.0.6")).toBe(true)
    expect(outdatedForProviders(MIN_ACP_PROVIDER_VERSION)).toBe(false)
    expect(outdatedForProviders("0.0.9")).toBe(false)
    expect(outdatedForProviders("0.1.0")).toBe(false)
    expect(outdatedForProviders("1.0.0")).toBe(false)
    expect(outdatedForProviders(null)).toBe(false)
  })

  it("runs a session with no model of its own on the default", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)

    const { renderer, app } = await mount()

    expect(getState().sessions[0]?.model).toBeNull()
    expect(renderer.getPaintedText().join("\n")).toContain(DEFAULT_MODEL.name)

    await app.close()
  })

  it("shows a Gateway model's id but never a subscription's routing key", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setState((current) => ({
      ...current,
      models: [
        { id: "grok-4.6", name: "Grok 4.6 · Grok", provider: "grok" },
        { id: "openai/gpt-4o", name: "GPT-4o" },
      ],
    }))

    const { renderer, app } = await mount(1100, 700)
    await app.getByTestId("model-picker").click()
    await settle()
    renderer.flush()

    const painted = renderer.getPaintedText().join("\n")
    expect(painted).toContain("Grok 4.6 · Grok")
    expect(painted).not.toContain("grok:grok-4.6")
    expect(painted).toContain("openai/gpt-4o")

    await app.close()
  })

  it("scrolls the model list instead of squashing it", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setState((current) => ({
      ...current,
      models: Array.from({ length: 40 }, (_, index) => ({
        id: `vendor/model-${index}`,
        name: `Model ${index}`,
      })),
    }))

    const { app } = await mount(1100, 700)
    await app.getByTestId("model-picker").click()
    await settle()

    const first = await app.getByTestId("model-vendor/model-0").bounds()
    const second = await app.getByTestId("model-vendor/model-1").bounds()
    expect(first.height).toBe(28)
    expect(second.y - first.y).toBe(28)

    expect(await app.getByTestId("model-vendor/model-30").count()).toBe(1)

    await app.close()
  })

  it("names the credential a turn would actually use", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { renderer, app } = await mount()

    if (!process.env.AI_GATEWAY_API_KEY) {
      expect(renderer.getPaintedText().join("\n")).toContain("No models")
      setState((current) => ({ ...current, apiKey: "vck_x" }))
      await settle()
      renderer.flush()
      expect(renderer.getPaintedText().join("\n")).toContain("AI Gateway")
    }

    setState((current) => ({
      ...current,
      accounts: [{ provider: "grok", account: "someone@example.com" }],
    }))
    await settle()
    renderer.flush()
    expect(renderer.getPaintedText().join("\n")).toContain("Grok")

    await app.close()
  })

  it("grows the composer when the draft wraps, keeping the first line off the top edge", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { renderer, app } = await mount(900, 500)

    await app.getByTestId("composer").fill("short")
    const oneRow = await app.getByTestId("composer").bounds()
    const oneRowCard = await app.getByTestId("composer-column").bounds()

    await app.getByTestId("composer").fill(`${"wrap ".repeat(60)}TAILWORD`)
    renderer.flush()
    const wrapped = await app.getByTestId("composer").bounds()
    const wrappedCard = await app.getByTestId("composer-column").bounds()

    expect(wrapped.height).toBeGreaterThan(oneRow.height * 2)
    expect(renderer.getPaintedText().join(" ")).toContain("TAILWORD")
    const shift = wrapped.y - wrappedCard.y - (oneRow.y - oneRowCard.y)
    expect(Math.abs(shift)).toBeLessThanOrEqual(2)

    await app.close()
  })

  it("keeps the composer and its footer inside a narrow split pane", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const long = "GPT-5.6-Luna Extended Preview · Codex"
    setState((current) => ({
      ...current,
      models: [
        {
          id: "openai/gpt-5.6-luna",
          name: long,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          fast: { label: "Fast", detail: "1.5x speed" },
          contextWindow: 400_000,
        },
      ],
    }))
    const first = createSession(workspace.id)
    openSession(first.id, 0)
    setSplit(true)
    const second = createSession(workspace.id)
    openSession(second.id, 1)
    for (const session of [first, second]) {
      updateSession(session.id, (current) => ({
        ...current,
        model: "openai/gpt-5.6-luna",
        modelName: long,
        context: { ...current.context, used: 39_524 },
      }))
    }

    const { renderer, app } = await mount(1100, 800)

    expect(renderer.getPaintedText().join("\n")).not.toContain(
      "every edit and command asks",
    )

    for (const index of [0, 1]) {
      const paneLocator = app.getByTestId(`pane-${index}`)
      const pane = await paneLocator.bounds()
      const column = await paneLocator.getByTestId("composer-column").bounds()
      expect(column.width, `pane ${index} column`).toBeLessThanOrEqual(pane.width)
      expect(column.x + column.width, `pane ${index} right edge`).toBeLessThanOrEqual(
        pane.x + pane.width,
      )
      const meter = await paneLocator.getByTestId("context-meter").bounds()
      expect(meter.x + meter.width, `pane ${index} footer`).toBeLessThanOrEqual(
        column.x + column.width + COMPOSER_CARD_INSET,
      )
    }

    await app.close()
  })

  it("measures the context on the last request, not as a running total", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    setState((current) => ({
      ...current,
      apiKey: "gateway-key",
      models: [{ ...DEFAULT_MODEL, contextWindow: 1_000_000 }],
    }))

    const answers = [
      [
        { type: "tool-call", toolCallId: "c1", toolName: "list_files", input: {} },
        {
          type: "finish",
          finishReason: { unified: "tool-calls" },
          usage: { inputTokens: { total: 9_000 }, outputTokens: { total: 400 } },
        },
      ],
      [
        { type: "text-delta", delta: "one file." },
        {
          type: "finish",
          finishReason: { unified: "stop" },
          usage: { inputTokens: { total: 22_000 }, outputTokens: { total: 800 } },
        },
      ],
    ]
    let requests = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (!url.includes("/language-model")) return Response.json({ object: "list", data: [] })
      if (isNaming(init)) return new Response("{}", { status: 400 })
      const events = answers[Math.min(requests, answers.length - 1)]!
      requests += 1
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    try {
      await send(session.id, "what is in here")
    } finally {
      globalThis.fetch = realFetch
    }

    const context = findSession(getState(), session.id)!.context
    expect(context.used).toBe(22_800)
    expect(context.system).toBeGreaterThan(0)
    expect(context.tools).toBeGreaterThan(0)
    expect(context.mcp).toBe(0)

    const { renderer, app } = await mount()
    expect(renderer.getPaintedText().join("\n")).not.toMatch(/\d tokens/)

    await app.getByTestId("context-meter").click()
    const painted = renderer.getPaintedText().join("\n")
    expect(painted).toContain("22.8K / 1M (2%)")
    expect(painted).toContain("Messages")
    expect(painted).toContain("Free space")
    expect(painted).not.toContain("MCP tools")

    await app.close()
  })

  it("centres the pane header on the traffic lights without padding below it", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { app } = await mount()

    const header = await app.getByTestId("pane-header-0").bounds()
    expect(Math.abs(header.y + header.height / 2 - TITLEBAR_CENTER)).toBeLessThanOrEqual(1)

    const band = await app.getByTestId("pane-band-0").bounds()
    expect(band.height).toBeLessThan(TITLEBAR_CENTER * 2)

    await app.close()
  })

  it("opens the token picker without moving the transcript", async () => {
    const root = tempDir()
    writeFileSync(path.join(root, "store.ts"), "export const store = 1\n")
    const workspace = createWorkspace(root, path.basename(root))
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    toolRow(session.id, "anchor", "BODY")

    const { app } = await mount()
    const before = await app.getByTestId("tool-anchor").bounds()

    await app.getByTestId("composer").fill("@sto")
    await app.getByTestId("mention-picker").waitFor()

    const after = await app.getByTestId("tool-anchor").bounds()
    expect(after.y).toBe(before.y)

    await app.close()
  })

  it("splits into two panes and back", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { renderer, app } = await mount()

    await app.getByTestId("toggle-split").click()
    await app.getByTestId("pane-1").waitFor()
    expect(renderer.getPaintedText()).toContain("No session open")

    await app.getByTestId("close-split").click()
    expect(await app.getByTestId("pane-1").count()).toBe(0)

    await app.close()
  })

  it("completes an @ mention from the workspace into the draft", async () => {
    const root = tempDir()
    mkdirSync(path.join(root, "src"), { recursive: true })
    writeFileSync(path.join(root, "src", "composer.tsx"), "export const composer = 1\n")
    writeFileSync(path.join(root, "src", "store.ts"), "export const store = 1\n")

    const workspace = createWorkspace(root, path.basename(root))
    openSession(createSession(workspace.id).id, 0)

    const { app, renderer } = await mount()
    await app.getByTestId("composer").waitFor()

    expect(await app.getByTestId("mention-picker").count()).toBe(0)

    await app.getByTestId("composer").fill("look at @comp")
    await app.getByTestId("mention-src/composer.tsx").waitFor()
    expect(await app.getByTestId("mention-picker").textContent()).toBe("src/composer.tsx")

    await app.getByTestId("mention-src/composer.tsx").click()

    expect(renderer.getPaintedText().join("\n")).toContain("look at @src/composer.tsx")
    expect(await app.getByTestId("mention-picker").count()).toBe(0)

    await app.close()
  })

  it("opens the same picker from the attach menu", async () => {
    const root = tempDir()
    writeFileSync(path.join(root, "notes.md"), "# notes\n")
    const workspace = createWorkspace(root, path.basename(root))
    openSession(createSession(workspace.id).id, 0)

    const { app, renderer } = await mount()
    await app.getByTestId("composer").waitFor()

    await app.getByTestId("attach-file").click()
    if (CAN_PICK_IMAGES) await app.getByTestId("attach-mention").click()

    await app.getByTestId("mention-notes.md").waitFor()
    expect(renderer.getPaintedText().join("\n")).toContain("@")

    await app.close()
  })

  it.skipIf(!CAN_PICK_IMAGES)("compiles the scripts it hands to osascript", () => {
    for (const [language, script] of [
      ["AppleScript", CHOOSE_IMAGES],
      ["JavaScript", READ_PASTEBOARD],
    ] as const) {
      execFileSync("osacompile", [
        "-l",
        language,
        "-o",
        path.join(tempDir(), "check.scpt"),
        "-e",
        script,
      ])
    }
  })

  it("lets ⌘V through a text field when there is no text to paste", async () => {
    const pressed: string[] = []
    const { render, renderer } = createTestRoot({ width: 400, height: 200 })
    render(
      <textarea
        testId="field"
        value=""
        autoFocus
        onKeyDown={(event: { key?: string; modifiers?: { cmd?: boolean } }) => {
          if (event.modifiers?.cmd) pressed.push(event.key ?? "")
        }}
      />,
    )
    const app = await connectTest(renderer)
    await app.getByTestId("field").press("cmd-v")
    expect(pressed).toEqual(["v"])
    await app.close()
  })

  it("resizes the split by dragging the divider without covering the window", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setSplit(true)
    openSession(createSession(workspace.id).id, 1)
    const { renderer, app } = await mount(1024, 700)
    const { width } = renderer.getWindowSize()

    const divider = await app.getByTestId("split-divider").bounds()
    const x = divider.x + divider.width / 2
    const y = divider.y + divider.height / 2

    renderer.nativeSimulateMouseMove(x, y)
    renderer.nativeSimulateMouseDown(x, y, 0)
    renderer.nativeSimulateMouseMove(x - 200, y, 0)
    expect(renderer.findByType("anchored")).toEqual([])
    renderer.nativeSimulateMouseMove(x - 150, y + 200, 0)
    expect(getState().splitRatio).toBeCloseTo((x - 150 - SIDEBAR_WIDTH) / (width - SIDEBAR_WIDTH), 2)

    renderer.nativeSimulateMouseUp(x - 150, y + 200, 0)
    const settled = getState().splitRatio
    renderer.nativeSimulateMouseMove(x + 100, y, 0)
    expect(getState().splitRatio).toBe(settled)

    await app.close()
  })

  it("keeps working in a session you switch away from", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const first = createSession(workspace.id)
    const second = createSession(workspace.id)
    openSession(first.id, 0)
    setState((current) => ({ ...current, apiKey: "gateway-key" }))

    let release = () => {}
    const answered = new Promise<void>((resolve) => (release = resolve))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String((input as Request)?.url ?? input)
      if (!url.includes("/language-model")) return Response.json({ object: "list", data: [] })
      await answered
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", delta: "done in the background." })}\n\ndata: ${JSON.stringify({ type: "finish", finishReason: { unified: "stop" } })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    const { app } = await mount()
    try {
      const turn = send(first.id, "a long task")
      openSession(second.id, 0)
      await app.getByTestId("composer").waitFor()
      expect(getState().panes[0]?.sessionId).toBe(second.id)
      expect(findSession(getState(), first.id)?.status).toBe("running")
      release()
      await turn
    } finally {
      globalThis.fetch = realFetch
    }

    const answer = messagesOf(first.id).find((message) => message.kind === "assistant")
    expect(answer?.kind === "assistant" && answer.text).toContain("done in the background.")
    expect(findSession(getState(), first.id)?.status).toBe("idle")
    await app.close()
  })

  it("marks a session that is waiting on you in the sidebar", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    appendMessage(session.id, {
      id: "ask-1",
      kind: "approval",
      at: Date.now(),
      approvalId: "ask-1",
      toolName: "shell",
      title: "Run a command",
      detail: "ls",
      scope: "shell",
      decision: "pending",
    })

    const { renderer, app } = await mount()
    await app.getByTestId(`waiting-${session.id}`).waitFor()

    updateSession(session.id, (current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.kind === "approval" ? { ...message, decision: "allowed" as const } : message,
      ),
    }))
    const marker = app.getByTestId(`waiting-${session.id}`)
    for (let tries = 0; tries < 50 && (await marker.count()) > 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      renderer.flush()
    }
    expect(await marker.count()).toBe(0)
    await app.close()
  })

  it("attaches an image, shows it, and sends it for the vision tool to read", async () => {
    const root = tempDir()
    const workspace = createWorkspace(root, "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)

    const elsewhere = tempDir()
    const picture = path.join(elsewhere, "shot.png")
    writeFileSync(picture, Buffer.from(ONE_PIXEL_PNG, "base64"))
    writeFileSync(path.join(elsewhere, "notes.txt"), "not an image")

    attachImages(session.id, [picture, path.join(elsewhere, "notes.txt")])
    const [kept] = getState().attachments[session.id] ?? []
    expect(path.dirname(kept!)).toBe(ATTACHMENT_DIR)
    expect(
      messagesOf(session.id).some(
        (message) => message.kind === "notice" && message.text.includes("notes.txt"),
      ),
    ).toBe(true)

    const { app } = await mount()
    await app.getByTestId("attachment-0").waitFor()
    await app.getByTestId("attachment-0-remove").click()
    expect(getState().attachments[session.id]).toEqual([])
    await app.close()

    setState((current) => ({ ...current, apiKey: "gateway-key" }))
    const prompts: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String((input as Request)?.url ?? input)
      if (url.includes("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "one grey pixel" } }] })
      }
      if (!url.includes("/language-model")) return Response.json({ object: "list", data: [] })
      if (isNaming(init)) return new Response("{}", { status: 400 })
      prompts.push(
        typeof init?.body === "string"
          ? init.body
          : Buffer.from(init?.body as never).toString("utf8"),
      )
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", delta: "seen." })}\n\ndata: ${JSON.stringify({ type: "finish", finishReason: { unified: "stop" } })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }) as unknown as typeof fetch

    try {
      await send(session.id, "", [kept!])
      const vision = createTools({ sessionId: session.id, root, search: false }).find(
        (tool) => tool.name === "vision",
      )!
      expect(await run(vision, { path: kept })).toContain("one grey pixel")
      await expect(run(vision, { path: picture })).rejects.toThrow(/outside the workspace/)
    } finally {
      globalThis.fetch = realFetch
    }

    expect(prompts[0]).toContain(`The user attached the image ${kept}`)
    const user = messagesOf(session.id).find((message) => message.kind === "user")
    expect(user?.kind === "user" ? user.images : undefined).toEqual([kept])

    const { app: reopened } = await mount()
    await reopened.getByTestId(`message-image-${user!.id}-0`).waitFor()
    await reopened.close()
  })

  it.each([700, 860, 990, 1100, 1280])(
    "keeps the composer inside its pane in a %ipx split",
    async (windowWidth) => {
      const workspace = createWorkspace(tempDir(), "demo")
      for (const pane of [0, 1]) {
        const session = createSession(workspace.id)
        updateSession(session.id, (current) => ({
          ...current,
          model: "openai/gpt-5.6-luna-preview",
          modelName: "OpenAI GPT-5.6 Luna Preview",
          mode: "full-access" as const,
        }))
        if (pane === 1) setSplit(true)
        openSession(session.id, pane)
      }

      const { app } = await mount(windowWidth, 700)
      await app.getByTestId("pane-0").waitFor()

      const panes = (await app.getByTestId("pane-1").count()) > 0 ? [0, 1] : [0]

      for (const index of panes) {
        const pane = await app.getByTestId(`pane-${index}`).bounds()
        const card = (await app.getByTestId("composer-column").all())[index]!.bounds!
        const send = (await app.getByTestId("send").all())[index]!.bounds!

        expect(card.x, `pane ${index} card left`).toBeGreaterThanOrEqual(pane.x)
        expect(
          send.x + send.width,
          `pane ${index} send right`,
        ).toBeLessThanOrEqual(pane.x + pane.width)
      }

      await app.close()
    },
  )

  it("opens a new session into the focused pane of a split", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setSplit(true)

    const { app } = await mount(760, 700)
    await app.getByTestId("pane-1").waitFor()

    setState((current) => ({ ...current, focusedPane: 1 }))
    const created = createSession(workspace.id)
    openSession(created.id, 1)

    expect(getState().panes[1]?.sessionId).toBe(created.id)
    await app.getByTestId("pane-1").getByTestId("composer").waitFor()

    await app.close()
  })

  it("folds the sidebar rather than squeezing panes", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    setSplit(true)
    openSession(createSession(workspace.id).id, 1)

    {
      const { app } = await mount(1400, 700)
      await app.getByTestId("pane-1").waitFor()
      const pane = await app.getByTestId("pane-0").bounds()
      expect(pane.x, "sidebar holds its column").toBe(SIDEBAR_WIDTH)
      await app.close()
    }

    {
      const { app } = await mount(640, 700)
      await app.getByTestId("pane-0").waitFor()
      const pane = await app.getByTestId("pane-0").bounds()
      expect(pane.x, "sidebar folded").toBe(0)
      expect(await app.getByTestId("pane-1").count()).toBe(1)
      expect(getState().sidebarCollapsed).toBe(false)
      await app.close()
    }
  })

  it("centres the transcript and the composer on one column", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    const session = createSession(workspace.id)
    openSession(session.id, 0)
    toolRow(session.id, "row", "body")
    setState((current) => ({ ...current, sidebarCollapsed: true }))

    const { app } = await mount(1024, 700)

    const row = await app.getByTestId("tool-row").bounds()
    const composer = await app.getByTestId("composer-column").bounds()
    const pane = await app.getByTestId("pane-0").bounds()

    expect(pane.width).toBeGreaterThan(CONTENT_WIDTH)
    expect(row.x).toBe(composer.x - COMPOSER_CARD_INSET)
    expect(row.x).toBe(pane.x + Math.round((pane.width - CONTENT_WIDTH) / 2))

    await app.close()
  })

  it("opens the command palette and runs a command from it", async () => {
    const workspace = createWorkspace(tempDir(), "demo")
    openSession(createSession(workspace.id).id, 0)
    const { renderer, app } = await mount()

    await app.getByTestId("open-palette").click()
    await app.getByTestId("palette").waitFor()
    expect(renderer.getPaintedText()).toContain("New session")

    await app.getByTestId("command-toggle-split").click()
    expect(getState().panes).toHaveLength(2)
    expect(getState().paletteOpen).toBe(false)

    await app.close()
  })
})
