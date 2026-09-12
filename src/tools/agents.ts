import { createFxAgent, type Agent } from "libfx"

import { backing } from "../agent/backing"
import { findSession, getState, patchMessage, type SubagentStep } from "../store"
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
          defineTool<{ task: string; instructions?: string }>(
            {
              name: "subagent",
              description:
                "Delegate a self-contained task to a second agent with the same workspace tools, and get back only its final answer. Use it for work whose intermediate steps you do not need, like a wide search or a survey of many files, so their output does not fill this conversation.",
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
                },
                required: ["task"],
              },
              parse: (input) => ({
                task: requireString(input, "task"),
                instructions: optionalString(input, "instructions") || undefined,
              }),
              label: (input) => input.task,
              run: async (input, ctx) => {
                const back = backing(
                  findSession(getState(), ctx.sessionId),
                  searchRows(ctx.sessionId),
                )
                if (!back) {
                  throw new Error(
                    "A subagent runs on the same credential as this session, and it has none.",
                  )
                }

                const steps = new Map<string, SubagentStep>()
                const publishSteps = () =>
                  patchMessage(ctx.sessionId, ctx.messageId, { steps: [...steps.values()] })

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
                    onStep: (step) => {
                      steps.set(step.id, step)
                      publishSteps()
                    },
                  }),
                })) as Agent

                try {
                  const turn = agent.prompt(input.task, { signal: ctx.signal })
                  let answer = ""
                  for await (const event of turn) {
                    if (event.type === "text_delta") answer += event.delta
                  }
                  const result = await turn.result
                  if (!answer.trim()) {
                    return {
                      text: `The subagent finished with no answer (${result.stopReason}).`,
                      label: `${input.task} · ${result.stopReason}`,
                    }
                  }
                  return { text: answer, label: `${input.task} · done` }
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
