import { restartAgents } from "./agent"
import {
  fxStatus,
  fxVersion,
  openLogin,
  outdatedForProviders,
  FX_BINARY,
  MIN_ACP_PROVIDER_VERSION,
} from "./cli"
import { PROVIDERS, signedIn, signOut, storedSession, type ProviderId } from "./oauth"
import { listProviderModels } from "./providers"
import { GATEWAY_URL } from "../tools"
import {
  apiKeySource,
  appendMessage,
  getState,
  newId,
  setState,
  type Model,
} from "../store"

function tell(text: string, tone: "info" | "error" = "info"): void {
  const state = getState()
  const focused = state.panes[state.focusedPane]?.sessionId ?? null
  if (!focused) return
  appendMessage(focused, { id: newId(), kind: "notice", at: Date.now(), tone, text })
}

export async function signInWithFx(): Promise<void> {
  tell(await openLogin())
}

export function signOutOfProvider(provider: ProviderId): void {
  signOut(provider)
  void refreshCredentials()
}

export async function withProviderModels(catalogue: Model[]): Promise<Model[]> {
  const gateway = catalogue.filter((model) => !model.provider)
  const lists = await Promise.all(
    signedIn().map(async (provider) => {
      try {
        const models = await listProviderModels(provider)
        return models.map((model) => ({
          id: model.id,
          name: `${model.name} · ${PROVIDERS[provider].label}`,
          provider,
          efforts: model.efforts,
          defaultEffort: model.defaultEffort,
          fast: model.fast,
          contextWindow: model.contextWindow,
          vision: model.vision,
          search: model.search,
        }))
      } catch (error) {
        tell(error instanceof Error ? error.message : String(error), "error")
        return []
      }
    }),
  )
  return [...lists.flat(), ...gateway]
}

export async function refreshCredentials(): Promise<void> {
  const accounts = signedIn().map((provider) => ({
    provider,
    account: storedSession(provider)?.account ?? null,
  }))
  setState((current) => ({ ...current, accounts }))
  const models = await withProviderModels(getState().models)
  setState((current) => ({ ...current, models }))
}

export async function setUseCli(useCli: boolean): Promise<void> {
  await restartAgents()
  setState((current) => ({ ...current, useCli }))
  if (!useCli) {
    tell("Running in this process, on the AI Gateway key.")
    return
  }
  const version = await fxVersion()
  if (!version) {
    tell(await fxStatus(), "error")
    return
  }
  tell(`Running through fx ${version} · ${await fxStatus()}`)
  if (outdatedForProviders(version)) {
    tell(
      `fx ${version} sends ACP sessions to the Gateway whatever you signed in to, so a` +
        ` subscription answers with a 401. Run \`${FX_BINARY} upgrade\` for` +
        ` ${MIN_ACP_PROVIDER_VERSION} or newer.`,
      "error",
    )
  }
}


const CATALOGUE_URL = `${GATEWAY_URL}/models`

type CatalogueEntry = { id?: unknown; name?: unknown; type?: unknown; context_window?: unknown }

let gatewayLoaded = false

export async function loadModels(): Promise<void> {
  const state = getState()
  if (gatewayLoaded) return
  if (apiKeySource(state) === "none") return
  gatewayLoaded = true
  try {
    const response = await fetch(CATALOGUE_URL)
    if (!response.ok) throw new Error(`the catalogue returned ${response.status}`)
    const body = (await response.json()) as { data?: CatalogueEntry[] }
    const models = (body.data ?? [])
      .filter((entry) => entry.type === "language" && typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id as string,
        name: typeof entry.name === "string" && entry.name ? entry.name : (entry.id as string),
        contextWindow:
          typeof entry.context_window === "number" ? entry.context_window : undefined,
      }))
    if (models.length > 0) {
      setState((current) => ({
        ...current,
        models: [...current.models.filter((model) => model.provider), ...models],
      }))
    }
  } catch (error) {
    gatewayLoaded = false
    console.error("[fx] could not list models:", error)
  }
}
