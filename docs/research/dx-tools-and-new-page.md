# Adding a new page + sidebar link, and DX tooling shortlist

**Date:** 2026-09-04
**Sources:** Part A primary — repo source read on this date (`src/routes/*`, `src/components/layout/*`, `src/router.tsx`, `src/routeTree.gen.ts`, `vite.config.ts`, `package.json`). Part B primary — official sites/docs/repos as cited per tool.

## TL;DR

- **New page = 2 file edits, 0 manual codegen.** Create `src/routes/<name>.tsx` with `createFileRoute`, add a `linkOptions` entry + item in `src/components/layout/nav-main.tsx`. The TanStack Router Vite plugin regenerates `src/routeTree.gen.ts` automatically on dev/build; no CLI command needed.
- **"fallow" is real**: `fallow-rs/fallow`, a free MIT-licensed Rust codebase-intelligence CLI for TS/JS (dead code, circular deps, duplication). Complementary to CodeRabbit, not a competitor.
- **CodeRabbit** is the strongest AI-review option; this repo is private (publishes to `npm.pkg.github.com`, `package.json:18-20`), so the free tier gives summaries only — full review needs $24/dev/mo.
- Repo already has: changesets, a release CI workflow, and vite-plus `fmt`/`lint` — so Biome/ESLint/Prettier/changesets recommendations below are "already covered".

---

## Part A — Recipe: new page with a sidebar link

### How routing works here (from source)

- File-based routing: every `src/routes/*.tsx` exporting `Route = createFileRoute("/path")` is picked up. Current routes: `src/routes/__root.tsx:6` (root, renders `AppShell` + `Outlet`), `src/routes/index.tsx:26` (`/`), `src/routes/sessions.tsx:13` (`/sessions`).
- Route tree generation is done by the **Vite plugin**, not a CLI: `vite.config.ts:17` includes `tanstackRouter({ target: "react" })` from `@tanstack/router-plugin` (`package.json:44`). The plugin regenerates `src/routeTree.gen.ts` automatically whenever routes change during `pnpm dev` / `pnpm build`. The generated file itself says "You should NOT make any changes" (`src/routeTree.gen.ts:7`) and is excluded from fmt/lint (`vite.config.ts:6-11`).
- The router instance is `src/router.tsx:5-9`; `defaultPreload: "intent"` means the sidebar's `Link` preloads route data on hover.
- Sidebar nav lives entirely in `src/components/layout/nav-main.tsx`: each entry is a `linkOptions({ to, search })` object (`nav-main.tsx:14-21`) spread into a typed `navItems` array (`nav-main.tsx:28-31`). `linkOptions` is what keeps entries type-checked against the generated route tree **including required search-param defaults** — a link with wrong/missing search defaults fails `pnpm check`. Active state is `pathname === link.to` (`nav-main.tsx:45`). Icons are `lucide-react` components (`nav-main.tsx:2`).

### Step-by-step: add `/tools`

**1. Create `src/routes/tools.tsx`** (minimal, matching the existing route style — see `sessions.tsx:13-20` for the fuller version with search params):

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tools")({
  component: ToolsRoute,
});

function ToolsRoute() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Tools</h1>
    </div>
  );
}
```

If the page needs URL state, copy the `sessions.tsx` pattern: `validateSearch` zod schema with `.catch(...)` defaults + `stripSearchParams` middleware (`src/routes/sessions.tsx:7-17`).

**2. Edit `src/components/layout/nav-main.tsx`:**

```tsx
import { Activity, ReceiptText, Wrench } from "lucide-react"; // add an icon

const toolsLink = linkOptions({ to: "/tools" }); // no search params → no search key

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof sessionsLink
  | typeof toolsLink // add to the union so typing stays exact
);

