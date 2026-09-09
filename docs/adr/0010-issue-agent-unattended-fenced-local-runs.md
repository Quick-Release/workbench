# The issue agent: unattended-but-fenced local runs that end in a draft PR

Status: accepted

Work item: GH-40

Issue #40 is the "session spawn" decision ADR 0005 deferred: the dashboard can now _act_ an issue, not just observe it. A Developer starts an agent run from the pull-requests page; workbench creates a fresh git worktree on `agent/issue-<n>` off the default branch, runs the opencode CLI on a local Ollama model inside it under a fixed prompt (only the issue number is interpolated — the agent reads the issue itself via `gh`), then commits, pushes, and opens a **draft** pull request whose body says `Fixes #<n>`. Nothing merges without human review; the Developer's own working tree is never touched.

The posture is **unattended but fenced**, and the fences are structural, not trusting: the agent's permissions are auto-approved only inside the worktree scope (a workbench-provided opencode permission config denies outside-worktree access and denies `git push` / `gh pr create` outright — publishing is the orchestrator's plan, never the agent's); the request surface is enumerated (`engine` plus exactly one of `pr | issue`, an optional ollama-qualified model, an optional plain-ref base branch — no command text from the page); the trigger rides the loopback-gated review seam; and the draft PR is the human gate. Failed runs keep their worktree for inspection; a retry starts from a clean one. An attacker-influencable issue text stays a real risk — the fences contain it, they do not dissolve it.

## Considered options

- **Dashboard-typed prompts** — rejected: arbitrary command execution with a UI.
- **Cloud/hosted models** — rejected: contradicts the local premise and sends issue text off-machine; also why the trigger stays on the local dev-server middleware, where loopback Ollama is reachable.
- **Sandbox as a security boundary** — rejected as a claim; the worktree, the permission config, and the draft-PR gate do the containing.
- **Letting the agent publish** — rejected: the orchestrator's plan owns commit/push/PR so provenance and the draft gate are structural.

## Consequences

- ADR 0005's deferred item is discharged: agent sessions are now acted on, through the same execution seam and Schema boundary, with the confirm-first rule honored by the draft PR being the confirmation.
- The review seam's engines widen from reviewers to one actor; history entries carry an issue or a PR, and the run stream gains notices surfaced from the agent's output.
- The first CLI is opencode (`--model`, `--format json`, `--auto`), chosen for its MIT license, first-class Ollama provider, and JSON-event headless mode; the engine registry's plan shape is what a Codex or mini-swe-agent engine would plug into later.
- Unattended runs are bounded: a per-step timeout with a generous default for the agent step, env-overridable; cancel/SIGTERM semantics are the review run's, unchanged.
- Failure keeps the evidence (worktree kept, run outcome `failed`); cleanup runs only for success and drops the local branch twin, so a retry is never polluted by a previous attempt.
