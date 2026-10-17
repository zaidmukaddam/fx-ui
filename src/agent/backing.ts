import type { FxHooks } from "libfx/node"

import { cliRuntime } from "./cli"
import { providerFetch, type SearchStep } from "./providers"
import {
  canAnswer,
  gatewayDefault,
  getState,
  nativeSearch,
  setLimits,
  type Session,
} from "../store"

const UNUSED_KEY = "fx-unused"

export type Backing = {
  options: {
    apiKey: string
    fetch: typeof globalThis.fetch
    model?: string
    runtimeFactory?: typeof cliRuntime
    hooks?: FxHooks
  }
  search: boolean
}

export function backing(
  session: Session | null,
  onSearch?: (step: SearchStep) => void,
  onUsage?: (tokens: number) => void,
  onCompaction?: (active: boolean) => void,
): Backing | null {
  const state = getState()
  if (!session || !canAnswer(state, session)) return null

  const provider = session.provider

  const search = nativeSearch(state, session)
  const model = session.model ?? (state.useCli ? null : gatewayDefault(state).id)
  // Token Pass covers no fast variants, so a Gateway turn on that key runs at standard speed.
  const fast = session.fast && !(state.tokenPass && provider === null)

  return {
    search,
    options: {
      apiKey: state.apiKey ?? UNUSED_KEY,
      fetch: providerFetch(globalThis.fetch, {
        provider,
        effort: session.effort,
        fast,
        search,
        onSearch,
        onUsage,
        onLimits: provider ? (limits) => setLimits(provider, limits) : undefined,
      }),
      ...(model ? { model } : {}),
      ...(state.useCli ? { runtimeFactory: cliRuntime } : {}),
      ...(onCompaction ? { hooks: compactionHooks(onCompaction) } : {}),
    },
  }
}

/** libfx reports compaction as a model call whose purpose is "compaction". */
export function compactionHooks(onCompaction: (active: boolean) => void): FxHooks {
  const open = new Set<string>()
  return {
    onEvent(event) {
      if (event.type === "model.start" && event.data.purpose === "compaction") {
        open.add(`${event.executionId}:${event.data.modelCallId}`)
        onCompaction(true)
      } else if (
        event.type === "model.end" &&
        open.delete(`${event.executionId}:${event.data.modelCallId}`)
      ) {
        onCompaction(open.size > 0)
      }
    },
  }
}
