# Node-side modules

This directory contains the Node-side implementation shipped with Workbench. It
has four distinct roles:

- `commands/` — direct package, CLI, and release entrypoints;
- `host/` — host-repository configuration, path discovery, and live host files;
- `sync/` — snapshot collectors and reporting used by `pnpm sync`;
- `seam/` — Vite middleware and execution-seam implementations;
- `services/` and `tracker/` — separate external-source adapters (ADR 0008).

Tests generally live beside the modules they exercise; cross-module route tests
stay with the public route. Vite plugin declaration shims (`*.d.mts`) also stay
beside their plugin modules.

## Import direction

- `commands/` orchestrates `host/`, `sync/`, `services/`, and `tracker/`.
- `sync/` may use host helpers and source adapters, but does not register Vite
  middleware.
- `seam/routes/` owns HTTP request/response handling at the localhost
  execution seam. Route modules may call `host/`, `services/`, `tracker/`, and
  the seam's internal AI/review modules.
- `host/` must not import route modules. In particular, live skill discovery
  belongs in `host/skills.mjs` so both sync and the skills route can use it.

Keep `src/types.ts` and `src/schema.ts` as the canonical browser snapshot and
execution-seam contracts; this directory should not grow a second contract
system.
