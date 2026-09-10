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

## Reporting a bug

Open an issue with what you did, what you expected, and what happened. Say
which provider the session was on (Gateway, Grok, Codex or the fx CLI), since
most bugs depend on it.
