# An Agent-Session Usage Page for Workbench (`/sessions`)

**Date:** 2026-09-03
**Sources:** primary only — the local ZCode CLI sqlite database (`~/.zcode/cli/db/db.sqlite`, inspected read-only via `sqlite3`), ZCode rollout logs (`~/.zcode/cli/rollout/`), this repository's source (`scripts/sync-data.mjs`, `src/**`, `workbench.config.*`), the Node.js `node:sqlite` API docs, and the npm registry (queried live on this date). Session ids are redacted to short prefixes; no message bodies, titles, or transcript contents are quoted.

## Question

Can Workbench get a new page that tracks all the agent sessions used to create tickets and code — with usage charts, e.g. comparing code produced via GLM 5.3 Flash vs GPT 5.6 Luna — given that ZCode stores per-request model telemetry locally?

## TL;DR

**Verdict: feasible, and the hard part is already done.** ZCode CLI's local database already records every model request with `model_id`, token counts, duration, session id, and timestamps (`model_usage`, `turn_usage` tables), plus per-session metadata (`session`). A sync step can read that database with **zero new dependencies** (`node:sqlite`, built into Node ≥ 22.13 unflagged; release-candidate from v25.7), fold pre-aggregated rows into the existing `src/data.generated.ts` snapshot, and a file-based `/sessions` route can render charts as **hand-rolled SVG/CSS** — no chart library. The shortest path is: opt-in `scripts/sessions.mjs` → `sessions` key on `OverviewData` (extend `src/types.ts` + `src/schema.ts` together, because the parser rejects excess properties) → `src/routes/sessions.tsx` → SVG bar charts.

**Two caveats found in the data.** (1) On this machine every `session.summary_additions/deletions/files` is NULL (0 of 21 sessions populated), so "code created per model" has no first-class source yet — the working proxies are model output tokens and Edit/Write tool-call counts. (2) Only one model id appears locally (`GLM-5.3-Flash`, 733 requests); a GLM-vs-Luna chart works the moment a second model is actually used, but today it would have a single bar.

---

## Where the data lives

### The sqlite database (primary source)

`~/.zcode/cli/db/db.sqlite` (WAL mode; `-shm`/`-wal` siblings present). Row counts measured 2026-09-03: `session` 21, `message` 841, `part` 3526, `model_usage` 730, `turn_usage` 43, `tool_usage` 922, `todo` 76, `session_entry` 132, `session_input` 39, `input_history` 35. **Empty on this machine:** `session_task_link`, `session_target`, `workflow_*` (all 0 rows), `permission`. **There is no `project` table** — `session.project_id` is a directory-derived slug (path with `/` folded to `-`, e.g. `proj_users-…-workbench`), so the directory mapping lives in `session.directory` (absolute path).

Tables that matter for this feature:

- **`session`** — one row per session (interactive or subagent). Columns: `id`, `parent_id` (NULL for root; set for subagent children), `task_type` (`'interactive'` 12 / `'subagent_child'` 9 locally), `directory`, `title`, `slug`, `project_id`, `workspace_id`, `share_url`, **`summary_additions` / `summary_deletions` / `summary_files` / `summary_diffs`** (all NULL locally — see Limitations), `time_created`/`time_updated` (ms epoch), `title_source`, `trace_id`.
- **`model_usage`** — one row per model request; this is the core of any model-comparison chart. Columns include `session_id`, `turn_id`, `query_source` (`main_turn` 560 / `subagent` 161 / `session_title` 12 locally), `provider_id`, `model_id`, `variant`, `agent`, `status` (`running|completed|error|cancelled`), `started_at`/`completed_at`/`duration_ms`/`time_to_first_token_ms`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `tool_call_count`, `retry_count`, `error_type`. Locally: 733 requests, all `builtin:zai-coding-plan / GLM-5.3-Flash`; agent breakdown `zcode-agent` 572, `zcode-general-purpose` 147, `zcode-Explore` 14.
- **`turn_usage`** — one row per user turn, PK (`session_id`, `turn_id`), with rollup counts (`model_request_count`, `tool_call_count`, token sums, `duration_ms`). Joins cleanly: 688 of 730 `model_usage` rows match a `turn_usage` row on (`session_id`, `turn_id`).
- **`tool_usage`** — one row per tool call (`tool_name`, `status`, `duration_ms`, `read_only`, `destructive`, byte sizes). Local distribution: `Bash` 497, `Read` 152, `Edit` 75, `WebFetch` 68, `Write` 40, … — Edit+Write counts are the best available per-session "code touched" proxy.
- **`session_task_link`** — links `child_session_id` → `parent_session_id` → `root_workflow_run_id` with `role`, `depth`, `path`, and a `model` column. This is the intended attribution tree for orchestrated runs, but it is only populated for workflow runs (0 rows here). Subagent attribution otherwise falls back to `session.parent_id`.
- **`session_target`, `message`, `part`, `todo`, `session_input`, `input_history`, `session_entry`** — transcripts, todos, and queued inputs. Not needed for charts; avoid them (privacy + size).

