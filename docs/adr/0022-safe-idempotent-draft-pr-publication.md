# Safe, idempotent draft-PR publication

Status: accepted

Work item: GH-167

Publishing a publication-eligible Candidate commit is a privileged, non-transactional operation whose remote effects can outlive a lost response. Workbench will place that complexity behind a narrow Publisher: a separate, single-use Publication approval authorizes completion of one exact Publication intent, and the Publisher converges observable GitHub state on that immutable commit without exposing credentials or generic remote commands to candidate execution. The contract promises deduplicated intent and proven read-back, not exactly-once external effects.

## Decision

A Publication intent binds the canonical host-repository identity, approved same-repository base ref and revision, Candidate commit, Verification bundle, Review payload, Delivery profile, publishing identity, and a Publisher-derived branch in a reserved namespace. Workbench commits the approval state durably before the first remote mutation. Reconciliation may continue after approval expiry, but another write requires valid authority for the unchanged intent; any changed binding requires a new intent and approval.

The Publisher obtains the Candidate commit from a trusted object source outside the candidate's Execution workspace. It verifies the commit, tree, ancestry, base, and evidence bindings and neither constructs nor changes the commit. Candidate-controlled hooks, Git configuration, credential helpers, executables, remotes, and shell commands cannot participate. Credentials are short-lived, repository-scoped, brokered outside candidate execution, and usable only through the Publisher's narrow interface; token scope alone is not the authority boundary.

The first Publisher may conditionally create one absent immutable branch at the exact Candidate commit and create one exact draft PR. It may not update or delete refs, force-push, edit or transition PRs, approve or merge, change repository policy, rerun workflows, deploy, or clean up remote evidence. A different Candidate commit receives a new branch and PR. Existing divergent state, human edits, ambiguous matches, stale evidence or base, policy drift, credential-boundary failure, and unknown remote state fail closed or await human resolution. They are not waivable within the Publisher.

The Publisher reads back both the remote ref and PR head before recording a Published draft. Lost responses are reconciled before further action. A lost PR-creation response with no observed match is not retried automatically because GitHub supplies no documented idempotency or read-after-write guarantee. Cancellation stops later dispatch but does not prove an in-flight operation stopped. Branch-only and externally changed outcomes are retained rather than compensated away.

The external module interface exposes only publication and read-only reconciliation; production and deterministic fake GitHub adapters remain internal seams. A content-addressed Publication receipt in Workbench-owned operational storage is authoritative. The initial PR body carries a human-readable projection and receipt digest. #124 owns the immutable pre-publication Review payload and combines it with later receipt and remote-check observations in its refreshable PR Review Brief; the Publisher does not mutate the payload to add those later facts. Closing-keyword issue linkage is included only when explicitly approved.

A host maintainer approves a versioned, expiring Delivery profile containing repository observations, allowed targets, required exact-head checks, privileged paths, and an inventory of push/PR integrations. The first profile supports same-repository branches only and rejects workflow, policy, deployment, or unknown privileged side effects. Required remote CI must have actually executed and passed for the exact head; GitHub's skipped or neutral success does not satisfy Workbench readiness.

Verification eligibility, Publication approval, Published draft, Ready for human review, exact-revision Human merge instruction, and merge remain distinct. Human merge authority binds the current Candidate commit, observed base, Publication receipt, current #124 review evidence, and required CI. Publisher success never marks a PR ready, approves it, merges it, enables auto-merge, or deploys it.

## Consequences

- The safe first release favors immutable review state and simple reconciliation over preserving one PR thread across repaired candidates.
- GitHub App permissions remain broader than one intended operation, so an independently enforced credential broker and narrow Publisher interface are mandatory.
- Git LFS, commit signing, submodule credentials, forks, cross-repository PRs, and other publication side channels are unsupported until an approved trusted adapter and Delivery profile cover them.
- Current Workbench repository settings do not enforce ADR 0011's documented human-review gate and define no required exact-head PR checks. Workbench therefore cannot presently reach Ready for human review under this contract; remediation is separate and this ADR changes no repository settings.
- Webhooks, notifications, workflows, apps, previews, and other integrations may not execute exactly once or be completely observable. Receipts preserve known effects and uncertainty rather than manufacturing certainty.
- Implementation acceptance requires fake-adapter and disposable-Git failure injection for replay, stale evidence, every unknown branch/PR outcome, concurrent human edits, credential and Git-configuration attacks, privileged workflow changes, and misleading remote checks.
- #165 retains durable ownership and reconciliation, #166 retains candidate verification, #124 retains the PR Review Brief, and ADR 0011 retains the human merge gate. This ADR implements none of them and authorizes no real publication, merge, deployment, or policy change.
