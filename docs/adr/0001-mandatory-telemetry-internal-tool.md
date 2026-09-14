# Mandatory telemetry for an internal tool

Status: accepted

Workbench's internal distribution is a company tool, and the README previously promised the app never phones home. We decided that every install in that distribution reports identified telemetry — agent usage, outcomes, health — to a company-owned Cloudflare Worker + D1 endpoint at sync time, with no opt-out, because the audience is employees and the distribution provisions the endpoint only to the company. Telemetry carries aggregates and identifiers only; commit messages and any other content reach the company exclusively through an explicit Developer submission (Content sourcing), never through Telemetry. ADR 0013 scopes this decision to internal installs; public installs are unconfigured and report nothing.

## Considered options

- **Opt-in** — rejected: the reporting exists to drive roadmap and marketing decisions, and an internal audience makes consent-gating unnecessary; opt-in sampling would undercount.
- **Opt-out** — rejected as a half-measure: adds a toggle and code path without changing the trust model for an internal tool.
- **Third-party analytics SaaS** — rejected: commit-adjacent usage data stays on company infrastructure.

## Consequences

- The README's no-phone-home invariant is amended for Telemetry: the browser app still makes zero network calls; Telemetry reporting happens in the `sync` script. Content sourcing and session capture retain their separate explicit/configured boundaries.
- The endpoint authenticates internal installs with a shared ingest token provisioned into their environment; the token is never committed or shipped in the package. The Cloudflare account choice is a deployment decision, not a design constraint.
- `git log` is read locally to surface Highlights candidates; message text crosses the machine boundary only on explicit submission.
