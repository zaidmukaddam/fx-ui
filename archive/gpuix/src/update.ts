import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { closeAll } from "./agent/agent"
import { version as currentVersion } from "../package.json"
import { flushState, getState, newId, setUpdate } from "./store"
import { capture } from "./workspace/run"

const REPO = "zaidmukaddam/fx-ui"
const API_BASE = "https://api.github.com"
const SIGN_IDENTITY = "Developer ID Application: Zaid Altaf Mukaddam (8BN7M8YM4J)"

type Release = { version: string; dmgUrl: string }

export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value.trim().replace(/^v/, "").split(".").map((piece) => Number.parseInt(piece, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function currentAppPath(): string | null {
  if (!process.execPath.endsWith(`${path.sep}MacOS${path.sep}fx`)) return null
  const app = path.dirname(path.dirname(path.dirname(process.execPath)))
  return app.endsWith(".app") ? app : null
}

export async function latestRelease(): Promise<Release | null> {
  const response = await fetch(`${API_BASE}/repos/${REPO}/releases/latest`)
  if (!response.ok) return null
  const body = (await response.json()) as {
    tag_name?: string
    assets?: { name?: string; browser_download_url?: string }[]
  }
  const tag = body.tag_name
  const dmgUrl = body.assets?.find((asset) => asset.name?.endsWith(".dmg"))?.browser_download_url
  if (!tag || !dmgUrl) return null
  return { version: tag.replace(/^v/, ""), dmgUrl }
}

async function downloadAndInstall(dmgUrl: string, appPath: string): Promise<void> {
  const dmgPath = path.join(os.tmpdir(), `fx-update-${newId()}.dmg`)
  const mountPath = path.join(os.tmpdir(), `fx-update-${newId()}`)

  const response = await fetch(dmgUrl)
  if (!response.ok) throw new Error(`could not download the update: HTTP ${response.status}`)
  await Bun.write(dmgPath, response)

  try {
    const requirement = `anchor apple generic and certificate leaf[subject.CN] = "${SIGN_IDENTITY}"`
    const signed = await capture("codesign", ["--verify", `-R=${requirement}`, dmgPath], {
      timeoutMs: 30_000,
    })
    if (signed.code !== 0) {
      throw new Error("the downloaded update is not signed by fx-ui's Developer ID, refusing to install it")
    }

    mkdirSync(mountPath, { recursive: true })
    const mounted = await capture(
      "hdiutil",
      ["attach", dmgPath, "-nobrowse", "-mountpoint", mountPath],
      { timeoutMs: 60_000 },
    )
    if (mounted.code !== 0) throw new Error(`could not mount the update: ${mounted.stderr.trim()}`)

    try {
      const copied = await capture("ditto", [path.join(mountPath, "fx.app"), appPath], {
        timeoutMs: 60_000,
      })
      if (copied.code !== 0) throw new Error(`could not install the update: ${copied.stderr.trim()}`)
    } finally {
      await capture("hdiutil", ["detach", mountPath, "-force"], { timeoutMs: 30_000 }).catch(() => {})
    }
  } finally {
    rmSync(dmgPath, { force: true })
    rmSync(mountPath, { recursive: true, force: true })
  }
}

let inFlight: Promise<void> | null = null

export function checkForUpdate(): Promise<void> {
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function run(): Promise<void> {
  if (process.platform !== "darwin") return
  const appPath = currentAppPath()
  if (!appPath) return

  let release: Release | null
  try {
    release = await latestRelease()
  } catch {
    return
  }
  if (!release || compareVersions(release.version, currentVersion) <= 0) {
    setUpdate({ stage: "idle" })
    return
  }

  const existing = getState().update
  if (existing.stage === "ready" && existing.version === release.version) return

  setUpdate({ stage: "downloading", version: release.version })
  try {
    await downloadAndInstall(release.dmgUrl, appPath)
    setUpdate({ stage: "ready", version: release.version, appPath })
  } catch (error) {
    setUpdate({ stage: "error", message: error instanceof Error ? error.message : String(error) })
  }
}

export async function relaunch(appPath: string): Promise<void> {
  await capture("open", ["-n", appPath], { timeoutMs: 10_000 })
  flushState()
  await closeAll()
  process.exit(0)
}
