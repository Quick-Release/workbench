# Workflow Labels

Skills move work through the skill flow; this file maps those moves to the label strings used in this repo's issue tracker. The sync script parses this file as its vocabulary source — one home for humans, skills, and the dashboard. Triage labels live separately in [triage-labels.md](./triage-labels.md); the two vocabularies are orthogonal (an issue can be ready-for-agent while its effort sits in the spec phase).

## Workflow phase

Exactly one `workflow:*` label per issue. **No `workflow:` label means pre-flow**: no flow skill has touched the work yet. A triaged issue with no phase label is on the shelf, not in the flow.

| Phase        | Label                   | Written by                                                                                     |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| grilling     | `workflow:grilling`     | grill-with-docs / grill-me starting a decision conversation (on-ramps route through grilling)  |
| prototyping  | `workflow:prototyping`  | handoff — and back to `workflow:grilling` when the prototype answers the open questions        |
| specced      | `workflow:specced`      | to-spec (also labels the effort's wayfinder map, if any)                                       |
| ticketed     | `workflow:ticketed`     | to-tickets                                                                                     |
| implementing | `workflow:implementing` | implement at session start; also the on-ramp entry for triage briefs and diagnosing-bugs fixes |
| reviewing    | `workflow:reviewing`    | code-review                                                                                    |
| shipped      | `workflow:shipped`      | implement's closing checklist, after merge                                                     |

Developers may hand-move any label at any time. If an issue wears two `workflow:` labels (hand-edit accident), the dashboard resolves to the furthest-along phase in flow order and surfaces a non-blocking warning — it never fails the sync.

**Decision tickets stay phase-free.** Children of a `wayfinder:map` (and the map's decision tickets generally) carry no `workflow:` label; the board derives their column from ticket type plus open/closed state — see [Kind](#kind-decision-tickets) — and claiming renders as a chip, never a column move. The map itself carries phase like any issue.

## Category

| Category    | Label         | Meaning                 |
| ----------- | ------------- | ----------------------- |
| bug         | `bug`         | Something isn't working |
| enhancement | `enhancement` | New feature or request  |

Absent label = no category (chores, docs, research). Category belongs to implementation-bound issues only — maps and decision tickets never carry it.

## Client tickets

Two labels mark a ticket as client-originated — the signal for the client-first work policy (CONTEXT.md, "Clients"; ADR 0012). Matched by exact name, never a substring; `client-bug` wins when both ride. Filed by a teammate on a client's behalf counts exactly the same; origin is never inferred from author or wording. While an open client bug exists, unrelated feature starts are gated.

| Kind            | Label             | Meaning                                        |
| --------------- | ----------------- | ---------------------------------------------- |
| client bug      | `client-bug`      | A client reported something that isn't working |
| client feedback | `client-feedback` | A client's request, comment, or feedback       |

## Parking

| State    | Label      | Meaning                                                                                   |
| -------- | ---------- | ----------------------------------------------------------------------------------------- |
| deferred | `deferred` | Parked: not being worked now, not refused. Orthogonal to triage state and workflow phase. |

`wontfix` is refusal (a triage state); `deferred` is parking with intent to revisit.

## Kind (decision tickets)

Decision-ticket type is encoded by the `wayfinder:*` labels — see [issue-tracker.md](./issue-tracker.md) under "Wayfinding operations": `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.

### Board placement

Decision tickets carry no `workflow:` label, so the board derives their column from the table below. The placement is a derived column, never a phase: no skill writes it, the record keeps no phase, and time-in-phase never measures it. The map itself is not in this table — it carries phase like any issue.

| Kind                  | Open column | Closed column |
| --------------------- | ----------- | ------------- |
| `wayfinder:grilling`  | grilling    | shipped       |
| `wayfinder:research`  | grilling    | shipped       |
| `wayfinder:prototype` | prototyping | shipped       |
| `wayfinder:task`      | ticketed    | shipped       |

Claiming never moves the card — an assignee renders as a claimed chip, the way `deferred` renders as parked. A closed decision ticket sits in shipped and chips by why it closed: resolved (`state_reason: completed`) chips **decided**, the Resolution being the outcome; ruled out of scope (`state_reason: not_planned`) chips **ruled out** — a scope boundary is not a decision.

Research shares the grilling column with grilling: both are decision-conversation work, wayfinder being an on-ramp that merges onto the main flow at grilling. Task is doing-side work that unblocks a decision, so an open task ticket reads as ready (ticketed) work, not implementation.

## Blocked

Never a label. Blocked is computed from blocker edges (issue-tracker.md, "Blocking"): a work item is blocked while any of its blockers is open.
