// Translate a Kiro (CodeWhisperer) event stream into the Gateway SSE the fx-ui
// core parses. Depends only on the wire-format parser, so it is testable
// offline. The core reads: text-delta, tool-input-start/delta/end, tool-call
// and finish (see src/agent/responses.ts).

import { parseKiroStream } from "./kiro-stream"
import type { Json } from "./responses"

function frame(value: Json): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

export function kiroEventsToGatewaySse(
  body: ReadableStream<Uint8Array>,
  onUsage?: (tokens: number) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (text: string) => controller.enqueue(encoder.encode(text))
      let calls = 0
      try {
        for await (const event of parseKiroStream(body)) {
          if (event.type === "content") {
            if (!event.text) continue
            emit(frame({ type: "text-delta", delta: event.text }))
          } else if (event.type === "tool-call") {
            calls += 1
            emit(frame({ type: "tool-input-start", id: event.id, toolName: event.name }))
            if (event.arguments && event.arguments !== "{}") {
              emit(frame({ type: "tool-input-delta", id: event.id, delta: event.arguments }))
            }
            emit(frame({ type: "tool-input-end", id: event.id }))
            let input: unknown = {}
            try {
              input = JSON.parse(event.arguments || "{}")
            } catch {
              input = {}
            }
            emit(frame({ type: "tool-call", toolCallId: event.id, toolName: event.name, input }))
          }
          // Kiro reports subscription credits / context percentage, not exact
          // tokens; the core reads token usage per request, so leave it unset.
        }
        emit(frame({ type: "finish", finishReason: { unified: calls > 0 ? "tool-calls" : "stop" } }))
        emit("data: [DONE]\n\n")
        controller.close()
        onUsage?.(0)
      } catch (error) {
        emit(
          frame({
            type: "error",
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        )
        emit(frame({ type: "finish", finishReason: { unified: "error" } }))
        emit("data: [DONE]\n\n")
        controller.close()
      }
    },
  })
}
