import { readFileSync } from "node:fs"
import path from "node:path"

import { describeImage } from "../agent/providers"
import { findSession, getState, sessionModel } from "../store"
import { requestApproval } from "./approvals"
import {
  DENIED_PREFIX,
  defineTool,
  field,
  optionalNumber,
  requireString,
  type HostTool,
  type ToolContext,
} from "./kit"
import { display, isAttachment, resolveInside } from "./paths"

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1"

const SEARCH_MODEL = "openai/gpt-5-mini"
const VISION_MODEL = "openai/gpt-5-mini"

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
export const MAX_IMAGE_BYTES = 8_000_000

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function vision(context: ToolContext): HostTool {
  return defineTool<{ path: string; question: string }>(
    {
      name: "vision",
      description:
        "Look at an image in the workspace, or one the user attached, and answer a question about it, such as a screenshot of a failing UI or a photo of a whiteboard.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Image file relative to the workspace root, or the full path of an image the user attached.",
          },
          question: {
            type: "string",
            description: "What to look for. Defaults to describing the image.",
          },
        },
        required: ["path"],
      },
      parse: (input) => {
        const question = field(input, "question")
        return {
          path: requireString(input, "path"),
          question:
            typeof question === "string" && question
              ? question
              : "Describe this image in detail.",
        }
      },
      label: (input) => `${input.path} · ${input.question}`,
      run: async (input, ctx) => {
        const target = isAttachment(input.path)
          ? path.resolve(input.path)
          : resolveInside(ctx.root, input.path)
        const shown = isAttachment(target) ? "attached image" : display(ctx.root, target)
        const mime = IMAGE_TYPES[path.extname(target).toLowerCase()]
        if (!mime) {
          throw new Error(
            `${input.path} is not an image this can read. Supported: ${Object.keys(IMAGE_TYPES).join(", ")}.`,
          )
        }
        const bytes = readFileSync(target)
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(`${input.path} is too large to send.`)
        }

        const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`
        const state = getState()
        const session = findSession(state, ctx.sessionId)
        const seeing = sessionModel(state, session)

        if (session?.provider && seeing?.vision) {
          return {
            text: await describeImage(
              session.provider,
              session.model ?? seeing.id,
              input.question,
              dataUrl,
              ctx.signal,
            ),
            label: `${shown} · ${input.question}`,
          }
        }

        const apiKey = state.apiKey
        if (!apiKey) {
          throw new Error(
            session?.provider
              ? `${seeing?.name ?? "This model"} does not take images, so reading one needs an AI Gateway key.`
              : "Reading an image goes through the AI Gateway, which needs its own key.",
          )
        }

        const response = await fetch(`${GATEWAY_URL}/chat/completions`, {
          method: "POST",
          signal: ctx.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: VISION_MODEL,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: input.question },
                  {
                    type: "image_url",
                    image_url: { url: dataUrl },
                  },
                ],
              },
            ],
          }),
        })
        if (!response.ok) {
          throw new Error(`Reading the image failed: ${response.status} ${await response.text()}`)
        }
        const body = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const answer = body.choices?.[0]?.message?.content
        if (typeof answer !== "string" || !answer.trim()) {
          throw new Error("The vision model returned nothing.")
        }
        return { text: answer, label: `${shown} · read` }
      },
    },
    context,
  )
}

function webSearch(context: ToolContext): HostTool {
  return defineTool<{ query: string; results: number }>(
    {
      name: "web_search",
      description:
        "Search the web and return an answer grounded in current sources. Use it for anything outside the workspace or newer than your training data; use web_fetch when you already have a URL.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          results: {
            type: "number",
            description: "How many sources to search. 1 to 10, defaults to 5.",
          },
        },
        required: ["query"],
      },
      parse: (input) => ({
        query: requireString(input, "query"),
        results: Math.min(10, Math.max(1, Math.floor(optionalNumber(input, "results") ?? 5))),
      }),
      label: (input) => input.query,
      run: async (input, ctx) => {
        const { apiKey } = getState()
        if (!apiKey) {
          throw new Error(
            "Web search runs Exa inside the AI Gateway, which needs its own key. A subscription cannot serve it.",
          )
        }

        const approved = await requestApproval({
          sessionId: ctx.sessionId,
          toolName: "web_search",
          title: "Search the web",
          detail: input.query,
          scope: "web:search",
          routine: false,
        })
        if (!approved) throw new Error(`${DENIED_PREFIX}: the search was not run.`)

        const response = await fetch(`${GATEWAY_URL}/chat/completions`, {
          method: "POST",
          signal: ctx.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [
              {
                role: "user",
                content: `${input.query}\n\nAnswer from the search results and list the source URLs you used.`,
              },
            ],
            tools: [
              {
                type: "vercel:exa_search",
                config: { query: input.query, num_results: input.results },
              },
            ],
            tool_choice: "required",
          }),
        })
        if (!response.ok) {
          throw new Error(`The search failed: ${response.status} ${await response.text()}`)
        }
        const body = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const answer = body.choices?.[0]?.message?.content
        if (typeof answer !== "string" || !answer.trim()) {
          throw new Error("The search returned nothing.")
        }
        return { text: answer, label: `${input.query} · ${input.results} sources` }
      },
    },
    context,
  )
}

function webFetch(context: ToolContext): HostTool {
  return defineTool<{ url: string }>(
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return its text. HTML is reduced to readable text; JSON and plain text come back as they are.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "An http or https URL." },
        },
        required: ["url"],
      },
      parse: (input) => ({ url: requireString(input, "url") }),
      label: (input) => input.url,
      run: async (input, ctx) => {
        const url = new URL(input.url)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("Only http and https URLs can be fetched.")
        }
        const approved = await requestApproval({
          sessionId: ctx.sessionId,
          toolName: "web_fetch",
          title: `Fetch ${url.host}`,
          detail: url.toString(),
          scope: `web:${url.host}`,
          routine: false,
        })
        if (!approved) throw new Error(`${DENIED_PREFIX}: ${url.host} was not fetched.`)

        const response = await fetch(url, {
          signal: ctx.signal,
          headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" },
        })
        if (!response.ok) {
          throw new Error(`${url.host} returned ${response.status} ${response.statusText}.`)
        }
        const body = await response.text()
        const type = response.headers.get("content-type") ?? ""
        const text = type.includes("html") ? htmlToText(body) : body
        return { text, label: `${url.host} · ${text.length.toLocaleString()} chars` }
      },
    },
    context,
  )
}

export function webTools(context: ToolContext): HostTool[] {
  return [
    vision(context),
    ...(context.search ? [] : [webSearch(context)]),
    webFetch(context),
  ]
}
