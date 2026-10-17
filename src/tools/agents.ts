import { createFxEngine, type FxEngine, type FxNodeEngineOptions } from "libfx/node"

import { backing } from "../agent/backing"
import {
  usableModel,
  findSession,
  forgetChildNotes,
  getState,
  patchMessage,
  pushChildNote,
  sessionModel,
  setLiveSubagent,
  takeChildNote,
  type AppState,
  type Model,
  type Session,
  type SubagentStep,
} from "../store"
import { askUserQuestion } from "./approvals"
import {
  DENIED_PREFIX,
  MAX_OUTPUT_CHARS,
  defineTool,
  field,
  optionalNumber,
  optionalString,
  readRetained,
  requireString,
  searchRows,
  type HostTool,
  type ToolContext,
} from "./kit"

const MAX_SUBAGENT_DEPTH = 1

function usableModels(state: AppState): Model[] {
  return state.models.filter((model) => usableModel(state, model.id, model.provider ?? null))
}

function exactModel(model: Model, want: string): boolean {
  const needle = want.toLowerCase()
  return model.id.toLowerCase() === needle || model.name.toLowerCase() === needle
}

function looseModel(model: Model, want: string): boolean {
  const needle = want.toLowerCase()
  const id = model.id.toLowerCase()
  return id.replace(/^[a-z0-9-]+\//, "") === needle || id.endsWith(`/${needle}`)
}

export function matchSubagentModel(state: AppState, want: string): Model {
  const needle = want.trim()
  if (!needle) throw new Error("Give a model id or name from this session's picker.")
  const usable = usableModels(state)
  // An exact id or name wins, so a subscription's "grok-4.6" is not shadowed by
  // the Gateway's "xai/grok-4.6"; a bare or suffix match is the fallback.
  const exact = usable.filter((model) => exactModel(model, needle))
  const matches = exact.length > 0 ? exact : usable.filter((model) => looseModel(model, needle))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(`Several models match ${needle}. Use a full id from the picker.`)
  }
  const listed = usable
    .slice(0, 8)
    .map((model) => model.name)
    .join(", ")
  throw new Error(
    `No model named ${needle} is available here.${listed ? ` Available: ${listed}.` : ""}`,
  )
}

export function childSessionFor(
  parent: Session,
  options: { model?: string; effort?: string } = {},
): Session {
  const state = getState()
  let next: Session = { ...parent, fast: false }
  let spec = sessionModel(state, next)

  if (options.model) {
    const want = options.model.trim()
    const inherited =
      (parent.model && parent.model.toLowerCase() === want.toLowerCase()) ||
      (parent.modelName && parent.modelName.toLowerCase() === want.toLowerCase())
    if (!inherited) {
      spec = matchSubagentModel(state, want)
      next = {
        ...next,
        model: spec.id,
        modelName: spec.name,
        provider: spec.provider ?? null,
      }
    }
  }

  spec = sessionModel(state, next) ?? spec
  if (options.effort) {
    const allowed = spec?.efforts ?? []
    if (allowed.length > 0 && !allowed.includes(options.effort)) {
      throw new Error(
        `${spec?.name ?? "This model"} does not take effort ${options.effort}. Use ${allowed.join(", ")}.`,
      )
    }
    next = { ...next, effort: options.effort }
  } else if (spec?.efforts?.length) {
    const current = next.effort
    if (!current || !spec.efforts.includes(current)) {
      next = {
        ...next,
        effort: spec.defaultEffort ?? spec.efforts[Math.floor(spec.efforts.length / 2)] ?? null,
      }
    }
  } else if (spec && (!spec.efforts || spec.efforts.length === 0)) {
    next = { ...next, effort: null }
  }

  return next
}

const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export type SubagentCall = {
  action: "run" | "message"
  name?: string
  task: string
  instructions?: string
  model?: string
  effort?: string
}

export function parseSubagentInput(input: unknown): SubagentCall {
  const actionRaw = optionalString(input, "action")
  if (actionRaw && actionRaw !== "run" && actionRaw !== "message") {
    throw new Error('action must be "run" or "message".')
  }
  const name = optionalString(input, "agent") || undefined
  const message = optionalString(input, "message") || undefined
  const task = optionalString(input, "task") || undefined
  const instructions = optionalString(input, "instructions") || undefined
  const model = optionalString(input, "model") || undefined
  const effort = optionalString(input, "effort") || undefined
  const action: "run" | "message" =
    actionRaw === "message" || (!actionRaw && name) ? "message" : "run"

  if (action === "message") {
    if (!name || !AGENT_NAME.test(name)) {
      throw new Error("A named child needs a name of letters, digits, _ and -.")
    }
    const body = message || task
    if (!body) throw new Error("Say what to send this child.")
    return { action, name, task: body, instructions, model, effort }
  }

  const body = task || message
  if (!body) throw new Error("Say what the subagent should do.")
  return { action: "run", task: body, instructions, model, effort }
}

