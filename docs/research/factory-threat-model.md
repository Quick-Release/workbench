# Factory 03: threat model, approvals, and credential boundaries

Work item: GH-161

This note records the threat-model research and grilling for the first managed clarification capability. It narrows the policy from [Factory 01](https://github.com/Quick-Release/workbench/issues/159) and [Factory 02](https://github.com/Quick-Release/workbench/issues/160); it does not authorize a runtime implementation, a security pilot, or a claim of perfect isolation.

## Resolution summary

The first enforceable profile is the Workbench-owned **Owned clarification**, not a generic “factory run.” It may read a server-resolved issue and explicitly approved host-repository context, consult approved public sources, and use the visibly selected provider/data destination to produce a clarification draft. It may not execute project commands, package scripts, hooks, arbitrary shell, source writes, Git operations, tracker writes, branch pushes, pull requests, deployments, merges, or arbitrary extensions.

Workbench owns the capability policy and approval binding. A typed capability broker is authoritative; issue text, repository content, skills, extensions, fetched documentation, tool output, and model output are untrusted data and cannot expand that policy. Pi owns the runtime conversation and transcript but does not own Workbench transitions or credentials for unrelated services.

The profile fails closed if it cannot enforce canonical read boundaries, symlink containment, credential separation, approved egress, approval freshness, resource limits, or dedicated session isolation. This is a bounded capability guarantee, not a claim that Pi, a worktree, Docker, a draft PR, or a provider is a complete security sandbox. Coding and delivery profiles require a future OS-level isolation and CI/workflow decision before they can claim this contract.

## Provenance and method

Local source inspection used Workbench `main` at `7338a11535a145a1e46f4c571a89ab780c98d468`. Relevant Workbench decisions are [ADR 0005](../adr/0005-control-surface-localhost-seam.md), [ADR 0010](../adr/0010-issue-agent-unattended-fenced-local-runs.md), [ADR 0011](../adr/0011-human-review-gates-merges.md), [ADR 0012](../adr/0012-client-bugs-gate-feature-starts.md), [ADR 0013](../adr/0013-public-access-distribution.md), [ADR 0014](../adr/0014-owned-clarification-boundary.md), the [#159 Resolution](https://github.com/Quick-Release/workbench/issues/159#issuecomment-5657948810), and the [#160 Resolution](https://github.com/Quick-Release/workbench/issues/160#issuecomment-5661194179). Factory 02's ADR is in [PR #182](https://github.com/Quick-Release/workbench/pull/182) and is not yet on `main`.

The fact-finding pass inspected `scripts/seam/review/opencode-engine.mjs`, `scripts/seam/review/review-runner.mjs`, `scripts/seam/routes/review-api.mjs`, the workflow and capture routes, tracker credential adapters, schemas, and relevant tests. It executed fixture-only tests: 143 tests passed across request gates, OpenCode plan construction, runner lifecycle, review API, session aggregation, telemetry, and Worker capture. Schema probes confirmed that `cancel { engine: "opencode" }` is rejected and that mismatched engine/target combinations are accepted. No real agent, provider, GitHub publication, exploit, network probe, client infrastructure, or paid service was run.

External primary sources were inspected at these pins:

| Source                            | Pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Relevant evidence                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi security documentation         | [`ceea48f`](https://github.com/earendil-works/pi/blob/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9/packages/coding-agent/docs/security.md)                                                                                                                                                                                                                                                                                                                                 | Pi runs with the launching account's permissions, has no built-in sandbox, and cannot reliably prevent prompt injection from repository content or tool output                 |
| Pi containerization documentation | [`ceea48f`](https://github.com/earendil-works/pi/blob/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9/packages/coding-agent/docs/containerization.md)                                                                                                                                                                                                                                                                                                                         | credential/session mounts and sandbox/proxy deployment caveats                                                                                                                 |
| Pi packages and source            | [`ceea48f`](https://github.com/earendil-works/pi/tree/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9)                                                                                                                                                                                                                                                                                                                                                                        | extensions have full system access, skills are instructions, package installation runs lifecycle scripts, and file handling follows normal filesystem behavior                 |
| GitHub token permissions          | [fine-grained token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) and [permissions matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)                                                                                                                                                                          | repository/permission scoping is distinct from filesystem, network, CI, workflow, secret, and deployment authority                                                             |
| GitHub Actions                    | [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [secure `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners), [environment approvals](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) | branch pushes and draft PRs can trigger work; privileged workflow contexts and self-hosted runners carry additional risks                                                      |
| Docker                            | [networking](https://docs.docker.com/engine/network/), [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), and [security](https://docs.docker.com/engine/security/)                                                                                                                                                                                                                                                                                    | outbound network, host DNS, read-write mounts, and Docker daemon access are not safe defaults                                                                                  |
| npm lifecycle scripts             | [npm v11 scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts)                                                                                                                                                                                                                                                                                                                                                                                                    | install/preinstall/postinstall/prepare hooks can execute package-controlled code                                                                                               |
| Self-hosted factory experiment    | [Jake Saunders](https://blog.jakesaunders.dev/building-an-almost-fully-self-hosted-sandboxed-agentic-software-factory/) and its pinned support configurations                                                                                                                                                                                                                                                                                                          | the author reports useful operational boundaries but also destructive, credential, outbound-network, LAN, and deployment risks; this is not an independent security evaluation |

## Threat model

### Protected assets

- Host-repository source, Git metadata, remotes, branches, hooks, package scripts, dependencies, generated artifacts, and client data.
- Developer GitHub credentials, provider authentication, telemetry/session-capture credentials, and local credential stores.
- Other repositories, home-directory files, local services, loopback services, cloud metadata endpoints, and host resources.
- Issue/PR bodies, comments, skills, context files, source excerpts, model prompts/completions, tool output, drafts, transcripts, logs, and research artifacts.
- GitHub-side effects: issue edits/comments, labels, dependency edges, branch pushes, PR creation, CI/preview/deployment triggers, workflow changes, merge, and release actions.

### Untrusted inputs

The following are data, not policy, even when they contain imperative language:

- browser JSON and request headers;
- issue/PR titles, bodies, comments, labels, and API payloads;
- `AGENTS.md`, skills, extensions, package manifests, dependency metadata, tests, hooks, and generated output;
- fetched documentation and redirects;
- model output, tool output, CLI output, test results, and captured provider responses;
- configured service URLs and environment values unless they are selected by trusted Workbench policy.

A prompt injection can be malicious, accidental, or merely wrong. The policy does not attempt to distinguish them; none can grant a capability.

### Trust boundaries

| Boundary                    | Required owner/guarantee                                                                                            | Current fact or residual risk                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → Workbench         | Loopback Host/Origin validation, typed requests, bounded bodies, server-resolved identities                         | Review routes apply the shared gate; the current workflow write plugin is a confirmed exception and must not be reused for clarification. |
| Workbench → Pi              | Dedicated runtime profile, sanitized environment, explicit provider destination, no unrelated credentials           | Current runner merges `process.env` into child processes; no credential mediation exists yet.                                             |
| Workbench → host repository | Canonical, approved, read-only paths with symlink containment and no secret files                                   | Current OpenCode worktree/permission configuration is a tool policy, not filesystem or OS isolation.                                      |
| Pi → capabilities           | Typed broker requests; fixed capability profile; no arbitrary RPC, shell, or extension authority                    | Pi documents that repository content can contain prompt injection and that extensions have full system access.                            |
| Workbench → public research | Approved HTTPS origins, sanitized queries, redirect/DNS/private-address checks                                      | Configured HTTP(S) destinations are policy-sensitive; arbitrary network access is not acceptable.                                         |
| Workbench → GitHub          | Least-privilege local adapter; read-only for clarification except the single approved issue-body update             | GitHub is authoritative, but validation and publication are not atomic.                                                                   |
| Branch/PR → CI              | No branch push in clarification; future delivery profile must analyze workflows, runners, secrets, and environments | GitHub documents that branch pushes and draft PRs can trigger workflows; draft status is not a safety boundary.                           |
| Pi → transcript/logs        | Dedicated local session store, explicit retention, no Telemetry/Session capture expansion                           | Pi sessions persist prompts/tool output by default; existing capture stores raw request/response content.                                 |

## Capability and approval matrix

| Operation                                 | Owned clarification profile                             | Approval and enforcement                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Read selected issue/comments              | Allowed                                                 | Start approval binds issue identity and revision; Workbench tracker adapter performs the read                                |
| Read repository context                   | Allowed only for an approved canonical path set         | Workbench creates a bounded context packet; `.git`, home, secrets, caches, unrelated repos, and escaping symlinks are denied |
| Public research                           | Allowed through approved origins and a sanitized broker | Provider/data destination is visible; private issue/repository content is excluded from public queries                       |
| Use selected provider                     | Allowed for the approved provider/model/destination     | Provider changes invalidate approval; provider credentials are not GitHub credentials                                        |
| Save draft/events                         | Allowed in the dedicated local clarification store      | Storage is not publication permission and is outside Telemetry, D1, R2, and Session capture by default                       |
| Follow-up/correction                      | Allowed within the same scope                           | Developer input changes content, not capabilities                                                                            |
| Generic shell/project commands            | Denied                                                  | No fallback to an unrestricted shell                                                                                         |
| Package install/scripts/hooks/tests       | Denied                                                  | No dependency or repository-controlled code executes in this profile                                                         |
| Source/Git/worktree writes                | Denied                                                  | Clarification never modifies code or branches                                                                                |
| GitHub comments/labels/tickets/PRs        | Denied except one approved issue-body update            | Publication approval binds exact body diff, issue revision, nonce, policy, and expiry; read-back is mandatory                |
| Push/CI/deployment/merge/workflow changes | Denied                                                  | Separate future delivery/security decision required                                                                          |
| External Pi-session attachment            | Denied                                                  | Existing sessions remain observed only                                                                                       |
| Credentials/new permissions               | Denied                                                  | No generic credential-fetching proxy or inherited authority                                                                  |

Approval is not a reusable bearer token. Start approval covers one attempt, one host, one issue/context digest, one provider/data destination, one capability profile, one tool set, and the current policy/contract version. It expires or is revoked on process termination, timeout, material context/scope/provider/policy change, or explicit cancellation. Publication approval is a separate single-use action. Replayed, stale, or uncertain requests fail closed and preserve local work for review.

## Data flow and user visibility

Before the first provider call, Workbench shows a data-flow manifest containing the host repository, selected issue, revision/context digest, included paths and issue material, public research origins, provider/model/data destination, enabled capabilities, and retention posture. The Developer approves that exact scope.

Workbench then constructs a bounded context packet. The provider receives only that approved snapshot and the minimum runtime instructions needed to produce a clarification draft. Public research requests contain no private issue text, repository code, credentials, or hidden context. Adding a path, source, provider, capability, or material instruction invalidates the approval and requires a new manifest review.

Pi’s conversation and transcript live in a dedicated Workbench-owned session directory with restricted permissions. The runtime must not enumerate or attach to the Developer’s unrelated `~/.pi/agent` sessions. Provider authentication is isolated from GitHub credentials and is not exposed through model-visible tools. Raw content does not enter Telemetry, D1, R2, or the Session capture proxy under this decision.

Lifecycle logs retain structured metadata—attempt id, state, policy result, capability result, timestamps, and bounded error categories—not raw prompts, source, secrets, or provider responses. Redaction is defense in depth, not a proof. Known secret files are excluded before context construction; if secret-like content nevertheless appears in tool/model output, the run stops, avoids persisting the raw value, and requires local Developer review.

## Fail-closed behavior

A run is unavailable rather than degraded when any of these cannot be established:

- supported Linux/private-pilot environment and selected runtime;
- dedicated session directory and process/resource limits;
- canonical, symlink-contained read scope;
- sanitized child environment and separate provider/tracker credentials;
- approved provider/data destination and egress policy;
- valid, unexpired, non-replayed approval;
- typed capability broker and schema-compatible runtime;
- known policy/contract/verifier version;
- clean secret and context checks.

The UI receives a typed reason and remediation where possible. Saved drafts remain local and inspectable, but no automatic downgrade, broader provider, unrestricted extension, generic shell, or blind retry is allowed.

## Abuse-case test plan

The implementation/pilot gate should use disposable host repositories and synthetic secrets only. These are proposed tests, not executed experiments in this decision:

| Case                          | Fixture and assertion                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection              | Put instructions in an issue comment, source file, `AGENTS.md`, docs, test output, and tool output. The model may quote or flag them, but no capability policy or approval changes.                                   |
| Malicious skill/extension     | Include an unapproved skill and extension that requests filesystem/network access. They are not loaded; a requested unsupported capability is denied.                                                                 |
| Symlink escape                | Link an approved path to a secret/home/other-repository path. Canonical resolution rejects it without reading the target.                                                                                             |
| Package scripts/hooks         | Include package lifecycle scripts and Git hooks that would write a marker or exfiltrate a synthetic secret. The clarification profile never runs them.                                                                |
| Network escape                | Request loopback, LAN, cloud metadata, private-address, unapproved HTTPS, redirect, and DNS-changing destinations. The broker denies them and emits metadata-only denial.                                             |
| Approval replay               | Replay an old start/publication request after issue revision, scope, provider, policy, nonce, or expiry changes. The request is rejected and no write occurs.                                                         |
| Secret-bearing output         | Return a synthetic credential from a fixture tool/model. The run stops; raw secret-bearing output is not added to logs or remote stores.                                                                              |
| Cancellation/crash            | Interrupt during research, draft persistence, and publication reconciliation. Draft state remains local; no automatic side effect replay occurs.                                                                      |
| Repository identity crossover | Attempt to use an issue, path, session, or approval from another host repo. Server-resolved identity and dedicated storage reject the crossover.                                                                      |
| CI side effect                | Keep the clarification profile incapable of pushing. Future delivery tests must use a disposable repository and explicitly inspect workflow triggers, runner type, secrets, environments, and deployment permissions. |

Passing this matrix proves the tested capability contract only. It does not prove a malicious host OS, provider, Developer, GitHub workflow, or future extension is harmless.

## Confirmed gaps and follow-up boundaries

The current code confirms, separately from this policy:

- review child processes inherit the complete Workbench environment;
- OpenCode permission rules are tool-level denies, not OS, filesystem, network, syscall, memory, or credential boundaries;
- there is no current clarification coordinator, capability broker, dedicated approval binding, or Pi adapter on `main`;
- `workflowApiPlugin` does not currently apply the shared Host/Origin gate;
- branch push occurs before draft-PR creation in the Agent run;
- draft PRs and branch pushes can trigger CI or other repository workflows;
- Pi/session capture can retain raw content without the guarantees selected here;
- current engine/target matching and OpenCode cancellation have known schema gaps;
- review/comment and capture operations have replay/retention gaps that are not repaired by this document.

These are not silently reclassified as solved. New clarification routes must satisfy this policy. Existing route hardening, Agent-run remediation, CI/workflow review, Pi runtime validation, and durable storage remain separate implementation decisions.

## Accepted residual risk and unsupported environments

This decision does not guarantee that a selected remote provider retains no approved content, that model suggestions are truthful, that a compromised host OS or Developer obeys policy, that GitHub validation/publication is atomic, that external terminals or agents are controlled, or that redaction detects every secret. The guarantee is narrower: untrusted content cannot expand Workbench-granted capabilities, and uncertainty cannot silently become permission.

The first supported security cohort is the #159 Linux/private-pilot posture: one trusted host repository, Workbench-local orchestration, and a selected Pi/provider setup. Other operating systems, remote runners, arbitrary containers, host-network Docker, unreviewed extensions, self-hosted CI, and generic cloud orchestration are unsupported until they independently satisfy this contract.

This decision does not grant new Telemetry, Content sourcing, or Session capture permission. Public installs remain dormant by omission under ADR 0013; internal Telemetry remains content-free and provisioned. Human merge review under ADR 0011 remains necessary but is not a substitute for pre-merge containment.

## Dependencies

- **#160 / PR #182:** Workbench coordinator, Pi conversation ownership, capability-broker seam, and clarification-only first result.
- **#164:** validate Pi runtime and RPC/SDK/session behavior.
- **#165:** choose durable ownership, storage, recovery, and deletion semantics.
- **#167–#169:** independently decide delivery, failure, inspection, and intervention policies if coding runs return to scope.
- **#133:** shared Pi conversation service; no competing session manager.
- **#131/#132:** constrained review and official-docs recipes must use the same trust vocabulary and cannot weaken the profile.
- **#155 / ADR 0013:** internal/public reporting posture remains unchanged.

No implementation, exploit test against real infrastructure, provider usage, automatic intake, project command, code edit, publication beyond the explicitly approved issue-body action, merge, deployment, or external-session control is authorized by this Resolution.

## Sources

- Workbench [#161](https://github.com/Quick-Release/workbench/issues/161), [#160 Resolution](https://github.com/Quick-Release/workbench/issues/160#issuecomment-5661194179), [#159 Resolution](https://github.com/Quick-Release/workbench/issues/159#issuecomment-5657948810), [ADR 0010](../adr/0010-issue-agent-unattended-fenced-local-runs.md), [ADR 0013](../adr/0013-public-access-distribution.md), and [ADR 0014](../adr/0014-owned-clarification-boundary.md).
- Workbench source at [`7338a115`](https://github.com/Quick-Release/workbench/tree/7338a11535a145a1e46f4c571a89ab780c98d468): [`opencode-engine.mjs`](https://github.com/Quick-Release/workbench/blob/7338a11535a145a1e46f4c571a89ab780c98d468/scripts/seam/review/opencode-engine.mjs), [`review-runner.mjs`](https://github.com/Quick-Release/workbench/blob/7338a11535a145a1e46f4c571a89ab780c98d468/scripts/seam/review/review-runner.mjs), and [`review-api.mjs`](https://github.com/Quick-Release/workbench/blob/7338a11535a145a1e46f4c571a89ab780c98d468/scripts/seam/routes/review-api.mjs).
- [Pi security at `ceea48f`](https://github.com/earendil-works/pi/blob/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9/packages/coding-agent/docs/security.md), [containerization at `ceea48f`](https://github.com/earendil-works/pi/blob/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9/packages/coding-agent/docs/containerization.md), and [packages/source at `ceea48f`](https://github.com/earendil-works/pi/tree/ceea48f5d5d12fd7915dfefba2835ccd55f23bb9).
- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [`pull_request_target` security](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners), and [environment approvals](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [Docker networking](https://docs.docker.com/engine/network/), [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), and [Docker security](https://docs.docker.com/engine/security/).
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts).
- [Self-hosted factory experiment](https://blog.jakesaunders.dev/building-an-almost-fully-self-hosted-sandboxed-agentic-software-factory).
