import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"

import { DIR } from "../../store"

const FILE = path.join(DIR, "mcp-auth.json")

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

type Store = Record<string, ServerAuth>

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  mkdirSync(DIR, { recursive: true })
  const temporary = `${FILE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 })
  renameSync(temporary, FILE)
  chmodSync(FILE, 0o600)
}

export function storedAuth(server: string): ServerAuth | null {
  return readStore()[server] ?? null
}

export function authorisedServers(): string[] {
  return Object.keys(readStore())
}

export function signOutOfServer(server: string): void {
  const store = readStore()
  if (!(server in store)) return
  delete store[server]
  writeStore(store)
}

function save(server: string, auth: ServerAuth): void {
  const store = readStore()
  store[server] = auth
  writeStore(store)
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function json(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`)
  }
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error(`${new URL(url).host} did not answer with JSON`)
  }
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
  const resourceMetadata = await json(metadataUrl)
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
      const server = await json(candidate)
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
  const body = await json(found.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "fx-ui",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(found.scope ? { scope: found.scope } : {}),
    }),
  })
  const clientId = text(body.client_id)
  if (!clientId) throw new Error("the authorization server issued no client id")
  return { clientId, clientSecret: text(body.client_secret) }
}

function loopback(): Promise<{
  redirectUri: string
  code: Promise<{ code: string; state: string }>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    let settle: (value: { code: string; state: string }) => void
    let fail: (error: Error) => void
    const code = new Promise<{ code: string; state: string }>((ok, no) => {
      settle = ok
      fail = no
    })

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== "/callback") {
        response.writeHead(404).end()
        return
      }
      const error = url.searchParams.get("error")
      const received = url.searchParams.get("code")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><meta charset="utf-8"><title>fx-ui</title>` +
          `<body style="font:14px ui-monospace,monospace;background:#000;color:#ededed;padding:48px">` +
          (error || !received
            ? `Sign-in failed: ${error ?? "no code returned"}.`
            : `Signed in. You can close this tab.`) +
          `</body>`,
      )
      if (error || !received) fail(new Error(error ?? "the server returned no code"))
      else settle({ code: received, state: url.searchParams.get("state") ?? "" })
    })

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("the callback listener reported no port"))
        return
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        code,
        close: () => server.close(),
      })
    })
  })
}

async function exchange(
  found: Discovered,
  client: { clientId: string; clientSecret?: string },
  form: Record<string, string>,
): Promise<ServerAuth> {
  const body = await json(found.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...form,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      resource: found.resource,
    }).toString(),
  })
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
  const listener = await loopback()
  const client = await register(found, listener.redirectUri).catch((error: unknown) => {
    listener.close()
    throw error
  })

  const verifier = base64url(randomBytes(32))
  const state = base64url(randomBytes(16))
  const url = new URL(found.authorizeEndpoint)
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: listener.redirectUri,
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
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
        redirect_uri: listener.redirectUri,
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

export async function accessTokenFor(server: string): Promise<string | null> {
  const auth = storedAuth(server)
  if (!auth) return null
  if (!auth.expiresAt || auth.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return auth.accessToken
  }
  if (!auth.refreshToken) return auth.accessToken

  try {
    const refreshed = await exchange(
      {
        authorizeEndpoint: auth.authorizeEndpoint,
        tokenEndpoint: auth.tokenEndpoint,
        resource: auth.resource,
      },
      { clientId: auth.clientId, clientSecret: auth.clientSecret },
      { grant_type: "refresh_token", refresh_token: auth.refreshToken },
    )
    save(server, { ...refreshed, refreshToken: refreshed.refreshToken ?? auth.refreshToken })
    return refreshed.accessToken
  } catch {
    return auth.accessToken
  }
}
