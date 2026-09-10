# Workbench

A control surface for a repository's planning and development work: a
TanStack Router/Vite dashboard that renders the host repo's planning state
live and starts actions on it — reads and actions both flow through one
validated localhost execution seam
([ADR 0005](docs/adr/0005-control-surface-localhost-seam.md)). It is
published as the npm package `@quick-release/workbench` so host repositories
can pin a SemVer version as a regular dependency instead of tracking a git
submodule.

## Install it in a host repository

Workbench is distributed through the public npm registry. In the host
repository:

```sh
pnpm add @quick-release/workbench
```

and add a script that runs the installed command:

```json
{
  "scripts": {
    "workbench": "workbench"
  }
}
```

`pnpm run workbench` regenerates the snapshot against the host repository and
launches Workbench on <http://localhost:4051>. Set `WORKBENCH_PORT` to serve
on a different port.

Alternatively, install straight from release tags with no registry setup —
anyone who can already clone this repository can install it:

```sh
pnpm add github:Quick-Release/workbench#semver:^0.1.0
```

The lockfile pins the resolved commit; update with
`pnpm up @quick-release/workbench`.

The `workbench` command detects the host repository by walking up from the
installed package to the enclosing git checkout. Any checkout that is not this
package's own repository counts as the host — npm installs, vendored copies,
and submodules — and always supplies the data; demo data is ignored there. A
standalone clone of this package reads its own planning sources by default,
which is how workbench tracks its own development. To work against a larger
corpus instead, run demo mode (`pnpm dev:demo`, or set `WORKBENCH_DEMO_SOURCE=1`),
which reads the demo checkout at `~/workspaces/getquick/banquinha`; set
`WORKBENCH_DEMO_SOURCE=/path/to/checkout` to demo against a different one.
Set `WORKBENCH_SOURCE_ROOT=/path/to/repository` when detection cannot see the
host (standalone checkouts, global installs, relocated package stores); the
override wins over both detection and demo mode.
When no host repository or demo source is selected, Workbench defaults to
its own GitHub issue source (`Quick-Release/workbench`), including
when the command is launched from an ordinary directory outside Git. An
explicit `services` configuration, host repository, or demo source takes
precedence. GitHub authentication comes from `GITHUB_TOKEN` or the local
`gh` login.
`WORKBENCH_PROJECT_NAME` and `WORKBENCH_REPOSITORY_URL` can override the
detected project metadata.

## Releases