### Rollout logs (avoid)

`~/.zcode/cli/rollout/model-io-sess_*.jsonl` — one file per session (3 locally), each line: `completedAt`, `durationMs`, `startedAt`, `requestId`, `attempt`, `sessionId`, `turnId`, `traceId`, `querySource`, `type`, `model` (`{modelId, providerId, role, source, variant}`), `request` (full prompt incl. system prompt and tools), `response` (incl. `usage` `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}` and **`text`**). Every token figure here also exists in `model_usage`, and the JSONL carries full transcripts — sync should read the **DB only**, never these files. `~/Library/Application Support/ZCode/` is Electron/WebView shell state (cookies, caches) with no additional session store.

### Ready-to-use SQL

Tokens per model per day (works today):

```sql
SELECT date(started_at/1000, 'unixepoch')          AS day,
       provider_id || ' / ' || model_id            AS model,
       COUNT(*)                                    AS requests,
       COUNT(DISTINCT session_id)                  AS sessions,
       SUM(input_tokens)                           AS input_tokens,
       SUM(output_tokens)                          AS output_tokens,
       SUM(cache_read_input_tokens)                AS cache_read,
       SUM(duration_ms)                            AS model_ms
FROM model_usage
WHERE status = 'completed'
GROUP BY day, model
ORDER BY day;
```

Additions/deletions per dominant model per session-day (the "code via GLM vs Luna" query; needs `summary_*` to be populated, otherwise substitute `output_tokens`):

```sql
WITH primary_model AS (
  SELECT session_id, model_id,
         ROW_NUMBER() OVER (PARTITION BY session_id
                            ORDER BY SUM(output_tokens) DESC) AS rn
  FROM model_usage WHERE status = 'completed'
  GROUP BY session_id, model_id
)
SELECT date(s.time_created/1000,'unixepoch') AS day,
       pm.model_id                            AS model,
       COUNT(*)                               AS sessions,
       SUM(s.summary_additions)               AS additions,
       SUM(s.summary_deletions)               AS deletions,
       SUM(s.summary_files)                   AS files_changed
FROM session s
JOIN primary_model pm ON pm.session_id = s.id AND pm.rn = 1
GROUP BY day, model ORDER BY day;
```

Per-session rollup for the table view (Edit/Write proxy included):

```sql
SELECT s.id, s.task_type, COALESCE(s.parent_id,'') AS parent_id, s.directory,
       datetime(s.time_created/1000,'unixepoch')   AS started,
       COUNT(DISTINCT mu.id)                       AS requests,
       SUM(mu.output_tokens)                       AS out_tokens,
       SUM(mu.duration_ms)                         AS model_ms,
       SUM(t.edits) AS edits, SUM(t.writes) AS writes
FROM session s
LEFT JOIN model_usage mu ON mu.session_id = s.id AND mu.status='completed'
LEFT JOIN (SELECT session_id,
                  SUM(tool_name='Edit')  AS edits,
                  SUM(tool_name='Write') AS writes
           FROM tool_usage GROUP BY session_id) t ON t.session_id = s.id
GROUP BY s.id ORDER BY s.time_created;
```

## Proposed pipeline