type NamedChild = {
  sessionId: string
  name: string
  agent: FxEngine
  child: Session
  instructions?: string
  busy: boolean
  messageId: string
  steps: Map<string, SubagentStep>
}

const namedChildren = new Map<string, NamedChild>()

type AgentOpener = (options: FxNodeEngineOptions) => Promise<FxEngine>

let openAgent: AgentOpener = createFxEngine

export function setSubagentOpener(opener: AgentOpener | null): void {
  openAgent = opener ?? createFxEngine
}

export function resetNamedSubagents(): void {
  for (const child of namedChildren.values()) {
    void child.agent.close().catch(() => {})
  }
  namedChildren.clear()
  openAgent = createFxEngine
}

function childKey(sessionId: string, name: string): string {
  return `${sessionId}:${name}`
}

export function liveNamedSubagent(sessionId: string): string | null {
  for (const child of namedChildren.values()) {
    if (child.sessionId === sessionId && child.busy) return child.name
  }
  return null
}

export function enqueueChildNote(sessionId: string, text: string): boolean {
  const name = liveNamedSubagent(sessionId)
  if (!name) return false
  pushChildNote(sessionId, name, text)
  return true
}

export async function closeNamedSubagents(sessionId: string): Promise<void> {
  const matching = [...namedChildren.entries()].filter(
    ([, child]) => child.sessionId === sessionId,
  )
  for (const [key, child] of matching) {
    namedChildren.delete(key)
    await child.agent.close().catch(() => {})
  }
  forgetChildNotes(sessionId)
}

function childInstructions(root: string, extra?: string): string {
  return [
    "You are a subagent working inside one workspace directory.",
    `Workspace root: ${root}`,
    "",
    "You cannot see the conversation that delegated this task, and nobody",
    "reads your intermediate steps. Do the work, then answer with the",
    "findings themselves: file paths, line numbers, what you concluded.",
    "Do not describe what you did.",
    ...(extra ? ["", extra] : []),
  ].join("\n")
}

async function collectTurn(
  agent: FxEngine,
  prompt: string,
  signal: AbortSignal,
): Promise<{ text: string; stopReason: string }> {
  const turn = agent.prompt(prompt, { signal })
  let answer = ""
  for await (const event of turn) {
    if (event.type === "text_delta") answer += event.delta
  }
  const result = await turn.result
  return { text: answer, stopReason: result.stopReason }
}

function labelled(
  input: SubagentCall,
  child: Session,
  status: string,
): string {
  const chosen =
    input.model || input.effort
      ? [child.modelName ?? child.model, child.effort].filter(Boolean)
      : []
  return [input.name, input.task, ...chosen, status].filter(Boolean).join(" · ")
}

function asAnswer(
  input: SubagentCall,
  child: Session,
  collected: { text: string; stopReason: string },
): { text: string; label: string } {
  if (!collected.text.trim()) {
    return {
      text: `The subagent finished with no answer (${collected.stopReason}).`,
      label: labelled(input, child, collected.stopReason),
    }
  }
  return { text: collected.text, label: labelled(input, child, "done") }
}

/** Each named child holds a native libfx runtime until its session closes, and
 *  libfx refuses new runtimes past its own limit, so a session keeps only a few. */
const MAX_NAMED_CHILDREN = 4

