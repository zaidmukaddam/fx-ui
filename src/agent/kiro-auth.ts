// Kiro subscription authentication for fx-ui.
//
// Ported and trimmed from the dsh-kiro-subscription reference adapter. Unlike
// Grok and Codex, Kiro has no browser OAuth flow here: it reuses whatever the
// Kiro IDE or Kiro CLI already signed in with on this machine.
//
//   - JSON credentials: ~/.aws/sso/cache/kiro-auth-token.json (Kiro IDE / SSO)
//   - SQLite credentials: kiro-cli's data.sqlite3 (requires Node 22.5+ for the
//     built-in node:sqlite; fx-ui runs on Bun/Node, and reading is read-only)
//
// Token refresh has two shapes, chosen from the credential contents:
//   - Kiro Desktop / social login: prod.{region}.auth.desktop.kiro.dev/refreshToken
//   - AWS SSO OIDC (Enterprise/CLI): oidc.{region}.amazonaws.com/token
//
// In SQLite mode nothing is written back (the database is opened read-only);
// in JSON mode a refreshed token is persisted to the same file.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"

const TOKEN_KEYS = [
  "kirocli:social:token",
  "kirocli:odic:token",
  "codewhisperer:odic:token",
]
const REGISTRATION_KEYS = [
  "kirocli:odic:device-registration",
  "codewhisperer:odic:device-registration",
]
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000

export interface KiroAuthOptions {
  credentialsFile?: string
  sqliteFile?: string
  region?: string
  apiRegion?: string
  writeBack?: boolean
  fetch?: typeof globalThis.fetch
}

interface CredentialData {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string | number
  profileArn?: string
  region?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  scopes?: string[]
}

function expandPath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return resolve(path)
}

function expirationMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0)
}

function normalizeCredentialData(value: Record<string, unknown>): CredentialData {
  return {
    accessToken: firstString(value.accessToken as string, value.access_token as string),
    refreshToken: firstString(value.refreshToken as string, value.refresh_token as string),
    profileArn: firstString(value.profileArn as string, value.profile_arn as string),
    region: firstString(value.region as string),
    clientId: firstString(value.clientId as string, value.client_id as string),
    clientSecret: firstString(value.clientSecret as string, value.client_secret as string),
    clientIdHash: firstString(value.clientIdHash as string),
    expiresAt: (value.expiresAt ?? value.expires_at) as string | number | undefined,
    scopes: Array.isArray(value.scopes) ? value.scopes.map(String) : undefined,
  }
}

