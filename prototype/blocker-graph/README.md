# Prototype: the blocker graph and frontier (issue #51)

Throwaway artifact answering: how should the blocker/dependency graph present the
frontier at real scale — the #41 map's 12 decision tickets and their 12 native
blocked-by edges, transcribed 2026-09-04? Single self-contained HTML file, no build
step — open `index.html` in a browser. Designed to fit 1440×900 with no pan/zoom
and no scroll.

## What it exercises

- Hand-rolled SVG with pure model/layout functions (the approach chosen in #43) —
  sections marked `2. MODEL` and `3. LAYOUT` port to the real modules behind the
  `GraphView` seam.
- Columns are graph depth (blockers left, blocked right); closed tickets render
  contracted (small, dimmed, edges visible) with an **Expand closed** toggle.
- Frontier highlighting (green = grabbable now), computed per ADR 0008 — open ∧
  unassigned ∧ all blockers closed — never stored.
- Blocked-chain reading: solid amber edges are open gates, dashed gray edges are
  satisfied (closed blockers) — 9 of the 12 real edges point at closed tickets.
- **Critical path** toggle: longest remaining open chain(s), all ties shown.
  Today it ties 3 ways (#50→#53 · #51→#53 · #52→#53) — degenerate at this scale;
  that's the finding to react to.
- Frontier strip (right rail): per-effort frontier in map order ("first in map
  order wins"), then the 29 unmapped open issues bucketed with no ordering
  pretense. The map's sub-issue structure is drawn nowhere — membership is
  order, not edges (ADR 0008).
- Click-through detail: blockers with state, map-order tiebreak, and an explicit
  "why not grabbable" line for every non-frontier ticket.

## Scenarios (header switcher)

- **Today** — the real transcription, unmodified.
- **Exercise** — adds the states real data can't show, MOCK-badged: #52 claimed
  (drops out of the frontier) and a broken `#53 blocked by #99` edge rendered as
  a fail-closed warning node (ADR 0008: dangling blockers count open).
- **Empty** — #50–52 flipped closed, #53 claimed: frontier empty, one ticket in
  flight, nothing grabbable.

## What's mocked

- States, not data: scenario mutations are clearly MOCK-badged on the node and
  in the detail panel; Today is unmodified.
- Assignees on #42/#43 and the 29 unmapped titles are transcribed, not live.

## React in the issue

- **Layout** — depth columns; contracted closed tier; fixed canvas with the rail;
  what reads well, what fights.
- **Highlighting** — green frontier; amber/dashed edge grammar; critical-path
  overlay (keep at effort-late scale only? drop?).
- **Empty/blocked states** — the Empty scenario's "claimed, in flight" empty
  message; the fail-closed broken-reference node; claimed-drops-out-of-frontier.
- **Keep / drop / add** for the real view behind the seam.
