# Phase and kind encode as namespaced labels; status vocabularies unify into phase + triage

Status: accepted

Ticket #46 asked how a tracker issue declares workflow phase and category/kind, and how the eight `TicketStatus` values, the five triage roles, and the workflow phases unify. The decision: namespaced labels, written by the skill that makes each move — `workflow:<phase>` for phase (exactly one per issue; **absent means pre-flow**: no flow skill has touched the work), the existing `wayfinder:*` labels for decision-ticket kind, the default `bug`/`enhancement` labels for category (implementation-bound issues only), and a standalone `deferred` parking label orthogonal to both machines. Triage state and workflow phase stay orthogonal — one vocabulary cannot represent an issue that is simultaneously specced and ready-for-agent, which is exactly the conflation `normalizeStatus` already suffers. `blocked` is never encoded: it is computed from blocker edges (#47). The eight-value `TicketStatus` retires as stored state (`complete`→shipped, `in-progress`→implementing, `ready`→ready-for-agent, `gated`→ready-for-human, `needs-development`/`planned`→ticketed, `blocked`→computed, `deferred`→the `deferred` label); display state derives from phase + triage + computed-blocked. The canonical vocabulary home is `docs/agents/workflow-labels.md`, parsed by the sync script, so humans, skills, and dashboard share one source. Decision tickets (map children) carry no phase label — their phase derives from type plus open/closed/claimed state; the map itself carries phase like any issue.

## Considered options

- **Title prefixes (the existing `Spec:` convention)** — rejected: skills would rewrite titles to move phase, prefixes collide with free-text titling, and nothing parsed them — undocumented folklore on eight issues.
- **Sub-issue structure as phase (umbrella issues per phase)** — rejected: GitHub sub-issues allow a single parent and the map already owns that edge for decision tickets; pre-artifact phases like grilling have no umbrella to sit under.
- **GitHub Projects single-select field** — rejected: bolts a Projects dependency onto every host-repo install and grows API surface per issue.
- **One merged status vocabulary** (triage folded into phase or vice versa) — rejected: orthogonality is load-bearing (see above).
- **Hardcoded label lists in sync and skills separately** — rejected: two homes recreate the heuristic drift this decision ends.

## Consequences

- Tracker-side migration (done): `workflow:grilling/prototyping/specced/ticketed/implementing/reviewing/shipped` + `deferred` labels created; the eight `Spec:`-titled issues carry phase labels (`workflow:shipped` for the closed ones) and lose the prefix; all other issues correctly need nothing.
- `normalizeStatus` string heuristics retire in favor of label reads; legacy local `Status:` lines map through the table above in sync code until the vocabulary-consolidation fog item lands (with #49).
- Two `workflow:` labels on one issue (hand-edit accident) resolve to the furthest-along phase with a non-blocking warning — never a failed sync.
- Feeds #52 (workflow state machine and next-action rules) and #53 (information architecture); the workflow views adopt the phase vocabulary in that work.
