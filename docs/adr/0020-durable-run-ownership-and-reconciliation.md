# Durable run ownership and reconciliation

Status: accepted

Work item: GH-165

Workbench needs operational records that survive a controller restart without claiming that a process, provider request, Git operation, or publication survived. Use distinct durable run and attempt identities, a fenced controller lease, a sequenced operational event ledger, and explicit reconciliation. The first posture is a foreground controller with host-repository-scoped local SQLite metadata; optional OS supervision may be evaluated later, while an external controller and default always-on daemon are out of scope.

## Decision

A `run_id` represents one approved work intent. Each dispatch receives a new `attempt_id`; reconnect retries use a deduplicated `request_id`. Workspace and Pi session identities remain owned by #163 and #133/#164 respectively. Browser viewers detach without becoming owners or cancelling by disappearance.

Run and attempt lifecycle states distinguish active, reconciling, awaiting-human, terminal, unknown, and quarantined outcomes. Dispatch intent is durable before side effects. Unknown post-dispatch outcomes are reconciled or presented for human resolution; they are never blindly replayed. Every mutating operation requires a controller lease, opaque token, fencing generation, and owner match. Lease expiry permits reconciliation but does not prove process death or authorize adoption.

Operational events are bounded, sequenced, and persisted before viewer publication. Snapshots plus cursors support reconnect; expired cursors report a gap. Full Pi transcripts, checkpoints, Telemetry, and unbounded output remain in their existing ownership boundaries.

## Consequences

- SQLite transactions and WAL coordinate local metadata but do not replace logical leases, fencing, or external side-effect reconciliation.
- The contract does not promise automatic attempt resumption, exactly-once tool dispatch, or success from subprocess exit.
- #116, #122, #133/#164, and #163 retain their respective worktree, checkpoint, Pi session, and execution-workspace ownership.
- #166–#169 remain responsible for verification, delivery, failure policy, and intervention.
- No store, daemon, supervisor, provider integration, automatic replay, or recovery pilot is authorized by this ADR.
