# Graph rendering approach for the flow and blocker graphs

**Date:** 2026-09-04

**Sources:** primary only — the npm registry metadata and published packages of each candidate (including an import/render harness run against the actual tarballs in plain Node), the Bundlephobia size API, the GitHub APIs for each library repo, the official React Flow documentation (reactflow.dev), and this repository's own test seam and planning docs.

## Question

Which rendering approach should the skill-flow graph (~37 nodes, ~20 edges, static, clustered by flow role) and the blocker/dependency graph (GitHub-issue DAG with computed frontier highlighting, ≤ ~50 nodes typical) build on, given the `renderToString` smoke-test seam, React 19.2, dark-only shadcn/Tailwind 4 tokens, and the team's dependency aversion?

## Finding

The make-or-break criterion turned out **not** to discriminate: every candidate survived `renderToString` in a DOM-less Node process. The real differentiators are bundle weight, transitive dependencies, theming fit, and how much of each library a static dashboard actually uses. Verified per candidate (details and repro under "Verification"):

### Hand-rolled SVG/CSS — no library (baseline)

- SSR: `renderToString` natively serializes SVG elements; there is no third-party import-time surface at all. Trivially safe.
- Bundle: 0 kB added. Cost is ~100–200 lines of own layout code per graph family (the flow graph is a static clustered layout — role lanes; the blocker DAG needs layer assignment + within-layer ordering).
- React 19 / maintenance / license: N/A — it is repo code behind the planned `GraphView` seam (`docs/wayfinding/skills-ecosystem-dashboard.md:207-211` already mandates that seam "so the library stays swappable").
- Frontier highlighting and flow-role clustering are presentation concerns no layout library provides; they reduce to Tailwind token classes on SVG elements either way.

### @dagrejs/dagre 3.1.1 — layout engine, rendering stays hand-rolled

- SSR: verified safe. The package is pure JavaScript (no React, no DOM): in plain Node, `import('@dagrejs/dagre')` succeeded with zero browser globals and `dagre.layout(g)` computed ranks/coordinates for a test graph. Its only dependency is `@dagrejs/graphlib` 4.0.5 (npm registry).
- Bundle: 15.8 kB gzip / 46.8 kB minified, 1 dependency (Bundlephobia API).
- React 19: N/A — no React peer dependency; layout is a pure function from graph to positions.
- Maintenance: actively maintained — npm releases 3.0.0 (2026-03-22), 3.1.0 (2026-08-02), 3.1.1 (2026-08-08); repo pushed 2026-08-08; ~174 open issues; ~5.8k stars (npm registry; `gh api repos/dagrejs/dagre`). Note the GitHub _releases_ page lags at v2.0.0 — npm is the live channel.
- License: MIT (npm registry).
- Caveat: the unscoped `dagre` package (0.8.5) is dead — last publish 2019-12-03, still pulling `lodash` and `graphlib@2`. `@dagrejs/dagre` is the maintained continuation; only the scoped name qualifies.

### @xyflow/react 12.11.6 (React Flow v12)

- SSR: verified safe with the documented pattern, with a real trap. The official guide states "Server side rendering is supported since React Flow 12" and requires per-node `width`/`height` (or `initialWidth`/`initialHeight`) plus `handles` for edges ([SSR guide](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration)). Empirically in plain Node `renderToString`:
  - the documented pattern — `<ReactFlowProvider initialNodes={…} initialEdges={…} initialWidth initialHeight>` — rendered node content and edge `<path>` elements (≈3.7 kB of markup);
  - the everyday controlled usage — `<ReactFlow nodes={…} edges={…}>` — rendered only the shell: the `react-flow__nodes`/`react-flow__edges` containers were empty (store population happens in effects, which never run during server render). A smoke test written the natural way would silently assert an empty graph.
