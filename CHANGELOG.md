# @quick-release/workbench

## 0.5.0

### Minor Changes

- 9bc16d9: One-shot "draft description" AI endpoint on the dev server: `POST /api/ai/draft` returns a structured draft title and body for a pull request via one typed TanStack AI round-trip, assembled from the PR record plus the host repo's commit-subject style; `GET /api/ai/health` reports provider-key availability. Lands behind a shared, contract-tested loopback/same-origin request gate (#37).
- e05bba8: Open pull requests of the host repo sync into the snapshot as a first-class record family (number, title, head/base, author, draft flag, body) — collected page-capped and fail-soft beside the other tracker-backed families, and reported in the sync summary (#79).

## 0.4.0

### Minor Changes

- 9627d15: Session handoffs lens on the Agent sessions page: the sessions collector counts Skill tool calls per session (still reading only the session database), and the new Handoffs lens joins the recorded parent links into trees with per-session skill-call counts and honest gap/cycle caveats — observed only, never acted on. (#65)

## 0.3.0

### Minor Changes

- 3b65273: Land the blocker graph view at `/blockers` (spec #54, ticket #61). The approved prototype ports behind the GraphView seam: depth columns from a pure longest-path layout (blockers left, blocked right), closed tickets contracted behind an expand toggle, frontier highlighting, and the edge grammar — solid amber open gates, dashed gray satisfied edges, dashed red broken references that fail closed as warning nodes. The execution seam gains blocker-edge add/remove endpoints over the native blocked-by API (removal confirmed, destructive), and the shared issue panel carries both actions, degrading to copy-the-command on static builds. Effort, focus, and expand ride the `?effort`/`?focus`/`?expand` params; the panel's show-in-graph jump lands focused.
- bbf69e1: Retire the legacy ledger (spec #54, ticket #66). The eight-value ticket status vocabulary, the truncated dependencies display string, the ledger snapshot arrays (tickets, plans, spec changes) and their parsers — the normalizeStatus string heuristics, the dashboard-plan ledger row parser, and the legacy local `Status:` line mapping — and the TicketTable, PlanTable, and SpecPanel components with their tests are deleted; the Overview keeps the next-action hero, the frontier strip, in-flight rows, and the sync trigger, with the workflow-views toggle and status/stream/source lenses gone. Display derives entirely from tracker-backed records (work items, maps, blocker edges, decisions, artifacts); local ticket files remain an edge-declaring surface, contributing ids and `Blocked by:` lines only. The generic service adapters stay in place and keep reporting their sync statuses and counts into the snapshot (only the retired Notion Dependencies read is removed), but their task records no longer enter the snapshot. The README and header badge state the control-surface posture — live reads and actions through the one validated localhost execution seam (ADR 0005); the telemetry contract is unchanged.
- cb556cc: Land the Skill flow view at /flow with the skills-ecosystem Catalog (spec #54, ticket #58). Sync fetches the Catalog from mattpocock/skills (one recursive trees call, fail-open to last-good data and then the curated offline fallback) and snapshots installed state for static degradation; the execution seam serves the Catalog joined with live disk state and gains a per-skill install endpoint. The flow graph renders hand-rolled SVG behind the new GraphView seam with pure deterministic layout modules ported from the approved prototype; uninstalled entries dim, upstream-new skills land on the shelf, favorites become a filter, and the skills route retires for one Catalog home.

### Patch Changes

- b63b94f: Load environment variables through dotenvx. Package scripts (`sync`, `worker:*`, and the demo entries) run via `dotenvx run`; the new gitignored `.env` is seeded from `.env.example` on first run, and the committed `.env.demo` replaces the inline `WORKBENCH_DEMO_SOURCE=1` prefix. Dev-workflow only — the published CLI and host repositories are unchanged.
- 8326189: The `pnpm test` gate is green again on Node 22 and 24 (issue #69). The init suite drives clack through synthesized keypress events instead of raw keystroke bytes, whose terminal decoding garbled control keys on mock streams and deadlocked the interactive flow. Cancelling at the token-env prompt no longer crashes `runInit` with a TypeError; the cancel flows out to the caller's `isCancel` check like every other prompt.

## 0.2.1

### Patch Changes

- 9604f0f: Deploy the telemetry ingest Worker and its D1 store with Alchemy (infrastructure-as-Effects): `alchemy.run.ts` is now the deploy surface (`pnpm worker:deploy` / `worker:dev` / `worker:tail`), `worker/schema.sql` moved to `worker/migrations/0001_init.sql` and is applied by deploys, and Effect moves to the v4 RC (`4.0.0-rc.112`). `worker/wrangler.jsonc` stays as the script-only escape hatch.
- 48c0c82: Adopt a dark neutral-charcoal default theme: `#14151b` background (sidebar shares it), `#191a24` panels, white `#ffffff` text, rust `#c44900` accent, plum-anchored info triad. Sidebar nav links read as plain text on the sidebar background (active item marked by weight, not a fill); orange stays for highlights. Also fixes the vendored sidebar menu buttons matching their `data-active` styles regardless of state (presence-based selector vs React's `data-active="false"`). Host configs overriding `theme` keep working unchanged.
- 48c0c82: Switch all typeface roles (sans, display, and the mono used by code/IDs/metric values) to self-hosted Inter Variable (`@fontsource-variable/inter`, bundled locally — no CDN), with tabular figures enabled globally so numeric columns and metric values align.
- 61a51d3: Add the telemetry ingest worker (Cloudflare Worker + D1 schema, under `worker/`). It is internal company tooling for the repo and is not part of the published package.

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
