import { $ } from "bun"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const pkg = (await Bun.file(path.join(root, "package.json")).json()) as { version: string }
const dist = path.join(root, "dist")
const app = path.join(dist, "fx.app")
const contents = path.join(app, "Contents")
const icon = path.join(root, "assets", "icon.png")

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

await $`codesign --force --sign - ${app}`.quiet()

const stage = path.join(dist, "dmg")
const dmg = path.join(dist, `fx-${pkg.version}.dmg`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage)
await $`ditto ${app} ${path.join(stage, "fx.app")}`
symlinkSync("/Applications", path.join(stage, "Applications"))
rmSync(dmg, { force: true })
await $`hdiutil create -volname fx -srcfolder ${stage} -ov -format UDZO ${dmg}`.quiet()
rmSync(stage, { recursive: true })

console.log(`[package] wrote ${path.relative(root, app)} and ${path.relative(root, dmg)}`)
