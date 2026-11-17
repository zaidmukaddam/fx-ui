import path from "node:path"

import { dedupe, jsonStore, loopbackCallback, pkce, postForm, postJson, requestJson } from "../../oauth-core"
import { DIR } from "../../store"

const REFRESH_MARGIN_MS = 120_000
const LOGIN_TIMEOUT_MS = 300_000
const DISCOVERY_TIMEOUT_MS = 15_000

export type ServerAuth = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  clientId: string
  clientSecret?: string
  authorizeEndpoint: string
  tokenEndpoint: string
  resource: string
}

const store = jsonStore<Record<string, ServerAuth>>(path.join(DIR, "mcp-auth.json"), {})

export function storedAuth(server: string): ServerAuth | null {
  return store.read()[server] ?? null
}

export function authorisedServers(): string[] {
  return Object.keys(store.read())
}

export function signOutOfServer(...keys: string[]): void {
  const current = store.read()
  let changed = false
  for (const key of new Set(keys.filter(Boolean))) {
    if (!(key in current)) continue
    delete current[key]
    changed = true
  }
  if (changed) store.write(current)
}

function save(server: string, auth: ServerAuth): void {
  const current = store.read()
  current[server] = auth
  store.write(current)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function resourceMetadataUrl(challenge: string | null, endpoint: string): string {
  const quoted = challenge?.match(/resource_metadata="([^"]+)"/)
  if (quoted?.[1]) return quoted[1]
  const url = new URL(endpoint)
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`
}

export type Discovered = {
  authorizeEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  resource: string
  scope?: string
}

export async function discover(
  endpoint: string,
  challenge: string | null,
): Promise<Discovered> {
  const metadataUrl = resourceMetadataUrl(challenge, endpoint)
  const resourceMetadata = await requestJson(metadataUrl, undefined, DISCOVERY_TIMEOUT_MS)
  const issuers = resourceMetadata.authorization_servers
  const issuer = Array.isArray(issuers) ? text(issuers[0]) : undefined
  if (!issuer) {
    throw new Error(`${metadataUrl} named no authorization server`)
  }
  const resource = text(resourceMetadata.resource) ?? new URL(endpoint).origin

  const base = new URL(issuer)
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${base.pathname === "/" ? "" : base.pathname}`,
    `${base.origin}/.well-known/openid-configuration${base.pathname === "/" ? "" : base.pathname}`,
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ]

  let last: Error | null = null
  for (const candidate of candidates) {
    try {
      const server = await requestJson(candidate, undefined, DISCOVERY_TIMEOUT_MS)
      const authorizeEndpoint = text(server.authorization_endpoint)
      const tokenEndpoint = text(server.token_endpoint)
      if (!authorizeEndpoint || !tokenEndpoint) continue
      return {
        authorizeEndpoint,
        tokenEndpoint,
        registrationEndpoint: text(server.registration_endpoint),
        resource,
        scope: Array.isArray(resourceMetadata.scopes_supported)
          ? resourceMetadata.scopes_supported.filter((entry) => typeof entry === "string").join(" ")
          : text(resourceMetadata.scope),
      }
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw last ?? new Error(`${issuer} published no authorization metadata`)
}

async function register(
  found: Discovered,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!found.registrationEndpoint) {
    throw new Error(
      "the server's authorization server does not offer dynamic client registration, so this app cannot sign in to it",
    )
  }
  const body = await postJson(
    found.registrationEndpoint,
    {
      client_name: "fx-ui",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(found.scope ? { scope: found.scope } : {}),
    },
    DISCOVERY_TIMEOUT_MS,
  )
  const clientId = text(body.client_id)
  if (!clientId) throw new Error("the authorization server issued no client id")
  return { clientId, clientSecret: text(body.client_secret) }
}

async function exchange(
  found: Discovered,
  client: { clientId: string; clientSecret?: string },
  form: Record<string, string>,
): Promise<ServerAuth> {
  const body = await postForm(
    found.tokenEndpoint,
    {
      ...form,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      resource: found.resource,
    },
    DISCOVERY_TIMEOUT_MS,
  )
  const accessToken = text(body.access_token)
  if (!accessToken) throw new Error("the authorization server issued no access token")
  const lifetime = typeof body.expires_in === "number" ? body.expires_in * 1000 : undefined
  return {
    accessToken,
    refreshToken: text(body.refresh_token),
    expiresAt: lifetime ? Date.now() + lifetime : undefined,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    authorizeEndpoint: found.authorizeEndpoint,
    tokenEndpoint: found.tokenEndpoint,
    resource: found.resource,
  }
}

export type PendingServerSignIn = {
  url: string
  completed: Promise<void>
  cancel: () => void
}

export async function beginServerSignIn(
  server: string,
  endpoint: string,
  challenge: string | null,
  open: (url: string) => Promise<void>,
): Promise<PendingServerSignIn> {
  const found = await discover(endpoint, challenge)
  const listener = await loopbackCallback({ label: server, ports: [], callbackPath: "/callback" })
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`
  const client = await register(found, redirectUri).catch((error: unknown) => {
    listener.close()
    throw error
  })

  const { verifier, challenge: codeChallenge, state } = pkce()
  const url = new URL(found.authorizeEndpoint)
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: found.resource,
    ...(found.scope ? { scope: found.scope } : {}),
  })) {
    url.searchParams.set(key, value)
  }

  const completed = (async () => {
    const timeout = setTimeout(() => listener.close(), LOGIN_TIMEOUT_MS)
    try {
      const returned = await listener.code
      if (returned.state !== state) throw new Error("the authorization server returned a different state")
      const auth = await exchange(found, client, {
        grant_type: "authorization_code",
        code: returned.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      })
      save(server, auth)
    } finally {
      clearTimeout(timeout)
      listener.close()
    }
  })()

  await open(url.toString())
  return { url: url.toString(), completed, cancel: () => listener.close() }
}

const dedupeRefresh = dedupe<string, string>()

export async function accessTokenFor(server: string): Promise<string | null> {
  const auth = storedAuth(server)
  if (!auth) return null
  if (!auth.expiresAt || auth.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return auth.accessToken
  }
  if (!auth.refreshToken) return auth.accessToken
  const refreshToken = auth.refreshToken

  return dedupeRefresh(server, async () => {
    try {
      const refreshed = await exchange(
        {
          authorizeEndpoint: auth.authorizeEndpoint,
          tokenEndpoint: auth.tokenEndpoint,
          resource: auth.resource,
        },
        { clientId: auth.clientId, clientSecret: auth.clientSecret },
        { grant_type: "refresh_token", refresh_token: refreshToken },
      )
      save(server, { ...refreshed, refreshToken: refreshed.refreshToken ?? auth.refreshToken })
      return refreshed.accessToken
    } catch {
      return auth.accessToken
    }
  })
}
