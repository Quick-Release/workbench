# Adopting Clack for CLI Prompts in @quick-release/workbench

**Date:** 2026-09-03
**Sources:** primary only — the [bombshell-dev/clack](https://github.com/bombshell-dev/clack) repo (READMEs, `packages/*/src`, GitHub release notes, at commit `37fca4eb7277`, main), the official docs site ([bomb.sh/docs/clack](https://bomb.sh/docs/clack/basics/getting-started/)), and the npm registry (versions and publish dates queried live via `npm view` on this date).

## TL;DR

**Verdict:** adopt, narrowly. `@clack/prompts` 1.7.0 (verified on npm, published 2026-07-03) is a lean (4 runtime deps, ~116 KB unpacked), ESM-only, MIT-licensed prompt library whose cancel semantics, Standard Schema validation, and CI-aware spinner fit this repo's stack well. But this repo's CLI is currently a **non-interactive pipeline**: `bin.mjs` reads two env vars and runs three child processes with `stdio: "inherit"`; there is nothing for a prompt to ask. So the right shape is to add clack **behind a new interactive entry point**, not into the existing default path.

**Recommended first step:** add `workbench init` — an opt-in subcommand that walks through creating `workbench.config.json` (project name, repository URL, then per-service prompts), validates the collected object with the existing hand-rolled rules in `scripts/config.mjs` (or a Zod 4 schema, which clack accepts directly — see §7), and writes the file. Wrap the existing sync step's status lines with `spinner`/`log` only where output is already clack-owned. Keep `bin.mjs` with no arguments exactly as it is: env-var-driven, TTY-guarded, non-interactive by default.

---

## 1. What Clack is

Clack is "stylish interactive prompts for JavaScript CLIs", a pnpm monorepo shipping two packages ([root README](https://github.com/bombshell-dev/clack/blob/main/README.md)):

- **`@clack/prompts`** — "opinionated, ready-to-use prompt components" (pre-styled).
- **`@clack/core`** — "headless, unstyled prompt primitives": a base `Prompt` class plus `TextPrompt`, `SelectPrompt`, `ConfirmPrompt`, `MultiSelectPrompt`, `GroupMultiSelectPrompt`, `PasswordPrompt`, `AutocompletePrompt`, `SelectKeyPrompt`, `MultiLinePrompt`, and `DatePrompt`, each accepting a custom `render()` function ([packages/core/README.md](https://github.com/bombshell-dev/clack/blob/main/packages/core/README.md); exports verified in [`packages/core/src/index.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/index.ts)). You would only touch `@clack/core` if restyling every prompt; `@clack/prompts` re-exports `isCancel`, `settings`, `updateSettings`, and the `ClackSettings` type from core ([`packages/prompts/src/index.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/index.ts)).

**Continuity of the original project:** the original repository was `natemoo-re/clack`; that URL now resolves to `bombshell-dev/clack` via GitHub's rename/transfer redirect (verified via the GitHub API on 2026-09-03), and the published package's author field is Nate Moore (`nate@natemoo.re`) with `natemoo-re` still the top contributor (272 commits, [contributors API](https://api.github.com/repos/bombshell-dev/clack/contributors)). Same project, moved under the maintainer's [bombshell-dev org](https://github.com/orgs/bombshell-dev/repositories) (which also publishes `args`, a <1 kB CLI flag parser, and `tab`, shell completions — useful companions if this repo ever grows real subcommand flags).

**License:** MIT — the root [`LICENSE`](https://github.com/bombshell-dev/clack/blob/main/LICENSE) file points to [`packages/core/LICENSE`](https://github.com/bombshell-dev/clack/blob/main/packages/core/LICENSE), "MIT License … Copyright (c) 2025-Present Bombshell contributors"; `license: "MIT"` on both packages in the npm registry (checked 2026-09-03).

**Runtime requirements:** `engines: { node: ">= 20.12.0" }` on both packages (npm registry; first declared in the 1.3.0 release notes, [releases](https://github.com/bombshell-dev/clack/releases)). This dev machine runs Node 26.7.0 and the repo has no engines floor, so no conflict.

## 2. Ecosystem state (verified via npm registry, 2026-09-03)

| Package                   | Version / dist-tag                         | Runtime deps                                                                                                                           |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@clack/prompts`          | **1.7.0** (`latest`, published 2026-07-03) | `@clack/core` 1.4.3 (exact), `fast-string-width`, `fast-wrap-ansi`, `sisteransi` ([npm](https://www.npmjs.com/package/@clack/prompts)) |
| `@clack/prompts`          | `1.0.0-alpha.10` (`alpha`, 2026-01-27)     | —                                                                                                                                      |
| `@clack/core`             | **1.4.3** (`latest`, published 2026-07-03) | `fast-wrap-ansi`, `sisteransi` ([npm](https://www.npmjs.com/package/@clack/core))                                                      |
| `prompts` (alt)           | 2.4.2 (published 2021-10-07)               | `kleur`, `sisteransi`                                                                                                                  |
| `@inquirer/prompts` (alt) | 8.7.1 (published 2026-09-02)               | 10 scoped `@inquirer/*` packages + `@types/node` peer                                                                                  |
| `enquirer` (alt)          | 2.4.1 (published 2023-07-28)               | —                                                                                                                                      |

**ESM/CJS:** `@clack/prompts` 1.0.0 (2026-01-28) went **ESM-only** — "The package is now distributed as ESM-only. In `v0` releases, the package was dual-published as CJS and ESM" ([1.0.0 release notes](https://github.com/bombshell-dev/clack/releases/tag/%40clack%2Fprompts%401.0.0)). Verified in the published 1.7.0 metadata: `"type": "module"`, single `exports` map with `.` → `./dist/index.mjs` + `./dist/index.d.mts`, plus `./package.json`. No `require()` support on Node < 20.19 without `--experimental-require-module`. This repo is `"type": "module"` with `.mjs` scripts (`package.json`), so this is a match, not a constraint.

**Dependency weight:** 1.7.0 unpacked size is 116,266 bytes (~114 KB), and the full transitive closure is 5 packages total (prompts, core, fast-string-width, fast-wrap-ansi, sisteransi) — no native builds, no postinstall scripts (registry metadata, checked 2026-09-03). Trivially cheap for a published CLI.

## 3. Current API surface (from `packages/prompts/src` and the README, at main `37fca4eb7277`)

Prompts ([`packages/prompts/README.md`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/README.md); module list in [`src/index.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/index.ts)):

- `text` (placeholder, initialValue, defaultValue, `validate`), `password`, `confirm` (optional `vertical` layout), `date`, `select`, `multiselect`, `groupMultiselect` (hierarchical), `selectKey` (single-keypress choice), `autocomplete` / `autocompleteMultiselect` (searchable, custom `filter`), `multiline` (multi-line text), `path` (filesystem autocompletion).
- Utilities: `intro` / `outro` (session bookends), `cancel`, `isCancel`, `note`, `box`, `log.info/success/step/warn/error/message`, `stream` (same methods but consuming sync/async iterables — aimed at LLM output), `spinner` (`start`/`stop`/`message`/`clear`, `indicator: "dots" | "timer"`, `isCancelled`/`onCancel`), `progress` (bar with `max`/`advance`), `tasks` (sequenced spinner steps), `taskLog` (continuous sub-process output that clears on success), `group` (sequential prompts sharing `results`, with one `onCancel` handler), `limitOptions`.
- Every prompt accepts `CommonOptions`: `input?: Readable`, `output?: Writable`, `signal?: AbortSignal`, `withGuide?: boolean` ([`packages/prompts/src/common.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/common.ts)). Custom streams enable testing (§6); `signal` enables programmatic cancellation (e.g. a timeout).
- **Cancellation semantics:** Ctrl+C (`\x03`) and `escape` are default `cancel` action aliases; the base `Prompt` flips to `cancel` state and resolves the promise with a `CANCEL_SYMBOL` symbol ([`packages/core/src/utils/settings.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/settings.ts), [`packages/core/src/prompts/prompt.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/prompts/prompt.ts)). Callers guard with `isCancel(value)` and exit via `cancel('message')` — the documented pattern ([prompts README "Cancellation"](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/README.md)). `group` centralizes this via its `onCancel` callback.
- **Validation:** `validate` accepts either a function `(value) => string | Error | undefined` **or a Standard Schema v1 object**; sync only (async schemas throw) ([`packages/core/src/utils/validation.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/validation.ts)). See §7 for what that means for this repo's Zod 4.
- **Settings/theming:** `updateSettings()` / `settings` control key aliases (vim `hjkl` by default), the cancel/error messages, the `withGuide` left-border chrome, date localization, and an `accessible` flag (static, screen-reader-friendly output; resolution order is per-call option > setting > `ACCESSIBLE` env var) ([`packages/core/src/utils/settings.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/settings.ts)). Visual customization is otherwise per-component: spinner `frames`/`styleFrame`, `progress` bar styles, `box`/`note` `format` functions ([API reference](https://bomb.sh/docs/clack/packages/prompts)). Deeper restyling means dropping to `@clack/core` primitives with your own `render()`.
- **Frameworks:** none. No Svelte/React/etc. adapters exist in the org or the docs — clack is plain Node stdio ([org repos](https://github.com/orgs/bombshell-dev/repositories); [docs API page](https://bomb.sh/docs/clack/packages/prompts) mentions no adapter). Irrelevant for this repo anyway; the CLI surfaces are plain `.mjs`.

**Version-gated features** (all from [GitHub release notes](https://github.com/bombshell-dev/clack/releases)) — relevant only if you pin below 1.7.0:

| Feature                                           | Since               |
| ------------------------------------------------- | ------------------- |
| `updateSettings` (aliases), `signal` option       | 0.9.0 (2024-12-19)  |
| `stream` API, spinner `timer` indicator           | 0.10.0 (2025-02-05) |
| `progress` bar (first commit 2025-04-16, PR #290) | 0.11.0 (2025-05-22) |
| ESM-only distribution                             | 1.0.0 (2026-01-28)  |
| `withGuide` chrome toggle                         | 1.0.x (2026-02-12)  |
| `date` prompt                                     | 1.2.0 (2026-03-31)  |
| `multiline` prompt; `engines` node ≥ 20.12        | 1.3.0 (2026-04-29)  |
| `groupMultiselect` scrolling / `maxItems`         | 1.4.0 (2026-05-12)  |
| **Standard Schema `validate` support**            | 1.5.0 (2026-05-29)  |
| `showInstructions` on select-family prompts       | 1.7.0 (2026-07-03)  |

## 4. Maintenance health

- **Release cadence:** ten `@clack/prompts` releases on the 1.x line between 2026-01-28 and 2026-07-03 — roughly monthly, with patch follow-ups (npm `time` data, checked 2026-09-03). The default branch was pushed 2026-08-26 and the latest main commit (2026-08-15) adds path-prompt tab completion (GitHub API).
- **Popularity / issue load:** 8,036 stars, 87 open issues (GitHub API, 2026-09-03).
- **People:** Nate Moore (`natemoo-re`, original author, 272 commits) plus active co-maintainers/contributors `43081j` (103 commits), `cpreston321`, `dreyfus92`, `florian-lefebvre`, `ghostdevv`, `orochaa`, `ulken` ([contributors API](https://api.github.com/repos/bombshell-dev/clack/contributors); release-note credits). The project outgrew its single-maintainer phase: the org has dedicated docs ([bomb.sh](https://bomb.sh/docs/clack/basics/getting-started/)), a Discord ([bomb.sh/chat](https://bomb.sh/chat)), and bot-managed changesets releases.
- **Health signals observed:** releases ship small and frequently (changesets), bugs in release notes get patch releases within days (e.g. `path` prompt directory regression fixed in 1.2.0 after introduction), and the docs site tracks the current API. Caveat: 1.0.0 was a breaking reset from the long-lived 0.x line (many third-party tutorials still document 0.x APIs); always check the README/docs over blog posts.

## 5. Non-interactive and CI behavior

- **No automatic TTY fallback.** Core's `setRawMode()` helper no-ops when the input stream is not a TTY (`if (i.isTTY) i.setRawMode(value)`, [`packages/core/src/utils/index.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/index.ts)), so a non-interactive run will not crash on raw-mode setup — but `prompt()` still creates a readline interface and waits on stdin ([`packages/core/src/prompts/prompt.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/prompts/prompt.ts)). Clack does **not** detect "no human attached" for you and fall back to defaults; the caller must guard. For this repo that means: check `process.stdin.isTTY` (and/or a `--yes` flag) before ever importing/calling a prompt, and otherwise read `WORKBENCH_SOURCE_ROOT` / `WORKBENCH_PORT` as today.
- **Spinner CI mode.** `isCI()` is `process.env.CI === 'true'` ([`packages/prompts/src/common.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/common.ts)); when set, the spinner stops erasing frames — it writes a newline per update instead of clearing, and skips redundant re-renders ([`packages/prompts/src/spinner.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/spinner.ts)) — so CI logs stay line-oriented. This makes a `spinner` around the sync step safe in automation **if** the CI branch is non-prompt (spinners/log/status lines only, never `text`/`select`).
- **Accessibility mode.** `ACCESSIBLE` env var or `settings.accessible` switches prompts to static output ([`packages/core/src/utils/settings.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/settings.ts)) — a second, documented lever for constrained environments.
- **Programmatic cancellation.** The `signal: AbortSignal` option cancels a prompt from code (e.g. expire an `init` prompt after N seconds in CI) — supported since 0.9.0 ([release notes](https://github.com/bombshell-dev/clack/releases/tag/%40clack%2Fprompts%400.9.0); `signal` handling in `packages/core/src/prompts/prompt.ts`).
- **Testing story: good, and first-party.** Every prompt takes `input`/`output` streams, and clack's own suites drive prompts that way — `MockReadable`/`MockWritable` (plain `node:stream` subclasses with pushed keypress buffers and captured writes) in [`packages/prompts/test/test-utils.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/test/test-utils.ts) and [`packages/core/test/mock-readable.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/test/mock-readable.ts). The same pattern ports directly to this repo's `node --test scripts/*.test.mjs` setup (`package.json`) with no extra test dependencies — inject two mock streams, push key events, assert on the captured output. The docs site itself has no testing page; the source tests are the reference.

## 6. Where it fits in THIS codebase (ordered, by value/risk)

Grounding: `bin.mjs` today reads `WORKBENCH_SOURCE_ROOT` (default: cwd) and `WORKBENCH_PORT` (default: `4051`) from env, then `spawnSync`es `scripts/sync-data.mjs`, `vp fmt`, and `vp dev --strictPort`, with `stdio: "inherit"` and `process.exit` on non-zero status. `scripts/sync-data.mjs` resolves the source root, loads `workbench.config.json` via `loadWorkbenchConfig` (`scripts/config.mjs`), walks `docs/plans/**` and `openspec/changes/`, fetches configured services, and writes `src/data.generated.ts`, logging two `console.log` lines. `scripts/config.mjs` validates with hand-rolled `stringValue`/`httpUrlValue`/`normalizeTheme`/`normalizeServices` helpers that throw plain `Error`s. Config shape: `projectName`, `repositoryUrl`, `theme` (aliased hex colors), `services[]` (`github`/`gitlab`/`asana`/`notion`, `tokenEnv` name only — tokens never in config).

1. **`workbench init` — interactive config scaffolding** _(do first; the main win)_. A new opt-in entry (e.g. `bin.mjs` dispatches `process.argv[2] === "init"` to `scripts/init.mjs` before the sync path) that builds a `workbench.config.json`:
   - `intro('workbench init')`, then `text` for `projectName` (default from cwd/repo name), `text` for `repositoryUrl` — or `autocomplete`/`select` over `git remote -v` results — and `multiselect` for which service types to enable.
   - Per selected service, conditional prompts (`select` for `type` already implies the shape; `text` for `repo`/`projectId`/`projectGid`/`dataSourceId`, `text` for `tokenEnv` with `placeholder: "GITHUB_TOKEN"`), rendered only when relevant — exactly the "progressive disclosure" pattern from the [best-practices guide](https://bomb.sh/docs/clack/guides/best-practices). `group` is a good fit for the fixed prefix (name → repo URL → services) with one shared `onCancel`.
   - **Zod 4 tie-in:** pass a Zod schema straight as `validate` on the `text`/`select` prompts — clack accepts any Standard Schema v1 object since 1.5.0 ([`packages/core/src/utils/validation.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/validation.ts); sync-only, so use `z.string().min(1)`-style sync checks, not async refinements). Zod 4 implements Standard Schema natively (the same property this repo already relies on for TanStack Router `validateSearch`, per [effect-adoption.md](./effect-adoption.md)). Practical split: per-field Zod schemas inside prompts for instant feedback, then run the whole collected object through a full config schema + the existing `loadWorkbenchConfig` normalization before writing the file, so `init` output is guaranteed to load.
   - Finish with `fs.writeFile` + `outro('Created workbench.config.json')`; on `isCancel` anywhere, `cancel('No changes written.')` and `process.exit(0)` — `init` must be all-or-nothing so a half-written config never ships.
2. **TTY/CI guard before any prompting.** In `init`, bail to a printed recipe when `!process.stdin.isTTY || process.env.CI === 'true'`: log the env vars to set instead (`log.info('Non-interactive: set WORKBENCH_SOURCE_ROOT and WORKBENCH_PORT')`) and exit 0. Clack will not do this for you (§5). Alternatively pass an `AbortSignal.timeout(...)` per prompt as a belt-and-braces expiry.
3. **Clack-formatted status output around the sync step** _(second; low risk)_. Where `bin.mjs` owns output, replace the bare `console.log` bookends with `intro('workbench')` / `outro(...)`, and report the sync result via `log.success('Synced N tickets, M plans...')` or a `spinner` (`s.start('Syncing data')` → `s.stop('Synced data')`) driven from `sync-data.mjs`'s summary. In CI (`CI=true`) the spinner already degrades to plain lines (§5), and in the default path you can keep `stdio: "inherit"` untouched — adopt clack output only in the codepaths that format, not inside the child-process passthrough. If `sync-data.mjs` itself is ever refactored to report sub-steps (ledger, plan tickets, services), `tasks` is the natural shape; until then one `spinner` suffices.
4. **`confirm` before destructive operations** _(third)_. Today nothing in `scripts/` is destructive, so there is nothing to guard — but the moment a script gains an overwrite/delete (e.g. regenerating `src/data.generated.ts` when it has local edits, or an `init` that would overwrite an existing `workbench.config.json`), gate it with `confirm({ message: 'Overwrite workbench.config.json?' })` + `isCancel` handling. Note the pattern is only meaningful in the interactive branch from step 2; non-interactive runs should require an explicit flag instead of a prompt.
5. **Not recommended now:** `progress` (sync is a single opaque child process with `stdio: "inherit"`, so there is no step count to advance), `stream`/`taskLog` (no streaming output source), `@clack/core` custom renders (the default styling is fine and consistent), and any prompt in the default `bin.mjs` path — the installed-package flow (`npx @quick-release/workbench`) must keep working with zero keystrokes, exactly the property `resolveSourceRoot`'s cwd fallback in `scripts/sync-data.mjs` was built to protect.

## 7. Zod / Effect interplay

- **Zod: direct, first-class.** `validate` accepts any Standard Schema v1 object and reads `~standard.validate()` synchronously ([`packages/core/src/utils/validation.ts`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/validation.ts)); Zod 4 implements Standard Schema (the repo's existing Zod 4.4.3 dependency, used for TanStack Router — [effect-adoption.md](./effect-adoption.md)). So `text({ message, validate: z.string().regex(...) })` works with zero adapters. Caveat: async validation throws (`'Schema validation must be synchronous'`), so keep prompt-level schemas sync.
- **Effect: none documented, none needed.** A GitHub issue search for "zod" returns 0 results and "effect" only matches the English word in unrelated threads (searched 2026-09-03). No Effect-TS integration exists or is claimed anywhere in the repo or docs. If the Effect adoption from [effect-adoption.md](./effect-adoption.md) proceeds, the sensible composition is: run `Effect.gen` flows _around_ prompts (prompt results as plain values entering the Effect program), not through them.

## 8. Integration constraints for this repo

- **ESM:** required and satisfied — clack 1.x is ESM-only; this repo is `"type": "module"` with `.mjs` entry points (`package.json`, `bin.mjs`). Static `import * as p from '@clack/prompts'` works as-is.
- **Subpath exports:** only `.` and `./package.json` are exported (registry `exports` map, 1.7.0) — no deep imports like `@clack/prompts/spinner`; import everything from the root. This is fine: ~114 KB unpacked, and there is nothing to tree-shake in a CLI that loads once.
- **Dependency bloat for the published package:** minimal — 5 packages total in the closure (§2), all pure JS, no install scripts. `@quick-release/workbench` publishes to GitHub Packages (`publishConfig.registry: npm.pkg.github.com`), and its dependencies still resolve from the public npm registry as long as CI's `.npmrc` scopes only `@quick-release` to GitHub Packages (the current publish setup already does this for `@clack/changesets`, a public-npm dependency — `package.json`). Adding `@clack/prompts` changes nothing about registry topology.
- **TypeScript types:** bundled `dist/index.d.mts` (registry `types` field); the source is fully typed and recent releases added extensive JSDoc on `text`, `password`, `multiline`, `date`, `limit-options`, and `messages` (1.5.1/1.3.0 release notes). This repo's scripts are plain JS (`.mjs`), so types only benefit editors — no `tsconfig` impact.
- **Node floor:** clack needs ≥ 20.12.0; the repo has no `engines` field and runs Node 26.7.0 in dev. If a floor is ever declared for `@quick-release/workbench`, it must be ≥ 20.12.0 to include clack.
- **Version pinning:** `@clack/prompts` 1.7.0 pins `@clack/core` **exactly** (`1.4.3`, registry deps), so the two always move together; the 1.x line is stable post-reset and feature releases are monthly minors — a caret range (`^1.7.0`) is reasonable.

## 9. Alternatives, briefly

- **`prompts` (terkelg) 2.4.2** — tiny and pleasant, but the last publish was 2021-10-07 (npm) and it lacks clack's `group`/`tasks`/`spinner` orchestration, Standard Schema `validate`, and first-party test harness; not the pick for new code.
- **`@inquirer/prompts` 8.7.1** — the most mature and robust option (published 2026-09-02, npm), and its `CancelSignal`-style error handling is comparable; but it pulls 10 scoped runtime packages (registry deps) versus clack's 4, and its node floor (`>=23.5.0 || ^22.13.0 || ^20.17.0`) is narrower than this repo's effective floor. A fine choice; clack wins here on bundle weight, the single-symbol `isCancel` ergonomics this plan leans on, and Zod-as-`validate`.
- **`enquirer` 2.4.1** — last published 2023-07-28 (npm); effectively dormant. Not the pick.

## Sources

All checked 2026-09-03 unless noted.

- https://github.com/bombshell-dev/clack (repo metadata: stars, issues, license, push date)
- https://github.com/bombshell-dev/clack/blob/main/README.md
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/README.md
- https://github.com/bombshell-dev/clack/blob/main/packages/core/README.md
- https://github.com/bombshell-dev/clack/blob/main/packages/core/LICENSE (root `LICENSE` points here; MIT)
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/index.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/common.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/text.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/spinner.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/messages.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/prompts/test/test-utils.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/src/index.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/src/prompts/prompt.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/index.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/settings.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/validation.ts
- https://github.com/bombshell-dev/clack/blob/main/packages/core/test/mock-readable.ts
- https://github.com/bombshell-dev/clack/releases (release notes for prompts 0.7.0–1.7.0 and core 1.x; Standard Schema support in 1.5.0, ESM-only in 1.0.0, engines in 1.3.0, `signal`/`updateSettings` in 0.9.0, `stream` in 0.10.0)
- https://api.github.com/repos/bombshell-dev/clack (metadata), `/commits/main` (HEAD `37fca4eb7277`, 2026-08-15), `/contributors`, `/orgs/bombshell-dev/repos` (org: `args`, `tab`, docs)
- https://api.github.com/repos/natemoo-re/clack (redirects to bombshell-dev/clack — transfer confirmed)
- GitHub issue search `repo:bombshell-dev/clack zod` (0 results) and `effect` (no Effect-TS interplay), 2026-09-03
- https://bomb.sh/docs/clack/basics/getting-started/
- https://bomb.sh/docs/clack/guides/best-practices
- https://bomb.sh/docs/clack/packages/prompts (API reference)
- https://www.npmjs.com/package/@clack/prompts (1.7.0 / dist-tags / time / deps / engines / exports / unpacked size, via `npm view` and registry API)
- https://www.npmjs.com/package/@clack/core (1.4.3 metadata as above)
- https://www.npmjs.com/package/prompts (2.4.2, published 2021-10-07)
- https://www.npmjs.com/package/@inquirer/prompts (8.7.1, published 2026-09-02, deps + engines)
- https://www.npmjs.com/package/enquirer (2.4.1, published 2023-07-28)
- https://github.com/standard-schema/standard-schema (Standard Schema v1 contract, linked from clack's `validation.ts`)
- Repo files read: `package.json`, `bin.mjs`, `scripts/sync-data.mjs`, `scripts/config.mjs`, `workbench.config.example.json`, `workbench.config.schema.json`, `docs/research/effect-adoption.md`
