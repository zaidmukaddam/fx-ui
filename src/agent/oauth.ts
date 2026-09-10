import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { capture } from "../workspace/run"
import { DIR } from "../store"

export type ProviderId = "grok" | "codex"

type ProviderSpec = {
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
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  grok: {
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
  },
  codex: {
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
  },
}

export type Session = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  accountId: string | null
  account: string | null
}

const FILE = path.join(DIR, "providers.json")

const REFRESH_MARGIN_MS = 120_000
const LOGIN_TIMEOUT_MS = 300_000

function readStore(): Partial<Record<ProviderId, Session>> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Partial<Record<ProviderId, Session>>
  } catch {
    return {}
  }
}

function writeStore(store: Partial<Record<ProviderId, Session>>): void {
  mkdirSync(DIR, { recursive: true })
  const staging = `${FILE}.${process.pid}`
  writeFileSync(staging, JSON.stringify(store, null, 2), { mode: 0o600 })
  chmodSync(staging, 0o600)
  renameSync(staging, FILE)
}

export function storedSession(provider: ProviderId): Session | null {
  return readStore()[provider] ?? null
}

export function signedIn(): ProviderId[] {
  const store = readStore()
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => store[id])
}

export function signOut(provider: ProviderId): void {
  const store = readStore()
  delete store[provider]
  writeStore(store)
}

function save(provider: ProviderId, session: Session): void {
  writeStore({ ...readStore(), [provider]: session })
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

async function post(
  url: string,
  contentType: string,
  body: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType, accept: "application/json" },
    body,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  return post(url, "application/x-www-form-urlencoded", new URLSearchParams(form).toString())
}

function postJson(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  return post(url, "application/json", JSON.stringify(body))
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function openExternally(url: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    await capture(opener, [url], { timeoutMs: 10_000 })
  } catch {
  }
}

function awaitCallback(spec: ProviderSpec): Promise<{
  port: number
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
      const allowed =
        spec.corsOrigin && request.headers.origin === spec.corsOrigin ? spec.corsOrigin : null
      if (url.pathname !== spec.callbackPath) {
        response.writeHead(404).end()
        return
      }
      if (request.method === "OPTIONS") {
        response
          .writeHead(204, {
            ...(allowed ? { "access-control-allow-origin": allowed } : {}),
            "access-control-allow-methods": "GET",
            "access-control-allow-private-network": "true",
            vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Private-Network",
          })
          .end()
        return
      }
      const error = url.searchParams.get("error")
      const received = url.searchParams.get("code")
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(allowed ? { "access-control-allow-origin": allowed, vary: "Origin" } : {}),
      })
      response.end(
        `<!doctype html><meta charset="utf-8"><title>fx-ui</title>` +
          `<body style="font:14px ui-monospace,monospace;background:#000;color:#ededed;padding:48px">` +
          (error || !received
            ? `Sign-in failed: ${error ?? "no code returned"}.`
            : `Signed in to ${spec.label}. You can close this tab.`) +
          `</body>`,
      )
      if (error || !received) fail(new Error(error ?? "the provider returned no code"))
      else settle({ code: received, state: url.searchParams.get("state") ?? "" })
    })

    server.on("error", reject)
    const close = () => server.close()
    const listenOn = (index: number) => {
      const port = spec.ports.length > 0 ? spec.ports[index] : 0
      if (port === undefined) {
        reject(
          new Error(
            `${spec.label} redirects only to ports ${spec.ports.join(", ")}, and all are in use.`,
          ),
        )
        return
      }
      server.once("error", () => {
        if (spec.ports.length > 0) listenOn(index + 1)
      })
      server.listen(port, "127.0.0.1", () => {
        const address = server.address()
        if (address === null || typeof address === "string") {
          reject(new Error("the callback listener reported no port"))
          return
        }
        resolve({ port: address.port, code, close })
      })
    }
    listenOn(0)
  })
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
  const spec = PROVIDERS[provider]
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
  const spec = PROVIDERS[provider]
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const state = base64url(randomBytes(16))

  const listener = await awaitCallback(spec)
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

const refreshing = new Map<ProviderId, Promise<{ token: string; accountId: string | null }>>()

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
  const pending = refreshing.get(provider)
  if (pending) return pending

  const refreshToken = session.refreshToken
  const refresh = (async () => {
    const spec = PROVIDERS[provider]
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
  })().finally(() => refreshing.delete(provider))
  refreshing.set(provider, refresh)
  return refresh
}