1. **Sync step** — new `scripts/sessions.mjs`, imported by `main()` in `scripts/sync-data.mjs` (which composes the `data` object at `scripts/sync-data.mjs:502-521` and writes `src/data.generated.ts` at `:522-525`). It reads the DB via `node:sqlite`'s `DatabaseSync` with `readOnly: true` (docs: "If `true`, the database is opened in read-only mode"; release-candidate stability since v25.7, unflagged since v22.13/v23.4 — this repo's scripts already require modern Node, v26.7.0 locally). Because the live DB is WAL, the robust pattern is: copy `db.sqlite` (+`-wal`/`-shm`) to a temp dir, open the copy read-only, run the three queries above, delete the copy. The path should default to `~/.zcode/cli/db/db.sqlite` and be **opt-in** (env var or a `workbench.config.json` flag): Workbench is a published npm package (`files` includes `scripts/`, `package.json`), and host repos should not have their `~/.zcode` read unless they ask for it.
2. **Snapshot schema** — add `sessions: { generatedAt, perDay: [...], perModel: [...], sessions: [...] }` to `OverviewData` in `src/types.ts` **and** matching `Schema.Struct` entries in `src/schema.ts`. These must move together: `parseOverviewData` is built with `{ onExcessProperty: "error" }` (`src/schema.ts:115-118`), so a new snapshot key without a schema change fails the build loudly (which is the intended behavior). Aggregate in sync; ship only counts/tokens/dates/model ids — no prompts, no titles unless explicitly wanted.
3. **Route** — TanStack Router here is file-based: `@tanstack/router-plugin` is wired in `vite.config.ts:15` and regenerates `src/routeTree.gen.ts` from `src/routes/` (currently only `__root.tsx`, `index.tsx`). Adding `src/routes/sessions.tsx` with `createFileRoute("/sessions")` is all it takes; `src/router.tsx` and the generated tree need no hand edits. Follow the `index.tsx` pattern: Zod `validateSearch` (model/day-range filters) + `loader: () => overviewData`.
4. **Components** — a `SessionsPage` beside `OverviewPage` reusing the house style: `MetricCard` for headline totals (`src/components/MetricCard.tsx`), the existing panel/eyebrow CSS vocabulary from `src/styles.css` (1,219 lines of hand-rolled CSS; no UI framework), and a sessions table via the existing TanStack Table wiring in `src/lib/table.ts`.

## Charting recommendation

**Hand-rolled SVG/CSS. Rationale:** every chart on this page is a simple aggregate — a per-day stacked bar (tokens or additions by model), a horizontal model-share bar, a session count line. The repo has zero chart deps (nothing matching recharts/chart.js/visx/d3 in `pnpm-lock.yaml`), 100% hand-written CSS, and an explicit minimal, read-only, local-only philosophy (README "Sources" section: the app "does not call GitHub, include credentials, query a ticket database"; adapters are told to stay behind `scripts/services/`). Library reality check against primary registries: `@tanstack/react-chart` has no published releases (empty dist-tags on the npm registry — TanStack Chart is not a drop-in option from the same vendor); `recharts` 3.10.1 declares React 19 peers and is SVG/component-based (npm `peerDependencies`), but pulling a D3-layered chart library for three bar charts works against the repo's grain; `chart.js` 4.5.1 renders to canvas ("Simple HTML5 charts using the canvas element", npm description) and needs the `react-chartjs-2` wrapper — canvas also fights the DOM-rendered, theme-variable-driven styling here. SVG bars over pre-aggregated rollups are ~100 lines of presentational React, fully themeable, and dependency-free. Revisit only if interactive tooltips/zoom on dense time series become a requirement.

## Linking sessions to tickets and code

- **Repo-level:** `session.directory` (and `project_id`) maps 1:1 to a checkout; sync already computes the host root (`resolveSourceRoot`, `scripts/source-root.mjs`), so filtering sessions to the host repo is a path-prefix match.
- **Ticket-level:** there is **no first-class session→ticket foreign key**. `session_task_link` covers workflow-run children only (empty locally). Workable approximations, in increasing cost: (a) repo-level attribution only; (b) time-window overlap between session `time_created…time_updated` and a ticket file's git history (sync already shells out to `git`); (c) a convention — mention the ticket id in the session title or first input and match `BQ-\d+`-style ids, aggregating counts rather than mining transcripts. Recommend (a) plus (c) as opt-in.
- **Code volume:** intended source is `session.summary_additions/deletions/files`; measured fallbacks are `model_usage.output_tokens` (model-attributed) and `tool_usage` Edit/Write counts (session-attributed). Both work today; the summary columns would upgrade query 2 into the exact chart the page promises.

## Limitations & risks

