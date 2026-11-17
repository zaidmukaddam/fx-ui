import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { launch } from "@gpuix/react/automation"

const out = process.argv[2] ?? "screenshots/fx.png"
mkdirSync(path.dirname(out), { recursive: true })

const app = await launch({
  command: "bun",
  args: ["app.tsx"],
  env: {
    GPUIX_BACKGROUND: "1",
    FX_UI_HOME: mkdtempSync(path.join(os.tmpdir(), "fx-ui-shot-")),
  },
})

await app.getByTestId("empty-add-workspace").waitFor({ timeoutMs: 60_000 })
await app.clock.pause()
await app.screenshot({ path: out })
await app.close()

console.log(`[screenshot] wrote ${out}`)
