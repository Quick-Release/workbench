# Public access: the source and the install are world-readable, and every company-reporting flow stays dormant unless the internal distribution provisions it

Status: accepted

Work item: GH-155

Workbench's source repository is public, and the package moves from GitHub Packages to the public npm registry (#107) — with those, the last org-only gates fall, and anyone can install and run the tool against their own host repository. The dashboard needs no account, no server, and no grant: it is a local control surface (ADR 0005) driven by the runner's own GitHub credentials. Public access is therefore a distribution fact, and this decision records what it does and does not change about the reporting posture ADR 0001 established.

ADR 0001 made telemetry mandatory and opt-out-free for an audience of employees, premised on the registry gating distribution to the company. That premise no longer holds for the whole audience, but the mechanism never depended on it: every company-reporting flow — Telemetry, Content-sourcing submissions, and the session-capture proxy — reads `TELEMETRY_INGEST_URL` and `TELEMETRY_INGEST_TOKEN` from the environment and stays dormant when they are unset (`scripts/sync/telemetry.mjs`, `scripts/seam/routes/submissions-api.mjs`, `scripts/seam/routes/llm-api.mjs`), and the ingest Worker answers 401 without the token even when its URL is known (`worker/ingest.mjs`). The two postures fall out of credential distribution alone: internal installs receive the endpoint and token through the company's provisioning; public installs never do, so they report nothing — an absent nothing, not a zero-filled one. There is deliberately no toggle: a public opt-in would require operating a public endpoint, which is not being offered. The mandatory, identified Telemetry of ADR 0001 is unchanged for the internal distribution and is scoped to it by this amendment.

The record also corrects itself: the worker documentation described the ingest token as "baked into the workbench package, whose GitHub Packages registry is the company boundary." No token was ever committed or shipped — a tree-by-tree scan of every commit in the repository's history found none — and no client code ever embedded one; the phrase described an intended distribution path that became provisioning into internal `.env` files. With the registry public, the boundary that sentence pointed at is gone anyway: the company boundary is the shared ingest token itself, and it stays unpublished, rotated on suspicion, and held by internal installs only.

## Considered options

- **Keep GitHub Packages and grant external collaborators** — rejected: per-stranger token ceremony, and "the entire world" is not an enumerable grant list.
- **Compile-time dual builds (internal/public distribution flags)** — rejected: environment gating already yields exactly the behavioral split; a second mechanism would be machinery in search of a difference.
- **Fork a public edition without the reporting flows** — rejected: two codebases to review, and the single artifact carries no secrets, so one codebase serves both postures.
- **Opt-in telemetry for public users** — deferred: there is nothing to opt into until a public endpoint exists; dormant-by-omission means offering one later is a configuration distribution, not a code change.
- **Public npm publish for a private tool** — the verdict `docs/research/versioning-and-distribution.md` recorded ("incompatible with this private internal tool") was premised on the tool staying private; it stopped being private, and #107 enacts the new posture.

## Consequences

- The install gate is npmjs.com's, i.e. none. Operational prerequisites for the flip are the `NPM_TOKEN` repository secret and the `@quick-release` scope on npmjs.com; both are human actions, tracked on the work item.
- The MIT license lands with this decision; without it the public source stayed all-rights-reserved and the granted access was read-only in law as well as in fact.
- Telemetry consumers must distinguish _unconfigured_ (skipped with reason `unconfigured`) from _reporting no usage_: a public install contributes absence, not zeros.
- `worker/README.md` no longer describes the token as package-baked; the deploy notes and the legacy runbook name provisioning as the distribution path.
- README and CONTEXT name the two postures, and "Developer" no longer implies employee.
- Rotating the shared ingest token remains the response to any suspected leakage; after this decision rotation re-binds internal installs through provisioning, never through a release.