function parseJson(text: string, source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`kiro credentials at ${source} are not valid JSON`, { cause: error })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`kiro credentials at ${source} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * A read-only view over the Kiro CLI SQLite database. Kiro stores tokens in the
 * `auth_kv` table and the CodeWhisperer profile in the `state` table.
 */
interface AuthKv {
  authValue(key: string): string | undefined
  stateValue(key: string): string | undefined
  close(): void
}

/**
 * Open the Kiro CLI database read-only, using whichever SQLite is available in
 * the current runtime: `bun:sqlite` (fx-ui runs under Bun) is tried first, then
 * Node's built-in `node:sqlite` (Node 22.5+, used by tests / non-Bun Node).
 */
async function openAuthKv(full: string): Promise<AuthKv> {
  try {
    const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite")
    const db = new Database(full, { readonly: true })
    const read = (table: "auth_kv" | "state", key: string): string | undefined => {
      const row = db.query(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
        | { value?: string }
        | undefined
      return row?.value
    }
    return {
      authValue: (key) => read("auth_kv", key),
      stateValue: (key) => read("state", key),
      close: () => db.close(),
    }
  } catch {
    // Not Bun (or bun:sqlite unavailable) — fall back to Node's built-in.
  }
  let sqlite: typeof import("node:sqlite")
  try {
    sqlite = await import("node:sqlite")
  } catch (error) {
    throw new Error(
      "reading Kiro CLI SQLite credentials requires Bun or Node.js 22.5 or newer",
      { cause: error },
    )
  }
  const db = new sqlite.DatabaseSync(full, { readOnly: true })
  const read = (table: "auth_kv" | "state", key: string): string | undefined => {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined
    return row?.value
  }
  return {
    authValue: (key) => read("auth_kv", key),
    stateValue: (key) => read("state", key),
    close: () => db.close(),
  }
}

export function defaultCredentialsFile(): string | undefined {
  const candidate = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  return existsSync(candidate) ? candidate : undefined
}

export function defaultSqliteFile(): string | undefined {
  const candidates = [
    join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3"),
    join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"),
    join(homedir(), ".local", "share", "amazon-q", "data.sqlite3"),
  ]
  return candidates.find(existsSync)
}

/** True when this machine has a Kiro login fx-ui can reuse. */
export function hasKiroCredentials(options: KiroAuthOptions = {}): boolean {
  if (options.credentialsFile && existsSync(expandPath(options.credentialsFile))) return true
  if (options.sqliteFile && existsSync(expandPath(options.sqliteFile))) return true
  // When fx-ui runs with an isolated home (FX_UI_HOME, which the test suite
  // always sets), never probe the developer's real home directory: a test must
  // not discover the machine's actual Kiro login and fire real network calls.
  // An explicit KIRO_* override still counts.
  if (process.env.FX_UI_HOME && !process.env.KIRO_CREDS_FILE && !process.env.KIRO_CLI_DB_FILE) {
    return false
  }
  return Boolean(defaultCredentialsFile() ?? defaultSqliteFile())
}

export class KiroAuthManager {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly writeBack: boolean
  private credentialsFile?: string
  private sqliteFile?: string
  private loaded = false
  private loading?: Promise<void>
  private refreshing?: Promise<string>
  private accessToken?: string
  private refreshToken?: string
  private expiresAt?: number
  private clientId?: string
  private clientSecret?: string
  private ssoRegion?: string
  private _profileArn?: string
  private _apiRegion: string
  private _account: string | null = null
  readonly fingerprint: string

  constructor(options: KiroAuthOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.credentialsFile = options.credentialsFile === "" ? undefined : options.credentialsFile
    this.sqliteFile = options.sqliteFile === "" ? undefined : options.sqliteFile
    this.writeBack = options.writeBack ?? true
    this._apiRegion = options.apiRegion ?? options.region ?? "us-east-1"
    if (options.region) this.ssoRegion = options.region
    this.fingerprint = createHash("sha256")
      .update(`${hostname()}-${userInfo().username}-fx-ui-kiro`)
      .digest("hex")
  }

  get profileArn(): string | undefined {
    return this._profileArn
  }

  get apiRegion(): string {
    return this._apiRegion
  }

  get apiHost(): string {
    return `https://runtime.${this._apiRegion}.kiro.dev`
  }

  get account(): string | null {
    return this._account
  }

  private apply(data: CredentialData): void {
    this.accessToken = firstString(data.accessToken, this.accessToken)
    this.refreshToken = firstString(data.refreshToken, this.refreshToken)
    this._profileArn = firstString(data.profileArn, this._profileArn)
    this.clientId = firstString(data.clientId, this.clientId)
    this.clientSecret = firstString(data.clientSecret, this.clientSecret)
    this.ssoRegion = firstString(data.region, this.ssoRegion)
    const expires = expirationMs(data.expiresAt)
    if (expires !== undefined) this.expiresAt = expires
  }

  private loadJsonFile(path: string): void {
    const full = expandPath(path)
    const raw = parseJson(readFileSync(full, "utf8"), full)
    const data = normalizeCredentialData(raw)
    this.credentialsFile = full
    this.apply(data)
    if (data.region) this._apiRegion = data.region
    if (data.clientIdHash) {
      const registration = join(dirname(full), `${data.clientIdHash}.json`)
      if (existsSync(registration)) {
        this.apply(normalizeCredentialData(parseJson(readFileSync(registration, "utf8"), registration)))
      }
    }
  }

  private async loadSqlite(path: string): Promise<void> {
    const full = expandPath(path)
    if (!existsSync(full)) throw new Error(`kiro CLI SQLite database not found: ${full}`)
    const kv = await openAuthKv(full)
    try {
      let token: Record<string, unknown> | undefined
      for (const key of TOKEN_KEYS) {
        const value = kv.authValue(key)
        if (value) {
          token = parseJson(value, `${full}:${key}`)
          break
        }
      }
      if (!token) throw new Error(`no supported Kiro token entry found in ${full}`)
      this.apply(normalizeCredentialData(token))

      for (const key of REGISTRATION_KEYS) {
        const value = kv.authValue(key)
        if (value) {
          this.apply(normalizeCredentialData(parseJson(value, `${full}:${key}`)))
          break
        }
      }

      this.loadProfileArnFromKv(kv, full)
    } finally {
      kv.close()
    }
  }

  private loadProfileArnFromKv(kv: AuthKv, full: string): void {
    try {
      const value = kv.stateValue("api.codewhisperer.profile")
      if (value) {
        const profile = parseJson(value, `${full}:api.codewhisperer.profile`)
        const arn = firstString(profile.arn as string)
        if (arn) {
          this._profileArn ??= arn
          const arnRegion = arn.split(":")[3]
          if (arnRegion) this._apiRegion = arnRegion
        }
      }
    } catch {
      // Older databases may not have a state table.
    }
  }

  private async loadSqliteProfileArn(path: string): Promise<void> {
    const full = expandPath(path)
    if (!existsSync(full)) return
    let kv: AuthKv
    try {
      kv = await openAuthKv(full)
    } catch {
      return
    }
    try {
      this.loadProfileArnFromKv(kv, full)
    } finally {
      kv.close()
    }
  }

  private async ensureLoaded(forceSqliteReload = false): Promise<void> {
    if (this.loaded && !(forceSqliteReload && this.sqliteFile)) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      const sqlite = this.sqliteFile ?? (this.credentialsFile ? undefined : defaultSqliteFile())
      const json = this.sqliteFile ? undefined : (this.credentialsFile ?? defaultCredentialsFile())
      if (json) {
        this.loadJsonFile(json)
      } else if (sqlite) {
        await this.loadSqlite(sqlite)
      }
      // If a JSON login is missing profileArn (Enterprise IdC), fill it from
      // kiro-cli's SQLite state table.
      if (!this._profileArn) {
        const dbPath = this.sqliteFile ?? defaultSqliteFile()
        if (dbPath && existsSync(expandPath(dbPath))) {
          try {
            await this.loadSqliteProfileArn(dbPath)
          } catch {
            // SQLite unavailable; profileArn stays empty.
          }
        }
      }
      this.loaded = true
    })()
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  private tokenIsFresh(): boolean {
    return (
      this.accessToken !== undefined &&
      this.expiresAt !== undefined &&
      this.expiresAt - Date.now() > REFRESH_THRESHOLD_MS
    )
  }

  /** Whether a usable credential could be loaded from disk. */
  async available(): Promise<boolean> {
    try {
      await this.ensureLoaded(true)
    } catch {
      return false
    }
    return Boolean(this.accessToken || this.refreshToken)
  }

  async getAccessToken(): Promise<string> {
    await this.ensureLoaded(true)
    if (this.tokenIsFresh()) return this.accessToken!
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  async forceRefresh(): Promise<string> {
    await this.ensureLoaded(true)
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    if (!this.refreshToken) {
      if (this.accessToken && (this.expiresAt === undefined || this.expiresAt > Date.now())) {
        return this.accessToken
      }
      throw new Error(
        "No usable Kiro access token or refresh token was found. Sign in with Kiro IDE or Kiro CLI.",
      )
    }

    const oidc = Boolean(this.clientId && this.clientSecret)
    const region = this.ssoRegion ?? "us-east-1"
    const url = oidc
      ? `https://oidc.${region}.amazonaws.com/token`
      : `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
    const body = oidc
      ? {
          grantType: "refresh_token",
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: this.refreshToken,
        }
      : { refreshToken: this.refreshToken }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `KiroIDE-0.7.45-${this.fingerprint}`,
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new Error(`Kiro token refresh request to ${url} failed`, { cause: error })
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000)
      throw new Error(`Kiro token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
    }
    const result = (await response.json()) as Record<string, unknown>
    const next = normalizeCredentialData(result)
    if (!next.accessToken) throw new Error("Kiro token refresh response did not contain accessToken")
    this.accessToken = next.accessToken
    this.refreshToken = next.refreshToken ?? this.refreshToken
    this._profileArn = next.profileArn ?? this._profileArn
    const expiresIn = Number(result.expiresIn ?? 3600)
    this.expiresAt = Date.now() + (Number.isFinite(expiresIn) ? Math.max(expiresIn - 60, 1) : 3540) * 1000
    this.persistJson()
    return this.accessToken
  }

  private persistJson(): void {
    if (!this.writeBack || !this.credentialsFile || this.sqliteFile) return
    const path = expandPath(this.credentialsFile)
    const raw = parseJson(readFileSync(path, "utf8"), path)
    raw.accessToken = this.accessToken
    raw.refreshToken = this.refreshToken
    raw.expiresAt = new Date(this.expiresAt ?? Date.now()).toISOString()
    if (this._profileArn) raw.profileArn = this._profileArn
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

let shared: KiroAuthManager | undefined

/** The process-wide Kiro auth manager, honouring KIRO_* environment overrides. */
export function kiroAuth(): KiroAuthManager {
  if (!shared) {
    shared = new KiroAuthManager({
      credentialsFile: env("KIRO_CREDS_FILE"),
      sqliteFile: env("KIRO_CLI_DB_FILE"),
      region: env("KIRO_REGION"),
      apiRegion: env("KIRO_API_REGION"),
    })
  }
  return shared
}