async function namedChildFor(
  ctx: ToolContext & { messageId: string },
  input: SubagentCall,
  makeTools: (context: ToolContext) => HostTool[],
): Promise<{ handle: NamedChild; fresh: boolean }> {
  const name = input.name!
  const key = childKey(ctx.sessionId, name)
  const existing = namedChildren.get(key)
  if (existing) {
    // Re-inserting keeps the map ordered from least to most recently used.
    namedChildren.delete(key)
    namedChildren.set(key, existing)
    existing.messageId = ctx.messageId
    existing.steps.clear()
    return { handle: existing, fresh: false }
  }

  const own = [...namedChildren.entries()].filter(([, child]) => child.sessionId === ctx.sessionId)
  if (own.length >= MAX_NAMED_CHILDREN) {
    const oldest = own.find(([, child]) => !child.busy)
    if (oldest) {
      namedChildren.delete(oldest[0])
      await oldest[1].agent.close().catch(() => {})
    }
  }

  const prepared = openChild(ctx, input)
  const handle: NamedChild = {
    sessionId: ctx.sessionId,
    name,
    agent: null as unknown as FxEngine,
    child: prepared.child,
    instructions: input.instructions,
    busy: false,
    messageId: ctx.messageId,
    steps: new Map(),
  }
  handle.agent = await openAgent({
    ...prepared.back.options,
    instructions: childInstructions(ctx.root, input.instructions),
    tools: makeTools({
      ...ctx,
      depth: (ctx.depth ?? 0) + 1,
      search: prepared.back.search,
      onStep: (step) => {
        handle.steps.set(step.id, step)
        patchMessage(handle.sessionId, handle.messageId, { steps: [...handle.steps.values()] })
      },
    }),
  })
  namedChildren.set(key, handle)
  return { handle, fresh: true }
}

function openChild(
  ctx: ToolContext,
  input: SubagentCall,
): { child: Session; back: NonNullable<ReturnType<typeof backing>> } {
  const parent = findSession(getState(), ctx.sessionId)
  if (!parent) {
    throw new Error("A subagent runs on the same credential as this session, and it has none.")
  }
  const child = childSessionFor(parent, { model: input.model, effort: input.effort })
  const back = backing(child, searchRows(ctx.sessionId))
  if (!back) {
    throw new Error("A subagent runs on the same credential as this session, and it has none.")
  }
  return { child, back }
}

function followUpPrompt(handle: NamedChild, input: SubagentCall): string {
  if (input.instructions && input.instructions !== handle.instructions) {
    handle.instructions = input.instructions
    return `Updated instructions:\n${input.instructions}\n\n${input.task}`
  }
  return input.task
}

