# Control surface: live reads and actions through one validated localhost seam

Status: accepted

Work item: GH-44

Ticket #44 asked whether the new dashboard views stay strictly visual. The decision reverses that lean: the new views are a control surface — they render the host repo's planning state live and start actions from the UI. The rationale is architecture purity, stated as one invariant: the browser talks only to the localhost `/api/*` **execution seam**; behind the seam the server shells out to the tools a Developer would run by hand (`gh`, `pnpm sync`, the skills CLI); everything crossing the seam in either direction passes the Effect Schema boundary. There is no separate setup-action category — the existing skills-install and tools-setup endpoints are the first members of the one seam, and new views reuse it.

## Considered options

- **Strictly visual (the ticket's original lean)** — rejected: a briefing-only dashboard can name the next action but not start it; the wayfinder map priced this reversal as a destination redraw, and the decision took it.
- **Advice plus copyable commands only** — rejected as the ceiling; kept as the static-mode degradation when no dev server is running.
- **Browser-direct GitHub writes** — rejected: tokens in the browser, a second auth path, writes outside the schema boundary.
- **Hosted backend** — rejected: one install serves one host repo, locally.

## Consequences

- ADR 0001's consequence "the browser app still makes zero network calls" narrows to zero *remote* network calls; the localhost execution seam is excepted. Reporting still happens only in sync, and the telemetry contract is unchanged.
- Phase-1 action scope: triage-state moves, issue create/edit/comment, blocker-edge edits, sync trigger. Destructive or costly actions (close, wontfix, blocker-edge removal, and any future session spawn) confirm first; label moves fire directly; no undo in v1 — GitHub history is the audit log.
- Static builds (no dev server) degrade action affordances to copy-the-command.
- Starting agent sessions from the dashboard is the declared destination but gets its own decision; until then the session database is observed, never acted on.
- The live-seam grilling ticket is absorbed by this decision: reads are live, served by the dev-server API.
- The invariant gets one mechanical guard: a vitest source-scan (`src/architecture.test.ts`) asserting no `fetch()` outside `/api/`-relative URLs in `src/**` and no Node-builtin or tracker-client imports in browser code.
- README's "read-only" wording is now wrong; rewording happens in the build slice.
