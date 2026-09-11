# @quick-release/workbench

## 0.13.0

### Minor Changes

- d2c53f2: Client-first work policy, step 3 of 3 (issue #136, ADR 0012): the bug gate is now enforced at the seam, and the dashboard's live state refreshes on a documented cadence. Every issue-agent start re-checks the client policy server-side — the target issue resolves through the host's own gh, the open client-bug set revalidates with a bounded live label read immediately before the spawn, and validated prerequisites are real blocker edges whose blocked side is a live-open client bug. Denials are typed (`client_bugs_open` with repository-scoped blocking references, `client_priority_unverified`, `target_not_open`), carry 403 status, release the claimed engine slot, and render in the agent panel with the blocking tickets spelled out; PR reviews stay ungated, and unknown, closed, or unclassifiable targets fail closed. The shared workflow atom gains a refresh lifecycle: coalesced ~60s polling while the tab is visible (backing off to five minutes on errors, stopping in static mode), an immediate re-read on tab focus, and a header chip showing the last successful check or the retrying state — slow or foreign-repo answers never overwrite newer state. The gh issue-view normalization is shared by both seam surfaces.
- 55f166f: Client-first work policy, step 1 of 3 (issue #136, ADR 0012): the tracker preserves each work item's source labels and creation/update timestamps, discovers client tickets by bounded label-specific paginated reads under the OR of `client-bug`/`client-feedback`, and reports explicit client coverage — a capped or failed pass is unknown client state, never "no client tickets". Pagination continuation now counts raw pages, so a full issue-list page mixing pull requests no longer stops the walk early. A pure shared policy module (`src/lib/client-priority.ts`) derives classification (exact normalized label match, bug tier winning doubles, feedback-plus-`bug` upgraded to bug treatment), client attention, tier ordering with a deterministic issue-number fallback, and the fail-closed feature-start gate verdicts (`client_bugs_open`, `client_priority_unverified`, `target_not_open`); the snapshot and seam payload carry the coverage, and older snapshots decode as unknown, which the policy treats fail-closed. UI, enforcement wiring, and the refresh lifecycle follow in steps 2 and 3.
- aa3c5c4: Client-first work policy, step 2 of 3 (issue #136, ADR 0012): the Client Tickets surface and client-aware ranking. New `/client-tickets` view beside Overview — every open client ticket by default (not just the executable frontier), with URL-backed filters for Bugs / Feedback & requests / All, ownership, waiting/blocked, and text search; the shared issue detail panel deep-links via `?issue=NN`; unfiltered open totals stay visible behind any filter; issue age and last update render as plain data, never an SLA; a Closed lens reads a bounded, label-specific history (one page per label, most recently updated first) through the new `GET /api/client-tickets/closed` seam read, naming completed and not-planned closures as GitHub does. The shell grows persistent open-client counts (distinct bug count) in the header, a badge on the nav entry, and a persistent banner while any client bug is open — "new feature starts paused" — on every page, in text and icon, never color alone. The Overview gains a Client attention section above ordinary work with ownership and waiting/blocked explanations; the recommendation engine reads a `client-action` bucket first (remediation for grabbable ready client bugs, triage for untriaged ones — waiting client work is attention, never a recommendation); triage lanes, in-flight lists, and the frontier strip sort client tickets ahead of internal work. Unknown or incomplete client coverage renders as a visible warning everywhere — never a quiet zero.

## 0.12.0

### Minor Changes

- 65a6428: Standards follow-ups from the #74 review batch, plus the recorded review-gate decision. The blocker-graph view speaks CONTEXT.md's vocabulary — the deep link is now `/blockers?map=GH-NN&focus=NN` (was `?effort=`), and the picker's aria label and empty-state copy say Map. The triage view reads the shared workflow atom instead of its own live-read fetch, so its rows, panel, and every other view see one state. The sync trigger's warnings channel is structured: sync writes a `syncWarnings` export into the generated snapshot module and the seam reads it from the same mtime-keyed import instead of scraping the "Tracker warnings (N)" console copy (older generated modules degrade to an empty channel). Two new lib modules gather the duplicated logic — `work-item-id.ts` (the namespaced id grammar: namespace, number, `#NN` label, stable id order, issue-number sort) and `map-order.ts` (the map-order tiebreak) — and `IssuePanelHost` replaces the panel wiring repeated across the overview, blockers, and triage routes. Comments citing the prototype-branch ADR 0010/0011 now repoint at the in-code tables they describe. CodeRabbit's automatic PR review is disabled; a human's review and explicit merge instruction are the gate (ADR 0011).

## 0.11.0

### Minor Changes

- e536056: Review run lifecycle (issue 26, epic 20): `POST /api/review` starts an engine run and streams the runner's typed events as server-sent events; `POST /api/review/cancel` stops it. The registry enforces one active run per engine with a typed busy rejection, a hung CLI run times out with a readable error, cancellation escalates from SIGTERM to SIGKILL so the process tree actually dies, and output is capped with a distinct truncation marker. The PR page grows per-PR review actions gated on each engine's health verdict, a live output panel, and the cancel affordance. Also here: the five API middlewares now share one guarded wrapper (URL parse, `next(error)` forwarding, one JSON writer), route tests are first-class, and the domain vocabulary records review engines and review runs.
- 03cab2b: Engine health checks with actionable setup guidance (issue 24, epic 20). New review-runner seam: `scripts/review-runner.mjs` probes the CodeRabbit and zcode CLIs through an injected spawn — binary found (with version), auth / provider status — as typed states, never running a review. The dev server answers `GET /api/review/health` behind the shared request gate with the payload validated at the Effect Schema boundary, and the pull-requests page probes it on load: each engine renders ready or not-ready with its one-step remediation command (`brew install coderabbit`, `coderabbit auth login --api-key …`, `zcode login`), and a not-ready engine is given no start affordance.
- 129e383: Opt-in posting of review findings as a PR comment (issue 25, epic 20). New `scripts/review-comment.mjs` runner operation: a completed review's findings post as one comment on the reviewed PR through the Developer's local `gh` (env-var-first token resolution via gh itself), with the write as the ground truth for authentication — a missing binary or a missing/rejected login surfaces as a named, one-step-fixable state (`brew install gh`, `gh auth login`) instead of an opaque failure. The dev server answers `POST /api/review/comment` behind the shared request gate — the request is enumerated (`engine`, `pr`, `findings`; the comment body is composed server-side with the engine and PR attribution) and validated at the Effect Schema boundary in both directions. The dashboard's `ReviewCommentAction` renders the explicit confirmation beat: nothing is ever sent without it, cancelling sends nothing, and success and failure both surface (the posted comment's link, or the remediation). Mounting the action under a completed review run lands with the run-lifecycle slice (#26).
- 38fc335: Session run history with re-run (issue 27, epic 20). The dev server now records every finished review run — engine, PR, outcome (completed / failed / cancelled / timed out), duration, and the streamed output — and answers `GET /api/review/history` with the list, newest first, behind the shared request gate and the Effect Schema boundary. The pull-requests page lists the session's runs, re-opens any run's streamed result without re-running it, and re-runs an entry with one click through the normal start path (single-run-per-engine and the confirmation-free local posture unchanged). History is in-memory on the dev server only: a restart resets it, and an empty session renders its own empty state.

### Patch Changes

- 0107b79: Fixed: git probes no longer inherit the caller's git context. A pre-commit hook exports `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` to everything it spawns — including the test suite behind the new pre-commit gate — which redirected `workbench init`'s origin probe (deadlocking its suite) and made `prepare`'s repo detection treat any directory as a repository (pointing the caller's `core.hooksPath` at workbench). The init and prepare git subprocesses, and the suites' fixture git calls, now strip that context.
- 633993a: Fixed the Highlights Submit action: the submission client now pins the wire body to the seam's contract fields, so a Submission no longer fails the seam's excess-property validation when the page's candidate carries its display date — every real Submit was being rejected as `malformed_request`. The seam schema rejects excess properties by design; the client, not the caller, owns the payload. Also adds the interactive Submit coverage ticket #18 asked for: a happy-dom component test that clicks a rendered Submit button and asserts the network boundary receives exactly the contract payload, plus a client-level unit pin.

## 0.10.0

### Minor Changes

- 18f8a36: Telemetry and the Submission flow land (ticket #12): every sync now reports one payload per Developer per host repo per UTC day to the company endpoint — identity via `gh` falling back to git email (nullable), workbench version/OS/Node, session aggregates when the host's sessions opt-in is on (omitted otherwise), the Developer's GitHub Outcomes over a rolling 30 days (opened, merged, median time-to-merge), and buffered health errors. Daily dedup uses a git-ignored local marker; delivery failures are logged and swallowed; demo mode and an unconfigured endpoint send nothing. The Highlights page gains its Submit action: the browser POSTs the candidate to a localhost seam that attaches the repo remote and ingest token server-side and forwards to the Worker's review queue, with immediate per-candidate confirmation. ADR 0001 posture throughout — telemetry is numbers-only; content moves only through an explicit Submission.

## 0.9.0

### Minor Changes

- 77ba915: Highlights (ticket #17): sync now reads the host repo's recent commit log with bodies and folds the v1 candidate set into the snapshot — messages with a body beyond the subject that reference a ticket or issue, capped to the most recent 30. A new read-only Highlights page renders the candidates (subject, body, author, date, ticket reference) behind an explainer card stating the consent posture: nothing leaves the machine until an explicit Submission. Entirely local — no network anywhere in the slice.

## 0.8.0

### Minor Changes

- 877b9e4: Session capture (ticket #35): the ingest worker gains an opt-in LLM capture proxy on `/llm/anthropic/` — agents point their provider base URL at the worker, which swaps credentials, relays responses untouched (streamed), and records bodies in a new R2 bucket plus one queryable metadata row per request in D1 (usage parsed server-side, duplicates forward-and-store-once, provider errors relayed verbatim). Authenticated read APIs serve a session index and per-session transcripts; the dashboard gains a session-capture page that renders the conversation redacted at render time with a visible ledger. Onboarding is a provider base-URL swap documented in `worker/README.md`; the R2 bucket and provider key join the alchemy stack.

## 0.7.0

### Minor Changes

- 891b142: The `SubmissionReviewAgent` now measures the review backlog on a schedule (ticket #33): waking an agent arms the Agents SDK's scheduler with one daily tick per repository that computes and persists the digest with no incoming request. The scheduler is an optimization, never a correctness dependency — a missed tick self-corrects on the next authenticated on-demand request, which recomputes from the current pending rows. The tick interval is a plain binding (`DIGEST_TICK_INTERVAL_SECONDS`, default 86,400 seconds) so the workerd suite drives it at one second through the runtime's alarm invocation.

### Patch Changes

- e0c2c1b: The `SubmissionReviewAgent` digest route is hardened (#32 review follow-ups): concurrent digest runs for one repository are serialized around the D1 round-trip so the previous-run chain cannot scramble, non-GET methods answer `405` instead of triggering a run, and a repository identity that does not percent-decode answers `400` instead of an unhandled 500.

## 0.6.0

### Minor Changes

- c5cb781: The Cloudflare Agents SDK (pinned to `agents` 0.22.0) lands additively in the telemetry worker behind the existing ingest token gate: the `SubmissionReviewAgent` runs as a SQLite-backed Durable Object keyed one-instance-per-repository, its `/agents/submission-review-agent/<repo>` route mounts strictly after the constant-time bearer-token check (healthz stays unauthenticated), the alchemy stack declares the DO binding with the SQLite-class migration derived automatically, the bare-wrangler escape hatch carries the equivalent binding plus manual migration, and the dependency joins the Renovate weekly group (#31).
- 0a40728: `computeDigest` in `worker/digest.mjs`: a pure, runtime-free function that turns pending-submission rows into a maintainer digest — total count, fresh/aging/stale age buckets, oldest age, and an oldest-first item list — with `now` injected so the output is deterministic. This is the stable compute seam a future AI summarizer plugs into (#30).
- 37d8e80: The `SubmissionReviewAgent` now serves the digest (ticket #32): an authenticated request to `/agents/submission-review-agent/<repo>` returns the repository's pending-submission digest — computed by the pure `computeDigest` from rows read through the existing D1 binding — alongside the previous run's persisted digest, so each on-demand run reports what changed since the last review pass. The worker test harness applies the D1 migrations to the workerd suite's database via the plugin's `readD1Migrations`/`applyD1Migrations` pattern.
- 1435b72: Pull-requests page: the open host-repo pull requests render from the synced snapshot (read-only rows with number, title, author, head → base, and draft flag) behind a new sidebar entry, and each row carries a one-shot "Draft description" action that posts only the PR number to the dev-server draft endpoint, shows a drafting state, and renders the returned title and body in a copyable panel; an in-flight draft is aborted by the next one, failures render readable errors, and a missing provider key renders a configuration hint instead of a broken action (#38).

### Patch Changes

- 7b81cbb: The ingest worker's HTTP contract is now behaviorally tested inside the real workerd runtime via `@cloudflare/vitest-pool-workers`, running under the standard `pnpm test` command beside the existing runtime-free suites; the vitest config gains a two-project split (dashboard pool + workers pool) with the dashboard project carrying its own plugins and alias (#29).

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
