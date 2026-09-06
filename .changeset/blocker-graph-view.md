---
"@quick-release/workbench": minor
---

Land the blocker graph view at `/blockers` (spec #54, ticket #61). The approved prototype ports behind the GraphView seam: depth columns from a pure longest-path layout (blockers left, blocked right), closed tickets contracted behind an expand toggle, frontier highlighting, and the edge grammar — solid amber open gates, dashed gray satisfied edges, dashed red broken references that fail closed as warning nodes. The execution seam gains blocker-edge add/remove endpoints over the native blocked-by API (removal confirmed, destructive), and the shared issue panel carries both actions, degrading to copy-the-command on static builds. Effort, focus, and expand ride the `?effort`/`?focus`/`?expand` params; the panel's show-in-graph jump lands focused.
