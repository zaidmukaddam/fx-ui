import { createFxAgent, type Agent } from "libfx"

import { backing } from "../agent/backing"
import {
  answerable,
  findSession,
  getState,
  sessionModel,
  type AppState,
  type Model,
  type Session,
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
  return state.models.filter((model) => answerable(state, model.provider ?? null))
}

function sameModel(model: Model, want: string): boolean {
  const needle = want.trim().toLowerCase()
  if (!needle) return false
  const id = model.id.toLowerCase()
  const name = model.name.toLowerCase()
  const bare = id.replace(/^[a-z0-9-]+\//, "")
  return id === needle || name === needle || bare === needle || id.endsWith(`/${needle}`)
}

export function matchSubagentModel(state: AppState, want: string): Model {
  const needle = want.trim()
  if (!needle) throw new Error("Give a model id or name from this session's picker.")
  const usable = usableModels(state)
  const exact = usable.filter((model) => sameModel(model, needle))
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) {
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
          defineTool<{ task: string; instructions?: string; model?: string; effort?: string }>(
            {
              name: "subagent",
              description:
                "Delegate a self-contained task to a second agent with the same workspace tools, and get back only its final answer. Use it for work whose intermediate steps you do not need, like a wide search or a survey of many files, so their output does not fill this conversation. You may set model and effort so the child uses a different one than this conversation, for example a faster model to implement after you have planned.",
              inputSchema: {
                type: "object",
                properties: {
                  task: {
                    type: "string",
                    description: "What the subagent should do. State it completely: it cannot see this conversation.",
                  },
                  instructions: {
                    type: "string",
                    description: "Extra direction on how to work or what to report.",
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
                required: ["task"],
              },
              parse: (input) => ({
                task: requireString(input, "task"),
                instructions: optionalString(input, "instructions") || undefined,
                model: optionalString(input, "model") || undefined,
                effort: optionalString(input, "effort") || undefined,
              }),
              label: (input) =>
                [input.task, input.model, input.effort].filter(Boolean).join(" · "),
              run: async (input, ctx) => {
                const parent = findSession(getState(), ctx.sessionId)
                if (!parent) {
                  throw new Error(
                    "A subagent runs on the same credential as this session, and it has none.",
                  )
                }
                const child = childSessionFor(parent, { model: input.model, effort: input.effort })
                const back = backing(child, searchRows(ctx.sessionId))
                if (!back) {
                  throw new Error(
                    "A subagent runs on the same credential as this session, and it has none.",
                  )
                }

                const agent = (await createFxAgent({
                  ...back.options,
                  instructions: [
                    "You are a subagent working inside one workspace directory.",
                    `Workspace root: ${ctx.root}`,
                    "",
                    "You cannot see the conversation that delegated this task, and nobody",
                    "reads your intermediate steps. Do the work, then answer with the",
                    "findings themselves: file paths, line numbers, what you concluded.",
                    "Do not describe what you did.",
                    ...(input.instructions ? ["", input.instructions] : []),
                  ].join("\n"),
                  tools: makeTools({
                    ...ctx,
                    depth: (ctx.depth ?? 0) + 1,
                    search: back.search,
                  }),
                })) as Agent

                try {
                  const turn = agent.prompt(input.task, { signal: ctx.signal })
                  let answer = ""
                  for await (const event of turn) {
                    if (event.type === "text_delta") answer += event.delta
                  }
                  const result = await turn.result
                  const used = [child.modelName ?? child.model, child.effort].filter(Boolean).join(" · ")
                  if (!answer.trim()) {
                    return {
                      text: `The subagent finished with no answer (${result.stopReason}).`,
                      label: `${input.task} · ${result.stopReason}${used ? ` · ${used}` : ""}`,
                    }
                  }
                  return {
                    text: answer,
                    label: `${input.task} · done${used ? ` · ${used}` : ""}`,
                  }
                } finally {
                  await agent.close()
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
