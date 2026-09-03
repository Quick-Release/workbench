# @quick-release/workbench

## 0.2.0

### Minor Changes

- 68e44d9: Add an opt-in agent-sessions page. With a `sessions` block in
  `workbench.config.json`, sync reads the local ZCode CLI session database
  read-only (via the built-in `node:sqlite`, against a temporary copy) and the
  new `/sessions` page charts output tokens per day and model share alongside a
  sortable per-session rollup. Only aggregates, model ids, timestamps, and
  session titles enter the git-ignored snapshot; prompts and responses are never
  read.
- cda2c61: Re-skin the app shell to a shadcn dashboard layout: a persistent collapsible sidebar (icon rail on desktop, sheet on mobile) with Overview/Sessions navigation and active-state highlighting, a sticky translucent header carrying the project name, snapshot line, read-only badge, and repository link, and a clean full-height content frame. Per-page duplicated headers, ambient blobs, and the old centered column are gone. Config-driven themes keep driving every color via new sidebar tokens derived from the legacy variable names.
- 810f00b: Add `workbench init`: an interactive subcommand that scaffolds `workbench.config.json` with clack prompts (per-field Zod validation, defaults inferred from git remotes, overwrite confirmation for existing configs). Falls back to a printed setup recipe in non-interactive environments. The default pipeline gains clack-formatted status output (intro, sync spinner, dev-server notice) and stays fully non-interactive.

### Patch Changes

- 68e44d9: Standalone checkouts now choose their data source explicitly: `pnpm dev` reads this repository's own planning sources, while `pnpm dev:demo` (or `WORKBENCH_DEMO_SOURCE=1`, optionally any checkout path) reads the demo checkout at `~/workspaces/getquick/banquinha` for a larger ticket corpus. Host repositories always ignore the demo source.

## 0.1.0

### Minor Changes

- 9ca82ab: First publishable release: host repositories install Workbench as a pinned
  SemVer dependency (`@quick-release/workbench` from GitHub Packages, or
  `github:Quick-Release/workbench#semver:` from release tags) instead of as a
  git submodule, and run it with the `workbench` command.