- Bundle: 59.9 kB gzip / 187.7 kB minified, 3 runtime dependencies (`zustand ^4.4`, `classcat`, `@xyflow/system`) plus a required stylesheet (`style.css`/`base.css`) whose `--xy-*` custom properties would need overriding to sit inside the dark-only token system (inspected in the published package).
- React 19: peer range `react >=17` (npm registry); ran against this repo's pinned react/react-dom 19.2.8 with `renderToString` without errors (with `zustand` 4.5.7 resolved transitively).
- Maintenance: very active — 12.11.4/12.11.5 published 2026-08-25, 12.11.6 on 2026-09-01; repo pushed 2026-09-02; ~130 open issues; ~38.2k stars (npm registry; `gh api repos/xyflow/xyflow`).
- License: MIT (npm registry; the project "will always be open source and MIT-licensed" per [attribution policy](https://reactflow.dev/attribution)) — but the renderer emits an attribution panel by default, and the policy is explicit that "Subscribing to React Flow Pro permits you to remove the attribution" ($169/mo Starter at time of writing). Confirmed empirically: the SSR output contained the attribution panel with a `data-message` stating hiding it requires a Pro subscription. For an internal, read-only dashboard this is a soft cost, not a legal blocker, but it is friction the other options don't have.
- Fit: its value is pan/zoom, dragging, connections, and editing — all unused for static dashboards. The v12 announcement frames SSR mainly for static diagram/OG-image generation ([12.0.0 release notes](https://reactflow.dev/whats-new/2024-07-09)).

### elkjs 0.12.0

- SSR: verified safe — `import('elkjs/lib/elk.bundled.js')` and a full `elk.layout(…)` call ran in plain Node with no Worker and no DOM.
- Bundle: 433.4 kB gzip / 1.45 MB minified (Bundlephobia API) — it ships the GWT-compiled Eclipse Layout Kernel. Disqualifying at ≤50 nodes.
- Maintenance: 0.12.0 published 2026-07-17; repo pushed 2026-08-13; ~98 open issues (npm registry; `gh api repos/kieler/elkjs`).
- License: `EPL-2.0 OR GPL-3.0-or-later` (npm registry) — weak copyleft, a different compliance conversation from the repo's MIT/Apache-style deps.

## Recommended implementation

Build **hand-rolled SVG for both graphs**, with layout computed by pure TypeScript modules in-repo:

1. **Flow graph:** a static clustered layout (fixed lanes/columns per flow role, nodes stacked within a lane). This is arithmetic, not graph theory — no library needed.
2. **Blocker DAG:** a small layered layout — longest-path ranking, BFS/median within-layer ordering, barycenter pass or two for crossing reduction — implemented as pure functions so they get ordinary node-side unit tests (repo convention: excess-property rejection matrix + `renderToString` smoke test per view).
3. **Rendering:** plain SVG elements styled with Tailwind 4 tokens (dark-only values per ADR 0002), so node/edge styling uses the exact same classes as the rest of the shell. Frontier highlighting is a class toggle computed from graph data.
4. Keep everything behind the `GraphView` seam the wayfinding doc already requires, so the layout half stays swappable without touching the views.

**Fallback path if the test seam or layout quality breaks:** swap the _layout_ module — not the views — for `@dagrejs/dagre@3.1.1` (MIT, 15.8 kB gzip, 1 transitive dep, releases in March and August 2026). It was verified to import and lay out graphs in DOM-less Node, so it cannot break `renderToString`; rendering remains hand-rolled SVG either way. Adopt it deliberately if the hand-rolled DAG ordering produces unacceptable edge crossings or eats more maintenance time than 15.8 kB justifies.

**Ruled out:** `@xyflow/react` (works under `renderToString` only via the `initial*` provider pattern; ~60 kB gzip + zustand + a stylesheet to retheme + the Pro-gated attribution request, for interactivity a static dashboard never invokes) and `elkjs` (433 kB gzip and EPL/GPL licensing for layout quality ≤50 nodes doesn't need).

## Edge cases

- **The controlled-prop trap if xyflow is ever revisited:** `<ReactFlow nodes={…}>` renders an empty shell server-side; only the `ReactFlowProvider` `initialNodes`/`initialEdges`/`initialWidth`/`initialHeight` pattern produces content under `renderToString` (verified). Any xyflow-based smoke test must use that pattern or it will pass vacuously.
- **Node sizing:** hand-rolled SVG needs fixed node boxes (the graphs' labels are known strings, so generous fixed sizes work). If text measurement is ever needed, that is a browser-only concern and belongs in effects, never in initial render — the same discipline the sidebar cookie work recorded.
- **Determinism:** own layout functions and dagre are both deterministic for identical input, so snapshot-style assertions in `renderToString` tests are stable.
- **Interaction creep:** if a graph ever needs pan/zoom or dragging, that is the moment to re-evaluate xyflow behind the `GraphView` seam; this decision only fixes the _starting_ point, per the seam's stated purpose.
- **Original `dagre` package:** must not be picked up transitively or by mistake; it has been unmaintained since 2019.

## Test implications

- Each new view keeps the existing seam: `renderToString` from `react-dom/server` with `vite-plus/test`, plus the `globalThis.document` stub pattern where a component reads browser APIs (`src/components/ui/sidebar.test.tsx:1-27`). Hand-rolled SVG needs no new stubbing.
- Smoke tests should assert real structure (number of rendered node groups, presence of edge `<path>`s, frontier classes), not just non-empty markup.
- If the dagre fallback is adopted, its usage stays confined to a pure `layout(graph)` function testable in plain Node — verified to work without any DOM.

## Verification

- Ran a plain-Node harness (`node` 22, no DOM, no polyfills) against the exact published tarballs: `@xyflow/react@12.11.6`, `@dagrejs/dagre@3.1.1`, `elkjs@0.12.0` with `react@19.2.8`/`react-dom@19.2.8` — dynamic `import()` of each package; `dagre.layout()` and `elk.layout()` calls; `renderToString` of React Flow in three configurations (controlled props → empty shell; with explicit dims → containers only; `ReactFlowProvider initialNodes` → full node content + edge paths, ≈3.7 kB markup). Harness outputs quoted above; installed transitive `zustand` was 4.5.7.
- Bundlephobia size API queried for all three packages on 2026-09-04 (sizes cited above).
- npm registry metadata (`registry.npmjs.org`) for versions, publish dates, licenses, peer/dependencies.
- GitHub API via `gh api` for `xyflow/xyflow`, `dagrejs/dagre`, `kieler/elkjs` (stars, open issues, push dates, releases).
- No repo code was changed for this note; the only write is this file.

## Sources

- Repo test seam: `src/components/ui/sidebar.test.tsx:1-27`, `src/components/layout/shell.test.tsx:1,59`, React 19.2.8 pinned at `package.json:54`
- Repo planning context: `docs/wayfinding/skills-ecosystem-dashboard.md:207-211` (Graph layer + `GraphView` seam), `docs/adr/0002-dashboard-shell-design-decisions.md` (dark-only, vendored token-driven primitives)
- [React Flow SSR/SSG guide](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration) — "Server side rendering is supported since React Flow 12"; width/height/handles requirements
- [React Flow 12.0.0 release notes](https://reactflow.dev/whats-new/2024-07-09) — SSR feature framing, `@xyflow/react` package rename
- [React Flow attribution policy](https://reactflow.dev/attribution) — MIT license statement; Pro subscription required to remove attribution
- npm registry: [@xyflow/react](https://registry.npmjs.org/@xyflow/react), [@dagrejs/dagre](https://registry.npmjs.org/@dagrejs/dagre), [elkjs](https://registry.npmjs.org/elkjs), [dagre](https://registry.npmjs.org/dagre)
- Bundlephobia size API: `https://bundlephobia.com/api/size?package=…` for the three versions named above
- GitHub repos: [xyflow/xyflow](https://github.com/xyflow/xyflow), [dagrejs/dagre](https://github.com/dagrejs/dagre), [kieler/elkjs](https://github.com/kieler/elkjs)
- Empirical harness: plain-Node import/layout/renderToString runs against the published packages, 2026-09-04 (methodology under Verification)
