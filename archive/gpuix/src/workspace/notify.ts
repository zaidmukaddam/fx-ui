import { getState } from "../store"
import { capture } from "./run"

const IS_MAC = process.platform === "darwin"

// AppKit through JavaScript for Automation reads the frontmost app without the
// Automation permission that asking System Events would prompt for.
const FRONTMOST =
  "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier"

async function inBackground(): Promise<boolean> {
  try {
    const result = await capture("osascript", ["-l", "JavaScript", "-e", FRONTMOST], { timeoutMs: 2_000 })
    return result.code === 0 && Number(result.stdout.trim()) !== process.pid
  } catch {
    return false
  }
}

/** Title and body travel as arguments, so their text never becomes AppleScript. */
function script(sound: boolean): string[] {
  const line = `display notification (item 2 of argv) with title (item 1 of argv)${sound ? ' sound name "Glass"' : ""}`
  return ["on run argv", line, "end run"].flatMap((source) => ["-e", source])
}

/** Shows a macOS notification when the setting is on and fx is not the frontmost app. */
export async function notifyInBackground(title: string, body: string, sound = false): Promise<void> {
  if (!IS_MAC || !getState().notify) return
  if (!(await inBackground())) return
  try {
    await capture("osascript", [...script(sound), title, body], { timeoutMs: 5_000 })
  } catch {}
}