- **Local-machine-only.** The DB lives in one user's home directory; the snapshot only ever reflects the machine that ran `pnpm sync`. Multi-host aggregation needs an export/merge convention (out of scope here).
- **Model attribution gaps.** Model id is per _request_, not per session; a session mixing models needs a "dominant model" rule (query 2's `ROW_NUMBER`). `query_source='session_title'` requests are title-generation noise — filter or bucket separately.
- **`summary_*` is unpopulated** on this machine (0/21). If it stays empty, "code created per model" remains token/tool-call proxies, which are directionally useful but not diffstats.
- **Subagent double-counting optics.** Parent + child sessions each carry their own `model_usage` rows (no double counting at the request level), but root-only vs rolled-up views differ; `task_type='subagent_child'` + `parent_id` support both, and subagent ids share a structural `sess_subagent_agent_…` prefix.
- **Privacy.** The snapshot is generated and git-ignored (`.gitignore`), so local data is never committed — but the page must not become a transcript viewer: keep titles out of the default snapshot, never read `~/.zcode/cli/rollout/*.jsonl` (full prompts/responses), and open the DB read-only against a copy.
- **Published-package surface.** Anything added to `scripts/` ships to every consumer of `@quick-release/workbench`; `node:sqlite` availability depends on the host's Node (≥ 22.13 unflagged) — gate the feature rather than adding a native sqlite dep.
- **DB schema drift.** ZCode owns this schema (see `schema_migration`); columns like `title_source` were added by migration. Pin expectations via the Effect schema at the `src/data.ts` boundary so a drift fails at sync/build, not in the UI.

## Open questions

1. Should the sessions sync be opt-in via `workbench.config.json` (e.g. a `sessions: { enabled, databasePath }` block) or an env var like `WORKBENCH_SESSIONS=1`?
2. Is displaying session _titles_ in the local UI acceptable, or counts-only?
3. When a session's diff summary stays NULL, which proxy is preferred on the charts — output tokens, or Edit+Write tool calls?
4. Should subagent sessions roll up into their parent (token attribution to the "task") or be charted as their own slice?
5. Does multi-machine aggregation matter now, or is single-host acceptable for v1?

## Sources

- `~/.zcode/cli/db/db.sqlite` — `.schema` dump and aggregate queries run 2026-09-03 (`session`, `model_usage`, `turn_usage`, `tool_usage`, `session_task_link`, `session_target`, `workflow_*`, `input_history`, `session_entry`; row counts and DISTINCT model/agent/query_source results quoted above; ids redacted).
- `~/.zcode/cli/rollout/model-io-sess_*.jsonl` — top-level/response/usage key names extracted programmatically (no content quoted).
- `~/Library/Application Support/ZCode/` — directory listing only (Electron shell state).
- `README.md:135-153` (sources + read-only philosophy), `README.md:49-62` (host detection, `WORKBENCH_SOURCE_ROOT`).
- `scripts/sync-data.mjs:413-531` (`main()`, snapshot composition `:502-521`, snapshot write `:522-525`), `scripts/services/index.mjs:16-70` (adapter seam), `scripts/source-root.mjs`.
- `src/types.ts:106-125` (`OverviewData`), `src/schema.ts:91-122` (`OverviewDataSchema`, `onExcessProperty: "error"`), `src/data.ts:1-6`, `src/routes/index.tsx:28-35` (route + Zod search pattern), `src/routes/__root.tsx`, `src/router.tsx:3-9`, `src/routeTree.gen.ts` (generated), `vite.config.ts:15` (`tanstackRouter` plugin), `src/components/MetricCard.tsx`, `src/components/OverviewPage.tsx`, `src/styles.css` (1,219 lines, hand-rolled).
- `package.json` (`files`, scripts, dependency list — no chart library), `pnpm-lock.yaml` (no recharts/chart.js/visx/d3), `.gitignore` (`src/data.generated.ts` ignored).
- Node.js `node:sqlite` docs — added v22.5.0, unflagged v22.13.0/v23.4.0, "Stability: 1.2 - Release candidate" since v25.7.0, `readOnly` option: https://nodejs.org/api/sqlite.html
- npm registry (queried 2026-09-03): `@tanstack/react-chart` (empty dist-tags), `recharts@3.10.1` (peerDeps include `^19.0.0`), `chart.js@4.5.1` ("Simple HTML5 charts using the canvas element"), `react-chartjs-2@5.3.1` (React 19 peers).
- Format reference: `docs/research/effect-adoption.md`.
