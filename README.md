# fx-ui

A desktop app for the [fx](https://fx.sh) coding agent, written in Rust on
[GPUI](https://www.gpui.rs). It drives the `fx` command-line tool, so install
fx first.

## Run it

```bash
cargo run              # open the app
cargo run -- <folder>  # open it on a folder
```

```bash
cargo test             # run the tests
scripts/package.sh     # build dist/fx.app and dist/fx-<version>.dmg
```

Building needs macOS, Rust 1.96 or newer and the Xcode command-line tools.
Packaging also needs Python 3.10 or newer: it installs pinned disk-image tools
into `dist/dmg-tools`, draws the install window's background, and writes the
Finder layout without opening Finder.

## Features

- Workspaces, sessions and a split view
- Models from the accounts fx is signed in to
- Ask, Auto and Full access approval modes
- Images, `@` file mentions and `/` skills
- Local and remote MCP servers
- Context and plan usage in the composer

## More

- [Architecture](docs/architecture.md) maps the source: what each folder and
  file holds, and where a change goes.
- [How it works](docs/how-it-works.md) covers every feature and why it works
  the way it does.
- [Platform notes](docs/platform.md) record what GPUI, macOS, git and fx do
  that you could not guess from reading.
- [Contributing](CONTRIBUTING.md) covers setup, checks and releasing.
- [`archive/gpuix`](archive/gpuix) keeps the earlier app, built on libfx and
  GPUIX, with its own docs and notices. Nothing builds or ships from it.

## License

[Apache-2.0](LICENSE).