Versions follow [SemVer](https://semver.org/). To cut a release, describe the
change in a changeset (`pnpm changeset`) inside your PR. After merging, an
automated "Version Packages" PR aggregates the changesets; merging it bumps
the version, writes the changelog, publishes the package to GitHub Packages,
pushes the `vX.Y.Z` tag, and creates the GitHub release.

## Run a standalone checkout

Inside a clone of this repository:

```sh
pnpm install
pnpm dev
```

This launches Workbench on <http://localhost:4051> against this repository's
own planning sources, so workbench can track its own issues. Run
`pnpm dev:demo` to develop against the demo checkout at
`~/workspaces/getquick/banquinha` instead when you need a larger corpus of
tickets and plans; `pnpm sync` and `pnpm sync:demo` regenerate the snapshot
only. Set `WORKBENCH_SOURCE_ROOT=/path/to/repository` to run against a
different checkout.

Environment variables (service tokens, the telemetry deploy token, the
`WORKBENCH_*` overrides) live in a gitignored `.env`, loaded by the package
scripts through [dotenvx](https://dotenvx.com). First run copies
`.env.example` to `.env` for you; values already set in the shell always win.

### Commits run the CI gate locally

Every commit runs the checks CI would run — `pnpm check` and `pnpm test` —
through the `.githooks/pre-commit` hook, wired up by the package `prepare`
script when you run `pnpm install`. A failing check blocks the commit until
it is fixed; the hook also refuses commits with a stale
`src/data.generated.ts` (run `pnpm sync` and stage the result). Bypass with
`git commit --no-verify` only in a genuine emergency. Merges to `main` are
additionally gated on review: pull requests are required, and CodeRabbit
reviews every PR automatically.

## Configuration

Copy `workbench.config.example.json` to `workbench.config.json` in the host
repository. The JSON schema ships with the package at
`node_modules/@quick-release/workbench/workbench.config.schema.json` (and at
the repository root for standalone checkouts). The config controls project
metadata, semantic theme colors, and service sync statuses:

```json
{
  "$schema": "./node_modules/@quick-release/workbench/workbench.config.schema.json",
  "projectName": "Example project",
  "theme": {
    "background": "#14151b",
    "accent": "#c44900"
  },
  "services": [
    {
      "id": "roadmap",
      "type": "asana",
      "projectGid": "123456789",
      "tokenEnv": "ASANA_TOKEN"
    },
    {
      "id": "tasks",
      "type": "notion",
      "dataSourceId": "00000000-0000-0000-0000-000000000000",
      "tokenEnv": "NOTION_TOKEN"
    }
  ]
}
```

Supported service adapters are `asana` (project tasks, via `projectGid`),
`notion` (data-source pages, via `dataSourceId`), `github` (open issues, via
`repo: "owner/name"`), and `gitlab` (open issues, via a numeric `projectId` or
`projectPath: "group/project"`). Each adapter reports its sync status and task
count into the snapshot, accepts an optional `statusMap` for mapping
service-specific states onto the triage vocabulary, and an optional
`apiBaseUrl` for
self-hosted instances. Tokens are read only from the named environment variables
while `sync` runs — put them in the gitignored `.env` (see above) or export
them in the shell; for GitHub, an authenticated `gh` CLI is used as a fallback
when the token variable is unset. Tokens are never written to the config or
bundled into the browser. Service failures are reported in the snapshot and
never fail the sync. Add future providers behind the adapter seam in
`scripts/services/` rather than adding arbitrary browser-side URLs.

### Agent sessions (opt-in)

Workbench can chart the coding-agent sessions that produced a repository's
tickets and code, including per-model usage (for example, comparing GLM 5.3
Flash against GPT 5.6 Luna). Enable it with a `sessions` block:

```json
{
  "sessions": {
    "enabled": true,
    "databasePath": "~/.zcode/cli/db/db.sqlite"
  }
}
```

`databasePath` is optional and defaults to the ZCode CLI session database in
your home directory. When enabled, `sync` opens a temporary copy of that
database read-only and folds pre-aggregated rows — per-model and per-day token
totals plus a per-session rollup — into the snapshot; the `/sessions` page
renders them as charts and a sortable table. Only aggregates, model ids,
timestamps, and session titles ever enter the (git-ignored) snapshot; prompts
and responses are never read. The feature requires a Node build with the
built-in `node:sqlite` module (Node ≥ 22.13).

### Local engines: reviews and the issue agent

The dashboard starts local CLIs: the review engines (CodeRabbit, zcode) on a
pull request, and the issue agent — [opencode](https://opencode.ai) on a local
[Ollama](https://ollama.com) model — on an issue. The review-engines health
probe on the pull-requests page reports what is missing and the one-step fix.
For the issue agent:

```sh
brew install opencode            # flags verified against the opencode docs
                                 # on 2026-09-09 (opencode-ai 1.18.30);
                                 # re-verify `opencode run` flags on upgrade
ollama pull qwen3-coder:30b      # the default model; needs tool calling
export OLLAMA_CONTEXT_LENGTH=32768   # before `ollama serve` — the 4096
                                     # default silently truncates long runs
```

An agent run is unattended but fenced: it executes in a fresh git worktree
under a workbench-provided permission config that denies everything outside
the worktree and denies publishing outright (`git push`, `gh pr create`); the
run ends in a draft pull request, which is the human gate. A failed run keeps
its worktree for inspection; a successful one cleans it up. Environment
overrides: `WORKBENCH_OPENCODE_BIN` (pin the CLI binary),
`WORKBENCH_OPENCODE_MODEL` (default model), `WORKBENCH_OPENCODE_TIMEOUT_MS`
(the agent step's time bound), and `OLLAMA_HOST` (where Ollama listens).

## Sources

`scripts/sync-data.mjs` collects the host repo's planning state and produces
the ignored, generated `src/data.generated.ts` snapshot. It reads:

- the host repo's tracker — GitHub issues for work items, map membership,
  and blocker edges (GitHub native blocked-by, plus `Blocked by:` lines in
  issue bodies and in `docs/plans/**/tickets/*.md`; local ticket files
  contribute their ids and gate lines only, never a status);
- `docs/adr/*.md` — ADR decision records;
- `docs/research/*.md` — research-note artifacts;
- the skills catalog from `mattpocock/skills`, and the configured service
  adapters' sync statuses;
- the session database, when enabled, for the usage rollups.

Missing optional directories are valid, so the app can be used by
repositories that adopt only part of the conventions.

The dashboard is a control surface, not a mirror: the browser reads live
state and starts actions only through the localhost `/api/*` execution seam,
behind which run just the tools a Developer would run by hand (`gh`,
`pnpm sync`, the skills CLI), with everything crossing the seam validated at
the Effect Schema boundary. The browser makes zero remote network calls and
never holds a credential; with no dev server running it degrades to the last
synced snapshot with copy-the-command affordances
([ADR 0005](docs/adr/0005-control-surface-localhost-seam.md)). During
`sync`, workbench contacts only
explicitly configured service read endpoints, the company Telemetry
endpoint (ADR 0001), and the GitHub API for the Developer's Outcomes — or
the canonical Workbench GitHub issue endpoint in standalone mode — with
tokens supplied through the shell environment, and reports identified
telemetry to the company endpoint
([ADR 0001](docs/adr/0001-mandatory-telemetry-internal-tool.md)).
Telemetry carries aggregates and identifiers only; commit messages and
other content never leave the machine except through an explicit Developer
submission. Links point to the detected repository remote for source
reading only.
