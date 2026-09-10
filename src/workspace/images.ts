import { copyFileSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"

import { IMAGE_TYPES, isAttachment, MAX_IMAGE_BYTES } from "../tools"
import { appendMessage, ATTACHMENT_DIR, getState, newId, setAttachments } from "../store"
import { capture } from "./run"

export const CAN_PICK_IMAGES = process.platform === "darwin"

export const READ_PASTEBOARD = `ObjC.import("AppKit")
function run(argv) {
  const board = $.NSPasteboard.generalPasteboard
  const urls = board.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }))
  if (!urls.isNil() && urls.count > 0) {
    const files = []
    for (let i = 0; i < urls.count; i++) files.push(ObjC.unwrap(urls.objectAtIndex(i).path))
    return JSON.stringify(files)
  }
  let data = board.dataForType($.NSPasteboardTypePNG)
  if (data.isNil()) {
    const tiff = board.dataForType($.NSPasteboardTypeTIFF)
    if (tiff.isNil()) return "[]"
    data = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
  }
  data.writeToFileAtomically(argv[0], true)
  return JSON.stringify([argv[0]])
}`

export const CHOOSE_IMAGES = `activate
set picked to choose file of type {"public.image"} with prompt "Attach images" with multiple selections allowed
set chosen to ""
repeat with image_file in picked
  set chosen to chosen & POSIX path of image_file & linefeed
end repeat
return chosen`

function tell(sessionId: string, text: string, tone: "info" | "error" = "error"): void {
  appendMessage(sessionId, { id: newId(), kind: "notice", at: Date.now(), tone, text })
}

export function attachImages(sessionId: string, files: string[]): void {
  const kept: string[] = []
  for (const file of files) {
    const name = path.basename(file)
    const extension = path.extname(file).toLowerCase()
    if (!(extension in IMAGE_TYPES)) {
      tell(sessionId, `${name} is not an image fx can read. It takes ${Object.keys(IMAGE_TYPES).join(", ")}.`)
      continue
    }
    try {
      if (statSync(file).size > MAX_IMAGE_BYTES) {
        tell(sessionId, `${name} is too large to attach.`)
        continue
      }
      if (isAttachment(file)) {
        kept.push(file)
        continue
      }
      mkdirSync(ATTACHMENT_DIR, { recursive: true })
      const copy = path.join(ATTACHMENT_DIR, `${newId()}${extension}`)
      copyFileSync(file, copy)
      kept.push(copy)
    } catch (error) {
      tell(sessionId, `${name} could not be attached: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (kept.length > 0) {
    setAttachments(sessionId, [...(getState().attachments[sessionId] ?? []), ...kept])
  }
}

export async function pasteImage(sessionId: string): Promise<void> {
  try {
    mkdirSync(ATTACHMENT_DIR, { recursive: true })
    const target = path.join(ATTACHMENT_DIR, `${newId()}.png`)
    const result = await capture("osascript", ["-l", "JavaScript", "-e", READ_PASTEBOARD, target], {
      timeoutMs: 10_000,
    })
    if (result.code !== 0) {
      tell(sessionId, `The clipboard could not be read: ${result.stderr.trim()}`)
      return
    }
    const files = JSON.parse(result.stdout || "[]") as string[]
    if (files.length === 0) {
      tell(sessionId, "The clipboard has no image in it.", "info")
      return
    }
    attachImages(sessionId, files)
  } catch (error) {
    tell(sessionId, `The clipboard could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function chooseImages(sessionId: string): Promise<void> {
  try {
    const result = await capture("osascript", ["-e", CHOOSE_IMAGES], {})
    if (result.code === 0) attachImages(sessionId, result.stdout.split("\n").filter(Boolean))
    else if (!result.stderr.includes("(-128)")) {
      tell(sessionId, `The file picker failed: ${result.stderr.trim()}`)
    }
  } catch (error) {
    tell(sessionId, `The file picker could not open: ${error instanceof Error ? error.message : String(error)}`)
  }
}
