# Pi RPC managed sessions for Owned clarification

Status: accepted

Work item: GH-164

Factory 06 (#164) evaluated an embedded Pi SDK session against a `pi --mode rpc` subprocess for the shared conversation boundary proposed by #133. The first Workbench integration is a versioned `pi-managed/v1` RPC adapter for **Owned clarification**, not a coding run, Review run, Agent run, or second chat system. RPC is selected because it gives the coordinator an independently supervised process and a language-neutral event boundary; this is not an OS-level sandbox and does not satisfy the future coding isolation contract owned by #163.

## Decision

One clarification attempt creates one dedicated Pi conversation, one managed runtime, and one session-file writer. Workbench owns the attempt, approval binding, immutable capability profile, Context/data-flow policy, controller lease, and lifecycle. Pi owns conversation entries/tree state and its native event source. The adapter is the only writer for its managed session.

The initial managed profile supports explicit prompt, steer, queued follow-up, clear-queue, stop-turn, terminate-runtime, snapshot/event observation, history, and live reconnect. It distinguishes acceptance from settlement: a successful RPC command response or assistant text is not completion; `agent_settled` plus final reconciliation is. It uses a versioned Workbench event envelope and cursor, preserves unknown events as evidence, and never blindly replays a request whose acceptance is uncertain.

The first profile has no generic code tools, project commands, Git, hooks, tests, tracker writes, deployment, arbitrary extensions, or unrestricted network access. Only reviewed broker capabilities and typed extension dialogs are eligible. Provider, model, authentication mode, destination, Pi revision, protocol, capabilities, policy, context, issue revision, nonce, and expiry are visible and approval-bound. Material changes require a new attempt and approval. Publication remains a separate exact-diff approval.

Browser disconnect detaches the viewer. Process loss becomes an explicit unknown state when reconciliation cannot establish the outcome; no automatic runtime restart or prompt replay is promised. Attached external sessions are observation-only and are not part of the first managed control profile. Durable cross-process ownership, leases, retention, supervision, and crash recovery belong to #165.

## Consequences

- #133 remains the single shared chat/session boundary; it gains an explicit managed-session capability profile rather than a competing service.
- Existing Review run, Agent run, and Session capture contracts remain distinct and unchanged.
- The later implementation must pin and reject unsupported Pi/adapter/protocol versions, use a dedicated resource set, and pass the fake JSONL transport matrix recorded in [`factory-pi-runtime-and-managed-sessions.md`](../research/factory-pi-runtime-and-managed-sessions.md).
- The RPC boundary reduces same-process coupling but does not make untrusted extensions or code execution safe. A coding profile cannot inherit this decision and must satisfy #163 independently.
- `resume` and `fork` remain explicit future capabilities; persisted history is not proof of recoverable unfinished side effects.

## Rejected options

- First using the SDK, because this slice benefits from an independently supervised child and avoids direct coordinator coupling to Pi’s runtime and extension state.
- Reusing Review run or Agent run contracts, because one-shot output streams and in-memory history do not model conversation ownership, cursors, or accepted-versus-settled lifecycle.
- Allowing attached-session control, automatic project/user extension discovery, broad tools, automatic process recovery, or silent provider fallback, because none has the required ownership or authority guarantee.
