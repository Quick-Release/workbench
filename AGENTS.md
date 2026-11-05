# workbench

## Agent skills

### Issue tracker

GitHub Issues on `Quick-Release/workbench`, accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# Workbench — Agent Instructions

## Repository

Canonical repository:

`/data/code/getquick/internal/workbench`

This checkout is the canonical human-managed checkout.

## Mandatory isolated development

AI coding agents must not make implementation changes directly in the canonical checkout at:

`/data/code/getquick/internal/workbench`

All coding tasks must run in a dedicated Git worktree.

Agent worktrees are stored under:

`/data/agents/workspaces/<agent>/getquick/workbench/<task>`

Examples:

- Codex: `/data/agents/workspaces/codex/getquick/workbench/<task>`
- Claude: `/data/agents/workspaces/claude/getquick/workbench/<task>`
- Pi: `/data/agents/workspaces/pi/getquick/workbench/<task>`

A worktree the agent host creates for you also counts: T3 Code's
worktrees under `~/.t3/worktrees/workbench/` and Claude Code's `isolation: "worktree"`
subagents. In that case keep the host's path and still name the branch
`agent/<agent>/<task>`.

This layout and branch scheme take precedence over any global convention,
such as `claude/<task>` branches.

Branches created for agent work must follow:

`agent/<agent>/<task>`

Examples:

- `agent/codex/fix-auth`
- `agent/claude/refactor-api`
- `agent/pi/update-dependencies`

## Before modifying files

Before making any implementation change, verify:

1. The current repository is Workbench.
2. The current working tree is not the canonical checkout.
3. The current path is under `/data/agents/workspaces/` or is a host-created worktree (see above).
4. The current branch starts with `agent/`.

Useful checks:

`git rev-parse --show-toplevel`

`git branch --show-current`

If the working tree is `/data/code/getquick/internal/workbench`, do not modify files. Create or enter an agent worktree first.

## Base branch

Unless a task explicitly specifies otherwise, create work from the repository's default branch.

Before creating a worktree, the canonical checkout should be clean and the base branch should be updated using a fast-forward-only pull.

Never force-push or rewrite the canonical base branch.

## Package manager

Use the package manager declared by the repository.

If `pnpm-lock.yaml` exists, use pnpm.

Do not use npm or Yarn in a pnpm project unless explicitly requested.

## Dependencies

Install dependencies inside the worktree as required.

Do not commit `node_modules` or other generated dependency directories.

## Environment files and secrets

Do not copy production credentials or secrets into agent worktrees.

Use development-specific environment files when provided.

Never commit `.env`, `.env.local`, credentials, API keys, tokens, or other secrets.

## Git

Before starting:

- Fetch the latest remote state.
- Create a dedicated agent branch.
- Work only in that branch/worktree.

During work:

- Keep changes scoped to the requested task.
- Do not modify unrelated files.
- Do not rewrite existing commits.
- Do not force-push.
- Every commit runs the local CI gate (`.githooks/pre-commit`): `pnpm check`
  and `pnpm test` must pass or the commit is blocked. Allow about three
  minutes for a commit; give the command a long timeout or run it in the
  background.
- Format with `pnpm format`, or `pnpm exec vp fmt --write <files>` for
  specific files. The formatter is `vp fmt` (oxfmt), not Prettier.
- If the hook reports `src/data.generated.ts` as stale, run `pnpm sync`,
  stage the file and commit again.
- Before numbering a new ADR, check open PRs for ADRs that already claim the
  next number. Several agents write ADRs in parallel.

Before finishing:

- Review `git diff`.
- Run the project's relevant lint, typecheck, tests, and build commands.
- Report any checks that could not be run or did not pass.
- Leave unrelated user changes untouched.

## Pull requests

When requested to publish work:

1. Push the agent branch.
2. Create a pull request.
3. Include a concise description of the change.
4. Include validation performed.
5. Include known limitations or follow-up work.

Agents must not merge their own pull requests unless explicitly instructed.

`main` is protected: merges happen only through reviewed pull requests.
CodeRabbit's automatic PR review is disabled (ADR 0011) — the merge gate is a
human's review plus the explicit instruction to merge. Batch pushes so the
reviewer reads one coherent change, keep the PR in draft until it is
reviewable end-to-end, and expect the merge to wait for that instruction.
Other automatic reviewers may comment; their threads are input to the human's
review — address or answer them, resolving them is not the gate.

`gh pr edit` fails on this repository with a Projects (classic) GraphQL
error. Change a PR's title or body with
`gh api -X PATCH repos/Quick-Release/workbench/pulls/<n> -f title="<title>" -F body=@<file>`.

When a human explicitly says to merge:

1. Mark the PR ready (`gh pr ready <n>`).
2. Confirm `CI / validate` and `CI / pack-install smoke` passed on the current
   head, and that no review thread is left unaddressed.
3. Merge that exact head as a merge commit:
   `gh api -X PUT repos/Quick-Release/workbench/pulls/<n>/merge -f merge_method=merge -f sha=<head>`.
   Pinning `sha` makes the merge fail if the head moved after the human's review.
4. Clean up the worktree (next section).

## Worktree cleanup

A worktree whose pull request has merged into `main` is finished, and the
agent removes it in the same session. That applies when you merge the PR, and
when you find one of your own branches already merged at the start of a task.

1. **Confirm the merge.** Run `gh pr view <branch> --json state,baseRefName,headRefOid`.
   It must show `MERGED` into `main`. Squash and rebase merges are allowed
   here, so `git branch --merged` is not proof.
2. **Confirm nothing would be lost.** `git -C <path> status --porcelain` must
   be empty, and `git -C <path> rev-parse HEAD` must equal the PR's
   `headRefOid`. If either fails, the worktree holds work the merge didn't
   carry: leave it in place and report it.
3. **Remove it.** Run these from the canonical checkout, never from inside the
   worktree being removed:

   ```sh
   git worktree remove <path>
   git branch -D <branch>          # -D: squash/rebase merges leave these exact commits off main; step 2 proved the merged PR holds them
   git push origin --delete <branch>
   git worktree prune
   ```

   Delete the remote branch yourself: the repository doesn't do it on merge.

4. **Update the canonical checkout.** Run `git pull --ff-only` there, but only
   if it's clean and on `main`. Otherwise leave it and say so.

A worktree whose PR is open, or that has no PR, is active: keep it. Remove
another agent's merged worktree only when a human asks.
