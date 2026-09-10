# CodeRabbit's automatic PR review is disabled; a human's review and explicit merge instruction are the only merge gate

Status: accepted

The repository ran with CodeRabbit as the standing reviewer: it reviewed every pull request automatically, its approval gated merges, and `AGENTS.md`, the README, and the pull-request template steered authors to batch pushes and summon `@coderabbitai review` by hand. That automation is now switched off — CodeRabbit is disabled on this repository, and nothing automatic takes its place. The gate does not loosen with it: `main` stays protected, pull requests stay required, and the review that admits a merge is a **human's**, expressed operationally as the explicit merge instruction. The standing rule that agents must not merge their own pull requests unless explicitly instructed was one guard among several while the bot gate existed; with the bot gone it is the gate, and it is a human act by definition.

What changes in practice: a PR's author — human or agent — requests review from a human instead of relying on a bot's badge; "reviewed" means the human read the change and said merge, not that an approval appeared; batching pushes and keeping a PR in draft until it is reviewable end-to-end remain the courtesies that make that human review one coherent reading instead of a stream of diffs. What does not change: CodeRabbit-the-product stays a **review engine** in CONTEXT.md's sense — a local CLI a Developer can start against a pull request from the dashboard, probed and health-checked like any other engine. The GitHub App's automatic PR review and the locally-run CLI are different surfaces; only the former is retired.

## Considered options

- **Document CodeRabbit as still the gate and batch around it** — rejected: the automation is off at the source; instructions describing a gate that cannot fire leave agents and humans waiting on a review that never comes.
- **Replace it with another automatic reviewer** — rejected for now: no replacement is decided. Until one is, the only honest gate is one that exists.
- **Soften the human gate so agents merge freely** — rejected: the fence that matters on an agent-heavy repo is human review of agent work; removing the bot must not remove the fence.
- **Leave the process undocumented** — rejected: the merge gate is the repo's central process rule (`AGENTS.md`, ADR 0010's draft-PR posture); a silently changed gate is a decision that looks like an accident.

## Consequences

- `AGENTS.md`, `README.md`, and the pull-request template no longer describe CodeRabbit-as-gate; the template keeps draft-while-working and batched pushes as review hygiene, and the merge waits on a human.
- A merge without a human's explicit instruction is a process violation even when every check is green — the local CI gate (`pnpm check`, `pnpm test` in the pre-commit hook) proves a change builds; only review says it is right.
- Other automatic reviewers may still comment (GitHub's Copilot reviewer does today); their threads are input to the human's review, not the gate itself — resolve them by addressing or answering, not as an end in itself.
- If an automatic reviewer returns, this ADR is superseded by a new one, not silently edited.
