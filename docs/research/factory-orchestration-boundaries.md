# Factory 02: orchestration boundaries and build-versus-adopt

Work item: GH-160

This note records the research and grilling that selected the orchestration boundary for the embedded clarification capability approved by [Factory 01](https://github.com/Quick-Release/workbench/issues/159). It is a design decision, not an implementation authorization, pilot result, or claim that any external runtime was executed successfully.

## Decision summary

Workbench will extend its existing localhost execution seam with a small, deterministic clarification coordinator. The coordinator owns the lifecycle of an **Owned clarification**, its **Clarification attempts**, capability policy, saved draft state, approval invalidation, and the one explicitly approved issue-body publication.

Pi, reused through the shared conversation boundary proposed in [#133](https://github.com/Quick-Release/workbench/issues/133), owns the runtime conversation and transcript. It proposes researched behavior and emits observations or typed capability requests; it does not own Workbench transitions or publish to GitHub. A Workbench capability broker mediates tracker reads, approved host-repository context, and public research so the runtime cannot silently acquire project-command or publication authority.

The first adapter supports one reviewed Pi runtime for the private cohort from #159. It exposes a narrow port rather than promising universal runtime interchangeability. RPC versus SDK is deferred to [#164](https://github.com/Quick-Release/workbench/issues/164). Existing Review runs and Agent runs retain their current meanings and contracts.

No external factory runtime is adopted for the first clarification capability. Symphony's deterministic-orchestrator separation and Mastra's explicit approval/idempotency ideas are useful patterns; their runtimes would duplicate or constrain Workbench responsibilities. Ramure is not adopted because its inspected runtime is Python/tmux/Pi coupled, its local backend does not establish isolation, its bundled extension targets older Pi package names, and no declared license was found in the inspected metadata.

## Provenance and method

Local source inspection used checkout `7338a11535a145a1e46f4c571a89ab780c98d468` (`main`) and the prior Factory 01 research at [`docs/research/factory-first-run-boundary.md`](./factory-first-run-boundary.md). The relevant product and authority decisions are [#159](https://github.com/Quick-Release/workbench/issues/159), [ADR 0014](../adr/0014-owned-clarification-boundary.md), [ADR 0005](../adr/0005-control-surface-localhost-seam.md), and [ADR 0010](../adr/0010-issue-agent-unattended-fenced-local-runs.md). Existing skill-flow constraints came from [#127](https://github.com/Quick-Release/workbench/issues/127), [#120](https://github.com/Quick-Release/workbench/issues/120), and [#133](https://github.com/Quick-Release/workbench/issues/133).

The following local checks were executed by the fact-finding pass:

- The three relevant seam test files passed: 104/104 tests, using fake CLIs, streams, and targets.
- A schema probe confirmed that the current `opencode` cancellation request is rejected even though the UI sends that engine name.
- A schema probe confirmed that mismatched engine/target combinations are currently accepted.

These checks did not run OpenCode, Ollama, Pi RPC/SDK, GitHub publication, a real host-repository task, a containment test, a restart recovery test, or an external factory runtime. The existing tests and the probes establish source behavior only; they do not establish product reliability or security.

External documentation and source were inspected at these pins:

| Source                               | Inspected pin                                                                                                                                                       | Relevant evidence                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ramure, the current Druids successor | [`fulcrumresearch/ramure` `d7675f1`](https://github.com/fulcrumresearch/ramure/tree/d7675f1eaaae37d08b829cbb1022c685e352fc0a) (`0.0.2`)                             | Python process/machine runtime, Pi/tmux assumption, Local/Docker/Morph backends, JSONL events and control endpoints                                                 |
| OpenAI Symphony                      | [`SPEC.md` `e0ccc83`](https://github.com/openai/symphony/blob/e0ccc83720a42a600a53b61c5f8d3e518bebe1db/SPEC.md) (`v0.0.2`)                                          | deterministic polling/claim/retry orchestration, workspace and agent-runner layering, Codex app-server coupling, in-memory scheduler and explicit persistence TODOs |
| Mastra Factory                       | [`@mastra/factory` `0.14.0`](https://factory.mastra.ai/), repository [`ac3b937`](https://github.com/mastra-ai/mastra/tree/ac3b93704f928cbf62b1af3133e8123f46ecacb1) | explicit board approvals, idempotency keys, integrations, sessions, storage and sandbox callbacks                                                                   |
| Pi coding agent                      | [`d981de1`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477) (`@earendil-works/pi-coding-agent` `0.85.1`)                        | RPC/SDK events and abort, append-only JSONL session entries and cursors, extension/tool interception, no built-in sandbox or GitHub authority                       |

## Domain boundary and vocabulary

The product boundary is **Owned clarification**: a Developer-started, host-repo-scoped research and proposal-correction experience that ends at an approved issue brief. It is not an Agent run, Review run, code change, draft PR, merge, or deployment.

| Term                      | Meaning                                                                                                                                                                        | Deliberate non-meaning                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Clarification draft**   | The saved candidate issue brief, including proposed behavior, scope, acceptance criteria, assumptions, unresolved choices, source references, and the visible issue-body diff. | It is not a `Decision`, `Artifact`, approval, or publication.                                                               |
| **Clarification attempt** | One bounded execution of an Owned clarification. Interruption or failure ends the attempt; an explicit retry starts another attempt.                                           | It is not an Agent run, Review run, or generic factory run.                                                                 |
| **Pi conversation**       | The runtime conversation and transcript backing an owned clarification. Pi/the shared conversation service owns its event cursor and transcript.                               | It is not Session capture, external-session control, or Workbench's clarification state.                                    |
| **Issue brief**           | The concrete behavior, scope, acceptance criteria, assumptions, and resolved choices that the Developer has reviewed as implementation-ready.                                  | Approval authorizes only the exact issue-body update; it does not authorize implementation.                                 |
| **Approval**              | The Developer's explicit acceptance of the visible issue-body diff under its current revision and scope constraints.                                                           | It is not a reusable permission for later prompts, provider changes, or other writes.                                       |
| **Evidence**              | Source-linked material supporting claims in a clarification draft.                                                                                                             | It is not automatically a modeled `Artifact`; the existing collector remains limited to research-note files under ADR 0009. |

The phrase **factory run** remains avoided. It implies a coding or autonomous-production lifecycle that this decision deliberately does not introduce.

## Responsibility and ownership

| Concern                            | Workbench coordinator                                                                                                     | Pi/runtime                                                | Capability or external backend                    | GitHub / Developer                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Target identity and issue revision | Resolves the one host repo, selected issue, and revision snapshot                                                         | Consumes the approved context                             | None                                              | GitHub is authoritative for issue state                           |
| Clarification lifecycle            | Owns transitions, attempt identity, cancellation, retry, limits, and approval invalidation                                | Emits observations and typed requests only                | Reports health/capabilities                       | Developer explicitly corrects and approves                        |
| Conversation and transcript        | Stores a reference and cursor, not a second transcript                                                                    | Owns the Pi conversation, ordered events, and transcript  | Runs the selected provider process                | Developer can reconnect to a live owned attempt                   |
| Host and public research context   | Brokers allowed tracker reads, approved read-only repository context, and public research policy                          | Reasons over returned context and proposes sources/claims | Performs only the capability it was granted       | Private content must not enter public queries                     |
| Skills                             | Selects or presents installed skill/context starters without a second workflow machine                                    | Uses skill instructions as runtime guidance               | None                                              | Existing skill flow remains authoritative for planning vocabulary |
| Draft and readiness                | Persists draft metadata; checks required structure, revision, scope, and unresolved blockers                              | Suggests content and flags possible gaps                  | None                                              | Developer remains the semantic readiness authority                |
| Side effects                       | Rejects project commands, code edits, tracker writes, tickets, labels, and publication except through approved operations | Cannot directly perform those writes                      | Executes only typed, policy-approved capabilities | Approval authorizes one issue-body update                         |
| Publication                        | Sends the exact approved diff with expected revision and reconciles the result                                            | Has no publication authority                              | GitHub API/CLI is an adapter behind the seam      | GitHub state after read-back is the ground truth                  |
| Reporting                          | Emits content-free workflow events only                                                                                   | Transcript remains outside Telemetry                      | None                                              | No new Session capture permission is implied                      |

## Minimal seams

### Clarification coordinator

The coordinator is the Workbench control plane. It owns the clarification and attempt identifiers, lifecycle transitions, explicit cancellation and retry, selected issue revision, scope and capability policy, saved draft, approval binding, and publication reconciliation. It must not delegate a transition to model output.

The product state is deliberately small:

- `active` covers research and correction;
- `awaiting-approval` means the draft passes deterministic structural checks and is visible for Developer review;
- `published` means the exact approved issue-body update was verified by reading GitHub back;
- `cancelled` and `failed` are terminal outcomes for the clarification.

An attempt has its own execution outcome: `running`, `completed`, `cancelled`, `failed`, or `reconciliation-required`. A publication response that may have succeeded never becomes a blind retry: the coordinator first reads the issue and resolves whether it is published, requires renewed approval, or remains incomplete.

### Pi conversation adapter

The first adapter needs only a narrow, testable contract for start, prompt/follow-up, ordered event subscription with a cursor, abort, health, and capability reporting. Browser disconnect detaches from a live owned attempt rather than cancelling it. If the process is gone, the saved draft and transcript remain evidence for a new explicit attempt; Workbench does not claim recovery of unfinished tool side effects.

Steering, saved-conversation resume, extension dialogs, and attachment to an existing external Pi process are optional or deferred. Unsupported capabilities must be visible, never silently discarded. RPC versus SDK is a Factory 06 decision.

### Capability broker

The runtime receives typed capability requests rather than arbitrary shell or GitHub access. The first product boundary permits selected issue/tracker reads, approved host-repository context reads, public research, draft persistence, text/event streaming, and clarification input. It does not permit project-command execution, code edits, ticket creation, label changes, arbitrary tracker writes, or issue publication.

The detailed threat model, credential policy, and enforcement mechanism belong to Factory 03. This decision establishes ownership and the no-implicit-authority rule without pretending that a provider extension is a security sandbox.

### Publication adapter

`Approve and update issue` binds to the selected issue revision, clarification scope, provider/data destination, capability policy, and coordinator/adapter contract version. A changed issue, scope, provider/data destination, capability policy, or incompatible contract invalidates pending approval. The command carries the exact visible body diff and an idempotency key. A successful response is verified by reading the resulting issue; an uncertain response requires reconciliation before any retry.

### Schema boundaries

Effect Schema boundaries remain appropriate at browser commands and responses, runtime events, capability requests/responses, tracker responses, and persisted Workbench metadata. Additive event fields may be accepted only under the normal schema compatibility policy. Incompatible versions fail closed while preserving the draft and Pi transcript. Pi's native transcript format remains Pi-owned and is not copied into a competing Workbench event store.

## Successful and interrupted traces

### Successful clarification

1. Workbench resolves the selected host repo and open issue and records its revision.
2. The coordinator starts one Clarification attempt with the visible provider/data destination and capability policy.
3. The capability broker returns approved issue, repository, and public-source context; private content is not sent to public research.
4. Pi streams research observations and a Clarification draft.
5. Workbench validates required structure and surfaces missing behavior, scope, criteria, decisions, or factual support.
6. The Developer corrects the draft in the same Pi conversation; the coordinator records the updated draft.
7. The draft reaches `awaiting-approval`, and the exact issue-body diff is displayed.
8. `Approve and update issue` revalidates the issue revision and approval binding.
9. Workbench performs the one issue-body update, then reads the issue back.
10. If the resulting body matches the approved diff, the clarification becomes `published`. Nothing else is changed.

### Interrupted clarification

- **Before a draft exists:** cancellation or provider failure ends the attempt; no issue write occurs. The clarification remains incomplete and can be explicitly retried.
- **After a draft exists:** the draft, source references, and Pi transcript remain; the attempt ends as cancelled or failed. A retry starts a new attempt and may use the saved material as context, but does not resume side effects.
- **Browser disconnect:** the viewer detaches; a live owned attempt continues under its approved limits and can be reattached with its cursor. Disconnect is not cancellation.
- **Provider crash or server restart:** Workbench does not claim live-process recovery. It exposes the saved incomplete state and requires a new explicit attempt.
- **Issue edit before approval:** the revision check invalidates the pending approval; the draft must be refreshed and reviewed again.
- **Uncertain GitHub response:** the attempt enters `reconciliation-required`. Workbench reads the actual issue before deciding whether publication succeeded, the approved diff is stale, or a fresh approval is needed. It never blindly repeats the write.

## Build-versus-adopt comparison

| Option                                                              | Inspected facts                                                                                                                                                                                                                                                                                                            | Decision                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend the existing Workbench seam with a clarification coordinator | ADR 0005 already makes the localhost seam the browser's action boundary. The current runner supplies process lifecycle, typed events, injected plans, and test seams, but is review-shaped and coding-run oriented.                                                                                                        | **Selected.** Reuse the seam and low-level patterns, but keep clarification contracts separate from Review and Agent runs.                                                                        |
| Adopt Ramure as an orchestration runtime                            | Ramure uses Python process/machine scopes, Pi/tmux, Local/Docker/Morph backends, JSONL logs, and live control endpoints. Local execution is ordinary host execution; Docker documents host networking. The inspected package metadata did not declare a license, and its bundled extension imports older Pi package names. | **Rejected as a dependency.** It adds a runtime and lifecycle surface without establishing Workbench's approval, issue-body publication, or host-boundary guarantees.                             |
| Adopt Symphony                                                      | Symphony is Apache-2.0 and cleanly separates deterministic orchestration, workspace, tracker, and agent runner. Its reference implementation is experimental, targets the Codex app-server protocol, keeps scheduler state in memory, and explicitly leaves persistent retry/session metadata unfinished.                  | **Rejected as a dependency; pattern retained.** Its observation-versus-transition split is useful, but it duplicates tracker/orchestration concerns and is not an embedded clarification product. |
| Adopt Mastra Factory                                                | Mastra documents explicit plan/merge approvals, idempotency keys, integrations, sessions, storage, and sandbox callbacks. It also brings board phases, tracker integrations, UI/server/auth/storage, and a broad Node dependency surface; it does not establish an issue-body-only, local-first clarification boundary.    | **Rejected as a dependency; selected approval patterns retained.** Its scope would duplicate Workbench rather than deepen the needed seam.                                                        |
| Adopt Pi                                                            | Pi is MIT-licensed and exposes RPC/SDK lifecycle events, abort, ordered cursors, append-only session entries, and extension/tool interception. It supplies no GitHub issue model, durable Workbench authority, or built-in sandbox.                                                                                        | **Selected as the first runtime adapter behind #133.** Version and RPC/SDK choice remain #164 decisions.                                                                                          |
| Keep proposal-first skills only                                     | Existing skills are the smallest fallback and remain useful; #159 selected embedding because issue, proposal, and evidence stay together.                                                                                                                                                                                  | **Retained as the fallback/comparator, not the embedded product boundary.** No second skill-flow state machine is introduced.                                                                     |

The comparison is not a benchmark. No external runtime was installed or executed, and no evidence shows that any external factory reduces the selected intent-clarification effort.

## Dependencies and deliberate deferrals

- **#161:** threat model, approvals, credentials, and concrete enforcement.
- **#162:** trusted briefs, readiness, and research context details.
- **#164:** Pi runtime validation and RPC-versus-SDK choice.
- **#165:** durable ownership, metadata storage, and crash/recovery policy.
- **#166–#169:** verification, delivery, failure policy, and inspection must be reconsidered against the clarification-only boundary; coding workspaces and draft-PR delivery are not first-result requirements.
- **#133:** supplies the shared conversation boundary; it is not silently reimplemented here.
- **#127/#120:** supply composable skills and starters; they do not become a second mandatory workflow machine.

This decision does not authorize implementation, automatic intake, code edits, project commands, ticket decomposition, labels, draft PRs, merge, deployment, remote execution, or control of externally started sessions. It does not choose a database schema or a generic workflow DSL.

## Sources

- Workbench [#160](https://github.com/Quick-Release/workbench/issues/160), [#159 Resolution](https://github.com/Quick-Release/workbench/issues/159#issuecomment-5657948810), [#158](https://github.com/Quick-Release/workbench/issues/158), [#133](https://github.com/Quick-Release/workbench/issues/133), and [#127](https://github.com/Quick-Release/workbench/issues/127).
- [`CONTEXT.md`](../../CONTEXT.md), [`ADR 0005`](../adr/0005-control-surface-localhost-seam.md), [`ADR 0010`](../adr/0010-issue-agent-unattended-fenced-local-runs.md), and [`ADR 0014`](../adr/0014-owned-clarification-boundary.md).
- [`factory-first-run-boundary.md`](./factory-first-run-boundary.md).
- [Ramure README at `d7675f1`](https://github.com/fulcrumresearch/ramure/blob/d7675f1eaaae37d08b829cbb1022c685e352fc0a/README.md) and [runtime](https://github.com/fulcrumresearch/ramure/blob/d7675f1eaaae37d08b829cbb1022c685e352fc0a/ramure/runtime.py).
- [Symphony SPEC.md at `e0ccc83`](https://github.com/openai/symphony/blob/e0ccc83720a42a600a53b61c5f8d3e518bebe1db/SPEC.md).
- [Mastra Factory documentation](https://factory.mastra.ai/using/work-and-approvals), [API](https://factory.mastra.ai/reference/mastra-factory-api), and [storage](https://factory.mastra.ai/configure/storage).
- [Pi RPC documentation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md), [extensions](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md), [SDK](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md), and [session format](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/session-format.md).
