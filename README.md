# fx-ui

A desktop app for the [fx](https://fx.sh) coding agent, built on
[libfx](https://fx.sh/docs/lib) and [GPUIX](https://gpuix.dev).

![fx-ui with a session open](docs/fx-gui.png)

## Run it

```bash
bun install
bun run dev
```

Sign in with Grok or Codex in settings, or paste a Vercel AI Gateway key there.

```bash
bun run test     # run the tests
bun run build    # build a standalone binary in dist/fx
bun run package  # build dist/fx.app and dist/fx-<version>.dmg
```

Packaging requires macOS, Xcode command-line tools, and Python 3.10 or newer.
It installs pinned DMG build tools into `dist/dmg-tools`, draws a Retina
installer background, and writes the Finder layout without opening Finder.
The DMG uses LZMA compression and explicit volume headroom for reliable CI builds.

## Features

- Workspaces, sessions and a split view
- Models from Grok, Codex, the AI Gateway or the fx CLI
- Ask, Auto and Full access approval modes
- Images, `@` file mentions and `/` skills
- Local and remote MCP servers
- Context and plan usage in the composer

## More

- [How it works](docs/how-it-works.md) covers every feature in detail, the
  agent's tools and the code layout.
- [Platform notes](PLATFORM.md) record what GPUIX, libfx, Grok and Codex do that
  you could not guess from reading.
- [Contributing](CONTRIBUTING.md) covers setup, checks and conventions.

## License

[Apache-2.0](LICENSE). The vendored gpuix binary's notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
