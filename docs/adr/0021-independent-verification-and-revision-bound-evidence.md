# Independent verification and revision-bound evidence

Status: accepted

Work item: GH-166

A coding agent cannot certify its own change through a summary, candidate-controlled hook, command name, or movable branch. Workbench will define `verification-contract/v1`: a host maintainer approves a versioned Verification recipe, Workbench creates an immutable Candidate commit from exported work, and separately controlled Verifiers record evidence against that exact repository, commit, base, recipe, harness, fixtures, and execution context. Only fresh, complete passing evidence satisfies a mandatory Verifier.

## Decision

The coding agent may invoke approved Verifiers for feedback, but intermediate results are not publication evidence. After the coding process is stopped or isolated, Workbench initiates final verification in a distinct execution profile. Independent Verifiers receive fresh checkouts unless the recipe explicitly declares a shared pipeline state. Candidate code cannot alter the approved recipe, trusted harness, recorder, evidence store, or publication credentials.

Verifier results preserve `passed`, `failed`, `not-run`, `inconclusive`, `infrastructure-error`, and `stale`. Agent output and logs are diagnostic; the trusted structured recorder owns process facts and the verdict. Formatting or generation that changes a verification checkout fails the candidate as non-canonical, while undeclared effects are inconclusive. Baseline failures and flakes remain non-passing evidence rather than becoming green by comparison.

A content-addressed Verification bundle joins the Candidate commit and base, recipe, individual evidence, aggregate eligibility, and any human Verification exception. The Inner publication gate requires an eligible bundle before the first remote Git write. The publisher pushes only the verified commit and reads back the remote branch and PR head. Unknown or mismatched outcomes require #165 reconciliation. After publication, exact-head unprivileged CI and the human approval required by ADR 0011 form the separate Outer delivery gate.

A human may grant a single-use, exact-candidate Verification exception for identified pre-existing failures, bounded flakes, unavailable non-security services, optional unsupported environments, or model-review concerns. Identity mismatch, stale or forged evidence, unapproved recipes, candidate influence over trusted verification, isolation or credential breaches, unknown execution/publication outcomes, undeclared effects, and code tasks with no applicable correctness Verifier are non-waivable. Exceptions never rewrite a result as passed or satisfy remote CI, acceptance criteria, or human merge review.

Optional Model-based scope review may require human attention after deterministic checks, but it cannot certify correctness, overrule a deterministic failure, or approve an exception.

## Consequences

- #135 discovers Command candidates but does not approve or execute Verifiers; #117 supplies fixture-driven validation seams; #124 presents exact-SHA evidence and claims; #129/#134 retain optional performance evidence.
- #163 enforces verification execution, #165 owns attempts and reconciliation, #167 owns publication, and #168 owns repair limits. This ADR creates none of those implementations.
- Candidate changes to tests, fixtures, scripts, lockfiles, or CI remain reviewable inputs and cannot weaken the immutable approved recipe for their own candidate.
- GitHub check success is not sufficient evidence because skipped or neutral checks can satisfy GitHub requirements and candidate-controlled workflow logic can mislead a trusted status identity.
- The first contract protects against candidate and stale-controller interference, not a malicious Developer, compromised host OS, compromised Workbench installation, or compromised verification platform.
- No verifier engine, backend selection, CI rewrite, provider call, host command, publication, merge, deployment, or pilot is authorized by this decision.
