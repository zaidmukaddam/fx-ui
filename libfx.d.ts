declare module "libfx" {
  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue }

  export type PromptBlock =
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; text?: string } }

  export type PromptInput = string | PromptBlock[]

  export type StopReason =
    | "end_turn"
    | "max_output_tokens"
    | "max_model_turns"
    | "refused"
    | "cancelled"

  export interface Usage {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }

  export interface TurnResult {
    stopReason: StopReason
    usage: Usage
  }

  export type TurnEvent =
    | { type: "text_delta"; delta: string }
    | { type: "reasoning_delta"; delta: string }
    | { type: "tool_start"; id: string; name: string }
    | {
        type: "tool_end"
        id: string
        name: string
        content?: string
        isError: boolean
      }

  export interface Turn extends AsyncIterable<TurnEvent> {
    result: Promise<TurnResult>
    cancel(): void
  }

  export interface HostTool {
    name: string
    description: string
    inputSchema: Record<string, JsonValue>
    execute(
      input: unknown,
      context: { signal: AbortSignal },
    ): JsonValue | undefined | Promise<JsonValue | undefined>
  }

  export interface DiagnosticEvent {
    type: string
    [key: string]: unknown
  }

  export type RuntimeFactory = (options: {
    args?: string[]
    env?: Record<string, string | undefined>
  }) => Promise<unknown>

  export interface AgentOptions {
    apiKey: string
    model?: string
    instructions?: string | string[]
    tools?: HostTool[]
    checkpoint?: ArrayBuffer | ArrayBufferView
    fetch?: typeof globalThis.fetch
    onEvent?: (event: DiagnosticEvent) => void
    backend?: "auto" | "native" | "wasm"
    runtimeFactory?: RuntimeFactory
  }

  export interface Agent {
    prompt(input: PromptInput, options?: { signal?: AbortSignal }): Turn
    checkpoint(): Promise<Uint8Array>
    close(): Promise<void>
  }

  export function createFxAgent(options: AgentOptions): Promise<Agent>

  export function listModels(options: {
    apiKey: string
    fetch?: typeof globalThis.fetch
  }): Promise<string[]>

  export function supportsJspi(): boolean
}

declare module "libfx/skills" {
  import type { HostTool } from "libfx"

  export interface SkillRecord {
    name: string
    description?: string
    instructions: string
    resources?: Array<{ uri: string; text: string }>
    tools?: HostTool[]
  }

  export interface SkillsAdapter {
    instructions: string
    tools: HostTool[]
  }

  export function createSkillsAdapter(records: SkillRecord[]): SkillsAdapter
}

declare module "libfx/skills/node" {
  import type { HostTool } from "libfx"
  import type { SkillRecord } from "libfx/skills"

  export interface LoadSkillOptions {
    readFile?: (path: string, encoding: "utf8") => string | Promise<string>
    resources?: Array<{ uri: string; text: string }>
    tools?: HostTool[]
  }

  export function loadSkillFile(
    path: string,
    options?: LoadSkillOptions,
  ): Promise<SkillRecord>

  export { createSkillsAdapter } from "libfx/skills"
}

declare module "libfx/mcp" {
  import type { HostTool } from "libfx"

  export interface McpClient {
    listTools(params?: unknown): Promise<unknown>
    callTool(params: unknown, resultSchema?: unknown, options?: unknown): Promise<unknown>
    readResource?(params: { uri: string }): Promise<unknown>
    getPrompt?(params: {
      name: string
      arguments?: Record<string, string>
    }): Promise<unknown>
    close?(): Promise<void>
  }

  export interface McpOptions {
    prefix?: string
    resources?: string[]
    prompts?: Array<string | { name: string; arguments?: Record<string, string> }>
  }

  export interface McpAdapter {
    tools: HostTool[]
    instructions: string
    close(): Promise<void>
  }

  export function createMcpAdapter(
    client: McpClient,
    options?: McpOptions,
  ): Promise<McpAdapter>
}
