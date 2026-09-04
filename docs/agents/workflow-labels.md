# Workflow Labels

Skills move work through the skill flow; this file maps those moves to the label strings used in this repo's issue tracker. The sync script parses this file as its vocabulary source — one home for humans, skills, and the dashboard. Triage labels live separately in [triage-labels.md](./triage-labels.md); the two vocabularies are orthogonal (an issue can be ready-for-agent while its effort sits in the spec phase).

## Workflow phase

Exactly one `workflow:*` label per issue. **No `workflow:` label means pre-flow**: no flow skill has touched the work yet. A triaged issue with no phase label is on the shelf, not in the flow.

| Phase        | Label                    | Written by                                                                                     |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| grilling     | `workflow:grilling`      | grill-with-docs / grill-me starting a decision conversation (on-ramps route through grilling)   |
| prototyping  | `workflow:prototyping`   | handoff — and back to `workflow:grilling` when the prototype answers the open questions         |
| specced      | `workflow:specced`       | to-spec, written only when it completes — a bounced spec never left grilling (also labels the effort's wayfinder map, if any) |
| ticketed     | `workflow:ticketed`      | to-tickets — the effort, and every spawned child at creation (children are born `workflow:ticketed` + `ready-for-agent`) |
| implementing | `workflow:implementing`  | implement at session start (also on rework, re-stamping from reviewing); also the on-ramp entry for triage briefs and diagnosing-bugs fixes |
| reviewing    | `workflow:reviewing`     | code-review                                                                                     |
| shipped      | `workflow:shipped`       | the closing act of a completed work item — implement's closing checklist after merge for tickets; whoever closes a completed effort (map, spec parent) |

The skill that spawns a work item stamps its initial labels at creation — to-tickets children are born `workflow:ticketed` + `ready-for-agent`; decision tickets are born unlabeled — and afterwards phase moves by the acting skill, triage state only by the triage skill. The full machines and the next-action rules live in [ADR 0010](../adr/0010-state-machines-and-next-action.md).

Developers may hand-move any label at any time. If an issue wears two `workflow:` labels (hand-edit accident), the dashboard resolves to the furthest-along phase in flow order and surfaces a non-blocking warning — it never fails the sync.

**Decision tickets stay phase-free.** Children of a `wayfinder:map` (and the map's decision tickets generally) carry no `workflow:` label; their phase derives from ticket type plus open/closed/claimed state. The map itself carries phase like any issue.

## Category

| Category    | Label         | Meaning                     |
| ----------- | ------------- | --------------------------- |
| bug         | `bug`         | Something isn't working     |
| enhancement | `enhancement` | New feature or request      |

Absent label = no category (chores, docs, research). Category belongs to implementation-bound issues only — maps and decision tickets never carry it.

## Parking

| State    | Label      | Meaning                                                                                    |
| -------- | ---------- | ------------------------------------------------------------------------------------------ |
| deferred | `deferred` | Parked: not being worked now, not refused. Orthogonal to triage state and workflow phase.   |

`wontfix` is refusal (a triage state); `deferred` is parking with intent to revisit.

## Kind (decision tickets)

Decision-ticket type is encoded by the `wayfinder:*` labels — see [issue-tracker.md](./issue-tracker.md) under "Wayfinding operations": `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.

## Blocked

Never a label. Blocked is computed from blocker edges (issue-tracker.md, "Blocking"): a work item is blocked while any of its blockers is open.
