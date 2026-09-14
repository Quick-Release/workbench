# Factory 06 — Pi runtime and managed-session contract

Status: accepted research/design decision

Work item: [GH-164](https://github.com/Quick-Release/workbench/issues/164)

Related decisions: [GH-159](https://github.com/Quick-Release/workbench/issues/159), [GH-160](https://github.com/Quick-Release/workbench/issues/160), [GH-161](https://github.com/Quick-Release/workbench/issues/161), [GH-162](https://github.com/Quick-Release/workbench/issues/162), [GH-133](https://github.com/Quick-Release/workbench/issues/133), [GH-163](https://github.com/Quick-Release/workbench/issues/163), [GH-165](https://github.com/Quick-Release/workbench/issues/165)

## Decision in brief

The first Pi integration is a versioned `pi-managed/v1` adapter for **Owned clarification** only. It is not a coding runtime, a replacement for the Issue agent, a Review run, or a second chat product.

The adapter launches a pinned `pi --mode rpc` subprocess and presents one Workbench-owned session contract. Workbench owns the clarification attempt, approval binding, capability policy, context/data-flow manifest, controller lease, and lifecycle. Pi owns the conversation tree, transcript entries, and Pi-native event source. One adapter is the sole writer for one live Pi session file.

The first profile supports Workbench-created sessions only. A browser may observe an explicitly paired external session in a later profile, but seeing history never grants send, steer, resume, fork, or termination authority. Coding tools and broader execution remain outside the profile until Factory 05 (#163) selects and validates an execution backend.

The adapter distinguishes acceptance from completion, preserves ordered event/cursor semantics, and fails closed on ambiguity. Browser disconnect detaches the viewer; it does not automatically cancel the owned runtime. Process death does not trigger automatic restart or prompt replay. Durable operational ownership, cross-process leases, recovery, and retention remain Factory 07 (#165).

No Pi provider, real session, host command, GitHub publication, pilot, or exploit test was run for this decision. The documentation records a contract for later implementation and fixture testing only.

## Evidence boundary

### Verified Workbench facts

The current `main` revision was `7338a11` during investigation. The repository has no Pi SDK or RPC integration, Pi conversation service, managed-session persistence, attached-session pairing, browser chat submission, or Pi event cursor.

The existing execution seam is review-shaped:

- `scripts/seam/routes/review-api.mjs` exposes health, start, cancel, and in-memory history.
- `scripts/seam/review/review-runner.mjs` owns detached subprocess groups, typed `started`/`output`/`notice`/`error`/`exit` events, output caps, timeout, cancellation, and one active run per engine.
- `scripts/seam/review/opencode-engine.mjs` builds the issue-agent plan and an OpenCode permission configuration, but that configuration is a tool-level policy rather than OS, filesystem, network, or credential isolation.
- `src/schema.ts` has no accepted-versus-settled Pi lifecycle, Pi event cursor, tool-event model, provider interruption model, or session ownership contract.
- Review history is in memory and resets with the dev server. Session capture is an authenticated, read-only telemetry proxy and is not a live conversation control plane.

A confirmed existing schema gap remains outside this decision: `ReviewCancelRequestSchema` accepts only review engines even though the UI can request OpenCode cancellation, and review run requests do not enforce engine/target pairing. These are maintenance issues; this decision does not repurpose Review run types for Pi sessions.

### Official Pi facts

The pinned research reference is `@earendil-works/pi-coding-agent@0.85.1`, upstream tag [`v0.85.1`](https://github.com/earendil-works/pi/tree/v0.85.1), commit [`d981de1`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477). The exact revision eventually supported by Workbench must be pinned and tested; `v0.85.1` is not a promise to support an unimplemented integration.

The tagged [RPC documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md) states that:

- commands are JSON objects over stdin and responses/events are JSON lines over stdout;
- command responses correlate through an optional `id` but a successful `prompt` response means accepted, queued, or immediately handled—not completed;
- `agent_end` is a low-level run boundary and may be followed by retry, compaction, or queued work; `agent_settled` is the session-level settled event;
- `steer`, `follow_up`, `clear_queue`, and `abort` are separate operations;
- `get_entries(since)` can return entries after a durable entry ID, but it does not make a disconnected live stream lossless or safely replayable;
- `select`, `confirm`, `input`, and `editor` extension dialogs have a JSON request/response sub-protocol, while TUI-only custom components are unsupported or degraded;
- session statistics expose provider-reported token/cost data where available, but context usage can be unavailable after compaction and cost is not a remaining-subscription meter.

The tagged [SDK documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md) states that `prompt()` resolves after an accepted run settles, while `preflightResult(true)` only means accepted/queued/handled. The SDK provides richer same-process types and direct tool/session state, but shares Pi’s extension/resource authority with the host process.

The tagged [extension documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) states that extensions can register tools, intercept or mutate tool calls, access UI, and execute arbitrary code with the launching process’s permissions. Project and user resource discovery is therefore not an authority boundary.

The tagged [session documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sessions.md) describes JSONL session files with tree-shaped entries, resume, fork, clone, and history. Persisted entries do not restore unfinished provider or tool side effects after a crashed runtime.

The tagged [security documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/security.md) states that Pi has no built-in sandbox. RPC process separation is a fault and packaging boundary, not proof of the OS-level isolation required for future coding profiles.

### Existing proposal facts

#133 already establishes the intended shared chat boundary: browser chat rather than a terminal emulator; Workbench-created sessions first; snapshot plus ordered events; history, reconnect, resume, and fork as distinct concepts; and attached sessions only through explicit future pairing. Its reference projects are not drop-in Pi RPC implementations and their exposure defaults are not Workbench security guarantees.

The accepted resolutions for #159–#162 establish that the first valuable result is Owned clarification ending at an approved issue brief; Workbench owns deterministic lifecycle, policy, approvals, and publication; Pi owns only conversation state; untrusted content cannot grant authority; the first capability profile is brokered read/research; and Context packets, readiness, and authorization are distinct.

## Domain model

| Concept                   | Meaning and owner                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clarification attempt** | One Workbench-owned, revision-bound clarification lifecycle. It carries one approval binding and one immutable Context packet.                                |
| **Pi conversation**       | The conversation transcript and ordered/tree-shaped event history used by the shared chat boundary. It is not a process, an approval, or Session capture.     |
| **Managed Pi session**    | One Workbench-created Pi conversation with one Workbench-controlled live runtime and one authorized session-file writer.                                      |
| **Attached session**      | An existing Developer-owned Pi session exposed only through an explicit observation pairing. Historical visibility is not control.                            |
| **Session history**       | A read of persisted conversation entries. It does not imply a live runtime or permission to resume it.                                                        |
| **Session reconnect**     | Reattaching a viewer to an existing managed runtime and reconciling a snapshot/event cursor. It does not replay an accepted request.                          |
| **Session resume**        | Starting a runtime from persisted conversation state after a runtime has ended. It is a separate capability and is not claimed by `pi-managed/v1`.            |
| **Session fork**          | Creating a new conversation from an earlier conversation entry. It is separate from history, reconnect, and resume.                                           |
| **Controller lease**      | The singular, fenced authority to submit commands to one managed session. Viewers have no command authority.                                                  |
| **Session event cursor**  | A position used to reconcile ordered session evidence. A Pi entry ID can help reconcile persisted entries; it is not automatically a live transport sequence. |
| **Capability profile**    | The immutable set of operations, tools, resources, and destinations granted to a session. A prompt or extension cannot broaden it.                            |

One clarification attempt creates one dedicated Pi conversation. Reconnect returns to that attempt. A provider, Context packet, issue revision, capability, policy, contract, or material scope change requires a new attempt and conversation.

## SDK versus RPC

| Concern                    | Embedded SDK                                                                       | `pi --mode rpc` subprocess                                                 | Decision                         |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| API shape                  | Typed same-process `AgentSession`, runtime, tools, extensions, and session manager | JSONL commands, responses, and events; language-neutral adapter            | RPC first                        |
| Acceptance/completion      | `preflightResult` is acceptance; `prompt()` settles after accepted work            | Prompt response is acceptance; `agent_settled` is session-level completion | Normalize both if ever supported |
| Fault boundary             | Shares Workbench process and crash boundary                                        | Independently killable Pi process                                          | RPC is the safer first seam      |
| Custom tools/extensions    | Easy to inject, but direct host authority                                          | Must be loaded by the child and still retain child permissions             | Only reviewed broker resources   |
| Authentication             | Direct credential/runtime APIs                                                     | Child’s configured auth and environment                                    | Visible, local, no fallback      |
| Packaging/version coupling | Workbench package directly couples to SDK API                                      | Requires a pinned executable/package and protocol contract                 | Reject unsupported versions      |
| Session state              | Direct access and replacement APIs                                                 | RPC session/state/tree/entry commands                                      | Adapter owns normalization       |
| Security                   | No sandbox; same process is not isolation                                          | No sandbox; process boundary is not isolation                              | #163 remains required for coding |

The Pi documentation recommends the SDK for a same-process Node application and RPC when process isolation or a language-neutral client is useful. The decision chooses RPC because this boundary benefits from an independently supervised child and because Workbench must not couple its control process directly to Pi’s extension/runtime state. This does not reject a future SDK adapter behind the same port.

## `pi-managed/v1` capability matrix

| Operation                 | Workbench-owned managed session | External/attached session                   | First-profile rule                                                    |
| ------------------------- | ------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Create/start              | Yes                             | No                                          | Workbench creates the runtime and dedicated session location          |
| Normal prompt             | Yes                             | No                                          | Explicit command ID and idempotency key; accepted is not complete     |
| Steer current work        | Yes                             | No                                          | Explicit operation; no implicit interruption                          |
| Queue follow-up           | Yes                             | No                                          | Explicit operation; its acceptance and delivery remain separate       |
| Clear queued work         | Yes                             | No                                          | Used before stop-turn when queued work must not continue              |
| Stop current turn         | Yes                             | No                                          | Clear queue, request Pi abort, and wait for observed idle/termination |
| Terminate runtime         | Yes                             | No                                          | Only the Workbench-owned process may be terminated                    |
| Snapshot/events           | Yes                             | Observation only if separately paired later | Versioned Workbench envelope, ordered cursor, bounded stream          |
| History                   | Yes                             | Read-only if explicitly paired later        | History never grants live control                                     |
| Reconnect                 | Yes while runtime exists        | No in v1                                    | Reconcile snapshot and cursor; never replay blindly                   |
| Resume after process loss | Deferred                        | No                                          | Requires #165 and explicit recovery evidence                          |
| Fork                      | Deferred                        | No                                          | Requires an explicit future capability and new approval context       |
| Provider/model change     | No in place                     | No                                          | New attempt and approval                                              |
| Tool/resource expansion   | No in place                     | No                                          | New capability profile and approval                                   |
| Issue publication         | No                              | No                                          | Separate exact-diff publication approval and read-back                |

The first profile supports explicit `prompt`, `steer`, `follow_up`, `clear_queue`, stop-turn, and terminate-runtime operations because Pi exposes them distinctly and #133 requires explicit steer-versus-queue behavior. Workbench must not turn a lost response into an automatic resend. A duplicate request key is deduplicated while the same controller/runtime is alive; after an uncertain restart, the request is `unknown` until reconciled and is never automatically replayed.

## Lifecycle and completion

The adapter exposes the following normalized states:

1. **Preparing** — context, approval, provider, policy, version, and capability preflight.
2. **Launching** — the pinned runtime is being started and identified.
3. **Accepted** — the command passed Pi preflight and may be queued or handled; completion is not implied.
4. **Running** — agent, turn, message, or broker tool activity is observed.
5. **Waiting for input** — a supported broker/dialog request is pending, or the runtime is waiting under a declared policy.
6. **Settled** — Pi emitted `agent_settled`, no queued continuation/retry/compaction retry remains, and the adapter reconciled the final session state.
7. **Failed** — a known provider, policy, protocol, runtime, or tool failure ended the attempt.
8. **Cancelled** — the Developer or Workbench explicitly stopped the attempt and the runtime’s ending was observed.
9. **Unknown after disconnect/process loss** — the adapter cannot establish whether a request or tool effect was accepted or completed.

`agent_end`, assistant text, `message_end`, a prompt acknowledgement, or a successful command response is not sufficient to enter Settled. Provider retry, compaction, queued follow-ups, and extension activity must be accounted for.

A browser disconnect detaches the viewer. The managed runtime may continue only within the already approved turn/resource/idle limits. A server shutdown terminates only Workbench-owned runtimes and preserves the available history; no automatic process recovery is promised. An external or attached runtime is never terminated by Workbench.

## Event and cursor contract

The adapter’s public event envelope is versioned independently from Pi’s raw JSONL. Each event carries, where available:

- a Workbench monotonic sequence for the live stream;
- the session and attempt identifiers;
- the originating Pi event type and bounded payload;
- Pi entry ID or tool/request correlation ID when available;
- the normalized lifecycle state;
- adapter, Pi, and protocol versions.

The event stream includes prompt acceptance/rejection, lifecycle changes, assistant/message deltas, tool start/update/end observations, queue changes, compaction/retry observations, extension UI requests, provider errors, policy denials, process exit, and unknown/malformed-event notices. Unknown Pi events are preserved as unrecognized evidence and cannot cause a completion or authority transition.

Reconnect returns a current snapshot plus events after a requested cursor. If the live buffer no longer covers the cursor, the adapter reads persisted Pi entries and reports a reconciliation boundary. It does not promise reconstruction of a live event that was never persisted or replay of an operation with unknown side effects.

## Authority, approval, and data flow

The start approval binds one attempt to:

- Workbench-resolved host repository identity and revision;
- selected issue number and composite issue revision;
- immutable Context packet digest and provenance/coverage warnings;
- selected skills and research sources;
- provider, model, authentication mode, and data destination;
- Pi revision, RPC contract, Workbench adapter, and policy versions;
- immutable capability profile and allowed tools/resources/destinations;
- approval nonce and expiry.

The generated session ID and runtime identity are recorded immediately after launch. Any material issue, context, skill, lockfile, provider, model, destination, capability, policy, contract, or scope change invalidates the binding. A publication approval separately binds the exact visible issue-body diff and expected issue revision; it is not a session capability.

The controller lease is singular per managed session. Viewers can read snapshots/events and request a handoff, but only the current fenced controller can submit a prompt or control operation. The first adapter may keep this lease process-local. #165 owns durable leases, cross-process ownership, heartbeats, fencing across restart, and recovery reconciliation. No provider credential or capability token belongs in a URL, browser state, telemetry event, D1/R2 record, or session transcript.

## Resources, tools, and extension UI

The first clarification runtime must use a dedicated, reviewed resource set. It must not automatically discover or execute project/user extensions, prompt templates, skills, or context files as authority. Selected skills and Context packet evidence enter through Workbench-owned, bounded channels.

No generic `bash`, `read`, `write`, `edit`, package, Git, hook, test, tracker-write, deployment, or arbitrary network capability is available in `clarification/v1`. The broker may expose only the approved tracker reads, host-context reads, public research, and local draft-save operations from #161/#162. The Pi process cannot widen this set because a prompt, issue, comment, skill, tool result, extension, or model output is untrusted content.

The RPC extension UI sub-protocol is available only to reviewed broker extensions. `select`, `confirm`, `input`, and `editor` requests become typed pending input with cancellation and bounded timeout. An unsupported custom TUI widget, arbitrary extension dialog, or required interaction that cannot be safely represented produces a typed denial/unsupported state; it does not silently continue with an authority-changing default.

This is a policy and adapter requirement, not a claim that Pi RPC enforces it by itself. Pi extensions have process permissions, and future code-running profiles require the independent OS/container execution decision from #163.

## Error and usage mapping

| Evidence                                            | Normalized result                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing or unapproved Pi binary                     | `runtime_missing` / `unsupported`                                       |
| Unsupported Pi or RPC contract                      | `protocol_mismatch` / `unsupported`                                     |
| Malformed JSONL or unknown framing                  | `malformed_event` or `protocol_failure`; terminate rather than guess    |
| Prompt rejected before acceptance                   | `rejected` with the Pi error                                            |
| Provider authentication unavailable                 | `auth_required`                                                         |
| Quota/rate limit/provider interruption              | `provider_failure` or `quota`; explicit user action, no silent fallback |
| Approved broker capability denied                   | `policy_denied`                                                         |
| Required supported dialog unanswered                | `waiting_for_input` until timeout, then typed cancellation/failure      |
| Explicit stop observed                              | `cancelled`                                                             |
| Child exits after known settled state               | `settled` if reconciliation proves it                                   |
| Child/process loss before outcome is known          | `unknown_after_process_loss`                                            |
| Browser disconnect while child lives                | `detached`, with runtime state preserved                                |
| Stale/expired/replayed approval or controller lease | typed denial                                                            |

Pi/provider-reported tokens and costs are displayed as reported values. Estimates and unavailable values are labelled separately; neither is presented as remaining subscription capacity. A provider/auth failure never silently changes provider, model, billing mode, or data destination.

## Required fixture contract tests

Before any provider use or pilot, the adapter must pass a fake JSONL transport matrix covering:

- acceptance versus rejection and the difference between acknowledgement and settlement;
- `agent_end` followed by automatic retry, compaction, queued work, and `agent_settled`;
- partial text, thinking, tool-call, tool-result, queue, compaction, and provider-error events;
- prompt, steer, follow-up, clear-queue, stop-turn, and terminate-runtime ordering;
- lost acknowledgement, duplicate request keys, reconnect reconciliation, and no automatic replay;
- snapshot/cursor reads, expired cursors, missing live events, malformed records, unknown event types, and protocol version mismatch;
- extension dialog request/response, cancellation, timeout, unsupported custom UI, and broker policy denial;
- missing runtime, unavailable model, auth failure, quota/rate-limit failure, and no-fallback behavior;
- process death before dispatch, after dispatch but before acknowledgement, during provider work, during a broker tool, after settlement, and during shutdown;
- two viewers, controller handoff, stale lease fencing, and conflicting commands;
- approval expiry/invalidation when issue, Context packet, provider, capability, policy, or contract changes;
- isolation of session IDs, host repositories, session directories, and controller authority.

These are contract tests, not evidence that Pi, a provider, or an OS sandbox is reliable. Real provider testing, resource abuse testing, and the disposable synthetic-secret abuse matrix remain separately authorized work.

## Changes to #133

The shared Pi Chat Workspace proposal should add or link the following constraints:

1. `pi-managed/v1` is a versioned adapter profile, not a second chat system.
2. Workbench-owned clarification sessions use a pinned RPC runtime, one writer, one controller lease, and an immutable capability profile.
3. Accepted, running, waiting, settled, failed, cancelled, and unknown states are distinct; `agent_settled` is not replaced by assistant text or command acknowledgement.
4. Snapshot, ordered live events, persisted history, reconnect, resume, and fork remain separate operations.
5. Reconnect never replays an accepted or uncertain prompt.
6. Attached sessions are observation-only until a separate pairing/control decision exists.
7. Provider/auth/data-destination visibility and approval binding are required; credentials are not browser/session-capture data.
8. #163 owns code-running isolation; #165 owns durable operational storage, leases, crash recovery, and retention.
9. Existing Review run, Agent run, and Session capture contracts remain unchanged.

No new terminal UI, session database, automatic agent launch, or external-session control is authorized by this decision.

## Rejected alternatives

- **SDK as the first adapter:** rejected for this slice because it shares Workbench’s process and failure boundary and directly couples the coordinator to Pi’s runtime/extension API. It remains a possible later adapter behind the same contract.
- **Reuse Review run or Agent run types:** rejected because their one-shot subprocess/output/history semantics do not model conversation ownership, event cursors, accepted-versus-settled requests, or clarification capabilities.
- **General coding tools in the first session:** rejected because #163 has not established the required OS-level boundary and Owned clarification is read/research-only.
- **Automatic project/user extension discovery:** rejected because Pi extensions execute with process permissions and untrusted repository content cannot establish authority.
- **Attached-session control in v1:** rejected because observation/history does not establish process ownership or session-file writer authority.
- **Automatic runtime recovery or prompt replay:** rejected because persisted entries cannot prove the outcome of an unfinished provider/tool effect.
- **External factory runtime or second chat store:** rejected by #160 and #133; Workbench remains the control surface and Pi remains the conversation runtime.

## Dependencies and remaining uncertainty

- **#163 / Factory 05:** must select and validate any OS/container execution backend before a coding or project-command profile can exist. `pi-managed/v1` deliberately has no such capability.
- **#165 / Factory 07:** must decide durable metadata, leases, supervision, retention, restart/recovery, migration, and deletion. This decision promises only live reconnect and history while the managed runtime remains available.
- **Exact supported Pi revision:** the implementation must pin and test one revision and RPC contract rather than follow `latest`.
- **Provider terms and account compatibility:** the private Linux/Pi/OpenAI Codex OAuth cohort remains a pilot boundary, not a universal compatibility or billing claim.
- **Enforcement:** no current runtime enforces this contract. The required fixture matrix and later disposable security matrix must be completed by separately authorized implementation/pilot work.

This decision closes the research question without authorizing implementation, provider calls, automatic intake, project commands, code edits, GitHub issue publication, draft PR delivery, merge, deployment, or external-session control.
