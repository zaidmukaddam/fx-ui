# Contributing

fx-ui is small, so there are only a few rules.

## Setup

You need macOS on Apple silicon and [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

`bun install` also installs the patched gpuix binary from `vendor/`.
[docs/how-it-works.md](docs/how-it-works.md#the-patched-gpuix-binary) explains
how to rebuild it.

## Before you open a pull request

```bash
bun run typecheck
bun run test
bun run build
```

All three have to pass. The tests drive the real app through GPUIX's test
renderer, against `.tmp-test-home` instead of your own `~/.fx-ui`.

## How the code is written

- No comments. A measured platform fact goes in [PLATFORM.md](PLATFORM.md),
  and the reason a feature works the way it does goes in
  [docs/how-it-works.md](docs/how-it-works.md).
- No `useEffect`. Work that runs once on mount uses `useMountEffect` from
  `src/ui/hooks.ts`.
- Match the code around you: its naming, its idioms, and how much it
  abstracts.

## Commits

One line: a type (`feat`, `fix`, `refactor`, `chore`, `docs` or `style`), a
colon, then what changed, in lowercase and without a trailing period. For
example, `fix: keep one store across hot reloads`.

## Releasing

Bump `version` in `package.json`, commit it, then tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The Release workflow checks that the tag matches `package.json`, runs the
checks, then builds, signs and notarizes the DMG with `bun run package` and
publishes it as a GitHub release. It needs these repository secrets:

| Secret | What it holds |
| --- | --- |
| `MACOS_CERTIFICATE` | The Developer ID Application certificate and key, exported as `.p12`, in base64 |
| `MACOS_CERTIFICATE_PASSWORD` | The password the `.p12` was exported with |
| `ASC_KEY_ID` | The ID of an App Store Connect API key with the Developer role |
| `ASC_ISSUER_ID` | The issuer ID shown above the keys in App Store Connect |
| `ASC_PRIVATE_KEY` | That key's `.p8` file, in base64 |

`bun run package` on its own signs ad hoc. To sign and notarize locally, store
the notary credentials in your keychain once, then name the identity and the
profile:

```bash
xcrun notarytool store-credentials fx-notary --apple-id <apple-id> --team-id 8BN7M8YM4J
SIGN_IDENTITY="Developer ID Application: Zaid Altaf Mukaddam (8BN7M8YM4J)" NOTARY_PROFILE=fx-notary bun run package
```

## Reporting a bug

Open an issue with what you did, what you expected, and what happened. Say
which provider the session was on (Gateway, Grok, Codex or the fx CLI), since
most bugs depend on it.
