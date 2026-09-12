import { capture } from "./run"

export async function openExternally(target: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    await capture(opener, [target], { timeoutMs: 10_000 })
  } catch {
  }
}
