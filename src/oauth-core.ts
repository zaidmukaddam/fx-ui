import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const state = base64url(randomBytes(16))
  return { verifier, challenge, state }
}

export async function requestJson(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : init?.signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${new URL(url).host} answered HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    )
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`${new URL(url).host} did not answer with JSON`)
  }
}

export function postForm(
  url: string,
  form: Record<string, string>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return requestJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    },
    timeoutMs,
  )
}

export function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return requestJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  )
}

export function jsonStore<T>(file: string, empty: T): { read(): T; write(value: T): void } {
  return {
    read(): T {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as T
      } catch {
        return empty
      }
    },
    write(value: T): void {
      mkdirSync(path.dirname(file), { recursive: true })
      const staging = `${file}.${process.pid}.tmp`
      writeFileSync(staging, JSON.stringify(value), { mode: 0o600 })
      chmodSync(staging, 0o600)
      renameSync(staging, file)
    },
  }
}

export function dedupe<K, V>(): (key: K, run: () => Promise<V>) => Promise<V> {
  const inFlight = new Map<K, Promise<V>>()
  return (key, run) => {
    const existing = inFlight.get(key)
    if (existing) return existing
    const promise = run().finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
  }
}

export type CallbackSpec = {
  label: string
  ports: number[]
  callbackPath: string
  corsOrigin?: string
}

export function loopbackCallback(spec: CallbackSpec): Promise<{
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
      server.once("error", (error) => {
        if (spec.ports.length > 0) listenOn(index + 1)
        else reject(error)
      })
      server.once("listening", () => {
        const address = server.address()
        if (address === null || typeof address === "string") {
          reject(new Error("the callback listener reported no port"))
          return
        }
        resolve({ port: address.port, code, close })
      })
      server.listen(port, "127.0.0.1")
    }
    listenOn(0)
  })
}
