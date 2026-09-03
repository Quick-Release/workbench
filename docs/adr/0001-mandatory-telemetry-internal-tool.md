# Mandatory telemetry for an internal tool

Status: accepted

Workbench is an internal company tool distributed through GitHub Packages, and the README previously promised the app never phones home. We decided that every install reports identified telemetry — agent usage, outcomes, health — to a company-owned Cloudflare Worker + D1 endpoint at sync time, with no opt-out, because the audience is employees and the registry itself already gates distribution to the company. Telemetry carries aggregates and identifiers only; commit messages and any other content reach the company exclusively through an explicit Developer submission (Content sourcing), never through Telemetry.

## Considered options

- **Opt-in** — rejected: the reporting exists to drive roadmap and marketing decisions, and an internal audience makes consent-gating unnecessary; opt-in sampling would undercount.
- **Opt-out** — rejected as a half-measure: adds a toggle and code path without changing the trust model for an internal tool.
- **Third-party analytics SaaS** — rejected: commit-adjacent usage data stays on company infrastructure.

## Consequences

- The README's no-phone-home invariant is amended: the browser app still makes zero network calls; all reporting happens in the `sync` script.
- The endpoint authenticates installs with a shared ingest token baked into the package; the Cloudflare account choice is a deployment decision, not a design constraint.
- `git log` is read locally to surface Highlights candidates; message text crosses the machine boundary only on explicit submission.
