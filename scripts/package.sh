#!/bin/bash
# Build the Rust app into dist/fx.app and dist/fx-<version>.dmg.
#
#   scripts/package.sh
#
# Signs ad hoc unless SIGN_IDENTITY names a Developer ID Application
# identity. With one, the disk image is notarized and stapled too when the
# notary credentials are given: NOTARY_PROFILE, a notarytool keychain
# profile, or NOTARY_KEY, NOTARY_KEY_ID and NOTARY_ISSUER, an App Store
# Connect key file with its ID and issuer. The app's own updater only
# installs images signed by fx-ui's Developer ID.
#
# Needs macOS, the Xcode command-line tools and Python 3.10 or newer; the
# pinned disk-image tools install into dist/dmg-tools.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/dist"
app="$dist/fx.app"
contents="$app/Contents"
identity="${SIGN_IDENTITY:--}"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)"

notary=()
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notary=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${NOTARY_KEY:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER:-}" ]]; then
  notary=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
fi
if [[ ${#notary[@]} -gt 0 && "$identity" == "-" ]]; then
  echo "Notarizing needs SIGN_IDENTITY set to a Developer ID Application identity" >&2
  exit 1
fi

cargo build --release --manifest-path "$root/Cargo.toml"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"
# The executable keeps the name it had before 0.3.0: an app that updates
# itself copies the new bundle over the old one, and a different name would
# leave the old binary behind and break the bundle's signature.
cp "$root/target/release/fx-desktop" "$contents/MacOS/fx"

# The icon at every size macOS asks for, from the one 1024px drawing.
iconset="$dist/AppIcon.iconset"
rm -rf "$iconset" && mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/assets/app-icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$root/assets/app-icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"
rm -rf "$iconset"

# The same identifier the app has always had, so this build takes the old
# one's place in Applications and in the Dock.
cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>fx</string>
  <key>CFBundleDisplayName</key><string>fx</string>
  <key>CFBundleIdentifier</key><string>io.github.zaidmukaddam.fx-ui</string>
  <key>CFBundleExecutable</key><string>fx</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [[ "$identity" == "-" ]]; then
  codesign --force --sign - "$app"
else
  codesign --force --sign "$identity" --options runtime --timestamp "$app"
fi

# The app gets its own ticket, stapled inside it, so a copy dragged out of the
# disk image opens with no network. The image is notarized again below, since
# stapling changes the app it holds.
if [[ ${#notary[@]} -gt 0 ]]; then
  echo "[package] notarizing the app, this usually takes a few minutes"
  zip="$dist/fx-$version-app.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" "${notary[@]}" --wait
  rm -f "$zip"
  xcrun stapler staple "$app"
fi

# The install window: its background, then the image laid out around it. The
# background is drawn again only when its script is newer than the last one.
if [[ ! "$dist/dmg-background.png" -nt "$root/scripts/dmg-background.swift" ]]; then
  swift "$root/scripts/dmg-background.swift" "$dist/dmg-background.png"
fi
tools="$dist/dmg-tools"
python3 -m venv "$tools"
"$tools/bin/python" -m pip install --quiet --disable-pip-version-check -r "$root/scripts/dmg-requirements.txt"

dmg="$dist/fx-$version.dmg"
rm -f "$dmg"
# Room for the app and the background, a quarter over, and 32 MiB to spare.
bytes=$(( $(du -sk "$app" | cut -f1) * 1024 + $(stat -f%z "$dist/dmg-background.png") ))
megabytes=$(( bytes * 5 / 4 / 1048576 + 32 ))
"$tools/bin/dmgbuild" -s "$root/scripts/dmg-settings.py" -D "dist=$dist" -D "size=${megabytes}m" fx "$dmg"

if [[ "$identity" != "-" ]]; then
  codesign --force --sign "$identity" --timestamp "$dmg"
fi
if [[ ${#notary[@]} -gt 0 ]]; then
  echo "[package] notarizing the disk image"
  xcrun notarytool submit "$dmg" "${notary[@]}" --wait
  xcrun stapler staple "$dmg"
fi

echo "[package] wrote $app and $dmg"
