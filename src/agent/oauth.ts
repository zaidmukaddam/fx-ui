import path from "node:path"

import { dedupe, jsonStore, loopbackCallback, pkce, postForm, postJson } from "../oauth-core"
import { capture } from "../workspace/run"
import { DIR } from "../store"
import { hasKiroCredentials } from "./kiro-auth"

export type ProviderId = "grok" | "codex" | "kiro"

// "oauth" providers (Grok, Codex) sign in through a browser PKCE flow and
// speak the OpenAI Responses API. "native" providers (Kiro) reuse the
// machine's existing IDE/CLI credentials and speak their own wire format, so
// the OAuth-only fields do not apply to them. A discriminated union keeps the
// OAuth fields required where they exist and absent where they do not.

type OAuthSpec = {
  kind: "oauth"
  label: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scope: string
  ports: number[]
  callbackPath: string
  redirectHost: string
  authorizeExtras: Record<string, string>
  refresh: "form" | "json"
  corsOrigin?: string
  endpoint: string
  catalogue: string
  catalogueField: "models" | "data"
  versionedCatalogue: boolean
  modalitiesUrl: string | null
  versionUrl: string
  versionHeader: string | null
  staticHeaders: Record<string, string>
  searchTools: string[]
}

type NativeSpec = {
  kind: "native"
  label: string
  searchTools: string[]
}

type ProviderSpec = OAuthSpec | NativeSpec

/** True when a provider signs in through the browser OAuth flow. */
export function isOAuthProvider(provider: ProviderId): boolean {
  return PROVIDERS[provider].kind === "oauth"
}

/**
 * The OAuth spec for a provider known to be OAuth. Only ever called on the
 * grok/codex code paths; throws if misused, which would be a programming error.
 */
export function oauthSpec(provider: ProviderId): OAuthSpec {
  const spec = PROVIDERS[provider]
  if (spec.kind !== "oauth") throw new Error(`${provider} is not an OAuth provider`)
  return spec
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  grok: {
    kind: "oauth",
    label: "Grok",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid profile email offline_access grok-cli:access api:access",
    ports: [],
    callbackPath: "/callback",
    redirectHost: "127.0.0.1",
    authorizeExtras: { referrer: "fx" },
    refresh: "form",
    corsOrigin: "https://accounts.x.ai",
    endpoint: "https://cli-chat-proxy.grok.com/v1/responses",
    catalogue: "https://cli-chat-proxy.grok.com/v1/models",
    catalogueField: "data",
    versionedCatalogue: false,
    modalitiesUrl: "https://api.x.ai/v1/language-models",
    versionUrl: "https://x.ai/cli/stable",
    versionHeader: "x-grok-client-version",
    staticHeaders: { "x-grok-client-identifier": "fx" },
    searchTools: ["web_search", "x_search"],
  },
  codex: {
    kind: "oauth",
    label: "Codex",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    ports: [1455, 1457],
    callbackPath: "/auth/callback",
    redirectHost: "localhost",
    authorizeExtras: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "fx",
    },
    refresh: "json",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    catalogue: "https://chatgpt.com/backend-api/codex/models",
    catalogueField: "models",
    versionedCatalogue: true,
    modalitiesUrl: null,
    versionUrl: "https://registry.npmjs.org/@openai/codex/latest",
    versionHeader: null,
    staticHeaders: {},
    searchTools: ["web_search"],
  },
  kiro: {
    kind: "native",
    label: "Kiro",
    // Kiro reuses the machine's existing Kiro IDE / Kiro CLI login; it has no
    // browser OAuth flow, no Responses endpoint and no gateway catalogue here.
    // Its credentials, model list and wire format live in ./kiro-auth.ts and
    // the kiro branch of the provider fetch shim in ./providers.ts.
    searchTools: [],
  },
}

export type Session = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  accountId: string | null
  account: string | null
}

const store = jsonStore<Partial<Record<ProviderId, Session>>>(path.join(DIR, "providers.json"), {})

const REFRESH_MARGIN_MS = 120_000
const LOGIN_TIMEOUT_MS = 300_000

export function storedSession(provider: ProviderId): Session | null {
  return store.read()[provider] ?? null
}

export function signedIn(): ProviderId[] {
  const current = store.read()
  const oauth = (Object.keys(PROVIDERS) as ProviderId[]).filter(
    (id) => isOAuthProvider(id) && current[id],
  )
  return hasKiroCredentials() ? [...oauth, "kiro"] : oauth
}

