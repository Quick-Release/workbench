# Factory 10 — Failure taxonomy, repair limits and usage budgets

Status: accepted research/design decision

Work item: [GH-168](https://github.com/Quick-Release/workbench/issues/168)

Prerequisites: [GH-164](https://github.com/Quick-Release/workbench/issues/164), [GH-165](https://github.com/Quick-Release/workbench/issues/165), [GH-166](https://github.com/Quick-Release/workbench/issues/166)

Related ownership: [GH-122](https://github.com/Quick-Release/workbench/issues/122), [GH-133](https://github.com/Quick-Release/workbench/issues/133), [GH-161](https://github.com/Quick-Release/workbench/issues/161), [GH-162](https://github.com/Quick-Release/workbench/issues/162), [GH-163](https://github.com/Quick-Release/workbench/issues/163), [GH-167](https://github.com/Quick-Release/workbench/issues/167), [ADR 0010](../adr/0010-issue-agent-unattended-fenced-local-runs.md), [ADR 0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md), [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md), [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md), [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md)

## Decision in brief

Workbench will define a failure policy for Workbench-owned operational work without renaming or merging the existing **Agent run**, **Review run**, **Clarification attempt**, **Operational run record**, and **Execution attempt** concepts. The first product remains read-only **Owned clarification**; it has no implementation repair loop. A future coding profile may use this policy only after #162's brief/readiness boundary, #163's enforceable Execution backend, #165's durable ownership and reconciliation, #166's independent verification, #167's safe publication, and #169's intervention boundary are implemented and validated with justified numeric limits.

The first release is **manual-retry-only after dispatch**. Every post-dispatch execution, provider, or tool retry or repair is an explicit Developer action that creates a fresh Execution attempt. A dispatched operation whose effect is uncertain becomes an **Unknown outcome** and must be reconciled or resolved by a human; it is never blindly replayed. Only one coordinator-level retry is permitted when durable evidence proves that no provider or tool dispatch occurred. Read-only reconciliation and authorized same-intent publication convergence under #167 are not execution retries and do not create a new candidate by themselves. Pi automatic retries are disabled for the Workbench adapter.

Workbench-owned budgets are durable at the Operational run record level and span attempts and controller restarts. Hard local limits are distinct from provider-reported usage, estimates, and unknown availability. Pi token/cost data is an observation, not a remaining subscription meter; Workbench never silently changes provider, model, authentication, billing mode, or destination.

## Scope and evidence boundary

This note records a human-accepted research/design decision and a later implementation contract. It does not implement a retry loop, repair agent, coding profile, provider adapter, execution backend, durable store, verifier, UI, notification service, or scheduler. It authorizes no provider session, real subscription use, host-repository command, GitHub publication, deployment, or client-infrastructure experiment.

The local code observations were checked against Workbench `main` at [`a5dcd92`](https://github.com/Quick-Release/workbench/commit/a5dcd92d44b120363f3f3d9d3f9162485a522c3a) on 2026-09-15. The issue's earlier baseline is [`fd22f6a`](https://github.com/Quick-Release/workbench/tree/fd22f6a2d1bde0a65838955bcdec4c9d6a3c6f13). The source layout changed between those revisions; the relevant runner behavior remains best-effort foreground execution rather than a durable repair system.

Pi claims use the pinned [`@earendil-works/pi-coding-agent` v0.85.1 / `d981de1`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477). Live OpenAI documentation and provider behavior can change, so those sources are evidence at the cited revision/date, not a universal compatibility or billing promise.

## Accepted decision lineage

This decision composes existing boundaries rather than creating a second factory runtime:

- [#161](https://github.com/Quick-Release/workbench/issues/161) and [ADR 0016](../adr/0016-clarification-threat-model-and-credential-boundaries.md) make issue, source, skill, documentation, tool, and model content untrusted data. It cannot expand a capability profile or approval. Credentials remain behind typed boundaries.
- [#162](https://github.com/Quick-Release/workbench/issues/162) and [ADR 0017](../adr/0017-trusted-clarification-context-and-readiness.md) make the Context packet immutable evidence for one Clarification attempt. Incomplete requirements remain `needs-information`; a model cannot invent a requirement or authorization.
- [#164](https://github.com/Quick-Release/workbench/issues/164) and [ADR 0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md) define the versioned Pi adapter, accepted-versus-settled semantics, managed-session ownership, and no automatic process recovery or prompt replay.
- [#165](https://github.com/Quick-Release/workbench/issues/165) and [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md) own durable run/attempt records, pre-dispatch persistence, leases, fencing, reconciliation, retention, and Unknown outcomes. A restart does not prove that a process or external operation stopped.
- [#166](https://github.com/Quick-Release/workbench/issues/166) and [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md) own Verifiers, Verification evidence, Candidate commits, invalidation, and Verification exceptions. Repair produces a new candidate and invalidates prior evidence.
- [#167](https://github.com/Quick-Release/workbench/issues/167) and [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md) own Publication intents, the Publisher, remote read-back, and publication uncertainty. An uncertain publication is not repaired by blind retry.
- [#122](https://github.com/Quick-Release/workbench/issues/122) owns human Work Checkpoints. [#133](https://github.com/Quick-Release/workbench/issues/133) and #164 own Pi conversation history and reconnect semantics. Neither is an operational run store or proof of resumability.

## Domain model and invariants

The policy uses the project glossary in [`CONTEXT.md`](../../CONTEXT.md):

| Concept                    | Policy meaning                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operational run record** | One approved work intent and its durable attempts, ownership, evidence references, budget ledger, and human-resolution state.                                                                                 |
| **Execution attempt**      | One fresh dispatch under that record. A retry is an action that creates an attempt; it is not a state and not a resumed process.                                                                              |
| **Run request**            | One client submission, deduplicated across reconnects so a repeated browser request cannot silently create another attempt.                                                                                   |
| **Clarification attempt**  | One revision-bound Owned clarification with its own Context packet, approval binding, and managed Pi conversation. It ends at an approved Issue brief, not a code candidate.                                  |
| **Repair**                 | A fresh future coding attempt intended to address a known candidate failure without changing the approved Issue brief, scope, capability profile, or Verification recipe. It produces a new Candidate commit. |
| **Unknown outcome**        | Workbench cannot prove whether an already-dispatched process or external operation had an effect. It requires reconciliation or human resolution and cannot be treated as a retry-safe failure.               |
| **Failure classification** | The typed interpretation of an observed outcome that selects the permitted next action. It is separate from the cause, diagnostic text, or UI status.                                                         |

The invariants are:

1. The coordinator, not Pi, a model, an extension, a verifier, or an external runtime, owns classification, retry decisions, limits, approval invalidation, and lifecycle transitions.
2. A request is persisted before dispatch. An attempt is never resumed or replayed after an uncertain dispatch.
3. A repair is not a second turn in the failed attempt. It is a new attempt and new candidate, with fresh verification required before publication.
4. No failure classification grants new commands, tools, credentials, destinations, provider/model choices, or verifier authority.
5. A human approval can authorize a new attempt within an unchanged binding, but it cannot manufacture success, erase failure evidence, or turn unknown into failed.
6. The first release performs no automatic implementation repair and no automatic post-dispatch retry.
7. A new run does not erase the evidence or accounting of an earlier run. A new run is a new intent, not a budget reset for an existing run.

## Existing Workbench behavior

The current seam must not be mistaken for the future policy. The read-only inspection found:

### Bounds that exist today

- `scripts/seam/review/review-runner.mjs` has a five-second health-probe timeout, a fifteen-minute default per-step timeout, a five-second termination grace period, detached process-group termination, and a one-megabyte combined stdout/stderr cap per run.
- `scripts/seam/review/opencode-engine.mjs` gives the OpenCode agent step a thirty-minute default controlled by `WORKBENCH_OPENCODE_TIMEOUT_MS`, with no upper bound and no total plan timeout. A seven-step plan can therefore run far longer than one step.
- The runner holds one active run per engine in process memory. It has typed stream events for start/output/notice/error/exit, but does not persist a durable run ID, attempt ID, cursor, lease, or budget ledger.
- Cancellation sends SIGTERM to the detached process group and then SIGKILL after the grace period, but does not prove descendant termination or absence of external effects. A browser response closing currently calls cancellation; server shutdown cancels the in-memory registry.
- Output history is in memory, resets after restart, is not paginated, and does not retain the metadata needed to bind evidence to a revision, attempt, step, or resource budget.

### Gaps that matter to #168

- There is no repair loop, retry count, pause state, total run budget, token/cost budget, provider-quota check, process/resource accounting, crash reconciliation, or repeated-failure signature.
- OpenCode's current issue path uses a deterministic temporary worktree and issue-number branch, performs best-effort force removal, then stages, commits, pushes, and creates a draft PR. This is not ownership-safe repair behavior or a compliant future coding profile.
- The current request schema accepts mismatched engine/target combinations, and the OpenCode cancellation request is rejected even though the UI can request it. These are maintenance defects, not permission to broaden #168.
- A nonzero step exit is not mapped to the full failure taxonomy. Current history collapses outcomes into `completed`, `failed`, `cancelled`, and `timed_out`; it has no Unknown, unsupported, policy-denied, infrastructure-error, cleanup, quarantine, or usage state.
- Separate ZCode session aggregation records some model usage, but it is not correlated with Operational run records and cannot be used as run ownership or budget state. Session usage remains within its existing reporting boundary.

The current implementation therefore provides measurable local observations but not the policy enforcement, durable accounting, or evidence independence required by this decision.

## Pi and provider findings

The pinned Pi RPC and SDK documentation establishes the following:

- An RPC command response acknowledges acceptance, queueing, or handling; it does not mean that the request completed.
- `agent_end` is not the session-level completion boundary because retry, compaction, or queued work may follow. `agent_settled` is the relevant settled event after those continuations are accounted for.
- The SDK's `preflightResult` is acceptance, while `prompt()` resolves after the accepted run settles. Workbench normalizes both transports behind the #164 contract.
- Pi exposes distinct `abort`, `steer`, `follow_up`, `clear_queue`, and session observation operations. A lost acknowledgement is not permission to send the same prompt again.
- Pi session statistics can report input, output, cache-read, cache-write, total tokens, and provider/model cost. Context usage can be absent after compaction, and a cost value is not an invoice or remaining subscription meter.
- The pinned settings allow automatic retries with `maxRetries` up to three by default. Workbench cannot allow an unaccounted Pi retry underneath a manual-retry policy, so the adapter sets Pi automatic retries to zero for this profile.
- Pi has no documented generic monetary budget, subscription-quota reservation, CPU/memory boundary, or OS-level sandbox. RPC process separation is not the coding isolation required by #163.

The inspected `openai-codex` provider is a subscription-mode provider with OAuth/account handling and provider-reported token/cost mapping. Its transport may classify retryable 429/5xx responses, but quota-like exhaustion is terminal when indicated by the response. The provider source does not query a remaining ChatGPT allowance or reserve usage for a restarted Workbench run. OpenAI's separate Codex documentation describes a usage dashboard, `/status`, and Codex App Server account methods such as `account/rateLimits/read` and `account/usage/read`; those are not Pi RPC guarantees and do not establish Workbench-owned reservation across concurrent or restarted attempts.

Sources:

- [Pinned Pi RPC documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md)
- [Pinned Pi SDK documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)
- [Pinned Pi provider documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/providers.md)
- [Pinned OpenAI Codex provider implementation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-codex-responses.ts)
- [Pinned OpenAI Codex OAuth implementation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/auth/oauth/openai-codex.ts)
- [OpenAI Codex pricing and limits](https://developers.openai.com/codex/pricing)
- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans)

## Failure taxonomy and action policy

A timeout, cancellation, process exit, provider response, or verifier result is an observation or cause. The policy keeps four dimensions separate:

- **Observation/cause:** what was seen, such as a timeout, cancellation, crash, nonzero exit, auth response, network outage, or verifier result.
- **Component result:** the vocabulary owned by the component, such as Verification evidence states `passed`, `failed`, `not-run`, `inconclusive`, `infrastructure-error`, and `stale`, or a provider-reported quota error.
- **Lifecycle state:** where the Workbench operation is, such as `awaiting-human`, `waiting-for-input`, `reconciling`, `failed`, `cancelled`, `unknown`, or `quarantined`.
- **Failure classification:** the Workbench-owned interpretation that selects the permitted next action. `Unknown outcome` and `quarantined` are states of uncertainty, not known failures.

### Action crosswalk

| Observation or cause                                                               | Policy classification                                  | Component result or lifecycle state       | Automatic action                            | Permitted human path                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| Durable evidence proves no provider/tool dispatch occurred                         | `pre-dispatch-failure`                                 | Attempt failed; provider turns `0`        | At most one coordinator retry               | Inspect; further attempt requires explicit approval                              |
| Mandatory Verifier fails on the Candidate                                          | `candidate-failure`                                    | Verifier `failed`; `awaiting-human`       | Preserve evidence; no repair                | Inspect and explicitly start a fresh repair attempt or close                     |
| Base and Candidate fail identically                                                | `pre-existing-failure`                                 | Verifier `failed`; `awaiting-human`       | No repair                                   | Retain non-passing evidence; use a permitted #166 Verification exception or stop |
| Bounded repeats disagree or the Verifier cannot support a verdict                  | `verification-uncertain`                               | Verifier `inconclusive`; `awaiting-human` | No automatic rerun or repair                | Request a bounded fresh attempt with a reason, then escalate                     |
| Approved service, environment, or network is unavailable before dispatch           | `infrastructure-error`                                 | Attempt `failed`; `awaiting-human`        | The one proven pre-dispatch retry may apply | Inspect environment and explicitly retry or close                                |
| Infrastructure failure or lost response after dispatch                             | `dispatch-uncertain`                                   | `unknown`; `reconciling`                  | No retry                                    | Reconcile process, workspace, session, and external evidence                     |
| Requirement, Issue brief, or acceptance criterion is incomplete or contradictory   | `needs-information`                                    | Clarification `awaiting-human`            | Stop implementation activity                | Return to clarification and obtain a Developer decision                          |
| Required dependency, host, platform, backend, or service is unavailable by profile | `unsupported`                                          | Verifier `not-run`; `awaiting-human`      | Stop                                        | Change the approved environment/profile through a new binding or close           |
| Provider authentication expired or is unavailable                                  | `auth-required`                                        | Provider failure; `awaiting-human`        | Stop; no reauthentication loop              | Explicitly reauthenticate; changed identity/mode requires fresh approval         |
| Rate limit or usage exhaustion is reported                                         | `quota`                                                | Provider failure; `awaiting-human`        | Stop; no fallback                           | Inspect provider state or explicitly approve a changed binding                   |
| Capability, command, destination, or credential is denied by policy                | `policy-denied`                                        | Denied; `awaiting-human`                  | Stop; never bypass                          | Only a new approved capability profile can change the decision                   |
| Timeout, cancellation, or crash with proven termination and no external effect     | `known-termination-failure` or `explicit-cancellation` | `failed` or `cancelled`                   | Preserve the terminal result                | Developer may explicitly start a new attempt                                     |
| Timeout, cancellation, or crash without proof of termination or effect             | `effect-uncertain`                                     | `unknown`; `reconciling` or `quarantined` | No retry or cleanup assumption              | Reconcile or obtain human resolution                                             |
| Cleanup, workspace ownership, or side-effect state is uncertain                    | `ownership-uncertain`                                  | Workspace `quarantined`                   | Do not reuse or path-delete                 | Reconcile ownership and termination, then retain or discard                      |
| Same normalized failure recurs without meaningful candidate progress               | `repeated-failure`                                     | `awaiting-human`                          | No further automatic action                 | Review bounded history and approve a reason/budget or close                      |
| Publication branch or PR response is uncertain                                     | `publication-uncertainty`                              | Publication `unknown`; `reconciling`      | Follow #167; no new publication dispatch    | Reconcile the unchanged Publication intent                                       |

A known failed Verifier is not a provider or process retry. A provider failure does not automatically justify a code repair. A requirement gap does not justify invention. An Unknown outcome cannot be relabelled as a retry-safe failure.

### Human resolution does not rewrite evidence

Human resolution is an explicit Developer action recorded against the Escalation record. It records the actor, time, evidence reviewed, reconciliation result, unchanged binding and budget, and selected action—such as close, retain, cancel, or start a new attempt. It never marks an Unknown outcome as failed or successful without evidence, claims that an unobserved process stopped, turns non-passing Verification evidence into `passed`, or grants publication/merge authority. The original Unknown observation remains preserved even after reconciliation identifies the effect.

## Retry, repair, pause, and stop semantics

### First-release automation

The first profile has these rules:

- No automatic implementation repair.
- No automatic retry after a provider, tool, process, Git, verifier, or publication dispatch.
- At most one coordinator-level retry for a request when the durable record proves that no external dispatch occurred. This retry creates a fresh Execution attempt but has zero provider-turn usage.
- Pi automatic retries are explicitly disabled. Any future provider retry must be represented in the Workbench ledger and approved by a later profile.
- A manual execution retry or repair is an explicit Developer action. The action starts a fresh attempt, revalidates the binding, and records why the human chose it.
- A fresh attempt does not resume a process, replay a prompt, reuse an uncertain tool call, or continue a candidate's prior mutable workspace. The retained work and evidence may be referenced as bounded context.

### Clarification-specific behavior

Owned clarification is not coding repair. When a known pre-dispatch or provider failure ends a Clarification attempt, a Developer may explicitly start a fresh Clarification attempt and dedicated Pi conversation. An unchanged Context packet may be referenced only after preflight confirms its revision, provenance, coverage, provider, capability, and policy binding remains valid; the new attempt still has a new request/attempt identity and explicit approval.

When an accepted prompt is followed by process loss or a lost acknowledgement, the attempt is Unknown. The transcript and evidence may be inspected, but Pi history is not proof that the provider or broker tool completed. There is no automatic session resume, prompt replay, or external-session control. A new attempt needs a fresh binding and may receive only bounded prior evidence.

### Canonical lifecycle wording

“Pause” is UI shorthand, not a durable result. The persisted state must say what is waiting:

- `awaiting-human`: Workbench will dispatch nothing further until a Developer decides what to do.
- `waiting-for-input`: a supported Pi/broker dialog needs a Developer response under its existing policy.
- `reconciling`: Workbench is inspecting an uncertain process, workspace, session, or external side effect.
- `unknown`: the effect of a dispatch is not yet proven.
- `failed`: a known terminal failure was established.
- `cancelled`: explicit cancellation ended with termination/effect facts sufficient to classify it as cancellation.

Stop-turn, cancel-attempt, close-run, and detach-viewer remain distinct operations. A browser disconnect detaches the viewer. A cancel request does not claim that an in-flight child or external request stopped until evidence supports that claim. Closing a run preserves its evidence and prevents new attempts under that intent.

## Usage budget and accounting contract

### Budget owner and lifetime

A Usage budget belongs to the Operational run record, not to a browser connection, Pi process, provider session, workspace path, or mutable branch. It spans all fresh Execution attempts under that intent and survives controller restart, reconnect, and process replacement. The Pi conversation may report session usage, but it does not own or reset the Workbench budget.

Before every dispatch, Workbench persists the attempt identity, request identity, approval binding, planned operation, current ledger, and dispatch intent. Each new attempt consumes an attempt slot at that durable boundary, even when the provider/tool side effect is later proven absent. Provider-turn usage remains zero when no provider dispatch occurred. An uncertain post-dispatch operation is charged conservatively and remains Unknown until reconciliation; a restart cannot refund or reset it by assumption.

Duplicate Run requests are deduplicated by request identity. A duplicate acknowledgement or reconnect does not create another attempt. A new run ID is a new human-approved intent; it does not rewrite the old record or claim that the old budget was unused.

### Hard limits versus usage facts

The later profile must declare numeric ceilings before it enables coding or automatic recovery. This decision intentionally approves no unjustified “two repairs / one active run / two pending reviews” defaults. Aggregate review capacity is scheduler work outside #168.

The future profile must distinguish at least:

| Field family                         | Meaning                                                                                                                                    | Gate authority                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `resource_limit`                     | Hard Workbench/backend bound for per-attempt and aggregate wall time, process activity, output, storage, and supported execution resources | Workbench and #163 backend                            |
| `attempt_count` / `repair_count`     | Durable count of fresh attempts and repair actions under the Operational run record                                                        | Workbench coordinator                                 |
| `tool_dispatches` / `provider_turns` | Count of attempted/accepted tool or provider operations, including bounded descendants where the backend can prove them                    | Workbench/backend                                     |
| `provider_reported_usage`            | Input/output/cache/total tokens and provider/model cost returned by Pi/provider                                                            | Observation only                                      |
| `estimate`                           | Explicit estimate such as predicted tokens or monetary estimate                                                                            | Never sufficient for a quota claim                    |
| `unknown`                            | Remaining allowance, reset time, missing post-compaction context usage, or usage hidden by a lost response                                 | Blocks unattended admission; visible to the Developer |
| `evidence_reference`                 | Bounded hashes/byte counts and structured outcome references for diagnostics                                                               | Evidence provenance, not permission                   |

Provider-reported cost is not an invoice. A provider-reported token total is not a remaining subscription meter. Unknown remaining usage blocks unattended or automatic dispatch; an explicitly human-approved action may proceed only within known Workbench hard limits, with `unknown` shown and no promise that the provider will accept it. No API-key, paid-provider, model, or billing fallback is implicit.

## Approval and invalidation

A retry within the same approved work intent still requires an explicit Developer action and a fresh attempt identity. A material change makes the previous binding stale and requires a new approval binding. Material changes include:

- Issue revision, Context packet, provenance/coverage, Issue brief, acceptance criteria, scope, exclusions, or base revision;
- Verification recipe, Verifier, trusted harness, fixture, or evidence policy;
- execution backend/profile, platform, resource limit, filesystem, network, service, credential, capability, command, or destination;
- provider, model, authentication mode/identity, billing mode, data destination, Pi/protocol/adapter/policy version;
- publication target, branch, Candidate commit, or any subsequent publication identity;
- budget or limit increase, automatic retry setting, or a change from manual to automatic action.

A diagnostic summary, bounded log reference, unchanged Context packet, or human decision to attempt the same approved action does not itself broaden authority. A model, provider response, repository instruction, skill, verifier output, or previous attempt cannot approve any of the changes above.

## Repair context and repeated failure

A future repair context is limited to:

- the approved Issue brief, scope, exclusions, acceptance criteria, and relevant decision references;
- the failed Verifier/recipe identity and its trusted structured result;
- bounded sanitized diagnostics, output hashes/byte counts, and the relevant environment/profile identity;
- the current candidate/base identity and changed-file or artifact references;
- prior-attempt classifications, bounded summaries, ledger usage, remaining hard limits, and approval-binding digest;
- the one human decision the repair must answer.

It does not silently include an unbounded transcript, unrelated repository history, secrets, provider credentials, or unapproved instructions. The repair may address the diagnosed candidate behavior within the unchanged scope; it may not weaken a Verifier, change the Issue brief, add a command, switch a provider, or publish.

A Failure signature is a bounded normalized identity made from the relevant Verifier/recipe, classification, normalized diagnostic or stable location where available, environment identity, and candidate/base context. A repeated signature with no meaningful candidate or evidence progress transitions to `awaiting-human` on the first repeat. The Operational run record stores one Escalation record per signature per attempt and references earlier evidence instead of duplicating raw output. There is no first-release notification service; the event stream and visible run state are the notification boundary.

A Developer who deliberately starts another attempt after a repeated signature must see the prior evidence, the reason for continuing, and the remaining budget. The approval cannot make a repeated failure disappear or convert it into a pass.

## Escalation and Work Checkpoints

Workbench records a bounded Escalation record when it reaches `awaiting-human`, `unknown`, `reconciling`, budget exhaustion, repeated failure, unsupported environment, authentication failure, quota failure, policy denial, or cleanup quarantine. The record contains:

- `run_id`, `attempt_id`, `request_id`, controller/fencing identity, and event cursor;
- exact failure classification, cause/observation, last trusted lifecycle event, and reconciliation status;
- host/issue/context/recipe/provider/profile/binding digests without secrets or private content beyond the approved references;
- Candidate/base/workspace/session/evidence references and retention/quarantine state;
- hard limits and consumed, remaining, estimated, observed, or unknown usage fields;
- permitted actions, prohibited actions, approval invalidations, and one next human decision;
- bounded diagnostic references, hashes, byte counts, redaction status, and provenance.

The Escalation record is not a Pi transcript, a Work Checkpoint, or proof that a process stopped. #122's **Save Work Checkpoint** remains an explicit Developer action. When selected, it may include reviewed repo/issue/commit/workspace references and known validation evidence, but it does not resume a process, export a hidden session, reset a budget, or authorize a retry. #133/#164 retain Pi conversation history and cursor semantics separately.

## Executable-policy fixture matrix

Implementation must use fake providers, runners/backends, verifiers, clocks, stores, process handles, and publication adapters. It must not consume a real subscription or run an unapproved host command.

| Fixture                                                          | Required result                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Request fails before durable dispatch intent                     | One proven coordinator retry at most; no provider usage; further retry requires human action                 |
| Duplicate Run request or reconnect replay                        | Same request/attempt identity is returned; no second dispatch                                                |
| Prompt accepted but acknowledgement is lost                      | `unknown`; no prompt replay; reconciliation required                                                         |
| `agent_end` followed by Pi retry/compaction/queue                | Not settled until `agent_settled` and continuation state are reconciled                                      |
| Pi automatic retry setting is enabled by default                 | Adapter rejects/overrides it for v1; unaccounted retry cannot occur                                          |
| Provider reports input/output/cache/total usage and cost         | Store as provider-reported observation, not remaining quota                                                  |
| Usage fields disappear after compaction                          | Mark unavailable/unknown; never infer zero usage or reset budget                                             |
| Provider auth failure                                            | `auth-required`; no fallback or automatic reauthentication loop                                              |
| Provider 429/5xx transient failure                               | Only the proven pre-dispatch rule may retry; terminal quota text stops; post-dispatch ambiguity is Unknown   |
| Remaining provider allowance is unavailable                      | Block unattended action; explicit human action may proceed only within local hard limits and visible Unknown |
| Deterministic Candidate Verifier failure                         | Preserve `failed` evidence; no automatic repair                                                              |
| Base and Candidate fail identically                              | Preserve pre-existing non-passing evidence; no manufactured pass                                             |
| Bounded repeated Verifier results disagree                       | `inconclusive`/`flaky`; bounded human-directed rerun only                                                    |
| Same failure signature repeats without progress                  | `awaiting-human`; one bounded escalation event; no loop                                                      |
| Cancellation during a tool                                       | `cancelled` only with termination/effect proof; otherwise Unknown                                            |
| Child process survives controller loss                           | Reconciliation/quarantine; no adoption or replay without proof and fencing                                   |
| Restart near an attempt or wall-time boundary                    | Ledger and limits survive; no reset or double charge                                                         |
| Candidate, base, recipe, capability, provider, or budget changes | Approval/evidence becomes stale; new binding required                                                        |
| Stale controller or lease submits retry/cancel/cleanup           | Fencing rejects the mutation                                                                                 |
| Output cap or malformed event is reached                         | Bounded diagnostic plus typed inconclusive/protocol failure; no fabricated completion                        |
| Cleanup cannot prove ownership or termination                    | Retain/quarantine; never path-delete or reuse                                                                |
| Uncertain branch/PR publication                                  | Follow #167 reconciliation; no new publication dispatch                                                      |
| Work Checkpoint is saved                                         | Explicit, bounded handoff; no process/session/budget mutation                                                |

## Explicitly unsupported in this decision

The following remain outside the first policy/profile or require later decisions:

- automatic implementation repair or automatic post-dispatch retry;
- numeric coding repair ceilings, provider quota reservation, exact monetary enforcement, or a universal “remaining credits” meter;
- coding execution before #163 validates an enforceable Execution backend and profile;
- silent provider/model/auth/billing/destination fallback;
- automatic Pi session resume, prompt replay, or control of attached Developer-owned sessions;
- arbitrary project/user extensions, generic shell, project commands, Git, publication, deployment, or workflow authority in Owned clarification;
- aggregate pending-review scheduling and notification service behavior;
- claims that a worktree, RPC child, process group, timeout, draft PR, or provider cost field is a security, completion, or quota boundary;
- guarantees across a compromised host, provider, Workbench installation, GitHub, or external integration.

## Ownership and implementation boundary

| Responsibility                                                                                      | Owner                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Clarification lifecycle, attempt approval, policy classification, retry decision, and budget ledger | #160 / future coordinator, constrained by this decision      |
| Pi transport, accepted/settled events, session history, and managed conversation                    | #133 / #164                                                  |
| Durable run/attempt state, leases, fencing, reconciliation, retention, and Unknown outcomes         | #165                                                         |
| Isolation and enforceable process/resource/filesystem/network boundary                              | #163                                                         |
| Issue brief, Context packet, readiness, and command/verifier distinction                            | #162 / #135                                                  |
| Verification recipe, evidence, candidate invalidation, and exceptions                               | #166                                                         |
| Draft publication and remote side-effect reconciliation                                             | #167                                                         |
| Human Work Checkpoints                                                                              | #122                                                         |
| Human inspection/intervention presentation                                                          | #169                                                         |
| Existing Review/Agent maintenance behavior                                                          | Existing runner contracts; not silently reclassified by #168 |

This decision creates no duplicate session store, worktree manager, verifier, scheduler, provider quota service, notification service, or execution backend.

## Sources

- [Issue #168](https://github.com/Quick-Release/workbench/issues/168), including its explicit rejection of unapproved `2 / 1 / 2` limits and its request for synthetic failure-policy scenarios.
- [Issue #164 Resolution](https://github.com/Quick-Release/workbench/issues/164#issuecomment-5662436923) and [ADR 0018](../adr/0018-pi-managed-session-transport-and-capability-boundary.md).
- [Issue #165 Resolution](https://github.com/Quick-Release/workbench/issues/165#issuecomment-5663200374) and [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md).
- [Issue #166 Resolution](https://github.com/Quick-Release/workbench/issues/166#issuecomment-5672579648) and [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md).
- [Issue #167 Resolution](https://github.com/Quick-Release/workbench/issues/167#issuecomment-5677790642) and [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md).
- [Factory 06 research](./factory-pi-runtime-and-managed-sessions.md), especially its usage/error mapping and fake JSONL transport matrix.
- [Factory 08 research](./factory-independent-verification.md), especially its repair invalidation and evidence contract.
- [Factory 09 research](./factory-safe-draft-pr-delivery.md), especially its publication uncertainty and review boundary.
- Current runner paths: [`scripts/seam/review/review-runner.mjs`](../../scripts/seam/review/review-runner.mjs), [`scripts/seam/review/opencode-engine.mjs`](../../scripts/seam/review/opencode-engine.mjs), [`scripts/seam/routes/review-api.mjs`](../../scripts/seam/routes/review-api.mjs), [`src/schema.ts`](../../src/schema.ts), and [`scripts/sync/sessions.mjs`](../../scripts/sync/sessions.mjs).
- [Pinned Pi RPC documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md), [SDK documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md), [provider documentation](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/providers.md), [Codex provider source](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-codex-responses.ts), and [Codex OAuth source](https://raw.githubusercontent.com/earendil-works/pi/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/auth/oauth/openai-codex.ts).
- [OpenAI Codex pricing and limits](https://developers.openai.com/codex/pricing), [Codex App Server](https://developers.openai.com/codex/app-server), and [OpenAI credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans).

## Validation boundary

The documentation branch passed the repository's normal `pnpm check` and `pnpm test` gates on 2026-09-15. `pnpm check` completed formatting, lint, and TypeScript validation successfully. `pnpm test` passed 555 Vitest tests and 442 Node tests. Sync reported the repository's three pre-existing ADR linkage warnings for ADRs 0001, 0003, and 0004; dependency sourcemap and simulated telemetry-delivery warnings were non-failing.

These commands validate repository documentation and fixtures; they do not constitute evidence that a provider, coding run, retry loop, execution backend, or host repository is safe. No provider session, coding attempt, repair loop, backend, publication, or host-project execution was run.
