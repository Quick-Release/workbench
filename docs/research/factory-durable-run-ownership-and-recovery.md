# Factory 07 — Durable run ownership and crash recovery

Status: accepted research/design decision

Work item: [GH-165](https://github.com/Quick-Release/workbench/issues/165)

Related decisions: [GH-116](https://github.com/Quick-Release/workbench/issues/116), [GH-122](https://github.com/Quick-Release/workbench/issues/122), [GH-133](https://github.com/Quick-Release/workbench/issues/133), [GH-160](https://github.com/Quick-Release/workbench/issues/160), [GH-163](https://github.com/Quick-Release/workbench/issues/163), [GH-164](https://github.com/Quick-Release/workbench/issues/164), [GH-166](https://github.com/Quick-Release/workbench/issues/166), [GH-167](https://github.com/Quick-Release/workbench/issues/167), [GH-168](https://github.com/Quick-Release/workbench/issues/168), [GH-169](https://github.com/Quick-Release/workbench/issues/169)

## Decision in brief

Workbench will define a durable operational ownership and reconciliation contract, but this issue does not implement a store, daemon, supervisor, recovery worker, or automatic replay. The first posture is a foreground Workbench controller backed by a host-repository-scoped local operational store. An explicitly enabled OS supervisor may be evaluated later; an external controller is outside the local-first product.

The contract applies to Workbench-owned Agent runs, Review runs, and future coding attempts without renaming or merging those concepts. It does not own Pi transcript/session history (#133/#164), portable Work Checkpoints (#122), Session capture, attached Developer-owned sessions, or GitHub verification/publication (#166/#167).

A durable record is not a claim that a process survived, a tool had no side effect, or a change is correct. Workbench distinguishes a stable **run intent** from each **execution attempt**. Browser viewers can detach without cancelling. Controller loss, process loss, reboot, and lost responses trigger reconciliation. No prompt, tool, provider, Git, or publication operation is replayed blindly.

## Evidence boundary

The current main revision during research was [`00b2f81`](https://github.com/Quick-Release/workbench/commit/00b2f81a7e095316754691604c64b5148541482a). No tracked files were modified during fact finding. No real agent, provider, host project command, infrastructure action, client repository, GitHub publication, exploit/security test, or pilot was run.

### Current Workbench behavior

The issue’s original links refer to paths and a baseline that predate the script organization refactor. The current files are `scripts/seam/routes/review-api.mjs`, `scripts/seam/review/review-runner.mjs`, and `scripts/seam/review/opencode-engine.mjs`; the underlying behavior described by the issue remains present.

The current Vite review plugin creates one in-memory run registry and one in-memory finished-run history per server process. The registry reserves one engine while target resolution is pending, binds the live run, releases it when the event stream ends, and cancels all active entries when the HTTP server closes. It cannot coordinate two Workbench processes and has no durable owner, lease, fencing generation, heartbeat, startup scan, or reconciliation.

The current run request contains an engine, a PR or issue target, and an optional model. The schema requires exactly one target but does not enforce all engine/target pairings. The browser starts one SSE request and parses its event stream once. There are no durable run IDs in that protocol, sequence numbers, cursors, snapshots, replay endpoint, or durable event log.

The runner launches a sequential plan with detached child process groups, inherited environment plus step overrides, per-step timeouts, a shared output cap, and SIGTERM-to-SIGKILL escalation. Node’s process primitives and the current process-group strategy are useful normal-cancellation mechanisms, but they do not prove descendant termination, durable process ownership, or whether a side effect happened before a crash.

A response close currently invokes the run’s cancel function. The server then continues draining the stream so the child can exit and the engine slot can be released. A server crash has no corresponding cleanup or startup-reconciliation path; a detached child may outlive the controller without a durable record capable of classifying it.

Finished history is written only in the stream’s `finally` block. It contains a process-local integer, target, outcome, duration, concatenated output, truncation, and timeout message. It disappears on server restart and its IDs restart at one. A rerun is a fresh start by target, not a resume.

The current Issue-agent plan force-removes a deterministic temporary path and branch based on issue number, then creates a worktree, runs OpenCode, commits, pushes, and creates a draft PR. #116 records the cross-repository collision and cross-process force-removal defect. The current plan’s tool permissions do not constitute OS isolation, and its inherited environment is not a durable ownership mechanism. #163 separately defines the future Execution workspace and backend boundary; this decision does not replace #116 or #163.

The current explicit cancel schema accepts review engines but not `opencode`, even though the UI can send an OpenCode cancellation request. This is an existing implementation defect, not an invitation to silently broaden #165’s research scope. Any future repair must preserve the typed cancellation and reconciliation model.

### Existing stores are not operational ownership

- The generated sync snapshot contains planning/tracker state, not live run ownership.
- The ZCode SQLite copy used by session aggregation is read-only usage evidence and must not become an operational run store.
- D1/R2 Telemetry, submissions, and opt-in Session capture have different consent and ownership boundaries.
- #122’s portable checkpoint is a Developer-approved handoff note with stale-state warnings; it is not a process lease or a live attempt record.
- #133/#164 own Pi conversation entries, native session cursors, managed-session writer authority, and Pi-specific history/reconnect/resume semantics.

## Domain model and lifetimes

### Identities

The contract keeps these identifiers distinct:

| Identity       | Meaning                                                     | Owner                            |
| -------------- | ----------------------------------------------------------- | -------------------------------- |
| `run_id`       | One approved Workbench work intent                          | Workbench operational controller |
| `attempt_id`   | One execution dispatch under a run                          | Workbench/backend boundary       |
| `request_id`   | One client submission used to deduplicate reconnect retries | Execution seam/controller        |
| `workspace_id` | One isolated Execution workspace                            | #163 backend/workspace boundary  |
| `session_id`   | One Pi conversation/runtime identity                        | #133/#164 session boundary       |

A retry creates a new attempt, not a new run intent and not a resumed prior attempt. An attempt never changes its identity after dispatch.

### Lifetimes

| Lifetime                | Disconnect or loss behavior                                                            |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Browser viewer          | Detaches; it is not the owner and does not cancel by disappearance                     |
| Controller process      | Holds a lease while alive; restart requires lease expiry and reconciliation            |
| Run intent              | Survives controller restart in the operational store                                   |
| Execution attempt       | Ends terminally or becomes unknown; it is never silently resumed                       |
| Pi conversation/runtime | Follows #164’s managed/attached session contract and remains separate from run records |
| Execution workspace     | Follows #163’s retained/quarantined/cleanup contract; uncertain work is not reused     |

A durable record means the controller remembers the obligation and evidence. It does not mean that the child process, provider request, Git operation, or remote publication survived.

## State contract

The state names below are the design vocabulary, not an implementation schema. A later implementation must preserve their distinctions and record transitions as events.

### Run lifecycle

```text
accepted → active → reconciling → awaiting-human → closed
```

- `accepted`: an approved work intent and capability/policy binding exist.
- `active`: an attempt is owned and operating or being prepared.
- `reconciling`: the previous owner, process, workspace, or side-effect outcome needs inspection.
- `awaiting-human`: automated reconciliation cannot safely choose the next action.
- `closed`: no further attempt is authorized by this run record.

Run lifecycle and result are separate. A run can close as cancelled, failed, or unresolved; `completed` on an attempt is not a verified successful change.

### Attempt lifecycle

```text
prepared → running → cancelling → cancelled
                       ├────────→ completed
                       ├────────→ failed
                       └────────→ unknown → quarantined
```

- `prepared`: an attempt identity, policy, workspace/session references, and dispatch plan are durable.
- `running`: the controller has dispatched the attempt and has an ownership/reconciliation handle.
- `cancelling`: cooperative stop or force termination is in progress.
- `cancelled`: termination is established and the attempt will not continue.
- `completed`: the attempt ended normally according to its runtime; downstream verification is still separate.
- `failed`: the attempt ended with an established failure before an unknown side-effect boundary.
- `unknown`: Workbench cannot prove process or external-effect outcome.
- `quarantined`: unknown resources or evidence cannot be safely adopted, cleaned, or reused.

Pi-specific `stop turn`, `terminate runtime`, `resume`, and `fork` remain #164 operations. #165 records their operational consequences but does not redefine Pi protocol states.

## Durable records and events

A run record contains stable run/request identity, canonical host-repository identity, target, run kind, approval/context/policy/capability/contract digests, current lifecycle/result state, current attempt reference, retention state, and human-resolution state.

An attempt record contains its run and attempt identities, backend/session/workspace references, pinned base revision where applicable, opaque process/backend handle, controller lease and fencing generation, dispatch/cancellation timestamps, terminal/unknown outcome, and bounded evidence references.

An operational event contains a per-run sequence, event ID, run/attempt identity, actor, lease generation, event time and record time, event type, causal/request correlation, and bounded payload or digest. Provider credentials, raw secrets, unbounded stdout, and duplicate Pi transcripts are not operational event payloads.

The controller persists a lifecycle or dispatch event before publishing it to a viewer. Viewer delivery is an observation channel, not the source of truth. Reconnect reads a snapshot plus events after a cursor. If the cursor has expired, Workbench reports a gap and returns a fresh snapshot; it does not fabricate a complete history. Slow or disconnected viewers do not create unbounded in-memory buffers.

## Controller leases and fencing

One controller lease is the singular authority to mutate one run and submit its authorized lifecycle operations. A lease binds:

- run and current attempt identity;
- controller instance identity;
- opaque lease token;
- monotonically increasing fencing generation;
- issued and expiry times;
- heartbeat and release observations.

Every mutating operation checks the run, attempt, token, generation, and lease validity in one durable transaction. A stale controller receives a typed denial and cannot write a late completion, cancellation, cleanup result, or retry decision. A viewer has no lease.

Heartbeat and expiry intervals belong to the execution profile and must be bounded. Expiry makes a run eligible for reconciliation; it does not prove that the old process is dead or that a workspace can be adopted. SQLite’s single-writer locking coordinates metadata writes but is not itself a logical run lease or stale-owner fence.

## Side-effect and crash-point contract

The controller records dispatch intent before invoking a process, provider, Git operation, or publication adapter. After dispatch, a missing acknowledgement is potentially side-effecting.

| Crash point                                   | Required result                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Before durable dispatch intent                | Attempt was not dispatched; a new attempt may be prepared                   |
| After dispatch intent, before acknowledgement | Outcome is unknown; reconcile before retry                                  |
| After process/backend handle is durable       | Inspect the backend; classify running, exited, or unknown                   |
| After process exit, before result persistence | Reconcile from process/backend evidence; otherwise unknown                  |
| During provider, Git, push, or PR operation   | Read back external state; never blindly repeat                              |
| During workspace cleanup                      | Retain or quarantine; never path-delete or reuse speculatively              |
| After terminal attempt event is durable       | Attempt is terminal; verification/publication still decide downstream truth |

Automatic retry is limited to operations whose non-dispatch or idempotence is proven: durable metadata retry before commit, read-only target resolution, lease acquisition after reconciliation, reconciliation reads, and cleanup after verified termination and ownership. An unknown prompt, provider request, package script, Git commit/push, PR request, workspace adoption, or publication outcome requires reconciliation or explicit human resolution.

## Reconciliation and intervention

After a controller restart, expired lease, process loss, or viewer reconnect, reconciliation:

1. loads active, reconciling, and uncertain records;
2. expires the prior lease and acquires a new fencing generation only if allowed;
3. inspects the process/backend handle, workspace, revision, event ledger, and relevant Git/GitHub state;
4. classifies the attempt as not-dispatched, running, exited, interrupted, side-effect-unknown, workspace-retained, cleanup-failed, quarantined, or awaiting-human;
5. persists the classification and evidence before exposing it;
6. creates a fresh attempt only when the retry is authorized and safe.

A live process is adoptable only when the backend provides a verifiable handle and fencing support. Otherwise it becomes unknown/quarantined; Workbench does not kill or adopt it speculatively. A clean process exit may establish an attempt result, but it cannot establish verification, publication, or review success.

Human resolution may inspect snapshots, events, retained work, and bounded artifacts; reconcile again; retry as a new attempt; cancel/close the run; retain evidence; or discard a workspace after termination and ownership are proven. It may not manufacture success, resume an unknown attempt, reuse a stale workspace, or bypass #166/#167 evidence gates. If later delivery supports linking an existing commit/PR, that link must be evidence-bearing and separately authorized.

## Storage, migration, and retention posture

The first operational store is host-repository-scoped local state outside the installed package and working tree, keyed by canonical repository identity rather than path or issue number. It is permission-restricted to the Developer and contains no raw provider credentials or unrelated Pi/session content.

SQLite WAL is acceptable for same-host local metadata only. Its documented constraints are part of the contract:

- there is one writer at a time;
- WAL does not support network filesystems;
- `-wal` and `-shm` companion files must be retained together;
- long-lived readers can delay checkpoints and grow the WAL;
- `SQLITE_BUSY`, disk-full, corruption, and broken storage must remain typed failures;
- backups use SQLite-safe mechanisms, not an active database-file copy;
- schema migrations are versioned and transactional before the controller accepts ownership.

Operational retention is separate from checkpoint, Pi session, Telemetry, and artifact retention. Bounded event/output data may be compacted only after a valid snapshot/cursor boundary exists. Active, unknown, quarantined, and explicitly retained work is protected. Deletion is explicit, ownership-checked, and recorded; identifiers are not silently reused.

## Supervision boundary

The first contract does not create an always-on service. A foreground controller records shutdown, stops accepting new work, persists its state, releases or expires its lease, and reconciles active attempts. A crash or reboot leaves durable records for reconciliation; it does not trigger replay.

An optional systemd-style deployment may later supervise the controller and process group. `Restart=on-failure`, cgroup termination, watchdogs, and stop timeouts improve process availability and cleanup but do not establish Workbench ownership, determine whether an external side effect happened, or make a restarted controller a resumed attempt. The same durable reconciliation contract applies with or without a supervisor.

## Failure-injection evidence gate

Before implementation is considered reliable, disposable fixtures must cover:

- duplicate start requests and reconnect retries;
- two controllers racing for one run;
- expired leases, fencing generations, stale writes, and late completions;
- crashes before and after every dispatch intent and external-effect boundary;
- lost acknowledgements, missing final events, partial output, and cursor gaps;
- children and descendants that ignore termination;
- clean shutdown, hard controller kill, process restart, and machine-reboot simulation;
- disk-full, lock contention, missing WAL, corruption, safe backup/restore, and migration failure;
- push/PR timeouts after remote state may have changed;
- workspace cleanup races, retained evidence, quarantine, and explicit discard;
- no duplicate prompt/tool execution, no false completion, and no path-only deletion.

The matrix uses fake processes, fake stores, synthetic secrets, disposable Git repositories, and mocked remote read-backs. It does not use real provider credentials, client repositories, production services, or exploit testing.

## Primary sources

### SQLite

- [WAL overview and concurrency](https://sqlite.org/wal.html)
- [WAL file and companion state](https://sqlite.org/wal.html#the_wal_file)
- [avoiding excessively large WAL files](https://sqlite.org/wal.html#avoiding_excessively_large_wal_files)
- [`wal_checkpoint`](https://sqlite.org/pragma.html#pragma_wal_checkpoint)
- [`synchronous`](https://sqlite.org/pragma.html#pragma_synchronous)
- [How To Corrupt An SQLite Database File](https://sqlite.org/howtocorrupt.html)

SQLite provides local transaction and locking primitives, not Workbench run ownership, fencing, or exactly-once side-effect semantics.

### Node process lifecycle

The inspected Node documentation revision is [`85c454a`](https://github.com/nodejs/node/tree/85c454ab2915b4768c830d40e7809a7a098e1057):

- [`child_process.spawn`](https://github.com/nodejs/node/blob/85c454ab2915b4768c830d40e7809a7a098e1057/doc/api/child_process.md#child_processspawncommand-args-options)
- [`subprocess.kill`](https://github.com/nodejs/node/blob/85c454ab2915b4768c830d40e7809a7a098e1057/doc/api/child_process.md#subprocesskillsignal)
- [`detached`](https://github.com/nodejs/node/blob/85c454ab2915b4768c830d40e7809a7a098e1057/doc/api/child_process.md#optionsdetached)
- [`process` exit and uncaught-exception events](https://github.com/nodejs/node/blob/85c454ab2915b4768c830d40e7809a7a098e1057/doc/api/process.md)

Signals, process groups, and `AbortSignal` do not prove descendant termination, rollback, or absence of external effects.

### systemd

The inspected systemd source/manual set is [`17d46d0`](https://github.com/systemd/systemd/tree/17d46d0442f3ce6921d963175731cf0ff5a8c50b), represented by the [systemd 261 service manual](https://www.freedesktop.org/software/systemd/man/261/systemd.service.html) and [kill manual](https://www.freedesktop.org/software/systemd/man/261/systemd.kill.html). Restart policies, cgroup termination, watchdogs, and stop hooks supervise processes; they do not understand Workbench run or publication state.

### Symphony

The inspected Symphony specification is [`e0ccc83`](https://github.com/openai/symphony/tree/e0ccc83720a42a600a53b61c5f8d3e518bebe1db). Its single-authority scheduling, claims, reconciliation, and tracker/filesystem-driven restart model are useful patterns. Its restart section does not restore retry timers or running sessions, and the specification does not provide durable run IDs, cross-process fencing, exactly-once dispatch, or proof that a crashed worker had no side effect. Workbench therefore reuses reconciliation ideas without adopting Symphony as a runtime or treating it as a durability guarantee.

## Rejected alternatives and boundaries

- **In-memory per-server state:** rejected because it cannot survive restart or coordinate controllers.
- **A shared Pi/session store:** rejected because #133/#164 own Pi conversation history and writer authority.
- **Using #122 checkpoints as live run records:** rejected because checkpoints are portable human-reviewed handoffs, not leases or process truth.
- **SQLite locking as ownership:** rejected because database locks do not fence stale logical owners or external effects.
- **Automatic replay/resume after restart:** rejected because unknown dispatches may have side effects.
- **Fresh Symphony-style redispatch as recovery:** rejected as a universal rule; Workbench must distinguish not-dispatched from unknown.
- **Always-on daemon by default:** rejected for the local-first product; optional OS supervision remains a later deployment choice.
- **External controller/cloud database:** rejected for the first local product and its credential/privacy boundary.
- **Automatic workspace cleanup/adoption:** rejected because uncertain resources and retained evidence require ownership proof.
- **Manual success marking:** rejected because verification, publication, and human review remain separate evidence gates.

## Responsibility table

| Responsibility                                                                           | Owner     |
| ---------------------------------------------------------------------------------------- | --------- |
| Existing issue-agent worktree identity defect                                            | #116      |
| Portable, human-approved checkpoints                                                     | #122      |
| Pi transcripts, managed session writer, Pi cursor/reconnect/resume semantics             | #133/#164 |
| Durable run/attempt records, leases, fencing, reconciliation, retention, deletion policy | #165      |
| Execution workspace/backend enforcement                                                  | #163      |
| Independent verification and revision-bound evidence                                     | #166      |
| Draft-PR delivery and human review                                                       | #167      |
| Failure taxonomy, repair limits, and budgets                                             | #168      |
| Inspection, intervention, and handoff UX                                                 | #169      |

No duplicate workflow state machine, session store, worktree manager, or external factory runtime is introduced.

This decision resolves #165 by defining the durable ownership and recovery contract. It authorizes documentation and later fixture evidence only—not a durable-store implementation, daemon, supervisor installation, provider use, automatic replay, host-repository run, GitHub publication, merge, deployment, or pilot.
