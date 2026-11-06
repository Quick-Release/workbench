# Issue-agent runs own their worktree and branch; retained work leaves only by explicit discard

Status: accepted

Work item: GH-116

ADR 0010's issue agent named its worktree `<tmp>/workbench-issue-<n>` and its branch `agent/issue-<n>`, and every run began by force-removing that path and resetting that branch. Different host repos with the same issue number collided on the path, and a second Workbench process could destroy an active run's uncommitted work, because the only guard (the in-memory run registry) does not cross processes. Each Agent run now owns a uniquely named worktree and branch, a run's own cleanup touches nothing else, and a failed or cancelled run's worktree stays until the Developer explicitly discards it.

## Decision

- **A branch per run.** Each run gets a run id created at start (a timestamp plus a random suffix) and its own branch, `agent/issue-<n>-<run-id>`. The name is flat because a nested `agent/issue-<n>/<run-id>` would collide with existing `agent/issue-<n>` refs. No branch is ever reset, and runs need no lock across processes to be correct. Two processes racing on the same issue produce two independent runs: wasteful, but nothing is destroyed. A retry opens its own draft PR saying `Fixes #<n>`. The human closes the drafts they don't want, which matches ADR 0022's one-branch-per-candidate posture. Push, `gh pr create --draft` and ADR 0011's merge gate are unchanged.
- **The path names the host repo and the run.** Worktrees live under a durable root for each user, `$XDG_STATE_HOME/workbench/worktrees/` (falling back to `~/.local/state/…`, overridable with `WORKBENCH_WORKTREE_ROOT`). The path is `<root>/<host-key>/issue-<n>-<run-id>`, where `<host-key>` is a digest of the host repo's real Git common directory. The temporary directory was rejected because it is often wiped at reboot, which would silently break retention. A path inside `.git` was rejected because it hides data in the host repo's admin directory.
- **Git enforces ownership while a run is active.** The run creates its worktree with `git worktree add --lock`, giving a reason that records the run id, PID and hostname. Git won't remove a locked worktree with a single `--force`, so another process cannot delete an active run. A run removes and unlocks only the path and branch it created. No step ever force-removes a path the current run did not create.
- **Retention lasts until an explicit discard.** Success cleans up immediately, as before. A failed or cancelled run keeps its worktree and local branch, with no age limit or count cap, and a retry never touches it. A Discard request names only `{ engine, runId }`. The server rebuilds the path from the root, host key and run id, never from a path the client sends. It acts only when `git worktree list` shows that path for this host repo on the exact expected branch, and then removes that worktree and local branch. Remote branches are never deleted.
- **A lock whose owner is gone means the worktree is quarantined.** Discard is refused while a lock's PID is alive on this host. If the PID is dead, or the lock came from another host, the worktree is a Quarantined workspace, and discarding it takes a second explicit confirmation before it is unlocked and removed. A matching PID is a reason to refuse; it never proves ownership.
- **Worktrees from the old naming scheme are left alone.** Workbench never infers ownership from the old `workbench-issue-<n>` and `agent/issue-<n>` names; the Developer removes them by hand.

## Considered options

- **Keep the fixed branch and add a lock across processes.** Rejected. Retrying after a published run already fails: the reset branch's push is rejected as non-fast-forward. Fixing that would need a force-push, or deleting a remote branch that may be an open PR's head.
- **Adopt ADR 0020's `run_id` and lease now.** Rejected for this fix. No durable run store exists, and ADR 0020 authorizes none. The local run id is a stand-in: the durable-ownership work (#165, #201, #204) adopts it as the attempt id and replaces the evidence held in the Git lock with leases and fencing.
- **Automatic retention (age limit, keeping only the newest run).** Rejected. Deleting evidence on a timer or a count is the silent loss of evidence this ADR removes.

## Consequences

- ADR 0010's "failed runs keep their worktree; a retry starts from a clean one" still holds. A clean start now comes from a new worktree, not from deleting the old one.
- An issue can collect several retained worktrees and several draft PRs. Retained runs are listed for the host repo so disk use is visible.
- This remains ADR 0019's reduced-trust posture: a host process running in a worktree. A run-owned worktree fixes who owns the checkout; it does not isolate the run.
