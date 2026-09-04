# Skills catalog and flow edges: upstream at sync, a curated flow file, live installed state

Status: accepted

Ticket #45 asked where Skill and SkillFlowEdge records come from at sync time. The decision splits the two by what actually changes upstream. The **Catalog** (which skills exist, id + category) is fetched from `mattpocock/skills` at sync time: one recursive trees call enumerating `skills/**/SKILL.md`, so category comes from the upstream directory path. **Classification** (flow role, skill flow edges, one-line blurbs, the offline fallback id list) lives in a curated typed module in this repo (`src/data/skill-flow.ts`) that shadows the ask-matt map's prose, edge by edge. The split is forced by the sources: upstream has no structured flow data anywhere, and `SKILL.md` frontmatter carries only `name`/`description`, so no fetch can ever produce edges — while hand-curating the catalog would pin its freshness to workbench releases for data a fetch gets for free. Installed state is never stored as truth: the seam reads disk (lockfile + well-known skill directories) per request, per ADR 0005. The browser always renders the full Catalog — uninstalled entries dimmed with a way to install. Scope is the Matt ecosystem only; `source` on the record keeps multi-source additive, and the multi-repo fog stays fog.

## Considered options

- **Committed catalog file as the primary source** — rejected: sync already speaks to GitHub for service adapters, and release-bound staleness bought nothing once edges had to be curated locally anyway.
- **Parse installed `SKILL.md` frontmatter as the catalog** — rejected: frontmatter lacks category and flow role, and an installed-only catalog cannot render the uninstalled entries the flow graph promises.
- **Regenerate the hardcoded 37-id list** — rejected: it drifts silently (37/37 complete today, zero categories encoded) and mixes data into code.
- **Parse the ask-matt prose at runtime** — rejected: `normalizeStatus`-style heuristic drift; upstream rewording breaks it.
- **Contribute structured frontmatter upstream** — the right someday: the curated module's shape makes migrating to it mechanical, but it cannot be the mechanism today.
- **Serve skills from the sync snapshot** — rejected for installed state: installs happen outside workbench (someone runs the skills CLI by hand), and that is exactly what a snapshot misses. The snapshot remains only as static-mode degradation.

## Consequences

- A skills collector in `pnpm sync` writes Skill records, plus an installed-state snapshot for static degradation only, into `src/data.generated.ts`. The upstream fetch is fail-open: unreachable GitHub degrades to last-good data and never fails a firewalled host repo's sync.
- The seam joins the bundled Catalog with live disk state. Staleness is therefore: Catalog as-of last successful sync (fallback: workbench-release curated data); installed state never stale; static builds as-of last sync, degrading actions per ADR 0005.
- The hardcoded `MATT_POCOCK_SKILL_IDS` array in `scripts/skills-api.mjs` is deleted. Descriptions resolve installed frontmatter → curated blurb → name only.
- Classification rulings: upstream-new skills enter the Catalog with no flow role (shelf, not graph, until classified); curated ids that vanish upstream are dropped unless installed — disk is the only truth for installed; `misc` is catalogued literally and classifiable (git-guardrails-claude-code → standalone); `deprecated` is filtered unless installed.
- Flow role is nullable: main-flow step, on-ramp, standalone, vocabulary layer, primitive, or none. Edge vocabulary: merges-onto | delegates-to | pairs-with | runs-internally | hands-off-to | next-step.
- v1 reuses the existing install-all action on the source card; per-skill install is prototype ticket #50's scope, which this decision unblocks.
