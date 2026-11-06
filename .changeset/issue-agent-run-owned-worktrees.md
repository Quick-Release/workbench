---
"@quick-release/workbench": minor
---

Issue agent: every run owns its worktree and branch (GH-116, ADR 0027). A run now works on `agent/issue-<n>-<run-id>` in `<root>/<host-key>/issue-<n>-<run-id>`, where the root is `$WORKBENCH_WORKTREE_ROOT`, else `$XDG_STATE_HOME/workbench/worktrees`, else `~/.local/state/workbench/worktrees`. The worktree is Git-locked while the run is active, so a second Workbench process or another host repo with the same issue number can no longer remove or reset it. Runs no longer force-remove a worktree or reset a branch before they start. A failed or cancelled run keeps its worktree and local branch until you discard it from the issue-agent panel. That panel lists the kept worktrees. A quarantined worktree, one whose lock outlived its process, asks for a second confirmation before it is discarded. Discarding never deletes the pushed remote branch. A retry opens its own draft PR.

Worktrees and branches from the old scheme are never touched. Remove them by hand: `git worktree list` shows any `<tmp>/workbench-issue-<n>` entries. Run `git worktree remove <path>` for each one, then `git branch -D agent/issue-<n>`, once you no longer need their contents.
