# Gates are enforced by the platform; Workbench describes and observes them

Status: accepted

Work item: none yet. Research and owner acceptance: `docs/research/software-factory-adoption-model.md` (PR #258, 2026-11-04). Amends the consequences of ADR 0011 for host repos other than Workbench.

ADR 0011's gates live only in Workbench's own repository today:

- protected `main` with a required pull request;
- required conversation resolution;
- a required CI check;
- a human's explicit merge instruction.

Nothing carries them to other host repos.

The Factory baseline (ADR 0024) **describes** the gate set. GitHub **enforces** it. Workbench's Conformance report (ADR 0025) **observes** whether a host actually has it. Gates are the one opinion kind a host can't override in its Baseline adoption. An exception is made only by changing the ruleset's targeting, which is visible at org level, not in the host's own file.

The rollout is staged, because GitHub's own documentation is unclear for our plan:

- `Quick-Release` is on GitHub Team.
- GitHub's docs say rulesets are available on Team and Enterprise, but also say that org-level rulesets targeting many repositories are for Enterprise. The two statements conflict.
- Whether "require workflows to pass" is available on Team is unverified.

The stages are:

1. **Describe and diagnose.** The doctor checks each host's branch protection and rulesets through the API.
2. **Trial.** Apply one org ruleset, targeted by a custom property such as `factory=quick-release`, on `workbench` and `cesam-astro`.
3. **Widen** it once the trial confirms it works on the Team plan.

If org-level targeting turns out to be Enterprise-only, the same ruleset is applied per repository by a script that the doctor verifies.

A shared, SHA-pinned reusable CI workflow is deferred until there is a second Node host to share it with.

## Consequences

- The human merge instruction stays a procedural gate, as ADR 0011 records. No ruleset can encode it.
- Repository CI remains candidate-controlled. It is not ADR 0021's independent verification, wherever the workflow comes from.
- Applying or changing org rulesets needs an `admin:org` credential. That is an org administrator's act, never a Workbench action through the seam.
