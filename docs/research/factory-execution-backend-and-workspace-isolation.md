# Factory 05 — Execution backend and workspace isolation

Status: accepted research/design decision

Work item: [GH-163](https://github.com/Quick-Release/workbench/issues/163)

Related decisions: [GH-159](https://github.com/Quick-Release/workbench/issues/159), [GH-160](https://github.com/Quick-Release/workbench/issues/160), [GH-161](https://github.com/Quick-Release/workbench/issues/161), [GH-162](https://github.com/Quick-Release/workbench/issues/162), [GH-164](https://github.com/Quick-Release/workbench/issues/164), [GH-116](https://github.com/Quick-Release/workbench/issues/116), [GH-165](https://github.com/Quick-Release/workbench/issues/165), [GH-166](https://github.com/Quick-Release/workbench/issues/166), [GH-167](https://github.com/Quick-Release/workbench/issues/167), [GH-168](https://github.com/Quick-Release/workbench/issues/168), [GH-169](https://github.com/Quick-Release/workbench/issues/169)

## Decision in brief

Do not select or install a coding execution backend yet. Define the versioned `execution-backend/v1` contract and the evidence required before a future coding profile can be selected. The first Workbench product remains **Owned clarification**, which is read/research-only and needs no generic command or coding backend.

A future coding profile must run the entire coding agent and its extensions/tools inside an enforceable OS, container, or virtual-machine boundary. A worktree, prompt, CLI permission file, inherited process policy, or draft pull request is not isolation. A candidate that cannot enforce filesystem, process, network, credential, resource, ownership, cancellation, and retention requirements is rejected or deferred rather than described as safe.

The first support posture is one exact tested Linux host/architecture and backend revision. There is no general Linux, macOS, Windows, or cross-architecture portability promise. Each run receives a unique, repository-bound **Execution workspace** containing an isolated snapshot/clone at a pinned revision. Host `.git` administration, writable host worktree mounts, host credentials, caches, sockets, and services do not cross the boundary by default. Results leave through declared artifacts; direct host mutation and backend-owned GitHub publication are not part of this contract.

The candidate disposition is deliberately non-final:

- Firecracker is the strongest future Linux isolation substrate, but Workbench would still need to build networking, filesystem projection, credential mediation, guest images, supervision, crash cleanup, and retention around it.
- Gondolin is a promising Pi-oriented experimental candidate with programmable VFS, mediated networking, and placeholder-based secret handling, but its documented resource and termination limits require additional Workbench enforcement and evidence.
- Rootless Docker is rejected as the sole boundary for untrusted coding agents. It reduces daemon privilege but does not by itself provide the required path, network, credential, resource, or lifecycle policy.
- Docker Sandboxes may be evaluated as an optional product-specific integration, but their platform, product, host-integration, and lifecycle behavior must not become the portable Workbench contract.
- A constrained host process remains a reduced-trust maintenance posture, not a compliant future coding profile.

No backend implementation, backend installation, real provider, client infrastructure, exploit test, or pilot was run or authorized by this decision.

## Evidence boundary

### Verified Workbench facts

The current `main` revision was `7338a11` during investigation. The current repository has no execution-backend abstraction, sandbox manager, coding-workspace ownership record, durable process supervisor, cross-process workspace lease, or crash-reconciliation service.

The current issue-agent path is implemented by:

- `scripts/seam/review/opencode-engine.mjs`, which chooses `/tmp/workbench-issue-<issue-number>` by default, uses `agent/issue-<number>`, force-removes the path on setup, adds a Git worktree, runs OpenCode, commits, pushes, and creates a draft PR;
- `scripts/seam/review/review-runner.mjs`, which launches children with `{ ...process.env, ...step.env }`, uses detached process groups, escalates cancellation from `SIGTERM` to `SIGKILL`, and retains failed worktrees according to the plan;
- `scripts/seam/routes/review-api.mjs`, whose active-run registry and history are in memory per server process;
- `scripts/host/source-root.mjs` and `scripts/host/git-context.mjs`, which resolve the host repository and sanitize Git context for selected Git calls but do not create coding-workspace isolation;
- `workbench.config.schema.json` and `scripts/host/config.mjs`, which currently configure services, theme, repository identity, and optional session metadata, not execution backends.

The runner’s OpenCode configuration denies selected external-directory and publication patterns at the tool layer. The child still inherits the Workbench environment, and the configuration is not an OS-enforced filesystem, process, network, or credential boundary. The current runner also has no durable workspace record, ownership nonce, cross-process lock, startup scan, remote-publication reconciliation, or proof that all descendants have stopped.

GH-116 records disposable Git reproductions showing that equal issue numbers in different host repositories collide at the shared temporary path and that a second process can force-remove an active or retained worktree. Those reproductions were not rerun during this investigation; they remain the issue’s recorded evidence and ownership prerequisite.

The accepted #159–#164 resolutions narrow the immediate product:

- #159 selects embedded Owned clarification ending at an approved issue brief, not a coding run.
- #160 gives Workbench deterministic clarification lifecycle, approval, capability, and publication ownership while preserving Agent and Review run contracts.
- #161 makes clarification brokered read/research-only and states that coding profiles need a later OS-level isolation decision.
- #162 makes context revision-bound and says discovery never grants command permission.
- #164 selects a Pi RPC conversation adapter for clarification only and assigns coding isolation to this issue.

### Fixture-test boundary

The repository’s tests use fake CLIs, fake process objects, injected runners, synthetic paths, and temporary Git fixtures. They cover command construction, argument bounds, output caps, timeout and signal logic, cleanup calls, request validation, and in-memory history. They do not establish host-file containment, credential non-disclosure, network isolation, symlink safety, dependency-script safety, production process-tree termination, crash recovery, or platform portability.

The prior accepted resolutions report fixture-only results for the related seam work. Those results are not evidence that any sandbox candidate satisfies this contract. No backend or host-isolation test was executed for #163.

## Primary-source findings

### Pi security and containerization

The pinned Pi research reference is `@earendil-works/pi-coding-agent@0.85.1`, upstream tag [`v0.85.1`](https://github.com/earendil-works/pi/tree/v0.85.1), commit [`d981de1`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477).

Pi’s [security documentation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/security.md) says Pi runs with the launching account’s permissions, has no built-in sandbox, and cannot make untrusted repository content or prompt injection safe. Extensions run with the same process permissions. Project trust controls resource loading; it is not filesystem, process, network, or credential isolation.

Pi’s [containerization documentation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/containerization.md) describes four distinct patterns:

- host Pi with Gondolin tool routing;
- whole-Pi plain Docker;
- whole-Pi OpenShell;
- whole-Pi Docker Sandboxes.

The documentation explicitly warns that custom extension tools remain on the host unless they also delegate. Its Gondolin example mounts the host workspace read/write, so changes write through to trusted files. Its plain Docker example passes an API key into the container and bind-mounts the current directory. These examples are useful patterns, not Workbench guarantees.

### Gondolin

The inspected Gondolin revision is [`6283697`](https://github.com/earendil-works/gondolin/tree/628369764fcd2c987b4b99e5159ec90d4febe53a). Its primary documentation describes:

- QEMU-backed guest isolation;
- explicit VFS providers, including disposable memory and host filesystem providers;
- symlink containment for its documented real filesystem provider;
- host-mediated HTTP/TLS and policy checks for internal ranges and redirects;
- placeholder-based host-side secret substitution for approved destinations.

Its documented limitations remain material: the host Node process and machine are trusted; resource/DoS isolation is incomplete; `AbortSignal` does not itself guarantee guest-process termination; full VM process/memory recovery is not provided; QEMU is the default and libkrun is experimental; and Windows is unsupported. Gondolin is therefore a candidate for later evidence, not a selected Workbench backend.

Sources at that revision:

- [security model](https://github.com/earendil-works/gondolin/blob/628369764fcd2c987b4b99e5159ec90d4febe53a/docs/security.md)
- [VFS](https://github.com/earendil-works/gondolin/blob/628369764fcd2c987b4b99e5159ec90d4febe53a/docs/vfs.md)
- [secrets](https://github.com/earendil-works/gondolin/blob/628369764fcd2c987b4b99e5159ec90d4febe53a/docs/secrets.md)
- [VM lifecycle and cancellation](https://github.com/earendil-works/gondolin/blob/628369764fcd2c987b4b99e5159ec90d4febe53a/docs/sdk-vm.md)
- [limitations](https://github.com/earendil-works/gondolin/blob/628369764fcd2c987b4b99e5159ec90d4febe53a/docs/limitations.md)

### Rootless Docker

Docker’s [rootless documentation](https://docs.docker.com/engine/security/rootless/) says rootless mode runs the daemon and containers as a non-root user in a user namespace. That reduces daemon privilege, but it does not create Workbench’s complete policy boundary.

Docker’s [networking documentation](https://docs.docker.com/engine/network/) says ordinary containers have outbound networking enabled by default, inherit host DNS configuration, and can reach external services. The `none` driver removes networking rather than providing a safe general allowlist. [Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) are host paths and can be writable. Rootless resource controls have prerequisites and can be unavailable or limited without the required cgroup setup. Docker socket access, host networking, privileged settings, devices, and unreviewed Compose input can restore powerful host authority.

Rootless Docker can be a component or reduced-risk local option after explicit policy construction, but it is not sufficient as the sole first coding boundary.

### Docker Sandboxes

Docker’s [Sandbox overview](https://docs.docker.com/ai/sandboxes/), [security model](https://docs.docker.com/ai/sandboxes/security/), [architecture](https://docs.docker.com/ai/sandboxes/architecture/), and [installation requirements](https://docs.docker.com/ai/sandboxes/install/) describe a stronger microVM and separate-daemon model with mountless, clone, and direct workspace modes, proxy-mediated egress, and host-side credential injection.

The same documentation identifies constraints relevant to Workbench: direct mode exposes a host worktree read/write; local stdio MCP servers execute on the host; state, packages, images, and VM resources have product-specific persistence; platform prerequisites are narrow and changing; and lifecycle semantics do not establish Workbench’s repository/run ownership. Docker Sandboxes may be evaluated as an optional integration, but its product-specific behavior cannot define the portable backend interface.

### Firecracker

The examined Firecracker revision is v1.17.0, tag [`29d66eb`](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0), resolving to commit [`95f868c8e345b1cc8faccd1a3c910b4989dc3f58`](https://github.com/firecracker-microvm/firecracker/tree/95f868c8e345b1cc8faccd1a3c910b4989dc3f58).

Firecracker’s primary documentation describes KVM microVM isolation, a minimal device model, jailer, namespaces, seccomp, cgroups, I/O rate limiting, and VM snapshots. It also makes the integrator responsible for network filtering, guest images, trusted jailer inputs, snapshot security and retention, supervision, crash cleanup, filesystem projection, and credentials. Firecracker itself does not provide a Workbench-compatible egress policy or credential broker. It is the strongest future Linux substrate considered, not a complete execution backend.

Sources:

- [design and threat containment](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/docs/design.md)
- [jailer](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/docs/jailer.md)
- [snapshot support](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/docs/snapshotting/snapshot-support.md)
- [kernel policy](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/docs/kernel-policy.md)

## Candidate comparison

| Candidate                                      | Filesystem/process boundary                                                                | Network/credential posture                                                                     | Resource/lifecycle posture                                                                   | Platform/setup                                         | Decision                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Host process with worktree and CLI permissions | Host user and host kernel; worktree is checkout ownership only                             | Inherited environment and host network; no credential boundary                                 | Existing process cleanup is best-effort and process-local                                    | Broad availability, weakest guarantees                 | Reduced-trust maintenance only           |
| Whole Pi/OpenCode inside rootless Docker       | Namespaces and seccomp, shared host kernel; mounts and privileged options remain dangerous | Outbound network and bind mounts require explicit restriction; no credential broker by default | Limits are conditional on rootless cgroup setup; daemon lifecycle is not Workbench ownership | Linux-oriented setup; Docker Desktop changes semantics | Reject as sole boundary                  |
| Gondolin                                       | QEMU guest and programmable VFS; host-mounted paths can write through                      | Stronger mediated HTTP/TLS and placeholder secrets                                             | Incomplete DoS governance; abort does not prove guest termination                            | Linux/macOS candidate; no Windows; experimental        | Retain for later evidence                |
| Docker Sandboxes                               | Product-managed microVM/separate daemon; direct workspace mode is host-visible             | Proxy and host-side credential behavior; host stdio integrations remain a boundary             | Product-specific persistence and lifecycle                                                   | Narrow, changing platform/product requirements         | Optional integration only                |
| Firecracker/Jailer                             | KVM microVM with minimal devices and defense-in-depth                                      | Network, credential, filesystem projection, and guest image policy are integrator work         | Strong primitives and snapshots; cleanup/supervision remain integrator work                  | Linux/KVM, x86_64/aarch64; high setup burden           | Strongest future substrate, not selected |

## Domain model

### Execution workspace

An isolated, run-owned checkout plus its backend-managed process, filesystem, network, resource, and retention state. It is not the Developer’s working tree and is not identified by a path alone.

### Execution backend

A narrow adapter that enforces the execution boundary and reports verifiable process/resource/filesystem/network facts. It is not the Workbench coordinator, workflow engine, approval store, verifier, or publication service.

### Execution profile

A versioned, approved set of backend, workspace, command, filesystem, network, credential, resource, and artifact capabilities for a class of execution. Owned clarification does not use a coding execution profile.

### Workspace owner

The Workbench run and fencing identity authorized to inspect, retain, export, or clean one Execution workspace. A matching path or branch name does not establish ownership.

### Retained workspace

An Execution workspace deliberately preserved after failure or cancellation so its evidence can be inspected. Retention does not imply that the process is alive or that the workspace can be resumed.

### Quarantined workspace

An Execution workspace whose process termination, ownership, or cleanup state is uncertain. It cannot be reused or deleted until explicit reconciliation or discard establishes authority.

### Execution artifact

A bounded, declared result exported from an Execution workspace, such as a patch, commit bundle, log, test evidence, or diagnostic record. It is not a publication or proof of correctness.

## `execution-backend/v1` contract

The backend port is deliberately smaller than a workflow system. A conceptual contract is:

```text
prepare(run, workspaceSpec, policy) -> ExecutionHandle
execute(handle, commandSpec) -> ExecutionId
events(executionId) -> bounded lifecycle/log/resource events
cancel(executionId, mode) -> acknowledged | terminated | unknown
inspect(handle) -> ownership, process, resource, path, and retention facts
export(handle, artifactSpec) -> declared artifact or typed denial
retain(handle, reason) -> retained | failed
cleanup(handle, ownerProof) -> cleaned | retained | cleanup_failed | unknown
```

`workspaceSpec` is explicit: host identity, base revision, copied or mounted inputs, declared artifact paths, sanitized environment, command working directory, network profile, resource limits, timeout, and policy digest. It must not accept arbitrary host paths, generic environment passthrough, Docker sockets, host networking, or unrestricted credential mounts.

Commands are structured argv plus a declared working directory and sanitized environment. Output is bounded and correlated to the execution ID. The backend reports start, output, resource-limit, denial, exit, cancellation, and process-loss observations. A command exit code is an observation, not proof of correctness or verification.

The backend must include, or allow Workbench to bind, canonical host-repository identity, unique run/workspace IDs, pinned base revision, owner/fencing token, backend and policy versions, declared capabilities, artifact paths, and retention state. Cleanup requires ownership proof and must never delete by path alone.

The backend does not own:

- Workbench approvals, capability decisions, or issue readiness;
- Pi conversations or session files;
- GitHub credentials or publication;
- workflow transitions, retries, verification, or human review;
- durable operational state owned by #165.

## Workspace and artifact boundary

A future coding run receives a copy or isolated clone at a pinned base revision. The workspace retains its own Git metadata, hooks policy, remotes policy, dependency state, and caches inside the execution boundary. Host `.git`, host credentials, host home directories, host package caches, Docker sockets, and writable host worktrees are excluded by default.

The backend exports only declared artifacts through a controller-owned channel. The controller later decides whether an artifact is valid evidence, suitable for a draft PR, or discardable. Direct branch pushes, issue edits, PR creation, merge, deployment, and host working-tree mutation remain outside this contract and belong to later decisions.

A retry creates a fresh workspace identity. It must not force-remove an active or retained workspace belonging to another run. Failed workspaces are retained; uncertain workspaces are quarantined; cleanup failure is visible and actionable.

## Credential and egress boundary

The execution environment receives a sanitized environment with no inherited Workbench secrets. GitHub, SSH, cloud, provider, registry, telemetry, and host-service credentials are absent unless an explicitly approved broker provides a narrowly scoped operation without exposing the raw credential.

Network is denied by default. Any permitted provider, registry, Git remote, or documentation origin is a separate declared purpose and allowlist. Loopback, LAN, private, metadata, redirect, DNS-rebinding, host-socket, and unapproved destinations remain denied. The backend must report policy denials rather than silently falling back to a broader route.

Dependencies, package scripts, lifecycle hooks, caches, fixture databases, and local services use per-run disposable state. A host daemon socket, host network mode, shared cache, or unreviewed Compose file is not an acceptable shortcut.

## Lifecycle and retention

The controller and backend distinguish:

1. `preparing` — identity, policy, workspace inputs, and backend capability checks;
2. `ready` — workspace exists and ownership is recorded;
3. `running` — a declared execution is active;
4. `cancelling` — cooperative stop or force termination is in progress;
5. `terminated` — backend proves the declared workload is no longer running;
6. `retained` — evidence is preserved for inspection;
7. `quarantined` — termination, ownership, or cleanup is uncertain;
8. `cleanup_failed` — cleanup was attempted but did not establish the requested result;
9. `unknown` — the backend cannot establish the process or resource outcome.

Cancellation is an operation, not an assertion: the controller requests cooperative stop, escalates according to the backend, waits for proof, and records `unknown` when proof is unavailable. A server restart, reboot, or backend crash does not authorize automatic command replay or unsafe workspace adoption. #165 must later define durable leases, supervision, crash reconciliation, migration, retention, and deletion.

## Platform and support matrix

| Platform posture                                                | Status for first coding profile                          | Reason                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Exact Linux host/architecture with tested backend prerequisites | Candidate support only after the evidence gate           | Matches #159’s private cohort and the strongest available VM/container options             |
| Other Linux distributions or CPU architectures                  | Unknown until separately tested                          | Kernel, KVM, cgroup, network, and backend behavior can differ                              |
| macOS                                                           | Unsupported for the first coding profile                 | VM/container candidates have different host boundaries and no completed Workbench evidence |
| Windows                                                         | Unsupported for the first coding profile                 | Candidate setup and filesystem/process semantics are not established                       |
| Host process/worktree only                                      | Not compliant with the future coding profile             | No enforceable complete isolation contract                                                 |
| Owned clarification                                             | Supported by its separate brokered read/research profile | It does not execute generic code or project commands                                       |

## Required evidence before backend selection

A separately authorized, disposable fixture matrix must test each candidate for:

- host-file, `.git`, symlink, mount, and synthetic-secret exclusion;
- process-tree, guest, VM, and container cancellation;
- CPU, memory, PID, disk, timeout, and output limits;
- denied loopback, LAN, metadata, redirect, DNS-rebinding, and host-socket access;
- raw credential non-exposure and secret-bearing log handling;
- dependency, cache, lifecycle-script, hook, and fixture-database separation;
- same-number issues in different repositories;
- crash retention, restart reconciliation, and stale-owner rejection;
- ownership-safe cleanup, quarantine, explicit discard, and no path-only deletion;
- approval, policy, context, revision, and backend-version invalidation;
- branch, artifact, and CI/workflow side effects;
- inspection of retained work without granting new execution authority.

Evidence must distinguish documented behavior, observed fixture behavior, and unsupported assumptions. No test against the Developer’s normal home directory, client infrastructure, production services, or real provider credentials is authorized by this decision.

## Responsibility boundaries

| Responsibility                                              | Owner                                     |
| ----------------------------------------------------------- | ----------------------------------------- |
| Current issue-agent worktree ownership defect               | #116                                      |
| Owned clarification conversation/runtime                    | #164 and #133                             |
| Execution-workspace identity and backend policy             | Future Workbench coordinator/backend port |
| OS/container/VM enforcement                                 | Selected future execution backend         |
| Durable run metadata, leases, recovery, retention, deletion | #165                                      |
| Independent verification and revision-bound evidence        | #166                                      |
| Draft-PR delivery and human review                          | #167 and #111                             |
| Failure, repair, budget, and intervention policies          | #168 and #169                             |

No duplicate worktree manager, Pi session store, workflow state machine, or external factory runtime is introduced.

## Rejected alternatives

- **Select the existing host process/worktree:** rejected because it cannot satisfy the required OS-level filesystem, process, network, credential, and resource boundary.
- **Treat OpenCode permissions or Pi project trust as sandboxing:** rejected because they are application/resource policies, not host-enforced containment.
- **Use rootless Docker alone:** rejected because mounts, network, daemon/socket access, credentials, resource prerequisites, and lifecycle still require independent enforcement.
- **Use host Pi with only Gondolin tool routing:** rejected for the first coding profile because custom extensions and other host-side resources can execute outside the VM.
- **Select Firecracker immediately:** rejected as premature; it is a strong substrate but not a complete Workbench backend and requires substantial orchestration and evidence.
- **Adopt Docker Sandboxes as the universal contract:** rejected because product-specific platform, host integration, credential, and lifecycle behavior cannot define portable Workbench semantics.
- **Use a shared host worktree or host `.git` mount:** rejected because it weakens ownership, path, hook, credential, and cleanup boundaries.
- **Automatic restart or workspace adoption after crash:** rejected because uncertain process/tool outcomes cannot be safely replayed or adopted without #165’s reconciliation protocol.

## Dependencies and remaining uncertainty

- #116’s ownership fix remains a separate maintenance prerequisite; this decision does not implement or replace it.
- #164’s `pi-managed/v1` conversation boundary remains clarification-only and does not inherit a coding execution profile.
- #165 must define durable operational ownership, storage, supervision, recovery, retention, and deletion before any backend can claim restart or crash recovery.
- #166–#169 must define verification, draft-PR delivery, failure/repair limits, and intervention before a coding profile can produce a reviewed change.
- The exact backend, revision, Linux host/architecture, guest image, network broker, credential broker, and artifact format remain unselected.

This decision resolves #163 by justified deferral. It authorizes documentation and later evidence design only—not backend implementation, installation, provider use, exploit testing, host-repo execution, GitHub publication, draft-PR delivery, merge, deployment, or pilot activity.