export function agentTools(
  context: ToolContext,
  makeTools: (context: ToolContext) => HostTool[],
): HostTool[] {
  return [
    defineTool<{ handle: string; offset: number; limit: number; query?: string }>(
      {
        name: "read_tool_result",
        description:
          "Read more of a large tool result that was returned as a preview and a handle. Give a query to search it, or an offset and limit to read a range.",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle from the preview." },
            query: {
              type: "string",
              description: "Literal text to find. Returns the matching lines.",
            },
            offset: { type: "number", description: "Character to start at. Defaults to 0." },
            limit: {
              type: "number",
              description: "How many characters to read. Defaults to 8000.",
            },
          },
          required: ["handle"],
        },
        parse: (input) => ({
          handle: requireString(input, "handle"),
          offset: Math.max(0, Math.floor(optionalNumber(input, "offset") ?? 0)),
          limit: Math.min(
            MAX_OUTPUT_CHARS,
            Math.max(1, Math.floor(optionalNumber(input, "limit") ?? 8_000)),
          ),
          query: optionalString(input, "query") || undefined,
        }),
        label: (input) => (input.query ? `search ${input.query}` : `read ${input.offset}`),
        run: async (input, ctx) => {
          const entry = readRetained(input.handle)
          if (!entry || !input.handle.startsWith(`${ctx.sessionId}:`)) {
            throw new Error(
              "That handle is not a retained result of this session. Copy it exactly from the preview.",
            )
          }

          if (input.query) {
            const hits = entry.text
              .split("\n")
              .filter((line) => line.includes(input.query!))
            return {
              text: hits.length > 0 ? hits.join("\n") : `No line contains ${input.query}.`,
              label: `${entry.tool} · ${hits.length} matching lines`,
            }
          }

          const slice = entry.text.slice(input.offset, input.offset + input.limit)
          const remaining = entry.text.length - (input.offset + slice.length)
          return {
            text:
              remaining > 0
                ? `${slice}\n… ${remaining.toLocaleString()} more characters after this range`
                : slice,
            label: `${entry.tool} · ${input.offset}..${input.offset + slice.length}`,
          }
        },
      },
      context,
    ),

    ...((context.depth ?? 0) >= MAX_SUBAGENT_DEPTH
      ? []
      : [
          defineTool<SubagentCall>(
            {
              name: "subagent",
              description:
                "Delegate work to a second agent with the same workspace tools, and get back only its final answer. Use it for work whose intermediate steps you do not need, like a wide search or a survey of many files. Pass task for a one-off child that is discarded after it answers. Pass action \"message\" with agent and message to create or continue a named child that keeps its conversation. You may set model and effort so the child uses a different one than this conversation, for example a faster model to implement after you have planned.",
              inputSchema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    description: '"run" for a one-off child, or "message" to create or continue a named child. Omit with task for a one-off.',
                  },
                  task: {
                    type: "string",
                    description: "What the subagent should do. State it completely: it cannot see this conversation.",
                  },
                  agent: {
                    type: "string",
                    description: "Name for a child that should keep its conversation. Letters, digits, _ and -.",
                  },
                  message: {
                    type: "string",
                    description: "What to send a named child. On action message this is the body; task is accepted too.",
                  },
                  instructions: {
                    type: "string",
                    description: "Extra direction on how to work or what to report. On a named child, a later call replaces the extra instructions.",
                  },
                  model: {
                    type: "string",
                    description:
                      "Optional model id or name from this session's picker. Omit to use the same model as this conversation.",
                  },
                  effort: {
                    type: "string",
                    description:
                      "Optional reasoning effort for that model. Omit to inherit, or to use that model's default when it does not support the parent's effort.",
                  },
                },
              },
              parse: parseSubagentInput,
              label: (input) =>
                input.name || input.model || input.effort
                  ? [input.name, input.task, input.model, input.effort, "running"]
                      .filter(Boolean)
                      .join(" · ")
                  : input.task,
              run: async (input, ctx) => {
                const steps = new Map<string, SubagentStep>()
                const publishSteps = () =>
                  patchMessage(ctx.sessionId, ctx.messageId, { steps: [...steps.values()] })
                const nestedTools = (search: boolean) =>
                  makeTools({
                    ...ctx,
                    depth: (ctx.depth ?? 0) + 1,
                    search,
                    onStep: (step) => {
                      steps.set(step.id, step)
                      publishSteps()
                    },
                  })

                if (input.action === "run") {
                  const prepared = openChild(ctx, input)
                  const agent = await openAgent({
                    ...prepared.back.options,
                    instructions: childInstructions(ctx.root, input.instructions),
                    tools: nestedTools(prepared.back.search),
                  })
                  try {
                    return asAnswer(
                      input,
                      prepared.child,
                      await collectTurn(agent, input.task, ctx.signal),
                    )
                  } finally {
                    await agent.close()
                  }
                }

                const { handle, fresh } = await namedChildFor(ctx, input, makeTools)
                handle.busy = true
                setLiveSubagent(ctx.sessionId, handle.name)
                try {
                  const parts: string[] = []
                  const first = await collectTurn(
                    handle.agent,
                    followUpPrompt(handle, input),
                    ctx.signal,
                  )
                  parts.push(asAnswer(input, handle.child, first).text)
                  while (!ctx.signal.aborted) {
                    const note = takeChildNote(ctx.sessionId, handle.name)
                    if (!note) break
                    const next = await collectTurn(handle.agent, note, ctx.signal)
                    parts.push(asAnswer(input, handle.child, next).text)
                  }
                  if (ctx.signal.aborted) {
                    throw new Error("Stopped.")
                  }
                  const last = parts.at(-1) ?? ""
                  const answer = parts.length > 1 ? parts.join("\n\n") : last
                  // Named children live only in memory, so after a restart or an
                  // eviction the same name is a stranger; the parent must know.
                  return {
                    text: fresh
                      ? `This is a new child named ${handle.name}; it remembers nothing from earlier messages.\n\n${answer}`
                      : answer,
                    label: labelled(input, handle.child, "done"),
                  }
                } finally {
                  handle.busy = false
                  setLiveSubagent(ctx.sessionId, null)
                  forgetChildNotes(ctx.sessionId)
                }
              },
            },
            context,
          ),
        ]),

    defineTool<{ question: string; options: string[] }>(
      {
        name: "ask_user_question",
        description:
          "Ask the user a question and wait for their answer. Use it when the choice is theirs to make, such as which of two approaches to take or which file they meant. Do not use it to confirm work you can do yourself.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, in one sentence." },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Answers to offer as buttons. Omit for a free-text answer.",
            },
          },
          required: ["question"],
        },
        parse: (input) => {
          const options = field(input, "options")
          return {
            question: requireString(input, "question"),
            options: Array.isArray(options)
              ? options.filter((option): option is string => typeof option === "string" && !!option)
              : [],
          }
        },
        label: (input) => input.question,
        run: async (input, ctx) => {
          const answer = await askUserQuestion(ctx.sessionId, input.question, input.options)
          if (answer === null) {
            throw new Error(`${DENIED_PREFIX}: the question was dismissed.`)
          }
          return { text: answer, label: `${input.question} → ${answer}` }
        },
      },
      context,
    ),
  ]
}