export function signOut(provider: ProviderId): void {
  const current = store.read()
  delete current[provider]
  store.write(current)
}

function save(provider: ProviderId, session: Session): void {
  store.write({ ...store.read(), [provider]: session })
}

function accountFromIdToken(idToken: string | undefined): {
  accountId: string | null
  account: string | null
} {
  if (!idToken) return { accountId: null, account: null }
  try {
    const payload = idToken.split(".")[1]
    if (!payload) return { accountId: null, account: null }
    const claims = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined
    const accountId =
      (auth?.chatgpt_account_id as string | undefined) ??
      (claims.chatgpt_account_id as string | undefined) ??
      null
    return { accountId, account: (claims.email as string | undefined) ?? null }
  } catch {
    return { accountId: null, account: null }
  }
}

function sessionFromTokenResponse(body: Record<string, unknown>, previous?: Session): Session {
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600
  const identity = accountFromIdToken(body.id_token as string | undefined)
  return {
    accessToken: String(body.access_token ?? ""),
    refreshToken: (body.refresh_token as string | undefined) ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: identity.accountId ?? previous?.accountId ?? null,
    account: identity.account ?? previous?.account ?? null,
  }
}

export async function openExternally(url: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    await capture(opener, [url], { timeoutMs: 10_000 })
  } catch {
  }
}

export type PendingSignIn = {
  provider: ProviderId
  url: string
  completed: Promise<string>
  submit: (code: string) => Promise<string>
  cancel: () => void
}

export function authorizeUrl(
  provider: ProviderId,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const spec = oauthSpec(provider)
  const url = new URL(spec.authorizeUrl)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: spec.clientId,
    redirect_uri: redirectUri,
    scope: spec.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...spec.authorizeExtras,
  }).toString()
  return url.href
}

export async function beginSignIn(provider: ProviderId): Promise<PendingSignIn> {
  const spec = oauthSpec(provider)
  const { verifier, challenge, state } = pkce()

  const listener = await loopbackCallback(spec)
  const redirectUri = `http://${spec.redirectHost}:${listener.port}${spec.callbackPath}`
  const authorize = authorizeUrl(provider, redirectUri, challenge, state)

  let done = false
  const exchange = async (code: string): Promise<string> => {
    const body = await postForm(spec.tokenUrl, {
      grant_type: "authorization_code",
      code: code.trim(),
      client_id: spec.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
    const session = sessionFromTokenResponse(body)
    if (!session.accessToken) throw new Error("the provider returned no access token")
    save(provider, session)
    done = true
    listener.close()
    return session.account ?? spec.label
  }

  const completed = (async () => {
    const answer = await Promise.race([
      listener.code,
      new Promise<never>((_ok, no) =>
        setTimeout(() => no(new Error("the sign-in timed out")), LOGIN_TIMEOUT_MS),
      ),
    ])
    if (answer.state !== state) throw new Error("the callback state did not match")
    return exchange(answer.code)
  })()
  completed.catch(() => {})

  return {
    provider,
    url: authorize,
    completed,
    submit: exchange,
    cancel: () => {
      if (!done) listener.close()
    },
  }
}

export async function signIn(provider: ProviderId): Promise<string> {
  const flow = await beginSignIn(provider)
  void openExternally(flow.url)
  return flow.completed
}

const dedupeRefresh = dedupe<ProviderId, { token: string; accountId: string | null }>()

export async function credential(
  provider: ProviderId,
): Promise<{ token: string; accountId: string | null } | null> {
  const session = storedSession(provider)
  if (!session) return null
  if (Date.now() < session.expiresAt - REFRESH_MARGIN_MS) {
    return { token: session.accessToken, accountId: session.accountId }
  }
  if (!session.refreshToken) {
    throw new Error(
      `The ${PROVIDERS[provider].label} sign-in expired and cannot refresh. Sign in again.`,
    )
  }
  const refreshToken = session.refreshToken

  return dedupeRefresh(provider, async () => {
    const spec = oauthSpec(provider)
    const form = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: spec.clientId,
    }
    const body =
      spec.refresh === "json"
        ? await postJson(spec.tokenUrl, form)
        : await postForm(spec.tokenUrl, form)
    const refreshed = sessionFromTokenResponse(body, session)
    if (!refreshed.accessToken) {
      throw new Error(`The ${PROVIDERS[provider].label} refresh returned no token. Sign in again.`)
    }
    save(provider, refreshed)
    return { token: refreshed.accessToken, accountId: refreshed.accountId }
  })
}
