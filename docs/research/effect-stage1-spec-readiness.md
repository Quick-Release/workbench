# Issue #1 spec readiness — Effect stage 1 against today's codebase

**Date:** 2026-09-07
**Sources:** primary only — GitHub issue #1 on `Quick-Release/workbench` (body, timeline, events, cross-references), the repository's git history, the current working tree at main (`13c3ad9`), and the npm registry (queried live on this date).

## TL;DR

**Verdict:** do **not** run `to-spec` on issue #1. Issue #1 already *is* a `to-spec` artifact — its body matches the skill's template section for section, and it wears the label `to-spec` writes (`workflow:specced`, per `docs/agents/workflow-labels.md:13`). More importantly, the spec's stage 1 was implemented the same evening it was published (commit `1aefe81`, 2026-09-02, closing tickets #2 and #3), and it has since grown well past its original scope. The only material drift is that one spec decision — pinning Effect to the stable v3 line — was deliberately overturned two days later by accepted [ADR 0003](../adr/0003-alchemy-and-effect-v4-rc.md): the repo now runs `effect 4.0.0-rc.112`. The gap is not a missing spec; it is stale tracker state — the parent spec issue was never advanced or closed after its tickets shipped. Recommended action: relabel (`needs-triage` → `ready-for-agent`, `workflow:specced` → `workflow:shipped`), close #1 as completed with a pointer to `1aefe81` and ADR 0003.

---

## 1. What issue #1 is, and what already happened to it

Issue #1 — "Adopt Effect — runtime validation of generated overview data (stage 1)" — was opened 2026-09-02T21:35:50Z by `vvaz` with a body already in the full `to-spec` template (Problem Statement / Solution / 18 User Stories / Implementation Decisions / Testing Decisions / Out of Scope / Further Notes), opening with: "Spec synthesized from `docs/research/effect-adoption.md` (2026-09-02) plus the in-session seam decision" (`gh api repos/Quick-Release/workbench/issues/1`).

Its timeline (`gh api repos/Quick-Release/workbench/issues/1/timeline` and `/events`) tells the rest of the story:

| When (UTC) | Event |
| --- | --- |
| 2026-09-02 21:35:50 | Created, labeled `ready-for-agent` (the label `to-spec` applies — SKILL.md step 3) |
| 2026-09-02 21:39:32 | Cross-referenced by #2 — "Tracer: fail-loud data boundary with Effect Schema (top level + tickets)" (`Parent: #1`) |
| 2026-09-02 21:39:46 | Cross-referenced by #3 — "Complete Effect Schema coverage: all record families + rejection matrix" (`Parent: #1`, `Blocked by: #2`) |
| 2026-09-02 22:11:05 | Commit `1aefe81` referenced from #1 — "feat: validate generated overview data with Effect Schema … Closes #2, closes #3. Spec: #1." |
| 2026-09-02 22:05 | #2 and #3 closed, `state_reason: completed` |
| 2026-09-02 23:24:51 | `ready-for-agent` removed, `needs-triage` applied (by `vvaz`) |
| 2026-09-04 18:41:33 | Renamed from "Spec: Adopt Effect — …" to "Adopt Effect — …" and labeled `workflow:specced` (the ADR 0007 label migration, which retired `Spec:` title prefixes) |
| 2026-09-04 18:42:21 | Cross-referenced by #46 ("How the tracker encodes phase and kind", closed, resolved by ADR 0007) |

The issue has zero comments. It remains **open** with labels `needs-triage` + `workflow:specced` (verified via `gh api repos/Quick-Release/workbench/issues/1`, `updated_at` 2026-09-04).

## 2. Sibling tracker state: no duplicates, no remaining Effect work

