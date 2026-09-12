# Implementation resume — the phase board, read-only (GH-146)

Branch `agent/zcode/board-2-phase-board` · PR #152 · base `main` (ad5959b)
Worktree: `/data/agents/workspaces/zcode/getquick/workbench/board-2-phase-board`

## What was built

The read-only slice of the Tier-1 flow visibility spec (#144): a board whose
columns are the workflow phases plus pre-flow, reachable from the nav's
workflow group, rendering every work item at its resolved place on the flow.

| Piece                       | Home                                 | Notes                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board derivation            | `src/lib/board.ts`                   | Pure over the workflow payload: placement, chips, caveats, warnings. No React.                                                                                                                                                                                    |
| Placement                   | `boardColumnFor`                     | Regular items + maps by `record.phase` (pre-flow fallback); decision tickets by the parsed table (open vs closed column); claimed never moves a card; an unlisted kind falls back to pre-flow.                                                                    |
| Chips                       | `board()`                            | blocked (fail-closed: dangling blocker references count), grabbable (exactly the frontier), parked, claimed, decided, ruled out (closed decision tickets by `state_reason`).                                                                                      |
| Shipped page                | `scripts/tracker/index.mjs`          | `recentlyShipped`: one page (100) of closed issues wearing the shipped label, `sort=updated desc`, deduped against records the sweep/maps/client/targeted reads already hold, newest (number desc) first. Runs once per sync, never a closed-history sweep.       |
| Placement rides the payload | `decisionPlacement`                  | Sync already parsed the table from `docs/agents/workflow-labels.md` for validation; now it also serves it. Optional payload field; client fallback `DEFAULT_DECISION_PLACEMENT` is pinned to the tracker default by a cross-module equality test.                 |
| Page                        | `src/components/BoardPage.tsx`       | Eight horizontally scrollable columns, honest counts and empty lines, chips in the existing badge vocabulary, caveat lines italic, double-label warnings amber on the card they describe. Read-only by design.                                                    |
| Route                       | `src/routes/board.tsx`               | `?issue=` panel param + `?lens=deferred`, validated exactly like triage; shared `IssuePanelHost`; reads the shared workflow atom (bundled snapshot paints, live read replaces — static builds browse the snapshot).                                               |
| Nav                         | `src/components/layout/nav-main.tsx` | "Board" (Columns3 icon) sits between Skill flow and Triage.                                                                                                                                                                                                       |
| Payload double-write        | `src/types.ts` + `src/schema.ts`     | `recentlyShipped` / `decisionPlacement` optional in both `OverviewData` and `WorkflowStatePayload`; spread conditionally in `workflow-state.ts` so older snapshots serialize without the keys. Excess-property matrix makes present-but-malformed a loud failure. |

## How it was built

- TDD at the seams the spec pre-agreed: pure lib suite first (red), then
  collector tests through the routed-fetch harness, schema round-trips,
  render smoke tests for the page, route-level smoke tests through the real
  generated route tree.
- Two-axis code review after the first commit (standards + spec, run as
  parallel sub-agents). Findings addressed in the second commit:
  drift pin for the placement table, comparator reuse in the collector, and
  route-level smoke tests the spec's testing decisions call for.

## Validation

- `pnpm check` (sync → fmt → lint → tsc) green; `pnpm test` green — 527
  vitest + 388 node tests, pre-commit gate ran on both commits.
- The live sync inside `check` exercised the real shipped query and parsed
  the real placement table against the host repo (both visible in the
  regenerated `data.generated.ts`).

## Review findings not acted on (with reasons)

- "Closed decision tickets without `state_reason` sit in shipped with no
  chip" — exactly what `docs/agents/workflow-labels.md` prescribes (the
  table places closed tickets in shipped; the state reason only chooses the
  chip). Honest, kept.
- Claimed chip renders on every card, not only decision tickets — the spec's
  chip list is unqualified and `deriveDisplayState` already computes claimed
  universally. Kept.
- Static boards don't render the warnings channel — inherited from GH-145's
  payload shape (warnings are live-read-only by design).

## Known limitations / follow-ups

- Phase moves, auto-sync, and time-in-phase are tickets 3–5 of #144.
- Warnings channel is live-only; closed map children beyond the targeted-read
  cap don't render (fail-closed, warned at sync).
- Pre-existing quirk (shared with /triage, documented in the route test):
  TanStack JSON-parses search, so a hand-typed bare `?issue=8` arrives as a
  number and is rejected; the app's own links serialize quoted and work.
- `worker/agent.runtime.test.mjs` flaked once under the full parallel suite
  (previous-run count); passes in isolation and on reruns; no worker code
  touched.
