# Adopting Effect in @banquinha/workbench

**Date:** 2026-09-02
**Sources:** primary only — effect.website docs, the Effect-TS GitHub org, and the npm registry (queried live on this date).

## TL;DR

**Verdict:** adopt Effect now, narrowly, on the stable v3 line (`effect` 3.22.1). It is a good fit for this repo's two real weak spots — unvalidated generated data and silently-swallowed script errors — and a poor fit for the React components themselves. Do **not** wait for v4, but pin v3 and track the v4 RC (schema lands on an "unstable" import path there).

**Recommended first step:** `pnpm add effect`, then validate `src/data.generated.ts` with `effect/Schema` at the `src/data.ts` boundary. Today that file is only compile-time-typed (`satisfies OverviewData`); nothing checks it at runtime. Keep Zod for TanStack Router `validateSearch`.

---

## 1. What Effect is

Effect is "a TypeScript library for building production-grade software" built around typed error handling, structured concurrency, resource safety, and observability "all from one composable core" ([docs onboarding](https://effect.website/docs/v3/onboarding)). Its core type is `Effect<Success, Error, Requirements>` (usually written `Effect<A, E, R>`): a value that _describes_ a workflow which succeeds with `A`, fails with a typed `E`, or needs contextual dependencies `R` — "a description of a workflow or operation that is lazily executed" ([the-effect-type](https://effect.website/docs/v3/getting-started/the-effect-type)). Effect values are immutable and do nothing when created; they are interpreted by a runtime system, ideally from a single entry point like your app's `main` ([the-effect-type](https://effect.website/docs/v3/getting-started/the-effect-type)). npm describes the package as "The missing standard library for TypeScript" ([npm/effect](https://www.npmjs.com/package/effect)). Because errors and requirements live in the type, failure handling becomes exhaustive and refactorable rather than try/catch archaeology.

## 2. Ecosystem state (verified via npm registry, 2026-09-02)

| Package                                      | Version / dist-tag                               | Note                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                                     | **3.22.1** (`latest`, published 2026-07-30)      | stable line; dual ESM+CJS ([npm](https://www.npmjs.com/package/effect))                                                             |
| `effect`                                     | `4.0.0-rc.112` (`rc`), `4.0.0-beta.107` (`beta`) | v4 RC; stable targeted "Q3/Q4 2026" ([RC post, 2026-08-12](https://effect.website/blog/releases/effect/40-rc))                      |
| `@effect/platform` / `@effect/platform-node` | 0.97.1 / 0.108.1                                 | filesystem, HTTP, etc.; merged into core in v4 ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md))         |
| `@effect/cli` / `@effect/rpc`                | 0.77.0 / 0.76.2                                  | merged into core in v4 ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md))                                 |
| `@effect/schema`                             | 0.75.5, **deprecated**                           | "this package has been merged into the main effect package" ([npm](https://www.npmjs.com/package/@effect/schema))                   |
| `@effect/vitest`                             | 0.30.0                                           | peers: `effect ^3.22.0`, `vitest ^3.2.0` ([npm](https://www.npmjs.com/package/@effect/vitest))                                      |
| `@effect/atom-react`                         | 4.0.0-beta.107 (`latest` is a beta)              | official React bindings; requires `effect` v4 beta + react `>=19.2.7 <20` ([npm](https://www.npmjs.com/package/@effect/atom-react)) |

**TypeScript minimum:** v3 docs require "TypeScript 5.4 or newer" with `strict: true` ([v3 installation](https://effect.website/docs/v3/getting-started/installation)); the main-branch (v4) README requires "TypeScript 5.9 or newer", recommending TS 7 ([README](https://github.com/Effect-TS/effect/blob/main/README.md)). This repo's TS 6.0.3 + `strict: true` (`tsconfig.json`) satisfies both.

**ESM/CJS:** the published `effect@3.22.1` ships dual format — `dist/esm` (`import`) + `dist/cjs` (`require`) behind a full `exports` map (verified in the published package.json via `npm view effect@3.22.1`). In v4, ecosystem packages consolidate into core `effect` and "share a single version number"; v4 also introduces unstable modules under `effect/unstable/*` — **`schema` is in that unstable set** ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).

## 3. Installation & setup for this stack

```sh
# stable v3 line (recommended today)
pnpm add effect

# only if you want the v4 RC instead (not recommended for this repo yet)
pnpm add effect@rc
```

- **tsconfig:** nothing to change. Docs require only `strict: true` ([v3 installation](https://effect.website/docs/v3/getting-started/installation)); this repo already sets it. `moduleResolution: "bundler"` + `verbatimModuleSyntax` work fine with the dual-format package.
- **Vite:** no special config. The official v4 docs include a Vite + React walkthrough whose only setup step is the `strict` check plus installing `effect` — no plugin or alias ([v4 installation](https://effect.website/docs/v4/getting-started/installation)).
- **Vitest:** nothing required to run Effects in tests — `Effect.runPromise(...)` is a plain promise. Optional `@effect/vitest` (Effect-aware `it.effect` etc.) currently peers `vitest ^3.2.0`, while this repo pins **vitest 4.1.9** — a peer mismatch, so skip that package for now and use plain `runPromise` in `*.test.ts`.
- **Runtimes:** "Node.js 18 or newer is the general minimum" ([README](https://github.com/Effect-TS/effect/blob/main/README.md)); the package has no `engines` restriction (npm). Browser support is first-class (`@effect/platform-browser`; the docs' Vite walkthrough runs in the browser). This repo's Node 22-era scripts and DOM-target SPA are both covered.

## 4. Effect Schema vs the existing Zod 4

**Where Schema lives now:** validation is the `Schema` module of the core package — `import { Schema } from "effect"` ([schema introduction](https://effect.website/docs/v3/schema/introduction)). The old standalone `@effect/schema` package is deprecated with the note "merged into the main effect package" ([npm](https://www.npmjs.com/package/@effect/schema)).

**What it gives you over a plain type:** a schema is a single value describing both an _encoded_ shape (what you read off the wire) and a _decoded_ type (what you use), with `decode`/`encode`/`assert` operations "the data is both validated and transformed" ([schema introduction](https://effect.website/docs/v3/schema/introduction)). Decoding failures surface as typed `ParseError`s, and schemas can derive fast-check arbitraries, JSON Schema, equivalences, and pretty printers ([schema introduction](https://effect.website/docs/v3/schema/introduction)). Via `Schema.standardSchemaV1` any dependency-free schema also satisfies the cross-library Standard Schema v1 contract ([standard-schema docs](https://effect.website/docs/v3/schema/standard-schema)).

**What this repo actually uses Zod for:** exactly one thing — `validateSearch` in `src/routes/index.tsx` (a `z.object` with `.catch()` fallbacks over q/status/source/stream). TanStack Router accepts it directly because Zod v4 implements Standard Schema; the same docs list **Effect/Schema** as another no-adapter option via `S.standardSchemaV1` ([TanStack Router search params](https://tanstack.com/router/latest/docs/framework/react/guide/search-params)).

**Recommendation: use both, for different jobs.** Keep Zod 4 in `validateSearch` — the surface is one small schema, it is idiomatic for TanStack Router, and migrating it buys nothing. Use `effect/Schema` for the _data boundary this repo doesn't currently validate at all_: `src/data.generated.ts` is generated by `scripts/sync-data.mjs` via `JSON.stringify` and trusted purely on the compile-time `satisfies OverviewData` — if the generator drifts (e.g. `normalizeStatus` emits an unknown status string), nothing fails until a lookup returns `undefined` in the UI. Don't migrate the same values through both libraries.

## 5. React integration

There is **no official React bindings guide** in the v3 or v4 docs. The official React-adjacent package, `@effect/atom-react` ("React bindings for the Effect Atom modules"), is only published on the v4 beta track and requires `effect` 4 beta ([npm](https://www.npmjs.com/package/@effect/atom-react)) — not for production use yet. The documented approach for apps where Effect "is not the primary framework and access to the main entry is restricted" is **`ManagedRuntime`**: build one long-lived runtime from a `Layer`, call `runtime.runPromise(effect)`, and `await runtime.dispose()` at teardown ([runtime docs](https://effect.website/docs/v3/runtime)). For services-free code, plain `Effect.runPromise` suffices — the docs note it "is just an alias for `Runtime.runPromise(defaultRuntime)`" ([runtime docs](https://effect.website/docs/v3/runtime)).

Minimal pattern for this repo's TanStack Router loaders (adapted from the runtime docs; today's `loader: () => overviewData` stays as-is until a real fetch exists):

```ts
// src/lib/runtime.ts — module scope: one runtime for the app's lifetime
import { Data, Effect, Layer, ManagedRuntime } from "effect";

export class OverviewError extends Data.TaggedError("OverviewError")<{
  readonly cause: unknown;
}> {}

export const loadOverview = Effect.tryPromise({
  try: (signal) =>
    fetch("/api/overview", { signal }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as import("../types").OverviewData;
    }),
  catch: (cause) => new OverviewError({ cause }), // E is now OverviewError, not `any`
});

export const runtime = ManagedRuntime.make(Layer.empty); // swap in service Layers when they exist
```

```tsx
// src/routes/api-demo.tsx
import { createFileRoute } from "@tanstack/react-router";
import { runtime, loadOverview } from "../lib/runtime";

export const Route = createFileRoute("/api-demo")({
  loader: () => runtime.runPromise(loadOverview), // Promise<OverviewData>, rejects typed as OverviewError
  component: DemoPage,
});
```

Components that need one-off Effects can call `runtime.runPromise` the same way; the v4 docs' Vite + React example shows the simpler `Effect.runSync` inside a hook for pure UI work ([v4 installation](https://effect.website/docs/v4/getting-started/installation)). Note for the future: v4's MIGRATION.md lists `Runtime<R>` removals among its breaking changes — re-verify the runtime story when upgrading ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).

## 6. Where it fits in THIS codebase (staged, by risk/value)

1. **Validate `src/data.generated.ts` at startup with `effect/Schema`** _(do first — highest value, near-zero risk)_. Put the schemas next to `src/types.ts`, run `Schema.decodeUnknownSync` inside `src/data.ts` so a drifted generator fails loudly in dev/build instead of rendering empty strings. Example:

   ```ts
   // src/schema.ts
   import { Schema } from "effect";
   import { ticketStatuses } from "./types";

   export const TicketStatus = Schema.Literal(...ticketStatuses);

   export const TicketRecord = Schema.Struct({
     id: Schema.String,
     title: Schema.String,
     status: TicketStatus,
     statusLabel: Schema.String,
     statusDetail: Schema.String,
     group: Schema.String,
     lane: Schema.String,
     dependencies: Schema.String,
     summary: Schema.String,
     sourcePath: Schema.String,
     sourceUrl: Schema.String,
     kind: Schema.Literals(["ledger", "plan-ticket", "external"]),
     externalSource: Schema.optional(Schema.String),
     progress: Schema.Struct({ done: Schema.Number, total: Schema.Number }),
   });

   export const OverviewDataSchema = Schema.Struct({
     meta: Schema.Struct({ projectName: Schema.String /* ... remaining meta fields */ }),
     tickets: Schema.Array(TicketRecord),
     plans: Schema.Array(Schema.Struct({/* PlanRecord fields */})),
     changes: Schema.Array(Schema.Struct({/* SpecChangeRecord fields */})),
   });
   ```

   ```ts
   // src/data.ts — replaces the current re-export
   import { Schema } from "effect";
   import { overviewData } from "./data.generated";
   import { OverviewDataSchema } from "./schema";

   export const data = Schema.decodeUnknownSync(OverviewDataSchema)(overviewData);
   ```

   (`Schema.decodeUnknownSync` per [schema getting-started](https://effect.website/docs/v3/schema/getting-started).)

2. **`scripts/sync-data.mjs` + `scripts/services/shared.mjs` as the Node-side pilot.** Both are full of silent fallbacks — `readText` returns `""` on failure, `command()` swallows non-zero exits, `requestJson` converts every failure to an untyped `throw new Error`. Rewriting the fallible helpers with `Effect.try` / typed `Data.TaggedError`s (or even just `Either`) makes "GitHub API failed" visible instead of silently dropping tickets. Node-only, covered by `node --test`, and zero impact on the SPA bundle. This is where Effect's error channel earns its keep in this repo.

3. **Real data fetching, if/when the app gains an API** — use the section-5 loader pattern; add `Effect.timeout`/`Effect.retry` (docs: [retrying](https://effect.website/docs/v3/error-management/retrying)). `scripts/services/*.mjs` already hand-roll HTTP-status and JSON-parsing checks that `Effect.tryPromise` would replace cleanly.

4. **Typed errors in `src/lib/overview.ts`** _(last; possibly never)_. Today every function there is pure and total — filters, counts, sorts with no failure paths. Wrapping them in `Effect.gen` adds ceremony with no typed-error payoff. Only reach for Effect here if fallible logic (parsing, remote lookups) moves into this module.

**What NOT to migrate:** React components (`OverviewPage`, `PlanTable`, `TicketTable`), `src/lib/table.ts` TanStack Table feature wiring, `src/router.tsx`, the theme bootstrapping in `src/main.tsx`, and the Zod `validateSearch` schema. Effect complements this stack at the boundaries; it should not become the component layer.

## 7. Costs & risks

- **Learning curve.** The official onboarding path is five steps and "takes most developers a few focused days" ([onboarding](https://effect.website/docs/v3/onboarding)); the myths page argues you're productive with "just 10–20 functions" (`Effect.succeed`, `Effect.gen`, `Effect.runPromise`, `Effect.catchTag`, plus `Option`/`Either`) ([myths](https://effect.website/docs/v3/additional-resources/myths)). Real cost is idiomatic fluency (generators, `Layer`, `Data.TaggedError`), mostly for whoever touches the script pilot.
- **Bundle size.** Effect 3's "minimum cost is about 25k of gzipped code" and it tree-shakes (bundler-safe per the myths page) ([myths](https://effect.website/docs/v3/additional-resources/myths)); the v4 migration guide quotes "With Schema, ~15 KB" minified+gzipped ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)); the experimental `effect/Micro` module starts "at 5kb gzipped" for bundle-constrained clients ([Micro docs](https://effect.website/docs/v3/micro/new-users)). For this small internal SPA the ~25 KB worst case is acceptable; stage 1 keeps Schema off the hot path question anyway.
- **Debugging ergonomics.** Default logs are human-readable with fiber/level/span annotations; a colorized `Logger.pretty` layer exists for development ([logging docs](https://effect.website/docs/v3/observability/logging)). `@effect/language-service` adds editor diagnostics and a VS Code extension provides fiber inspection, span stacks, and breakpoints ([devtools docs](https://effect.website/docs/v3/getting-started/devtools)); a live DevTools server ships via `@effect/experimental` (0.61.1).
- **v4 transition risk.** The RC is declared interface-final, with community projects running it in production for months ([RC post](https://effect.website/blog/releases/effect/40-rc)), but v4 moves `schema` to an `effect/unstable/*` path and renames many APIs (v3→v4 schema renames are mostly "auto"-migratable, e.g. `decode` → `decodeEffect` — [migration/schema.md](https://github.com/Effect-TS/effect/blob/main/migration/schema.md)). Adopting v3 Schema now means a mechanical migration later; keep schemas in one file (`src/schema.ts`) to bound the blast radius.
- **Tooling mismatches found:** `@effect/vitest` peers `vitest ^3.2.0` (repo: 4.1.9); `@effect/atom-react` requires effect v4 beta. Neither blocks stages 1–2.
- **Ramp-up resources (official):** docs onboarding path ([link](https://effect.website/docs/v3/onboarding)), Effect University ([effect.kitlangton.com](https://effect.kitlangton.com/), linked from effect.website), Effect Days ([effect.website/effect-days](https://effect.website/effect-days/)) and the official YouTube playlists linked from the homepage.

## Sources

- https://effect.website/docs/v3/onboarding
- https://effect.website/docs/v3/getting-started/the-effect-type
- https://effect.website/docs/v3/getting-started/installation
- https://effect.website/docs/v4/getting-started/installation
- https://effect.website/blog/releases/effect/40-rc
- https://effect.website/docs/v3/schema/introduction
- https://effect.website/docs/v3/schema/getting-started
- https://effect.website/docs/v3/schema/standard-schema
- https://effect.website/docs/v3/runtime
- https://effect.website/docs/v3/additional-resources/myths
- https://effect.website/docs/v3/micro/new-users
- https://effect.website/docs/v3/observability/logging
- https://effect.website/docs/v3/getting-started/devtools
- https://effect.website/docs/v3/error-management/retrying
- https://github.com/Effect-TS/effect/blob/main/README.md
- https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- https://github.com/Effect-TS/effect/blob/main/migration/schema.md
- https://www.npmjs.com/package/effect (version/dist-tags/format queried via `npm view effect@3.22.1`, `npm view effect dist-tags`)
- https://www.npmjs.com/package/@effect/schema (deprecation notice)
- https://www.npmjs.com/package/@effect/vitest (peer deps)
- https://www.npmjs.com/package/@effect/atom-react (version + peers)
- https://tanstack.com/router/latest/docs/framework/react/guide/search-params
- Repo files read: `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `src/main.tsx`, `src/router.tsx`, `src/routes/index.tsx`, `src/types.ts`, `src/data.ts`, `src/lib/overview.ts`, `src/lib/table.ts`, `scripts/sync-data.mjs`, `scripts/config.mjs`, `scripts/services/shared.mjs`
