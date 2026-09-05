---
"@quick-release/workbench": minor
---

Land the Skill flow view at /flow with the skills-ecosystem Catalog (spec #54, ticket #58). Sync fetches the Catalog from mattpocock/skills (one recursive trees call, fail-open to last-good data and then the curated offline fallback) and snapshots installed state for static degradation; the execution seam serves the Catalog joined with live disk state and gains a per-skill install endpoint. The flow graph renders hand-rolled SVG behind the new GraphView seam with pure deterministic layout modules ported from the approved prototype; uninstalled entries dim, upstream-new skills land on the shelf, favorites become a filter, and the skills route retires for one Catalog home.
