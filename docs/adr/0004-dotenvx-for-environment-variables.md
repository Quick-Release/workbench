# dotenvx for environment variables

Status: accepted

Package scripts that consume environment variables now run through
[dotenvx](https://dotenvx.com) (`dotenvx run -- <command>`): `sync` (which
feeds service tokens and the `WORKBENCH_*` overrides to `sync-data.mjs`), the
four `worker:*` Alchemy commands (which read `TELEMETRY_INGEST_TOKEN` at
deploy time), and the demo entries, which switch the inline
`WORKBENCH_DEMO_SOURCE=1` prefix for a committed `.env.demo` loaded with
`dotenvx run -f .env.demo -f .env`. The demo file is safe to track because it
holds no secrets; everything else lives in a gitignored `.env` that
`scripts/env.mjs` seeds from `.env.example` on first run, so a fresh clone
never trips dotenvx's missing-file warning. `.env.example` is the single
inventory of every variable the repo reads.

The mechanism relies on dotenvx's precedence contract, verified before
adoption: values already set in the shell or CI always win over file values,
and nested `dotenvx run` invocations (the demo entries go through
`pnpm sync`, which runs dotenvx again) follow the same rule, so the outer
demo flag survives the inner load.

## Considered options

- **Inline prefixes and shell exports** (the previous state) — rejected: each
  script invented its own convention (`WORKBENCH_DEMO_SOURCE=1 pnpm dev`,
  undocumented token exports), nothing told a new contributor which variables
  exist, and the deploy token had no documented home at all.
- **The `dotenv` package** — rejected: it is a library, not a runner, so it
  cannot front the Alchemy CLI; dotenvx's runner, multi-file `-f` chaining,
  and encrypted-env upgrade path cover all three use cases with one tool.
- **direnv (`.envrc`)** — rejected: hooks into the shell rather than the
  scripts, so `pnpm` invocations from editors or CI silently skip it.
- **Extending dotenvx to the installed `workbench` CLI in host repositories**
  (e.g. loading `.env` inside `bin.mjs`) — deferred: that is a published
  behavior change for every host repo and deserves its own decision.

## Consequences

- `pnpm dev`, `pnpm sync`, `pnpm build`, `pnpm test`, and the `worker:*`
  commands all see the same environment; nothing needs `export`ing first.
- `scripts/env.mjs` runs before every dotenvx entry point and never
  overwrites: an existing `.env` always wins over the example, and packaged
  copies without `.env.example` stay silent.
- Real values keep winning over files everywhere, so CI and shell behavior is
  unchanged; removing the tool would only require unwrapping the scripts.
- `@dotenvx/dotenvx` is a devDependency: host installs of the published
  package do not gain dotenvx, and `bin.mjs` still reads the raw process
  environment.
- The demo entries gained an explicit file instead of a hidden inline
  default; `.env.demo` documents the flag and the demo-checkout path it
  selects.
