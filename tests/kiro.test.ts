// Protocol tests for the Kiro subscription port. These need no network: they
// exercise the wire translation both ways (Gateway prompt -> Kiro
// conversationState, and Kiro event stream -> Gateway SSE) plus credential
// refresh. The live end-to-end path (real Kiro credentials + runtime) is
// exercised by running the app itself.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { buildKiroPayload } from "../src/agent/kiro-payload"
import { KiroEventParser, parseKiroStream } from "../src/agent/kiro-stream"
import { kiroEventsToGatewaySse } from "../src/agent/kiro-sse"
import { KiroAuthManager } from "../src/agent/kiro-auth"
import { runtimeModelId } from "../src/agent/kiro-model-id"
import { describeImageKiro } from "../src/agent/kiro-runtime"

async function sseFrames(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  return buffer
    .split("\n\n")
    .map((frame) => frame.replace(/^data:\s*/, "").trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

describe("kiro subscription port", () => {
  it("maps system, tools, calls and tool results into conversationState", () => {
    const payload = buildKiroPayload(
      {
        prompt: [
          { role: "system", content: "Be precise." },
          { role: "user", content: [{ type: "text", text: "Open a.txt" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a.txt" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "read",
                output: { type: "text", value: "hello" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      "claude-sonnet-4.5",
      "arn:aws:codewhisperer:us-east-1:1:profile/test",
    ) as Record<string, any>

    expect(payload.profileArn).toBe("arn:aws:codewhisperer:us-east-1:1:profile/test")
    const state = payload.conversationState
    expect(state.history[0].userInputMessage.content).toBe("Be precise.\n\nOpen a.txt")
    expect(state.history[1].assistantResponseMessage.toolUses).toEqual([
      { name: "read", input: { path: "a.txt" }, toolUseId: "call-1" },
    ])
    const context = state.currentMessage.userInputMessage.userInputMessageContext
    expect(context.toolResults).toEqual([
      { content: [{ text: "hello" }], status: "success", toolUseId: "call-1" },
    ])
    // additionalProperties / $schema / empty-required are stripped.
    expect(context.tools[0].toolSpecification.inputSchema.json).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })
  })

  it("forces strict user/assistant alternation", () => {
    const payload = buildKiroPayload(
      {
        prompt: [
          { role: "assistant", content: "leading assistant" },
          { role: "user", content: "then user" },
        ],
      },
      "auto",
      "",
    ) as Record<string, any>
    const state = payload.conversationState
    expect(state.history[0].userInputMessage.content).toBe("(empty placeholder)")
    expect(state.history[1].assistantResponseMessage.content).toBe("leading assistant")
    expect(state.currentMessage.userInputMessage.content).toBe("then user")
  })

  it("handles split JSON and assembles tool fragments", () => {
    const parser = new KiroEventParser()
    const encoder = new TextEncoder()
    expect(parser.feed(encoder.encode('\u0000noise{"content":"hel'))).toEqual([])
    expect(
      parser.feed(
        encoder.encode('lo"}\u0001{"name":"read","toolUseId":"c1","input":{}}{"input":"{\\"path\\":"}'),
      ),
    ).toEqual([{ type: "content", text: "hello" }])
    parser.feed(encoder.encode('{"input":"\\"a.txt\\"}"}{"stop":true}'))
    expect(parser.finish()).toEqual([
      { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.txt"}' },
    ])
  })

  it("parses a stream to content then a deduplicated tool call", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"content":"working"}{"name":"read","toolUseId":"c1","input":{}}'))
        controller.enqueue(encoder.encode('{"input":"{\\"path\\":\\"a.txt\\"}"}{"stop":true}'))
        controller.close()
      },
    })
    const events = []
    for await (const event of parseKiroStream(body)) events.push(event)
    expect(events).toEqual([
      { type: "content", text: "working" },
      { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.txt"}' },
    ])
  })

  it("translates Kiro events into Gateway SSE frames", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"content":"hi"}{"name":"read","toolUseId":"c1","input":{}}'))
        controller.enqueue(encoder.encode('{"input":"{\\"path\\":\\"a.txt\\"}"}{"stop":true}'))
        controller.close()
      },
    })
    const frames = await sseFrames(kiroEventsToGatewaySse(body))
    expect(frames.map((f) => f.type)).toEqual([
      "text-delta",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ])
    expect(frames[0].delta).toBe("hi")
    expect(frames[4]).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "a.txt" },
    })
    expect(frames.at(-1)).toEqual({ type: "finish", finishReason: { unified: "tool-calls" } })
  })

  it("maps auto-kiro and dotted claude ids to runtime ids", () => {
    expect(runtimeModelId("auto-kiro")).toBe("auto")
    expect(runtimeModelId("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
    expect(runtimeModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
  })

  it("loads the image request region and profile before sending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-ui-kiro-image-"))
    const file = join(dir, "kiro-auth-token.json")
    const profileArn = "arn:aws:codewhisperer:eu-central-1:1:profile/test"
    writeFileSync(file, JSON.stringify({
      accessToken: "image-token",
      expiresAt: "2099-01-01T00:00:00Z",
      region: "eu-central-1",
      profileArn,
    }))
    const auth = new KiroAuthManager({ credentialsFile: file, writeBack: false })
    let request: { url: string; init?: RequestInit } | undefined
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init }
      return new Response('{"content":"An image."}')
    }) as typeof fetch
    const signal = new AbortController().signal

    expect(await describeImageKiro(auth, "auto-kiro", "Describe", "image/png", "aW1hZ2U=", signal, base))
      .toBe("An image.")
    expect(request?.url).toBe("https://runtime.eu-central-1.kiro.dev/generateAssistantResponse")
    expect(JSON.parse(String(request?.init?.body)).profileArn).toBe(profileArn)
    expect(request?.init?.signal).toBe(signal)
  })

  it("refreshes desktop credentials and writes the rotated token back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-ui-kiro-auth-"))
    const file = join(dir, "kiro-auth-token.json")
    writeFileSync(
      file,
      JSON.stringify({ refreshToken: "refresh-old", region: "us-east-1", expiresAt: "2000-01-01T00:00:00Z" }),
      { mode: 0o600 },
    )
    let request: { url: unknown; init: any } | undefined
    const auth = new KiroAuthManager({
      credentialsFile: file,
      fetch: (async (url: string, init: RequestInit) => {
        request = { url, init }
        return new Response(
          JSON.stringify({ accessToken: "access-new", refreshToken: "refresh-new", expiresIn: 3600, profileArn: "arn:test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch,
    })
    expect(await auth.getAccessToken()).toBe("access-new")
    expect(request!.url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken")
    expect(JSON.parse(request!.init.body)).toEqual({ refreshToken: "refresh-old" })
    expect(auth.profileArn).toBe("arn:test")
    expect(JSON.parse(readFileSync(file, "utf8")).refreshToken).toBe("refresh-new")
  })

  it("uses AWS SSO OIDC refresh when a client secret is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-ui-kiro-oidc-"))
    const file = join(dir, "kiro-auth-token.json")
    writeFileSync(
      file,
      JSON.stringify({
        refreshToken: "r",
        clientId: "cid",
        clientSecret: "secret",
        region: "eu-central-1",
        expiresAt: "2000-01-01T00:00:00Z",
      }),
      { mode: 0o600 },
    )
    let url: unknown
    const auth = new KiroAuthManager({
      credentialsFile: file,
      writeBack: false,
      fetch: (async (u: string) => {
        url = u
        return new Response(JSON.stringify({ accessToken: "a", expiresIn: 3600 }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await auth.getAccessToken()
    expect(url).toBe("https://oidc.eu-central-1.amazonaws.com/token")
  })
})
