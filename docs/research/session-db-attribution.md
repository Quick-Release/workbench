# What the Session Database Can Attribute (`~/.zcode/cli/db/db.sqlite`)

**Date:** 2026-09-04
**Sources:** primary only — the local ZCode CLI sqlite database itself, inspected on this date via `node:sqlite` (`DatabaseSync`, opened `readOnly`) against a **temporary copy** of `db.sqlite` + its `-wal`/`-shm` siblings (same method as `scripts/sessions.mjs:54-60`; the live WAL database was never opened or written). Evidence is schema introspection (`sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`), row counts, and distinct enum-ish values (`tool_name`, `task_type`, `status`, `query_source`, `session_entry.type`, `title_source`, `finish_reason`) plus metadata columns only (titles are included, as they already enter the repo's snapshot). **No prompt or response content was read or quoted; session ids are redacted to short prefixes.** Companion to `docs/research/agent-session-usage-page.md` (2026-09-03), which this doc supersedes on row counts — the database was recreated between the two dates (`schema_migration` now holds 18 migrations, `session.version` = 0.16.5) and gained columns (`session.time_compacting`, `session.time_archived`, `model_usage.task_type`, `model_usage.mode`, `model_usage.logical_request_id`).

## Question

What can the session database attribute per session that a dashboard's session / context-handoff views need: skill invocations, `/clear` and `/compact` boundaries, subagent parent/child trees, task types, and anything else useful for phase boundaries or context hygiene? (Ticket #42.)

## TL;DR

**Four of five attributions are YES.** Skill tool invocations are recorded per session in `tool_usage` (`tool_name='Skill'`, `session_id` never NULL); parent/child trees are real (`session.parent_id` + `task_type='subagent_child'` + a `session_parent_idx` index); task types are a clean two-value enum (`interactive` / `subagent_child`) mirrored on both `session` and `model_usage`; and the request-level rows give a per-session phase timeline including measurable context growth (`input_tokens` 235 → 109,955 across local requests). **The one NO is `/clear` and `/compact` boundaries:** no table or row marks a compaction or reset on this machine — only forward-looking schema hooks exist (`session.time_compacting`, `model_usage.context_exceeded`, both unpopulated). A handoffs view is therefore modelable for sessions, skills, subagents, and context growth, but cannot show in-session compaction/clear events from this source today.

## Inventory (row counts measured 2026-09-04)

| table | rows | role for the dashboard |
|---|---|---|
| `session` | 6 | one row per session (interactive or subagent) |
| `model_usage` | 64 | one row per model request; the phase/context timeline |
| `tool_usage` | 107 | one row per tool call, incl. Skill |
| `part` | 328 | message parts (transcript; avoid — content) |
| `message` | 73 | messages (transcript; avoid — content) |
| `session_entry` | 11 | runtime events (types below) |
| `todo` | 9 | per-session todo list with status |
| `turn_usage` | 3 | per-turn rollups (sparse — see Limitations) |
| `session_input`, `input_history` | 3, 3 | queued/prompted inputs (metadata only) |
| `schema_migration` | 18 | schema versioning |
| `local_setting`, `permission` | 1, 0 | settings |
| `session_target`, `session_task_link`, `workflow_*` | 0 | orchestration scaffolding, empty locally |

Key columns beyond `scripts/sessions.mjs`'s subset: `session` adds `time_compacting`, `time_archived`, `revert`, `title_source`, `title_message_id`, `time_title_updated`, `version`, `share_url`, `summary_additions/deletions/files/diffs`; `model_usage` adds `logical_request_id`, `attempt_index`, `mode`, `task_type`, `finish_reason`, `context_exceeded`, `time_to_first_token_ms`, `reasoning_tokens`, `tool_call_count`, `retry_count`; `tool_usage` adds `side_effect_scope`, `read_only`, `destructive`, `approval_status`, byte sizes, `running`-capable `status`. Join-friendly indexes exist: `session_parent_idx`, `session_task_type_idx`, `tool_usage_session_turn_idx`, `model_usage_session_turn_idx`.

## The five questions

### 1. Skill invocations per session — YES

`tool_usage.tool_name` distinct values (count / distinct sessions): `Read` 58/5, `Bash` 34/5, `Edit` 6/2, **`Skill` 4/3**, `TodoWrite` 3/1, `Agent` 3/1, `Write` 2/1, `WebFetch` 1/1, `TaskOutput` 1/1. `tool_usage.session_id` is `NOT NULL` and 0 of the 4 Skill rows are NULL, so `GROUP BY session_id` attributes them directly (local join check: one interactive session has 1, two `sess_subagent_*` sessions have 1 and 2). Skill rows are `read_only=1, destructive=0, approval_status='none'`, status `completed` 1 / `error` 3 — errors are visible, so failed invocations count too. **Caveat:** the row records only the generic name `Skill`; *which* skill ran lives in the call arguments (content, out of bounds), so the dashboard can chart "skill invocations per session" but not per-named-skill usage from metadata alone.

### 2. `/clear` and `/compact` boundaries — NO (schema hooks only, all unpopulated)

Nothing in the data marks a compaction or reset. Checked: `session.time_compacting` (column exists — **0 of 6** non-null), `session.time_archived` (0), `session.revert` (0), `model_usage.context_exceeded` (0 of 64), `session_entry.type` vocabulary contains only `runtime/bash_shell_selection` (3) and `runtime/workspace_checkpoint` (8) — no compaction/clear event type; message roles extract to only `user`/`assistant` (no summary role); no `time_cleared`-style column exists. `/clear` in practice starts a fresh `session` row (each local task has its own), so clears are visible only as new-session starts, not in-session events. If a compaction ever runs, the hooks (`time_compacting`, `context_exceeded` on `model_usage`/`turn_usage`) are where it would light up — a dashboard should read them, but cannot rely on them today.

### 3. Parent/child session trees — YES

`session.parent_id` is NULL on all 3 `interactive` roots and set on all 3 `subagent_child` rows; locally every child points at one root (`sess_e6e4a836…`, the planning session that spawned them). Children are further recognizable by their `sess_subagent_…` id prefix, and `session_parent_idx` makes the recursive walk cheap. A second, richer tree table — `session_task_link` (`parent_session_id`, `child_session_id`, `root_workflow_run_id`, `role`, `depth`, `path`, `phase`, `model`) — exists but is **0 rows** (workflow-orchestration only), so `parent_id` is the only live edge. `model_usage.parent_user_message_id` / `assistant_message_id` also exist for in-session threading.

### 4. Task types — YES, a two-value enum

`session.task_type`: `interactive` 3, `subagent_child` 3. `model_usage.task_type` (new column) mirrors it per request: `interactive` 49, `subagent_child` 15. Meaning: `interactive` = a top-level user-driven session; `subagent_child` = a session spawned by an agent (matches the `parent_id`/prefix evidence in Q3). `session_task_type_idx` indexes it.

### 5. Everything else useful for phase boundaries and context hygiene

- **Per-request phase timeline:** `model_usage.started_at`/`completed_at`/`duration_ms`/`time_to_first_token_ms` per session give a request timeline (locally 4–24 requests per session, first→last spanning the whole session). `finish_reason` (`stop` 6 / `tool-calls` 61), `attempt_index`/`retry_count`, and `logical_request_id` (unique 64/64 locally — retries would share one) let a view mark pauses, retries, and turn clusters.
- **Context growth is measurable:** completed requests carry `input_tokens` from 235 to 109,955 and `cache_read_input_tokens` up to 108,992 — a per-session input-tokens-over-time chart is a working context-hygiene visual, and `context_exceeded` flags failures if they occur.
- **Titles and provenance:** `title` + `title_source` (`generated` for interactive, `first_input` for subagents) + `time_title_updated`; titles are already snapshot-approved.
- **Work-in-progress markers:** `tool_usage.status` includes `running` (4 local rows), so active work is visible in near-real-time; `side_effect_scope` (`none` 59 / `system` 36 / `session` 10 / `workspace` 8 / `network` 3) classifies tool impact per session.
- **Phase proxy via todos:** `todo` is per-session (`session_id`, `position`) with `status` `completed` 7 / `in_progress` 1 / `pending` 1 — a lightweight phase-boundary signal without reading content.
- **Model/agent attribution:** `query_source` (`main_turn` 46 / `subagent` 15 / `session_title` 3 — filter the last, as `scripts/sessions.mjs` does), `agent` (`zcode-agent` 49 / `zcode-general-purpose` 12 / `zcode-Explore` 3), `mode` (`yolo` 64), `provider_id`/`model_id` (single model locally: `builtin:zai-coding-plan / GLM-5.3-Flash`), all joinable on `session_id`.
- **Lifecycle timestamps:** `session.time_created`/`time_updated` (ms epoch), `version` (CLI version per session, 0.16.5), `directory` for repo scoping.

```sql
-- Context-hygiene timeline for one session (metadata only)
SELECT started_at, duration_ms, input_tokens, output_tokens,
       cache_read_input_tokens, context_exceeded, finish_reason
FROM model_usage
WHERE session_id = :id AND status = 'completed'
ORDER BY started_at;
```

## What the handoffs view cannot get from this source

1. **In-session `/clear` and `/compact` events** — no rows mark them; only unpopulated hook columns (`session.time_compacting`, `*.context_exceeded`). A compaction that already happened is invisible unless it produced one of those.
2. **Which skill was invoked** — `tool_usage` says `Skill`, not the skill name (arguments are content).
3. **What happened between requests** — gaps in the `model_usage` timeline are unexplained; there is no idle/event table bridging them (`session_entry` holds only shell-selection and workspace-checkpoint runtime events locally).
4. **Diff stats** — `session.summary_additions/deletions/files/diffs` are NULL on 6 of 6 sessions (unchanged since the 2026-09-03 doc); Edit/Write counts and output tokens remain the proxies.
5. **Reliable turn rollups** — `turn_usage` has only 3 rows vs 64 `model_usage` rows (28 join on `session_id`+`turn_id`); use request-level rows, not turn-level, as the atomic unit.
6. **Workflow orchestration trees** — `session_task_link`/`workflow_*` are all empty; subagent attribution rests entirely on `session.parent_id`.

## Sources

- `~/.zcode/cli/db/db.sqlite` (copied with `-wal`/`-shm` to a temp dir, opened `readOnly` via `node:sqlite` `DatabaseSync`, Node v22.23.1; queries run 2026-09-04): `sqlite_master` table list, `PRAGMA table_info` / `PRAGMA index_list` per table, row counts, and DISTINCT aggregates over `tool_usage(tool_name, status, approval_status, side_effect_scope, read_only, destructive)`, `session(task_type, parent_id, title_source, time_compacting, time_archived, revert, summary_*)`, `model_usage(query_source, agent, mode, status, task_type, finish_reason, context_exceeded, input_tokens, cache_read_input_tokens, logical_request_id)`, `session_entry(type)`, `message`/`part` role/type extraction (values only), `todo(status)`, `schema_migration(id)`; session ids redacted.
- `scripts/sessions.mjs:35-73` — the copy-then-open-read-only method and the known schema subset this doc extends.
- `docs/research/agent-session-usage-page.md` (2026-09-03) — prior DB survey; row counts and column set superseded by this doc after the database's recreation (18 `schema_migration` rows, `session.version` 0.16.5).
