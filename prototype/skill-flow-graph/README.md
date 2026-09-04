# Prototype: the skill-flow graph (issue #50)

Throwaway artifact answering: how should the skill-flow graph look and behave at real
scale (37 skills, 21 draft edges)? Single self-contained HTML file, no build step —
open `index.html` in a browser.

## What it exercises

- Hand-rolled SVG rendering with pure layout functions (the approach chosen in #43) —
  the layout section ports to the real modules behind the `GraphView` seam.
- Horizontal main-flow spine, on-ramps above merging on, vocabulary + primitives
  underlay, standalone shelf and in-progress holding pen as right-hand columns.
- Click-through detail: inputs/outputs via the edge lists, when-to-use, per-skill
  install affordance (visual only), dimmed uninstalled states (mocked: 17 of 37).
- Designed to fit 1440×900 with no pan/zoom and no scroll.

## What's mocked

- The classification and edge tables are a draft transcribed from the ask-matt map and
  `skills-lock.json` categories — not the curated `src/data/skill-flow.ts` module.
- Installed states are a plausible mix, not live disk state through the seam.

React in the issue: what the real view keeps, drops, and adds.
