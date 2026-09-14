# Bound managed clarification with explicit capabilities and credentials

Status: accepted

Work item: GH-161

The first managed clarification profile is a read/research capability, not a generic factory or coding run. Workbench owns a typed capability broker, approval binding, context/egress policy, credential separation, and fail-closed decisions; Pi owns only the selected runtime conversation and transcript. The profile may read an approved issue and canonical repository context and consult approved public sources, but it cannot execute project commands, package scripts, hooks, arbitrary shell, source writes, Git operations, branch pushes, pull requests, deployments, merges, workflow changes, or unreviewed extensions. Untrusted issue/source/documentation/skill/tool/model content is data and cannot expand the profile. The provider/data destination, context digest, host and issue identity, capability/tool set, policy and contract versions, and approval nonce/expiry bind each attempt; material changes require fresh approval.

This is a bounded capability guarantee, not a claim that Pi, worktrees, Docker, draft PRs, providers, or human merge review are complete sandboxes. Unsupported environments and missing enforcement fail closed. Coding profiles require a later OS-isolation and CI/workflow decision. Dedicated local Pi session storage stays separate from Session capture, Telemetry, D1, R2, and unrelated personal sessions. Existing Agent/Review runs and confirmed workflow-route gaps retain explicit residual-risk follow-up rather than being silently reclassified as compliant.

## Considered options

- **Trust Pi permissions, repository instructions, or a Git worktree as the boundary:** rejected. Pi documents that it runs with the launching account's authority, prompt injection is expected, extensions have full system access, and project trust does not constrain all context files. Worktree and tool-level permission rules do not provide OS, filesystem, network, credential, or syscall isolation.
- **Use a plain container or host-network Docker as the guarantee:** rejected. Docker's default network, DNS, read-write bind mounts, and daemon access can expose or modify the host; a container is a candidate only if it independently satisfies the complete policy.
- **Expose a generic credentialed proxy:** rejected. Tracker and provider credentials remain separate, least-privilege, and bound to typed adapters; the model receives no credential-fetching capability.
- **Fail open when a control is unavailable:** rejected. Missing path, egress, approval, credential, runtime, or session enforcement returns a typed denial and preserves local work; it never downgrades to an unrestricted process.

## Consequences

- The first implementation needs a bounded context manifest, canonical/symlink-safe reads, sanitized child environment, dedicated Pi session directory, explicit egress policy, and one-time approval records before a pilot can be considered.
- Branch pushes and draft PRs are treated as privileged delivery actions because GitHub workflows may run before merge; they are outside Owned clarification. Human merge review remains necessary but is not a pre-merge containment boundary.
- Secret exclusion and redaction are defense in depth, not proof. Secret-bearing output stops the run and stays local; raw transcripts, prompts, source, and provider responses do not enter Telemetry or Session capture under this decision.
- The current ungated workflow write plugin, inherited child environment, legacy Agent-run fence, capture retention, and current engine/cancellation mismatches are confirmed gaps for separate hardening; this ADR does not claim they are fixed.
- Required disposable-fixture tests cover prompt injection, unapproved extensions, symlink escape, package scripts, unauthorized network, approval replay, secret-bearing output, cancellation/crash, repository crossover, and CI side effects. Passing them proves only the tested contract.
- The concrete Pi runtime and session implementation belong to #164; durable ownership/deletion/recovery belongs to #165; delivery and coding-run security require later decisions.
