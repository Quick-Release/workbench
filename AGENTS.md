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
3. The current path is under `/data/agents/workspaces/`.
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

## Worktree cleanup

Do not delete an active worktree automatically.

After a branch has been merged, worktrees may be removed from the canonical repository with `git worktree remove` and stale metadata cleaned with `git worktree prune`.
