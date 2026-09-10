import { $ } from "bun"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const pkg = (await Bun.file(path.join(root, "package.json")).json()) as { version: string }
const dist = path.join(root, "dist")
const app = path.join(dist, "fx.app")
const contents = path.join(app, "Contents")
const icon = path.join(root, "assets", "icon.png")
const identity = process.env.SIGN_IDENTITY ?? "-"
const entitlements = path.join(import.meta.dir, "entitlements.plist")

const notary = process.env.NOTARY_PROFILE
  ? ["--keychain-profile", process.env.NOTARY_PROFILE]
  : process.env.NOTARY_KEY && process.env.NOTARY_KEY_ID && process.env.NOTARY_ISSUER
    ? [
        "--key",
        process.env.NOTARY_KEY,
        "--key-id",
        process.env.NOTARY_KEY_ID,
        "--issuer",
        process.env.NOTARY_ISSUER,
      ]
    : null
if (notary && identity === "-") {
  throw new Error("Notarizing needs SIGN_IDENTITY set to a Developer ID Application identity")
}

await $`bun run build`.cwd(root)

rmSync(app, { recursive: true, force: true })
mkdirSync(path.join(contents, "MacOS"), { recursive: true })
mkdirSync(path.join(contents, "Resources"), { recursive: true })
await $`cp ${path.join(dist, "fx")} ${path.join(contents, "MacOS", "fx")}`

const iconset = path.join(dist, "AppIcon.iconset")
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  await $`sips -z ${size} ${size} ${icon} --out ${path.join(iconset, `icon_${size}x${size}.png`)}`.quiet()
  await $`sips -z ${size * 2} ${size * 2} ${icon} --out ${path.join(iconset, `icon_${size}x${size}@2x.png`)}`.quiet()
}
await $`iconutil -c icns ${iconset} -o ${path.join(contents, "Resources", "AppIcon.icns")}`
rmSync(iconset, { recursive: true })

writeFileSync(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>fx</string>
  <key>CFBundleDisplayName</key><string>fx</string>
  <key>CFBundleIdentifier</key><string>io.github.zaidmukaddam.fx-ui</string>
  <key>CFBundleExecutable</key><string>fx</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
)

const hardened = identity === "-" ? [] : ["--options", "runtime", "--timestamp"]
await $`codesign --force --sign ${identity} ${hardened} --entitlements ${entitlements} ${app}`.quiet()

const stage = path.join(dist, "dmg")
const dmg = path.join(dist, `fx-${pkg.version}.dmg`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage)
await $`ditto ${app} ${path.join(stage, "fx.app")}`
symlinkSync("/Applications", path.join(stage, "Applications"))
rmSync(dmg, { force: true })
await $`hdiutil create -volname fx -srcfolder ${stage} -ov -format UDZO ${dmg}`.quiet()
rmSync(stage, { recursive: true })
if (identity !== "-") await $`codesign --force --sign ${identity} --timestamp ${dmg}`.quiet()

if (notary) {
  console.log("[package] notarizing, this usually takes a few minutes")
  const result = (await $`xcrun notarytool submit ${dmg} ${notary} --wait --output-format json`
    .nothrow()
    .json()) as { id?: string; status?: string }
  if (result.status !== "Accepted") {
    if (result.id) await $`xcrun notarytool log ${result.id} ${notary}`.nothrow()
    throw new Error(`Notarization ended with status ${result.status ?? "unknown"}`)
  }
  await $`xcrun stapler staple ${dmg}`.quiet()
}

console.log(
  `[package] wrote ${path.relative(root, app)} and ${path.relative(root, dmg)}` +
    (identity === "-" ? ", signed ad hoc" : notary ? ", signed and notarized" : ", signed"),
)
