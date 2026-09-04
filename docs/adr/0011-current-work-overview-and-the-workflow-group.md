# Current work is the Overview; five views take routes under a Workflow group; the legacy ledger retires

Status: accepted
Work item: GH-53

Ticket #53 asked how the seven new views (skill-flow graph, triage queue, blocker graph, current work/next action, session handoffs, artifacts/decisions/ADRs, implementation/review status) fit the shadcn shell (ADR 0002) and what happens to the workflow-views toggle just shipped. The decision: the dashboard's home **is** current work — the Overview re-founds as the current-work/next-action view, tracker-backed, carrying the next-action hero (ADR 0010's priority table, command-first copy) and the repo-wide frontier strip (maps in map order, the unmapped open issues bucketed with no ordering pretense — absorbed from #51); a global header chip renders the recommendation's primary line on every page, informational until session spawning lands (ADR 0005's declared destination). The other five destination views take one route each under a Workflow sidebar group; session handoffs render as a lens on the existing Agent sessions page — one home for everything observed from the session database.

```
AppShell
├── Site header — snapshot stamp · "Next: /implement #34" chip (every page)
├── Sidebar
│   ├── Overview `/` — next-action hero · repo-wide frontier strip
│   │     (maps in map order + unmapped bucket, no ordering pretense)
│   ├── Workflow
│   │   ├── Skill flow `/flow` — Catalog graph + shelf + favorites filter (absorbs /skills)
│   │   ├── Triage `/triage` — Intake lane · Waiting lane (whose move) · inline state moves
│   │   ├── Blocker graph `/blockers` — per-effort canvas · detail rail
│   │   ├── In flight `/in-flight` — reviewing > implementing > claimed
│   │   └── Decisions `/decisions` — decisions + artifacts regrouped by work item
│   ├── Agent sessions `/sessions` — usage charts · Session handoffs lens
│   └── Tools `/tools` — unchanged
└── Detail panel — shared, `?issue=NN` on any view: state · caveats ·
      phase-1 actions · show-in-graph · open on GitHub
```

Per view: **Skill flow `/flow`** absorbs the `/skills` page's Catalog duties — one home for the Catalog (ADR 0006): the full graph with uninstalled dimmed, the shelf for upstream-new unclassified skills, favorites demoted to a filter; the `skills` sidebar item and route retire. **Triage `/triage`** — named against the glossary's avoid-list on "queue": an Intake lane (`unlabeled ∪ needs-triage`, map children excluded — the /triage skill's surface) and a Waiting lane grouped by whose move it is (`needs-info` → reporter, `ready-for-human` → human, `deferred` → parked); quick triage-state moves fire inline on rows, `wontfix` renders only behind a lens. **Blocker graph `/blockers`** stays per-effort — grabbable highlighting, the edge grammar (solid amber open gate, dashed gray satisfied), and the why-not-grabbable caveat lines from the #51 prototype; the critical path overlay is dropped at v1 scale; empty splits three ways: all-clear / in-flight / stuck-blocked; the repo-wide strip moves to the Overview; the scenario switcher stays prototype-only. **In flight `/in-flight`** renders ADR 0010's in-flight bucket (reviewing, then implementing, then claimed-but-not-started), informational until sessions are actionable. **Decisions `/decisions`** renders Decision and Artifact records regrouped by work item (ADR 0009), resolution and ADR records grouped, never merged. A **map renders composed** — its Blocker graph, its decision records in Decisions, its grabbable head in the Overview strip — with no dedicated map page.

One navigation grammar everywhere: a shared detail panel opened by a `?issue=NN` search param (deep-linkable, browser-back closes it) carries state, caveats (ADR 0010's show-with-caveat), and ADR 0005's phase-1 actions, with "open on GitHub" secondary and a "show in graph" jump to `/blockers?effort=…&focus=NN` for items in an effort. Recommendation copy is **command-first** — the action as the skill command plus work item ("`/implement` #34"), the reason as a secondary line mapping 1:1 to ADR 0010's buckets; the chip shows just the primary. The legacy ledger retires in the same rebuild: the workflow-views toggle and the TicketTable/PlanTable/SpecPanel sections are deleted, their record model superseded by the tracker-backed records the ADR 0008 landing change ships (the vocabulary consolidation is this rebuild's prerequisite, not a contingency); what survives of the toggle is its idiom — a URL-param single-select toggle group — as the pattern for phase lenses.

## Considered options

- **One `/workflow` hub with seven tabs** — rejected: seven densities (canvas graphs, tables, lanes) share one route; deep links degrade to params; the hub competes with the home for "here's all the work".
- **Workflow group beside an untouched Overview** — rejected: two competing "all the work" homes, one of them still rendering the retired ledger model.
- **A legacy lens/section until consolidation lands** — rejected: maintaining two data models in one page recreates the TicketStatus conflation ADR 0007 retired; the consolidation is a prerequisite landing change.
- **Promote the toggle to switch the new views** — rejected: the views are destinations with their own routes and lenses, not slices of one table.
- **A dedicated `/issues/NN` route** — rejected: yanks context from graph and queue; the URL-backed panel keeps deep links without leaving the view.
- **Link-out-only detail (github.com)** — rejected: a control surface acts in place (ADR 0005); GitHub is the secondary link, not the detail home.
- **Keep `/skills` beside `/flow`** — rejected: two Catalog homes drift; favorites is a lens, not a page.
- **Keep the critical path (tie-broken) or redefine it as a blocking-count badge** — rejected for v1: degenerate at current scale (the longest open chain ties three ways, highlighting the whole open subgraph); the edge grammar already answers gating. The centrality badge is the better form if it returns at effort depth.
- **Sentence-first or item-first recommendation copy** — rejected: the seam's vocabulary is the command a Developer would run by hand; the reason line should name its ADR 0010 bucket.
- **Session handoffs = the handoff documents** — rejected: #49 models documents out (OS temp dir); the lens renders observed boundaries derivable from the session database (#42).
- **Unmapped bucket on the blocker graph page, or as triage intake** — rejected: repo-wide grabbing is the current-work view's job, and the bucket is mostly `ready-for-agent`, not intake.

## Consequences

- `/to-spec` absorbs this as the shell's shape: the homes table, the panel grammar, the lens idiom, command-first recommendation copy — the map's last IA fog lines (recommendation copy/rendering; sessions-attribution rendering home) clear with it.
- #50's skill-flow graph lands at `/flow` with the Catalog duties folded in; #51's blocker graph lands at `/blockers` per its recorded reaction; both prototypes' model/layout functions port behind the GraphView seam (#43).
- The chip, hero, and panel are informational/in-place-actional per ADR 0005's phase-1 scope; static builds degrade actions to copy-the-command.
- Sequencing: the ADR 0008 landing change (TicketRecord migration / vocabulary consolidation) lands before or with this rebuild; the toggle's removal ships as part of it, not a separate deprecation.
- Sidebar order: Overview · Workflow (Skill flow, Triage, Blocker graph, In flight, Decisions) · Agent sessions · Tools; existing pages keep their routes.
- "Session handoff" joins CONTEXT.md; the sessions lens renders exactly what the session database can attribute (#42).
