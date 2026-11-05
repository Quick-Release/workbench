# Baseline upgrades arrive as reviewed host changes; conformance diagnosis is read-only

Status: accepted

Work item: none yet. Research and owner acceptance: `docs/research/software-factory-adoption-model.md` (PR #258, 2026-11-04).

A Factory baseline (ADR 0024) changes over time, and host repos drift from it. Workbench handles both with two separate mechanisms.

**Diagnosis.** A read-only Conformance report, produced by the Host Repo Doctor (#125), compares a host against its Baseline adoption. For each opinion it reports ready, missing, drifted, customised or unknown. The opinions it covers are tracker labels, skill pins, conventions docs, rulesets and branch protection, and CI check names. It offers a CI-friendly exit code, and it never mutates anything.

**Change.** Moving a host to a new baseline version is always a proposed diff that the Developer approves as a host PR. The bump can come from a dependency bot or from `workbench upgrade`. This is the model used by Copier, cruft, `nx migrate` and Renovate. Label creations and renames are listed explicitly and never applied automatically.

This keeps ADR 0005's rule that the seam runs only what a Developer would run by hand, and ADR 0011's rule that a human's review admits a change.

## Considered options

- **A live reference that hosts follow automatically** — rejected for vendored opinions such as docs, skills and labels: a silent change to a host's conventions is a decision that looks like an accident. Opinions that need to be live are enforced by the platform instead (ADR 0026).
- **A doctor that also fixes** — rejected: diagnosis and mutation have different authority. Fixing is the upgrade path's job, behind confirm-first semantics.

## Consequences

- Declared deviations are reported as customised, not drifted. Only undeclared differences count as Baseline drift.
- An upgrade PR needs a human review per host. That is deliberate and slower than a live reference; fast-moving rules belong in rulesets.
- If upgrade PRs later become agent-assisted, they go through the Publisher contract of ADR 0022, not a new path.
- Each step of the move from today's model can ship on its own:
  1. collect the scattered defaults into the baseline module;
  2. add the adoption record;
  3. make skill installs follow the baseline's pins;
  4. ship the doctor;
  5. add `workbench upgrade`.
