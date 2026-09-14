# Execution backend selection deferred pending isolation evidence

Status: accepted

Work item: GH-163

Factory 05 evaluated the current host-process/worktree runner, rootless Docker, Gondolin, Docker Sandboxes, and Firecracker against the threat and approval contract from #161. No candidate has yet demonstrated the complete Workbench boundary for filesystem, process, network, credentials, resources, ownership, cancellation, and crash cleanup. Backend selection is therefore deferred rather than inferred from a worktree, CLI permission policy, container label, or documented startup speed.

## Decision

Define a versioned `execution-backend/v1` port for future coding profiles, but select no implementation yet. The backend will prepare uniquely identified, repository-bound Execution workspaces at pinned revisions; execute structured commands inside an enforceable OS/container/VM boundary; emit bounded lifecycle and resource events; cancel and report proof or uncertainty; export declared artifacts; and perform ownership-checked retention or cleanup.

Workbench retains approvals, capability policy, lifecycle, retry, verification, GitHub publication, and human gates. The backend receives a sanitized environment and no raw host/provider credentials, host `.git`, writable host worktree, Docker socket, or unrestricted network by default. Network destinations, provider access, dependency registries, and local services are separate capabilities.

The first potential coding cohort is one exact tested Linux host/architecture. A future profile must run the entire coding agent and extensions inside the boundary and must pass a disposable synthetic-fixture matrix before selection. Owned clarification remains read/research-only under #159–#164 and does not need or inherit this backend.

## Candidate disposition

- Firecracker is retained as the strongest future Linux substrate, not selected; it still requires Workbench-owned filesystem projection, network filtering, credential mediation, guest image construction, supervision, and cleanup.
- Gondolin is retained as an experimental candidate with useful VFS, network, and secret mediation, but its documented resource and termination limits require further enforcement and evidence.
- Rootless Docker is rejected as the sole boundary for untrusted coding agents.
- Docker Sandboxes are retained only as an optional product-specific integration, not the portable contract.
- Host process/worktree execution remains a reduced-trust maintenance posture, not a compliant future coding profile.

## Consequences

- #116 remains the owner of the existing issue-agent worktree ownership defect; this ADR does not create a competing manager.
- #164 owns Pi conversation/runtime semantics for clarification only; it does not authorize code execution.
- #165 owns durable run metadata, leases, supervision, recovery, retention, and deletion.
- #166–#169 own independent verification, draft-PR delivery, failure/repair policy, and intervention.
- No backend installation, implementation, provider use, exploit test, host-repo run, or pilot is authorized by this ADR.