- Across all 71 issues and 4 PRs, only #1, #2, and #3 mention Effect (`gh issue list --state all`, `gh pr list --state all`). There is **no** separate spec issue, **no** implementation PR for stage 1 (the work landed as a direct commit to main, `1aefe81` — the PR list contains only #19, #67, #68, #71, none Effect-related), and **no** tickets for research stages 2, 3, or 4.
- `@effect/platform-node` appears in the codebase only via the ADR 0003 Alchemy work (commit `9604f0f`), which is telemetry-worker infrastructure, not the research doc's stage 2 (typed errors in `scripts/sync-data.mjs`). As of this date `scripts/sync-data.mjs` imports no Effect (`grep -n "effect" scripts/sync-data.mjs` — no matches beyond unrelated words).
- For label-convention comparison: other specced-but-unimplemented issues (e.g. #12, #28, #34, #35) carry `workflow:specced` + `ready-for-agent`. Shipped work carries `workflow:shipped` (e.g. #5, #55–#62). Issue #1's current pairing (`needs-triage` + `workflow:specced`) matches neither convention — it is the only such issue on the tracker.

## 3. Codebase status: stage 1 is implemented, and has grown

**The original implementation** — commit `1aefe81` (2026-09-02, on main, verified with `git merge-base --is-ancestor 1aefe81 HEAD`) — added exactly what the spec's first step called for (`git show 1aefe81 --stat`):

- `package.json` (+`effect`), `src/schema.ts` (122 lines), the gate in `src/data.ts`, `src/data.test.ts` (137 lines), and a small `src/types.ts` adjustment.

**Today's state** (working tree at `13c3ad9`):

- **The data gate is live, exactly as specced.** `src/data.ts:1-5` imports the generated snapshot and exports `overviewData: OverviewData = parseOverviewData(generatedData)` — "the result of a synchronous decode", export name and shape unchanged, so consumers like `src/routes/index.tsx:7` are untouched.
- **The schema module exists and covers everything.** `src/schema.ts` (509 lines) defines one struct per record family — tickets (line 85), plans (262), spec changes (277), external-service statuses (309), theme (289), meta (377–392) — composed into `OverviewDataSchema` (line 377). Status and record-kind literals are derived from the const vocabularies in `src/types.ts` (lines 10–24), and the decoded output is annotation-checked against the domain type (`src/schema.ts:406-412`). Since the original commit it has also absorbed work items, maps, blocker edges, decisions, artifacts, skills, session usage, and the execution-seam request/result contracts (lines 101–508) — added by the issue #55–#64 work (commits `504895c`…`3b65273`).
- **Tests match the spec's testing decisions and exceed them.** `src/data.test.ts` (1,018 lines) imports the data module (validating the real generated file on every run, lines 96–100) and walks the full rejection matrix with path assertions — unknown ticket status (109), missing required field (112–115), unknown record kind (117–119), non-numeric progress (121–125), unknown theme key (131–140) — plus excess-property rejections and suites for every later boundary. The cited prior art (vitest selector tests over domain-typed fixtures) still exists as `src/lib/overview.test.ts` and siblings.
- **Every pipeline exercises the gate.** `dev`, `build`, `test`, and `check` all run `pnpm sync` first (`package.json:28,32,35`), regenerating `src/data.generated.ts` (gitignored — not present in a fresh clone; produced by `scripts/sync-data.mjs`) before anything imports it. Validation runs on plain module import, no new Vite/TS/test-runner config — as the spec required.
- **Zod still owns search params.** `zod` 4.4.3 is a dependency (`package.json:63`) and is used in `src/routes/index.tsx`, `src/routes/sessions.tsx`, `src/routes/flow.tsx`; the data boundary never touches it.
- **Current toolchain:** `effect` `4.0.0-rc.112` and `@effect/platform-node` `4.0.0-rc.112` (`package.json:41,51`), `vitest` `4.1.9`, `react` `19.2.8`, `typescript` `6.0.3`. Tests import from `vite-plus/test` (`src/data.test.ts:1`), not `@effect/vitest` — consistent with the spec's decision to skip that package.

## 4. The one material drift: v3 pin → v4 RC, by accepted ADR

The spec's central version decision — "Single new runtime dependency: `effect`, pinned to the stable v3 line (3.22.1 at spec time)" and the out-of-scope item "Effect v4 / RC adoption" (issue #1 body) — held for less than 48 hours:

- Commit `9604f0f` (2026-09-04), "feat: deploy telemetry worker with Alchemy, move to Effect v4 RC", moved `effect` and `@effect/platform-node` to `4.0.0-rc.112` and migrated `src/schema.ts` to the v4 API (`Schema.Literals`, `onExcessProperty` — visible at `src/schema.ts:25,409-412`).
- [ADR 0003](../adr/0003-alchemy-and-effect-v4-rc.md) (accepted, commit `766355e`) documents this explicitly: "The app is pinned to the Effect v4 RC (`4.0.0-rc.112`), **overriding the v3 recommendation**; RC breaking changes land as normal code changes in this repo. `src/schema.ts` already uses the v4 API (`Schema.Literals`)" (ADR 0003, Consequences, line 17). The stated reason: `alchemy` peer-depends on `effect >=4.0.0-rc.112`, so the versions cannot be split (ADR 0003, "Considered options").

So the spec is not wrong so much as *superseded on one axis* — by a decision recorded in the proper home (an ADR), which is exactly where the spec's own user story 18 said v4 planning should live ("a note that v4 relocates Schema to an unstable import path, so that the eventual upgrade is planned rather than surprising"). The team chose to skip the interim instead.

## 5. Research-doc claims re-verified (2026-09-07)

The spec's Further Notes cite `docs/research/effect-adoption.md` (committed in `1aefe81`). Its version claims were re-checked live:

- `npm view effect version` → **3.22.1** — still the latest stable, unchanged since the research date.
- `npm view effect dist-tags` → `latest: 3.22.1`, `rc: 4.0.0-rc.112`, `beta: 4.0.0-beta.107` — v4 is still an RC, so the research's ecosystem picture holds; the repo simply now tracks the `rc` tag (matching it exactly).
- The research doc's stage 1 ("Validate `src/data.generated.ts` at startup with `effect/Schema` … do first — highest value, near-zero risk", effect-adoption.md §6.1) is precisely what `1aefe81` implemented. Stage 2 (typed errors in the sync script) remains undone; stages 3–4 remain undone/not planned.

## 6. Recommendation

**(a) Is the spec still accurate against today's codebase?** As a record of what was decided on 2026-09-02, yes; as a description of today's code, it has four drift points:

1. **Version line (contradicted):** spec pins stable v3 / 3.22.1 and lists v4-RC adoption as out of scope; codebase is on `4.0.0-rc.112` by accepted ADR 0003 (superseding, not erring).
2. **Schema-module blast radius (overtaken):** the spec bounds Effect Schema to one module covering the overview payload so a future v3→v4 migration touches one file; the v4 move already happened, and the module is now the shared contract hub for the whole execution seam (work items, decisions, blocker edges, seam request/result types), far beyond the six record families listed.
3. **Minor staleness (harmless):** "3.22.1 at spec time" is still the npm `latest`, and the `@effect/vitest` peer-conflict rationale still holds (tests use `vite-plus/test` over vitest 4), but the v3→v4 migration note in Further Notes is moot — there will be no v3→v4 migration.
4. **Everything else still holds:** fail-loud decode at the single data boundary (`src/data.ts:5`), unchanged export shape, Zod left alone, no runtime machinery, no new build config, tests asserting external behavior with path-identifying rejection errors.

**(b) Implementation status:** stage 1 is **fully implemented and shipped to main** (commit `1aefe81`, 2026-09-02), split-verified by tickets #2 and #3 (both closed as completed), then extended by eleven later commits (`9604f0f`, `504895c`…`3b65273`). Nothing of stage 1 remains to build. Research stages 2–4 have not been started.

**(c) Is running `to-spec` warranted?** **No.** The issue is already the artifact `to-spec` produces: the body is in that skill's exact template, the label `workflow:specced` is defined as "written by to-spec" (`docs/agents/workflow-labels.md:13`), and the body cites its synthesis source. Re-speccing would either duplicate an existing spec or — worse, given the code has moved — synthesize a spec that conflicts with both the shipped implementation and accepted ADR 0003. The spec phase for this work is complete; no spec action is needed. (If anyone wants the v3→v4 override reflected on the issue, a one-line comment linking ADR 0003 is the right vehicle — not a rewritten spec body.)

**(d) Recommended next step:** close out the tracker state, and do not create a new spec:

1. On issue #1: remove `needs-triage`, apply `ready-for-agent`-workflow bookkeeping consistent with shipped work — i.e. replace `workflow:specced` with `workflow:shipped` (written by "implement's closing checklist, after merge", `docs/agents/workflow-labels.md:17`; it was evidently skipped for this issue) — then close the issue as completed with a short comment: implemented in `1aefe81` (closing #2/#3); version decision superseded by ADR 0003; stages 2–4 out of scope per the spec itself.
2. Do **not** run `to-spec`; do not reopen a spec cycle for stage 1.
3. If the team still wants the research doc's stage 2 (typed errors in `scripts/sync-data.mjs`), start it as a fresh, current-state issue — the v4-RC baseline and the seam contracts that now live in `src/schema.ts` change the premises the old spec was written against.

## Sources

- Issue #1: `gh api repos/Quick-Release/workbench/issues/1` (body, labels, dates); `/timeline` and `/events` (labels, rename, cross-references, commit reference); `/comments` (empty).
- Issues #2 and #3: `gh api repos/Quick-Release/workbench/issues/2` and `/3` (parent linkage, `state_reason: completed`, close timestamps).
- Issue #46: `gh api repos/Quick-Release/workbench/issues/46` (tracker-encoding question resolved by ADR 0007).
- Commit `1aefe81` — "feat: validate generated overview data with Effect Schema" (message: "Closes #2, closes #3. Spec: #1"); stat via `git show 1aefe81 --stat`; ancestry via `git merge-base --is-ancestor 1aefe81 HEAD`.
- Commit `9604f0f` — "feat: deploy telemetry worker with Alchemy, move to Effect v4 RC" (`src/schema.ts` +`tsconfig.json` changed); commit `766355e` — ADR 0003.
- Codebase: `src/data.ts:1-5`; `src/schema.ts:25,85,262,277,289,309,377,406-412`; `src/data.test.ts:1,96-140`; `src/routes/index.tsx:7,116`; `package.json:28,32,35,41,51,54,59,62,63`; `scripts/sync-data.mjs` (no Effect imports).
- Domain docs: `docs/adr/0003-alchemy-and-effect-v4-rc.md` (lines 10, 17); `docs/agents/workflow-labels.md:13,17`; `docs/agents/triage-labels.md:9`; `docs/research/effect-adoption.md` (§2 table, §6 staging).
- Skill: `to-spec` SKILL.md (`/data/code/getquick/internal/workbench/.zcode/skills/to-spec/SKILL.md`) — description (line 3), publish + `ready-for-agent` step (line 19), spec template (lines 21–75).
- npm registry, queried 2026-09-07: `npm view effect version` → 3.22.1; `npm view effect dist-tags` → latest 3.22.1, rc 4.0.0-rc.112, beta 4.0.0-beta.107.