export const navItems: NavItem[] = [
  { title: "Overview", icon: ReceiptText, ...overviewLink },
  { title: "Agent sessions", icon: Activity, ...sessionsLink },
  { title: "Tools", icon: Wrench, ...toolsLink },
];
```

**3. Nothing else.** Start `pnpm dev` (or run `pnpm build`); the plugin regenerates `src/routeTree.gen.ts` with the new route, TypeScript picks it up, and `linkOptions({ to: "/tools" })` type-checks. No manual codegen command exists or is needed for this setup.

**Gotcha:** if you write the `linkOptions` before the route file exists, `pnpm check` fails on the unknown `to` path — create the route file first, or save it and let the dev server regenerate before linting.

---

## Part B — DX tooling for this repo

Stack context: TypeScript, Vite (+ `vite-plus` which already provides `fmt`/`lint`/`test` commands — `package.json:27-33`), React 19, TanStack Router, Cloudflare Workers deployed via alchemy (`package.json:16,24`), pnpm, changesets already wired into `.github/workflows/release.yml`.

### The two named tools

**CodeRabbit** — AI code review as a GitHub App. Reviews every PR with line-by-line comments, can be wired to review agent-authored PRs. Install: sign in at [coderabbit.ai](https://coderabbit.ai), install the GitHub App on `Quick-Release/workbench`, optionally add a `.coderabbit.yaml` ([docs.coderabbit.ai](https://docs.coderabbit.ai)). Pricing: free tier is permanent but limited to PR summarization + release notes on private repos; **OSS/public repos get Pro-tier reviews free**; paid starts at $24/dev/mo (Essentials, annual) with a 14-day Pro trial ([coderabbit.ai/pricing](https://www.coderabbit.ai/pricing), [docs.coderabbit.ai/management/plans](https://docs.coderabbit.ai/management/plans)). Since this repo is private, meaningful review requires a paid seat or accepting summary-only. Setup effort: GitHub App, ~5 minutes, zero config files required.

**Fallow** (`fallow-rs/fallow`) — verified: a free, MIT-licensed, Rust-based **codebase intelligence** tool for TypeScript/JavaScript, not an AI reviewer. Single binary detects unused code (files/exports/types/deps), circular dependencies, duplication, complexity hotspots, architecture boundary violations, and CSS drift; deterministic, 100+ framework plugins; ships as CLI (`npx fallow`), GitHub Action (`fallow-rs/fallow@v3`), and VS Code extension (LSP). Optional paid "Fallow Runtime" layer adds production-coverage evidence ([github.com/fallow-rs/fallow](https://github.com/fallow-rs/fallow), [GitHub Marketplace action](https://github.com/marketplace/actions/fallow-codebase-intelligence)). Particularly relevant here: this codebase is partly agent-generated, and Fallow's dead-code/duplication checks are exactly the failure mode of agent code. `npx fallow recommend` auto-detects the stack and proposes a config; `npx fallow audit` gates only newly-introduced findings, which suits a PR check. Setup effort: one devDependency + optional workflow step; no config needed to start.

The two are complementary: Fallow = deterministic structural analysis (free), CodeRabbit = LLM review (paid for private repos). Using both is a common combo.

### Other candidates

- **Renovate** ([docs.renovatebot.com](https://docs.renovatebot.com)) — automated dependency-update PRs, pnpm-native, grouped updates keep this repo's many pinned deps (`effect`/`@effect/*` RC pins, `alchemy` beta) from drifting silently. Free for OSS; included free on private repos via the Mend-hosted GitHub App. Setup: GitHub App or `renovate.json`. **Best pick** for this repo's dependency churn. Alternative: **Dependabot** ([docs.github.com](https://docs.github.com/en/code-security/dependabot)) — built into GitHub, zero signup, but weaker grouping and no pnpm-aware grouping schedules.
- **GitHub Actions CI** — already present: `.github/workflows/release.yml` runs `pnpm install --frozen-lockfile` + `pnpm check` on push to main (`.github/workflows/release.yml:1-30`). Gap: nothing runs on PRs. Cheap win: add a `pull_request` trigger or a small CI workflow running `pnpm check && pnpm test`. Free for private repos within Actions minutes quota.
- **CodeQL** ([codeql.github.com](https://codeql.github.com)) — GitHub's free-for-OSS semantic code analysis (JS/TS). For private repos requires GHAS (paid) — so effectively **skip** unless the org already has Advanced Security.
- **Biome** / **ESLint + Prettier** — **redundant here**: `vite-plus` already provides `vp fmt` / `vp lint` wired into `pnpm check` (`package.json:31-33`, `vite.config.ts:5-11`). Only revisit if vite-plus's linting proves insufficient.
- **Husky + lint-staged / lefthook** — pre-commit formatting. `pnpm check` in CI already blocks unformatted code; hooks add local speed but the repo has deliberately avoided them so far. **Maybe** — lefthook ([github.com/evilmartians/lefthook](https://github.com/evilmartians/lefthook)) is the lighter, Go-binary option if wanted.
- **Changesets** — **already installed and wired** (`@changesets/cli` at `package.json:66`; `changeset`/`release-publish` scripts; changesets action in `release.yml`). Nothing to do.
- **Socket** ([socket.dev](https://socket.dev)) — npm supply-chain security (install scripts, typosquats, manifest diffing). Useful given the RC/beta-heavy dependency set; free tier covers public repos, private repos need a paid plan. **Maybe.** **Snyk** ([snyk.io](https://snyk.io)) — broader vuln scanning with generous free tier but noisy for a non-web-facing CLI tool; Socket or Renovate's advisories cover most of the value.
- **Graphite** ([graphite.dev](https://graphite.dev)) — stacked-PR workflow + free "Diamond" AI review on PRs. Only worth it if the team adopts stacked diffs as a process; otherwise skip. Free for individuals.

### Shortlist

| Tool                    | Verdict         | Why                                                                                       | Cost                            | Setup                                  |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| Fallow                  | **Install now** | Free dead-code/dup/circular-dep analysis; ideal for agent-generated TS                    | Free (MIT)                      | `pnpm add -D fallow` + optional Action |
| Renovate                | **Install now** | Dependency pins on RCs/betas drift without it                                             | Free                            | GitHub App + `renovate.json`           |
| PR CI workflow          | **Install now** | `pnpm check`/`test` currently only run on main pushes                                     | Free (minutes)                  | ~10-line YAML                          |
| CodeRabbit              | **Maybe**       | Best-in-class AI review, but private repo ⇒ $24/dev/mo for real reviews; try 14-day trial | Free tier summaries; $24/dev/mo | GitHub App                             |
| Socket                  | **Maybe**       | Supply-chain risk on RC/beta deps                                                         | Paid for private                | GitHub App                             |
| lefthook                | **Maybe**       | Local fmt speed; CI already enforces                                                      | Free                            | config file                            |
| Graphite                | **Skip**        | Process change, not a gap                                                                 | Free tier                       | App + CLI                              |
| CodeQL                  | **Skip**        | Private repo ⇒ GHAS paid                                                                  | $                               | none                                   |
| Biome / ESLint+Prettier | **Skip**        | vite-plus already does fmt/lint                                                           | Free                            | —                                      |
| Changesets / Dependabot | **Skip**        | Changesets already in; Renovate preferred over Dependabot                                 | Free                            | —                                      |

---

## Sources

- Repo source: `src/routes/{__root,index,sessions}.tsx`, `src/router.tsx`, `src/routeTree.gen.ts:5-9`, `src/components/layout/{app-sidebar,nav-main}.tsx`, `vite.config.ts:6-22`, `package.json`, `.github/workflows/release.yml` (read 2026-09-04).
- [coderabbit.ai/pricing](https://www.coderabbit.ai/pricing), [docs.coderabbit.ai/management/plans](https://docs.coderabbit.ai/management/plans)
- [github.com/fallow-rs/fallow](https://github.com/fallow-rs/fallow), [Fallow GitHub Action](https://github.com/marketplace/actions/fallow-codebase-intelligence)
- [docs.renovatebot.com](https://docs.renovatebot.com), [docs.github.com/en/code-security/dependabot](https://docs.github.com/en/code-security/dependabot), [codeql.github.com](https://codeql.github.com), [socket.dev](https://socket.dev), [snyk.io](https://snyk.io), [graphite.dev](https://graphite.dev), [github.com/evilmartians/lefthook](https://github.com/evilmartians/lefthook)
