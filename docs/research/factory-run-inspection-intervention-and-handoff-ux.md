# Factory 11 — Run inspection, intervention and handoff UX

Status: accepted research/design decision

Work item: [GH-169](https://github.com/Quick-Release/workbench/issues/169)

Prerequisites: [GH-162](https://github.com/Quick-Release/workbench/issues/162), [GH-165](https://github.com/Quick-Release/workbench/issues/165), [GH-166](https://github.com/Quick-Release/workbench/issues/166), [GH-167](https://github.com/Quick-Release/workbench/issues/167), [GH-168](https://github.com/Quick-Release/workbench/issues/168) (all resolved)

Related ownership: [GH-122](https://github.com/Quick-Release/workbench/issues/122) (Work Checkpoints), [GH-123](https://github.com/Quick-Release/workbench/issues/123) (Since You Were Away), [GH-124](https://github.com/Quick-Release/workbench/issues/124) (PR Review Brief), [GH-133](https://github.com/Quick-Release/workbench/issues/133) (Pi Chat Workspace), [GH-144](https://github.com/Quick-Release/workbench/issues/144) (flow-board visibility), [ADR 0010](../adr/0010-issue-agent-unattended-fenced-local-runs.md), [ADR 0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md), [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md), [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md), [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md), [ADR 0023](../adr/0023-failure-taxonomy-repair-limits-and-usage-budgets.md)

## Decision in brief

Workbench run inspection is a **display projection of settled contracts**, not a new state machine. Every status word, action verb, and state name shown to the Developer comes from an existing owner: run and attempt lifecycles from #165, evidence states from #166, publication states from #167, failure and escalation policy from #168, conversation states from #164, workflow phases from GitHub labels. This decision adds no lifecycle, renames nothing, and introduces no glossary terms.

There is **no new top-level page** in the first run surface. Run detail anchors in the existing issue detail panel; the In flight view gains run-status chips but keeps zero actions; the start affordance moves to the issue panel and recommendation next-action; the Pull requests page keeps only Review runs. Status is presented **panel-per-axis, never as one merged status word**. Discussion about an Agent run is **read-only**; the only way to change a coding run's course is stop turn → amend → fresh attempt. **Discard workspace** is the single destructive action requiring a typed confirmation. Publication remains a separate single-use approval; the UI never shows one "done" spanning start and publish.

The minimal first surface is the issue-panel run section, In-flight run chips, and the "Where you left off" return card. Aggregate dashboards, notifications, steering, resume, and cross-issue run coordination are explicitly deferred.

## Scope and evidence boundary

This note records a human-accepted research/design decision. It implements no UI, run detail service, durable store, checkpoint format, notification service, or phase automation, and authorizes no agent run, provider session, host-repository command execution, GitHub publication, or prototype build. Per the work item, `/prototype` was not used: every interaction settled on paper, and the six required journey/case walkthroughs below are the validation.

Code observations were checked against Workbench `main` at [`a7e0615`](https://github.com/Quick-Release/workbench/commit/a7e0615) on 2026-09-17. The work item's baseline is [`fd22f6a`](https://github.com/Quick-Release/workbench/tree/fd22f6a2d1bde0a65838955bcdec4c9d6a3c6f13). Between the two, Factory decisions 01–10 resolved; all five prerequisites of this ticket are closed, so this decision is finalizable rather than a sketch informing upstream work.

## Accepted decision lineage

This decision composes existing boundaries rather than creating a second run vocabulary:

- [#161](https://github.com/Quick-Release/workbench/issues/161) and [ADR 0016](../adr/0016-clarification-threat-model-and-credential-boundaries.md): agent messages, tool output, and conversation content are untrusted data. No display may present them as authoritative state; the trusted structured recorder (#166) owns verdicts.
- [#162](https://github.com/Quick-Release/workbench/issues/162) and [ADR 0017](../adr/0017-trusted-clarification-context-and-readiness.md): the pre-start manifest renders brief, readiness dimensions, and context provenance; each readiness dimension reports `ready` / `needs-information` / `unsupported` / `unknown` independently.
- [#163](https://github.com/Quick-Release/workbench/issues/163) and [ADR 0019](../adr/0019-execution-backend-selection-deferred-pending-isolation-evidence.md): the manifest's workspace-posture line describes Execution workspace isolation; backend selection remains deferred.
- [#164](https://github.com/Quick-Release/workbench/issues/164) and [ADR 0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md): conversation status (`accepted`, `running`, `waiting-for-input`, `settled`, `failed`, `cancelled`, unknown-after-process-loss) belongs to the managed-session surface (#133), never to run status.
- [#165](https://github.com/Quick-Release/workbench/issues/165) and [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md): run lifecycle `accepted → active → reconciling → awaiting-human → closed`; attempt lifecycle `prepared → running → cancelling → cancelled` with terminal `completed`/`failed` and `unknown → quarantined`; distinct run/attempt/request/workspace/session IDs; disconnect detaches without cancelling; reconnect is snapshot plus cursor with explicit gaps.
- [#166](https://github.com/Quick-Release/workbench/issues/166) and [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md): evidence states `passed` / `failed` / `not-run` / `inconclusive` / `infrastructure-error` / `stale`; agent-invoked checks are feedback only; only fresh independent `passed` evidence satisfies a mandatory Verifier.
- [#167](https://github.com/Quick-Release/workbench/issues/167) and [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md): publication is a separate single-use approval per immutable Publication intent; `published` ≠ `ready for human review` ≠ `approved` ≠ `merged`; lost responses are Unknown outcomes requiring reconciliation.
- [#168](https://github.com/Quick-Release/workbench/issues/168) and [ADR 0023](../adr/0023-failure-taxonomy-repair-limits-and-usage-budgets.md): manual-retry-only first release; every retry is a fresh attempt; usage is durable across attempts and restarts with honest observed/estimated/unknown fields; repeated failure signature escalates to Awaiting-human.
- [#122](https://github.com/Quick-Release/workbench/issues/122) owns Work Checkpoints and the return-brief fields; [#124](https://github.com/Quick-Release/workbench/issues/124) owns the Review payload and PR Review Brief; [#133](https://github.com/Quick-Release/workbench/issues/133) owns the conversation surface; [#144](https://github.com/Quick-Release/workbench/issues/144) owns flow-board visibility that In flight extends.

## Vocabulary bindings

The work item title's informal words are bound to settled terms for the rest of this decision; no synonyms enter `CONTEXT.md`:

| Informal word | Bound meaning                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "managed run" | Never a term. Use **Agent run** (one execution against an issue), **Review run** (one execution against a PR), or **Clarification attempt** (one owned Pi conversation). "Managed session" remains #164's Pi-conversation concept only. |
| "handoff"     | Decomposed: **reconnect** (viewer reattaches, #165), **return brief** ("Where you left off" card, fields from #122), **escalation** (Awaiting-human + Escalation record, #168), **ready for human review** (#167, presented via #124).  |
| "intervene"   | Never a UI word. The UI shows only the named actions in the matrix below.                                                                                                                                                               |

The existing display-state discipline (`src/lib/display-state.ts`) is the presentation pattern reused throughout: wrong or surprising attributions render **both facts with a caveat**, never a rewritten single truth.

## Existing Workbench behavior

Observed at `a7e0615`; the current seam must not be mistaken for the target design:

- Agent runs are started from the **Pull requests page** (`src/components/IssueAgentPanel.tsx` inside `PullRequestsPage.tsx`) — issue work started on the PR page is exactly the second-workflow confusion this decision removes.
- Run state is an in-memory per-engine registry (`scripts/seam/routes/review-api.mjs`); there is no run detail page, no durable run record, no checkpoints UI, and no reconnect: a stream that ends without an exit event marks the run failed, and **closing the page cancels the run** (`review-api.mjs` SSE handling) — both contradict the #165 contract this design assumes.
- The client-side board (`src/lib/review-run-state.ts`) phases `idle/running/busy/done`; the event grammar is `started/output/truncated/notice/exit/error` (`src/schema.ts`). Cancel has no confirmation; a second tab gets `409 run_busy`.
- In flight (`src/components/InFlightPage.tsx`) is strictly informational — "nothing on this view recommends or acts" — an invariant this decision preserves.
- Workflow phases come from GitHub `workflow:` labels; display state, phase clock, freshness chip, and show-with-caveat lines already implement honest-unknown presentation (`src/lib/display-state.ts`, `src/lib/phase-clock.mjs`, `src/lib/freshness.ts`).
- Design language: React 19 + TanStack Router, shadcn/ui (new-york) + Radix primitives, Tailwind v4 semantic theme, `data-slot` test contract, and the pure-board-module pattern (`lib/*-state.ts` with thin containers) that run-detail surfaces must follow.

## Information architecture

1. **No new top-level page.** The dedicated "Factory page" hypothesis is rejected for the first run surface; integrated surfaces are enough, as the work item anticipated. Aggregate dashboards stay deferred.
2. **Run detail lives in the issue detail panel.** A Run section renders: status header (run lifecycle chip primary), pre-start manifest (before approval), operational timeline, evidence panel, publication section, action matrix, and the read-only ask input. Deep link: the existing `?issue=N` param, extended with run/attempt IDs — IDs only, never tokens or transcript content.
3. **In flight gains run-status chips, zero actions.** The informational invariant holds; the run chip uses the run-lifecycle word, and the card links to the issue panel for anything actionable.
4. **Start affordance moves to the issue panel** and the Overview recommendation next-action. The PR page keeps only Review runs (health panel, review buttons, history) — review of PRs is its existing job, not issue-run control.
5. **Client-bug prominence is unchanged**: header chip, Overview client-attention section, the bug gate's typed `StartDenial` with blocking issue refs (`src/lib/review-runs.ts`), releasable only by GitHub (ADR 0012). No new mechanism.
6. **Board and recommendation engine are untouched in v1**: no run chips on board cards (board placement derives from phases — mixing run state onto cards would conflate axes), no recommendation-engine awareness of run states.

## Status presentation rules

**Panel-per-axis, never a merged status word.** The axes are settled and each renders in its own section with its own vocabulary, cross-referenced by ID:

| Axis                  | Owner vocabulary                                                                           | Renders in                           |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| Run lifecycle         | `accepted / active / reconciling / awaiting-human / closed`                                | status header chip (primary)         |
| Attempt               | `prepared / running / cancelling / cancelled / completed / failed / unknown / quarantined` | timeline segments                    |
| Conversation          | #164 managed-session states                                                                | #133 surface; referenced in timeline |
| Verification evidence | #166 six states                                                                            | evidence panel                       |
| Publication           | #167 four delivery words + `unknown`                                                       | publication section                  |
| Workflow phase        | GitHub `workflow:` labels                                                                  | existing issue panel grid            |
| Usage                 | `observed / estimated / unknown`                                                           | status header line                   |

Rules:

- Workflow phase is **never moved by run events**; the panel shows "phase is GitHub's; run state is Workbench's" as separate facts. No automatic phase transitions are authorized by this decision.
- Acknowledgements, assistant text, and process exit never display as completion (#164, #165). A stream ending without an exit event renders as an explicit gap, never invented history.
- Conversation status never appears in the run header; the timeline carries one reference line ("conversation active / settled — open in chat").
- Unknown renders as the word, styled distinctly (amber family), never averaged away, never green, never a spinner posing as progress.

## Pre-start manifest and approval states

**Before approval, a fixed manifest renders, every line honestly renderable as unknown:**

1. Task scope: Issue brief reference and pinned issue revision (#162).
2. Base revision for the attempt.
3. Execution workspace posture: fresh isolated workspace; fence summary of denied actions (external directories, push, remote, PR create/merge).
4. Verification recipe and its readiness (#166): recipe ID/version or `none approved yet`.
5. Budget line (#168): manual-retry-only; usage durable across attempts and restarts; `observed / estimated / unknown`.
6. Egress statement: source stays local; any approved research queries carry only generic library/topic/version information (#162).
7. **"Publishing is NOT granted by this approval"** — always present.

Unknown never renders green. Unknown usage blocks only unattended dispatch (#168), never a manual Developer start.

**Approval states.** Start is one explicit act on a visible manifest: the manifest renders first, then a single Start button. There is no separate confirmation class for start; retry is the same act with a new attempt ID — "retry as fresh attempt" re-renders the manifest, so scope or recipe changes are visible before re-approval (#168: material changes require fresh approval). After approval, the status header shows the #165 lifecycle; attempt completion is never displayed as verification, publication, or review success (#165).

## Operational timeline (event-to-display rules)

- **One timeline per run, segmented by attempt** (`attempt 2 — started after manual retry`), so a retry reads as two segments, not one blur.
- Each entry is one operational event in plain language ("verifier `check` failed on attempt 1") with raw detail — stdout chunk, argv, exit status — behind an expand, capped with the existing worded truncation line.
- Agent-reported checks and agent stdout are display-muted and never rendered as state; the trusted recorder's events are the state (#166).
- Expired cursor renders a divider: "— N earlier events not retained —" (#165).
- **No progress bars or percentages**: nothing in the event grammar justifies them.
- Usage renders in the header line: `usage: observed 12.4k tok / estimated — / unknown` — honest fields, unknown never averaged away (#168).

## Evidence panel

Per attempt, per #166's contract:

- Header: `Tested <candidate sha> against <recipe vN>`.
- One row per Verifier with its settled state **word**; color only reinforces the word, never replaces it.
- Agent-invoked checks render in a separate **"agent-reported (feedback only)"** group, visually muted, **never a checkmark**.
- `stale` renders amber with the exact tested revision: "verified at `a1b2c3`, candidate now `d4e5f6`".
- Model-based scope review renders its word (`clear / concern / inconclusive`) with "cannot certify correctness"; it can demand attention, never grant green.
- Any Verification exception names its scope and states "does not satisfy mandatory checks or CI".
- The Verification bundle digest is visible for cross-reference with the PR body projected digest (#167).

## Publication section

- No intent yet → "publishing not requested". Start-to-publish is always at least two explicit approvals; the UI never shows one "done" spanning both.
- With an intent: the four delivery words (`published`, `ready for human review`, `approved`, `merged`) render as distinct states; the Publication receipt digest and PR link are shown. Merge-side states are read-only facts from GitHub.
- Unknown outcome (e.g., push succeeded, response lost) renders **`unknown — reconcile`** with reconcile as the primary action; adoption of an observed PR happens only through reconciliation results, never inferred from process exit.
- A stale-evidence block renders "publishing blocked — evidence stale for current candidate"; the inner publication gate enforces this upstream regardless of UI (#166/#167).
- Review content stays owned by #124's PR Review Brief; this section links, never duplicates.

## Intervention action matrix

Every button label carries its consequence in subtext. Disconnect detaches; it never cancels (#165).

| Action                         | Class             | Displayed consequence                                                                                                                                |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detach viewer                  | direct            | "Stop watching. The run keeps going."                                                                                                                |
| Reconnect                      | direct            | Snapshot + cursor; gap divider if events expired.                                                                                                    |
| Take checkpoint (#122)         | direct            | "Record a pick-up-later note. Never resumes a process or resets budget."                                                                             |
| Reconcile (read-only inspect)  | direct            | "Inspect processes, workspaces, revisions, publishing state." Classification results require explicit human acceptance before they close a question. |
| Stop turn                      | two-step confirm  | "Finish the current turn, keep the attempt alive."                                                                                                   |
| Cancel run                     | two-step confirm  | "Stop the run. Kept workspace stays until you discard or retain it."                                                                                 |
| Retain workspace               | two-step confirm  | "Keep the workspace for inspection; it counts against retention."                                                                                    |
| **Discard workspace**          | **typed confirm** | The single destructive action: typed as workspace/issue ID, states work is unrecoverable. Requires ownership and termination proven (#165).          |
| Start / retry as fresh attempt | fresh approval    | Manifest re-renders; new attempt ID; new candidate requires fresh verification (#166).                                                               |
| Publish                        | fresh approval    | Its own single-use intent + approval flow (#167).                                                                                                    |

**Lease and multiple viewers.** Implicit acquire: controls render enabled; the acting tab acquires the controller lease server-side per mutation; a tab that held it shows "controls moved to another viewer" and flips read-only until its next action. Three displayed ownership states: "controls held by this tab" / "held by another viewer" / "unheld — this tab acquires on first action". Fencing (#165) is the correctness mechanism; the notice is courtesy, not security.

## Read-only discussion versus steering

- Discussion about an **Agent run** is **read-only Q&A** in v1: grounded in the run's operational events and checkpoint, grants no tools, cannot restart anything, and is labeled "Ask about this run (read-only)".
- The only way to change a coding run's course: **stop turn → amend the brief → fresh attempt** (manual-retry-only, #168).
- `steer` exists only in Clarification attempt conversations under #164's contract, on the #133 surface — a visibly different input with different labels. The two input modes never share a send affordance.

## "Where you left off" return card

Rendered at the top of the run section on **reconnect-after-gap**, and whenever the run is **`awaiting-human`** or **`reconciling`**. Fixed fields, all from the operational run record plus a #122 checkpoint — no new handoff format:

1. Run/attempt state (lifecycle words).
2. Ownership (the three lease-display states).
3. Last trusted event (ID + time).
4. Changed files (workspace link).
5. Checks summary (evidence words from the evidence panel).
6. Missing decision — for escalations, the concrete question in one sentence (e.g., "verifier `check` failed twice with the same signature: retry as fresh attempt or discard?").
7. Exactly **one primary next safe action**, drawn from the matrix: "Follow live" for an active run (dismiss card, open live timeline); the decision action (e.g., "Start fresh attempt") for an escalated run.

The awaiting-human bridge: with manual-retry-only (#168), a failed attempt with no permitted automatic next step moves the run to `awaiting-human`, which triggers this card — that is how the #165 lifecycle and the #168 policy meet in the UI.

## Robustness, error states and accessibility

- **No new notification service in v1**; escalation is the in-app Awaiting-human state and return card. The work item authorizes no notification service.
- Tool output collapsed by default, capped, truncation stated in words (existing pattern).
- Slow or lost connections: coalesced polling with the existing static-snapshot degradation (`src/lib/live-refresh.ts`); run streams render explicit gaps; an older answer never overwrites newer state (existing order guard).
- Deep links encode issue/run/attempt IDs only — never tokens, credentials, or transcript content.
- Accessibility rides the existing shadcn/Radix primitives: every action keyboard-reachable, destructive confirmations focus-trapped, state words not color-only (works without color perception).
- Multiple viewers: read-only, per the lease model above; `409 run_busy` is replaced by the ownership display, not an error.

## Journey and case walkthrough

Paper walkthroughs validated the design; no prototype was built. Human feedback: the Developer accepted each round of recommendations and the derived clarifications below.

1. **Approve a ready bug** — recommendation next-action points at the issue; manifest shows scope, base, workspace posture, recipe readiness, budget, egress, and the not-granted publication line; with client bugs open the typed start-denial names blocking issues. Holds.
2. **Return after a tab closes** — the run continued (post-#165 behavior; today's disconnect-cancels code is a recorded defect below). Return card renders from snapshot + cursor; expired events show the gap divider. Holds.
3. **Intervene after a failed check** — attempt 1 fails `check`, run awaiting-human; card leads with the missing decision and one primary action; retry re-renders the manifest; attempt 2 is a new timeline segment; budget carried across attempts. Holds.
4. **Review a delivered draft** — separate publication approval; four delivery words distinct; receipt digest and PR link; review content via #124's brief. Holds.
5. **Stale evidence** — amber "verified at `a1b2c3`, candidate now `d4e5f6`"; publication section shows "blocked — evidence stale"; inner gate enforces upstream. Holds.
6. **Unknown publication** — `unknown — reconcile` primary, never a spinner or inferred success; failed reconciliation escalates to awaiting-human. Holds.

Derived clarifications accepted with the design:

- Start/retry are the same act: manifest first, single Start; retry = new attempt ID after re-rendered manifest.
- Return card for an active run: primary action is "Follow live".
- Lease display includes the "unheld" state — the normal post-reconnect case, since the lease is per-mutation.
- Failed attempt + no permitted automatic next step lands the run in `awaiting-human` (the #165/#168 bridge).

## Minimal first surface and explicit deferrals

**v1 ships:** the issue-panel run section (status header + pre-start manifest + timeline + evidence panel + publication section + action matrix + read-only ask), In-flight run-status chips, and the "Where you left off" return card. The current single-run-per-engine posture is unchanged.

**Explicitly deferred:** aggregate run dashboards; clarification-conversation surfaces (#133/#164 own them); Since You Were Away (#123); PR Review Brief presentation (#124); parallel runs and dispatch backpressure (#173); remote runners (#174); recommendation-engine awareness of run states; board-card run chips; notification service; session `resume`/`fork` (#164 future capabilities); numeric coding-profile ceilings (#168's later profile).

**Required follow-up defects recorded (implementation unauthorized by this decision):**

1. Page disconnect cancels the run (`scripts/seam/routes/review-api.mjs` SSE handling) — contradicts #165's detach-without-cancelling contract.
2. Issue-run start lives on the Pull requests page (`src/components/IssueAgentPanel.tsx`) — this decision moves the affordance to the issue panel.
3. `ReviewCancelRequestSchema` validates against `reviewEngines` only and rejects `opencode` (`src/schema.ts`) — issue-agent runs cannot be cancelled via the API today (recorded first in #168).

## Explicitly unsupported

Presenting agent messages or summaries as authoritative state; a merged status word across axes; automatic workflow-phase moves from run events; a second issue workflow beside GitHub's; steering a coding run mid-attempt; mid-run tool grants through the ask input; inferring publication success from process exit; rendering agent-reported checks as passing evidence; automatic retries in the first release; embedding secrets or transcript content in deep links; notification channels of any kind in v1.

## Sources

- Resolved Factory decisions: [#159](https://github.com/Quick-Release/workbench/issues/159)–[#168](https://github.com/Quick-Release/workbench/issues/168), with Resolution comments linked from the [#158 map](https://github.com/Quick-Release/workbench/issues/158).
- ADRs [0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md), [0020](../adr/0020-durable-run-ownership-and-reconciliation.md), [0021](../adr/0021-independent-verification-and-revision-bound-evidence.md), [0022](../adr/0022-safe-idempotent-draft-pr-publication.md), [0023](../adr/0023-failure-taxonomy-repair-limits-and-usage-budgets.md); [CONTEXT.md](../../CONTEXT.md) vocabulary.
- Workbench code at `a7e0615`: `src/components/IssueAgentPanel.tsx`, `src/components/PullRequestsPage.tsx`, `src/components/InFlightPage.tsx`, `src/components/IssueDetailPanel.tsx`, `src/lib/review-run-state.ts`, `src/lib/display-state.ts`, `src/lib/live-refresh.ts`, `src/schema.ts`, `scripts/seam/routes/review-api.mjs`, `scripts/seam/review/opencode-engine.mjs`.
- Sibling research notes: `factory-durable-run-ownership-and-recovery.md`, `factory-independent-verification.md`, `factory-safe-draft-pr-delivery.md`, `factory-failure-policy-repair-limits-and-usage-budgets.md`, `factory-pi-runtime-and-managed-sessions.md`, `factory-task-briefs-and-readiness.md`.

## Validation boundary

Documentation-only change. Repository gate run per commit: `pnpm check` and `pnpm test` (Vitest + Node suites). No UI implementation, run service, store, prototype, agent run, provider session, host-repo command execution, publication, or notification service was produced or executed for this decision.
