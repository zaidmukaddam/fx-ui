import { cliRuntime } from "./cli"
import { providerFetch, type SearchStep } from "./providers"
import {
  DEFAULT_MODEL,
  canAnswer,
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
  }
  search: boolean
}

export function backing(
  session: Session | null,
  onSearch?: (step: SearchStep) => void,
  onUsage?: (tokens: number) => void,
): Backing | null {
  const state = getState()
  if (!session || !canAnswer(state, session)) return null

  const provider = session.provider

  const search = nativeSearch(state, session)
  const model = session.model ?? (state.useCli ? null : DEFAULT_MODEL.id)

  return {
    search,
    options: {
      apiKey: state.apiKey ?? UNUSED_KEY,
      fetch: providerFetch(globalThis.fetch, {
        provider,
        effort: session.effort,
        fast: session.fast,
        search,
        onSearch,
        onUsage,
        onLimits: provider ? (limits) => setLimits(provider, limits) : undefined,
      }),
      ...(model ? { model } : {}),
      ...(state.useCli ? { runtimeFactory: cliRuntime } : {}),
    },
  }
}
