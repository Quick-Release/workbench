# Trusted clarification context and readiness

Status: accepted

Work item: GH-162

Workbench will assemble a bounded, versioned **Context packet** for each Workbench-owned **Clarification attempt**. The packet pins the selected issue revision, resolved host and repository context, related planning records, selected skills, approved public research, readiness dimensions, coverage warnings, and the data-flow/authorization manifest. It is immutable evidence for one attempt, not permission to execute commands or expand capabilities. A task-profiled **Issue brief** distinguishes the minimum information required for bugs, refactors, and feature requests; a **Clarification draft** may contain labelled assumptions, but material gaps remain `needs-information` until the Developer resolves them. Preparation, clarification start, draft saving, and exact issue-body publication are separate gates. Publication requires a fresh issue revision check, a single-use approval for the visible body diff, and read-back reconciliation.

Readiness remains multi-dimensional: tracker eligibility, brief completeness, host capability, research sufficiency, and authorization each report `ready`, `needs-information`, `unsupported`, or `unknown`; `blocked` is a reason, not a fifth verdict. Declarative manifests and lockfiles may be read to establish dependency versions, but Workbench must not install, resolve against registries, run scripts, import project modules, invoke `--help`, or use discovered commands as execution permission. Version-matched official documentation is preferred; version-aware documentation services and optional bounded retrieval are evidence sources only, and private repository/issue content must not enter public queries. Clear implementation tickets may bypass clarification through the existing composable skills flow. This decision defines the contract and stop conditions; packet storage, Pi transport, numeric resource limits, coding profiles, OS isolation, verifier execution, and pilot protocol remain downstream decisions.

## Considered options

- **One opaque readiness score:** rejected because tracker eligibility, brief quality, host capability, research applicability, and authorization have different meanings and owners.
- **Runtime probing and package-manager execution:** rejected because scripts, imports, installation, registry access, and `--help` can have side effects and do not establish approval.
- **Latest documentation or broad external crawling:** rejected because version mismatch, private-data egress, prompt injection, and stale evidence would be hidden.
- **A universal language-specific readiness gate:** rejected because generic clarification can support non-Node hosts while implementation capabilities remain explicitly unknown or unsupported.
- **A mandatory factory discovery phase:** rejected because clear tickets retain the existing composable skill flow.

## Consequences

- #120, #121, #125, #131, #132, and #135 retain ownership of their existing starter, readiness, host-doctor, Pi review, documentation, and command-discovery contracts; the clarification coordinator joins their evidence rather than duplicating them.
- Source-derived facts, documentation evidence, Developer input, and model proposals require distinct provenance and cannot silently become authority. Truncation, stale lockfiles, missing comments, unsupported parsers, and unavailable documentation remain visible uncertainty.
- A future implementation must preserve separate start and publication approvals, bind approvals to packet/context and data destination, and fail closed on material changes. This ADR does not claim that the current product enforces those guarantees.
