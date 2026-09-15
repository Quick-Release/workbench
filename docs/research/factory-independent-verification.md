# Factory 08 — Independent verification and revision-bound evidence

Status: accepted research/design decision

Work item: [GH-166](https://github.com/Quick-Release/workbench/issues/166)

Related decisions: [GH-117](https://github.com/Quick-Release/workbench/issues/117), [GH-124](https://github.com/Quick-Release/workbench/issues/124), [GH-129](https://github.com/Quick-Release/workbench/issues/129), [GH-135](https://github.com/Quick-Release/workbench/issues/135), [GH-161](https://github.com/Quick-Release/workbench/issues/161), [GH-162](https://github.com/Quick-Release/workbench/issues/162), [GH-163](https://github.com/Quick-Release/workbench/issues/163), [GH-165](https://github.com/Quick-Release/workbench/issues/165), [GH-167](https://github.com/Quick-Release/workbench/issues/167), [GH-168](https://github.com/Quick-Release/workbench/issues/168)

## Decision in brief

A future Workbench coding profile must not treat an agent summary, candidate-controlled hook, command name, process exit, or movable branch as proof that a change is correct. Workbench will own a portable `verification-contract/v1`: a host maintainer approves a versioned **Verification recipe**, Workbench assembles an immutable **Candidate commit**, and separately controlled **Verifiers** execute the approved recipe against that exact commit in isolated verification checkouts. Only fresh, complete passing **Verification evidence** satisfies a mandatory Verifier.

A content-addressed **Verification bundle** joins the repository, Candidate commit and base, recipe, individual evidence, aggregate eligibility decision, and any human **Verification exception**. The first remote Git write is protected by the **Inner publication gate**. After publication, exact-head unprivileged CI and a human's explicit approval form the **Outer delivery gate**. Passing either gate never claims that every acceptance criterion is satisfied.

The contract is independent of a particular execution backend and does not select or implement one. It protects evidence from candidate agents, candidate code, stale Workbench owners, and mutable references within the threat model accepted by #161/#163/#165. It does not claim to resist a malicious Developer, compromised host OS, compromised Workbench installation, or compromised verification platform.

## Evidence boundary

The issue's pinned baseline was [`fd22f6`](https://github.com/Quick-Release/workbench/tree/fd22f6a2d1bde0a65838955bcdec4c9d6a3c6f13). Current Workbench behavior was rechecked at [`359469a`](https://github.com/Quick-Release/workbench/commit/359469a8e77645c95b874381e47ce729dcaaa5f7) on 2026-09-14. The script organization changed between those revisions, but the relevant behavior remains.

Research used source inspection, GitHub issue/decision inspection, and the primary sources listed below. No Workbench test, build, verifier, agent, provider, package installation, host-repository script, publication, exploit, client infrastructure, or pilot was run. The adversarial cases in this note are required future fixture evidence, not completed experiments.

## Current Workbench behavior

### The Issue agent has no independent verification step

At current main, `scripts/seam/review/opencode-engine.mjs` instructs the agent to include tests and run repository checks. The fixed plan then stages all files, commits, pushes the branch, and creates a draft PR. No separately controlled Verifier reruns an approved recipe between the agent step and publication. `AGENT-SUMMARY.md` is agent-authored narrative, not execution evidence.

The OpenCode permission configuration denies selected publication commands at the agent tool layer, while `scripts/seam/review/review-runner.mjs` runs plan steps with the Workbench process environment plus step overrides. Prior Factory decisions already establish that this is not OS-level isolation, credential separation, or evidence independence.

### Existing command names hide effects and coverage

At both inspected revisions:

- `check` runs `sync`, a formatting check, lint, and TypeScript checking;
- `test` runs `sync`, the Vitest suite, and an explicit Node test list;
- `build` runs `sync` and the Vite Plus build;
- `sync` writes and formats `src/data.generated.ts`.

`check`, `test`, and `build` therefore establish different facts and all may modify a verification checkout through synchronization. A recipe must describe their actual invocation, dependencies, effects, and expected evidence rather than infer safety or coverage from their names.

The repository's `.githooks/pre-commit` runs `check`, rejects an unstaged generated snapshot, and then runs `test`. It may install dependencies when `node_modules` is absent and Git permits bypass through `--no-verify`. It is useful Developer feedback but cannot be the independent publication gate.

The only current GitHub workflow, `.github/workflows/release.yml`, triggers on pushes to `main`, installs dependencies, runs `pnpm check`, and then enters credentialed release behavior. It does not run the test suite or build and is not a pull-request validation workflow. #117 owns fixture-driven full PR validation and packaged test seams; #166 does not duplicate it.

## External findings

Primary sources were checked on 2026-09-14. SLSA references use v1.2. GitHub documentation is live and generally undated; REST references below use API version 2026-03-10. These sources supply patterns and platform facts. They do not certify Workbench or prove a proposed Verifier independent.

### SLSA and in-toto

[SLSA source requirements](https://slsa.dev/spec/v1.2/source-requirements) define a source revision as a specific, logically immutable snapshot. A revision ID such as a Git SHA is unique only in repository context, supporting the decision to bind evidence to canonical repository identity plus commit and base rather than a bare SHA.

The [in-toto Statement v1](https://in-toto.io/Statement/v1) binds subjects through digests and assumes subjects are immutable. Its [validation model](https://github.com/in-toto/attestation/blob/main/docs/validation.md) checks recognized signatures and matching subject digests. A digest establishes which bytes or revision an attestation addresses; it does not establish that the right tests ran or that their result was interpreted correctly.

The [SLSA Verification Summary Attestation v1.2](https://slsa.dev/spec/v1.2/verification_summary) records a verifier identity, policy URI and optional digest, input-attestation digests, subject digest, and signed result. `verification-contract/v1` adopts that shape as a reference but makes the recipe digest mandatory and uses richer Workbench result states. It is not a claim of SLSA conformance.

[SLSA build requirements v1.2](https://slsa.dev/spec/v1.2/build-requirements) require higher-level provenance to originate from a control plane rather than tenant-controlled build steps and require secret material used to sign provenance to remain inaccessible to user-defined steps. [Build provenance](https://slsa.dev/spec/v1.2/build-provenance) describes builder identity as the transitive closure of trusted entities that ran the build and recorded provenance. These support separating the recorder, recipe, and publication credentials from candidate execution. SLSA also explicitly excludes compromise of the build platform and does not prove the adequacy of a producer's chosen policy.

The [in-toto Test Result predicate v0.1](https://in-toto.io/attestation/test-result/) can identify source and test configuration by digest and report `PASSED`, `WARNED`, or `FAILED`. It does not represent Workbench's required `not-run`, `inconclusive`, `infrastructure-error`, or `stale` distinctions, so it is informative rather than sufficient.

### GitHub checks and merge policy

GitHub's [Checks API](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#create-a-check-run) creates a check run for a specific commit and records `head_sha`. GitHub also documents that [required checks must pass on the latest commit SHA](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#required-check-needs-to-succeed-against-the-latest-commit-sha). For pull-request workflows, [`GITHUB_SHA` may identify a synthetic merge commit](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request), while `github.event.pull_request.head.sha` identifies the candidate head. Remote evidence therefore needs to say whether it tested the head, a synthetic merge result, or both.

GitHub accepts `success`, `skipped`, and `neutral` as successful required-check conclusions, and conditionally skipped jobs can appear successful. A green GitHub mergeability signal does not by itself prove that every mandatory Workbench Verifier executed. Workbench preserves its own result vocabulary and treats only a fresh `passed` result as satisfying a mandatory Verifier.

GitHub's [protected-branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging) says write-capable identities can set statuses, while protected branches may require an expected GitHub App. Expected-app enforcement protects status authorship, not candidate-controlled workflow logic that causes the expected app to report misleading success. Strict checks can require a topic branch to be current with its base; loose checks do not.

The same documentation describes optional stale-review dismissal and approval of the most recent reviewable push. These controls reinforce exact-revision review but are repository settings, not universal guarantees. ADR 0011's human merge instruction remains the Workbench gate regardless of automatic reviewer output.

GitHub Enterprise Cloud can use [ruleset-required workflows](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging) sourced from a separately controlled repository. [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-and-branch-protection) can require review of workflow and policy changes and is evaluated from the PR's base branch. These are useful outer-gate options, not portable prerequisites for local verification.

GitHub recommends [pinning third-party actions to a full commit SHA](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions) and warns against executing candidate code in privileged [`pull_request_target` workflows](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target). A trusted workflow source does not make candidate build scripts safe to execute with secrets.

### Exit status and logs

GitHub maps an action's [zero exit code to success and nonzero to failure](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/set-exit-codes), but an exit status alone does not prove test coverage or expected output completeness. The [in-toto specification](https://github.com/in-toto/specification/blob/master/in-toto-spec.md) can record command, materials, products, stdout, stderr, and return value, while noting that byproducts are not verified by the default routine.

[TAP 14](https://testanything.org/tap-version-14-specification.html) uses a required plan to detect a truncated or damaged TAP stream, but that guarantee applies only to conforming TAP output. No primary source establishes arbitrary build logs as complete or deterministic. GitHub also allows authorized users to [delete workflow logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs#deleting-logs), and retention is configurable. Structured process facts and verdicts must therefore remain separate from bounded diagnostic logs.

### Spotify's feedback loops

Spotify's [Honk Part 3](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) describes independently implemented Verifiers selected from repository contents, callable by the agent for feedback and rerun before opening a PR. It also describes a later model judge for scope drift. Spotify states that it had not yet invested in judge evaluations, although internal observations found useful vetoes. Workbench reuses the separation between deterministic checks and model review, not Spotify's activation rules, results, platform assumptions, or confidence.

## `verification-contract/v1`

This is a design boundary, not an implementation schema.

### Recipe governance

A host-repo maintainer approves each Verification recipe version and any trusted harness or fixture revision. The Developer approving a run selects an already-approved recipe in the run manifest. Workbench retains an immutable approved copy outside candidate write authority.

A recipe binds:

- canonical host-repository identity and supported task profile;
- recipe ID, version, digest, approval, expiry/revocation policy;
- pinned base-revision verification surfaces;
- every Verifier's exact structured invocation and working directory;
- trusted implementation, harness, fixtures, expected evidence, and digests;
- dependencies, prerequisites, environment, services, filesystem effects, network, credentials, resources, timeouts, and log policy;
- mandatory versus optional applicability and evidence-expiry rules.

A discovered Command candidate from #135 can inform recipe authoring but grants no authority. Candidate changes may propose a new recipe version, tests, fixtures, scripts, lockfiles, or configuration. They cannot replace the immutable approved layer or certify their own weakening. A recipe-changing task needs separate human approval and a trusted meta-check.

### Candidate identity

Workbench assembles an immutable Candidate commit from the agent's exported artifact without invoking candidate-controlled Git hooks. The Candidate commit is identified by canonical repository, full commit SHA, parent/base SHA, and tree. The publisher may publish only that exact commit.

Verification starts after the coding process is proven stopped or isolated. Intermediate agent-invoked Verifier runs are feedback only. Every final independent Verifier receives a fresh checkout of the Candidate commit and only its declared trusted harness, fixtures, services, caches, and capabilities. Declared pipeline groups may share state when their ordering and state digest are explicit; undeclared cross-Verifier state is prohibited.

Each material change invalidates affected evidence: candidate or base commit, recipe or approval, Verifier/harness/fixture, lockfile/toolchain/runtime, execution profile/backend enforcement, declared service/environment, security policy, or configured expiry. Dependency-aware reuse is permitted only when independence is established; uncertainty invalidates conservatively.

### Preparation and side effects

Dependency installation, generation, database setup, and compilation are explicit recipe preparation steps. Their invocation, candidate inputs, approved destinations, credential mediation, cache policy, effects, bounds, and resulting environment identity are evidence. Candidate lifecycle code remains untrusted and runs only inside the verification boundary.

A Verifier may write only in its disposable verification checkout:

- no diff means the candidate was canonical for that check;
- an expected formatting/generated diff is `failed: candidate-not-canonical` with a diagnostic patch;
- an undeclared diff is `inconclusive: verifier-contract-violation`;
- no verifier output is silently copied or committed into the Candidate commit.

A repair uses diagnostics to produce a new Candidate commit and invalidates prior evidence. Repair limits and budgets belong to #168.

### Evidence and result states

Every result records at least:

- repository, run, attempt, Candidate commit, and base identity;
- recipe and Verifier IDs, versions, implementation/configuration digests, and recorder identity;
- execution backend/profile, platform, architecture, and relevant toolchain;
- structured argv, working directory, sanitized environment declaration, fixtures, services, and inputs;
- start/end times and duration;
- exit status, signal, timeout, cancellation, and process-termination facts;
- pre/post filesystem or declared-output comparison;
- bounded sanitized stdout/stderr references, hashes, byte counts, truncation, and redaction categories;
- typed verdict and reason;
- tamper-evident record digest tied to the fenced attempt.

The recorder's structured channel is authoritative; candidate stdout and agent summaries are diagnostics. Raw secret-bearing output is not retained merely to preserve a hash. Truncated diagnostics may accompany a pass only when the structured result is complete and full output is not required by the recipe; otherwise the result is inconclusive.

Mandatory Verifier states remain distinct:

| State                  | Meaning for the gate                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `passed`               | Fresh, complete evidence satisfies this Verifier                  |
| `failed`               | The Verifier established a failing condition                      |
| `not-run`              | No qualifying execution occurred, including prerequisite failure  |
| `inconclusive`         | Execution occurred but cannot support a trusted verdict           |
| `infrastructure-error` | The approved environment could not complete the Verifier reliably |
| `stale`                | Evidence no longer matches bound inputs or policy                 |

Only `passed` satisfies a mandatory Verifier. Independent bounded Verifiers continue after a failure; dependent or unsafe work stops and records why it was not run. An integrity failure that makes later execution untrustworthy stops the recipe.

Workbench presents separate facts:

- **Verification complete:** all mandatory Verifiers have terminal evidence.
- **Verification satisfied:** all mandatory Verifiers have fresh passing evidence.
- **Publication eligible:** verification is satisfied or every otherwise-blocking result has a valid permitted Verification exception.
- **Delivery eligible:** exact-head remote CI and human approval also satisfy the Outer delivery gate.

Workbench never reports “passed with exception.” The non-passing result and human decision remain visible.

### Baselines, flakes, and exceptions

When attribution matters, the same recipe, fixtures, and environment run against the base:

- base pass and candidate fail indicates a candidate regression;
- identical base and candidate failure is pre-existing failure, not candidate pass;
- inconsistent bounded repeats are inconclusive/flaky;
- unavailable services and platforms are infrastructure-error or unsupported/not-run, never green.

A human Verification exception is single-use and binds the exact Candidate commit, blocking Verifier/evidence, rationale, approving identity, expiry, and publication action. It may permit publication of a confirmed pre-existing failure, bounded known flake, unavailable non-security service, optional unsupported environment, or model concern. It does not satisfy remote CI, acceptance criteria, or human merge review.

Identity mismatch, stale/inconsistent evidence, missing/unapproved/revoked recipe, candidate influence over the recorder or trusted recipe, isolation/credential/network/filesystem breach, forged/replayed/wrong-attempt evidence, unknown execution or publication outcome, undeclared effects, and absence of every applicable correctness Verifier for a code task are non-waivable.

### Publication and remote CI

The Verification bundle content-addresses the Candidate commit and base, recipe, individual evidence, aggregate decision, and exception records. The publication service receives no mutable branch as authority. It rechecks the local object, pushes the exact Candidate commit, uses expected-old-reference semantics for updates where available, reads back the remote reference and PR head, and records success only when both equal the verified SHA.

A mismatch, concurrent branch movement, ambiguous response, or failed read-back follows #165 reconciliation and cannot become successful publication by assumption. Verifiers receive no GitHub publication credentials.

The Inner publication gate requires an eligible bundle before the first remote Git write. After push, the Outer delivery gate requires unprivileged CI against the exact current PR head and the human approval required by ADR 0011. Synthetic merge-result CI records both head and merge SHAs. A new push invalidates prior head-bound CI and review as policy requires. Privileged release or deployment workflows are not candidate Verifiers.

### Optional model review

A separately approved Model-based scope review may inspect the Issue brief and Candidate commit after deterministic Verifiers pass. It records provider/model, prompt and policy version, inputs, output, uncertainty, and destination. Its outcomes are `clear`, `concern`, or `inconclusive`, not deterministic pass/fail.

A concern may stop unattended publication and require repair or human review. The model cannot certify correctness, satisfy acceptance criteria, overrule deterministic failure, approve an exception, or hide uncertainty. Spotify's reported results do not establish Workbench quality; evaluation is required for each intended task profile.

## Minimal bug-fix example

1. The approved Issue brief describes a reproducible parser regression and observable acceptance criterion.
2. A host maintainer has approved a recipe containing a trusted regression fixture, static checks, the base/full suite, and build.
3. The Developer approves the run manifest and recipe. The coding agent may invoke abstract Verifiers for feedback.
4. The agent exports a patch. Workbench stops or isolates the coding process and creates Candidate commit `C` on base `B` without candidate hooks.
5. Each mandatory Verifier runs in a fresh verification checkout of `C`. The recorder captures structured process facts, effects, sanitized logs, and exact identities.
6. The trusted regression fixture, static checks, full suite, and build all produce fresh passing evidence without modifying `C`.
7. Workbench creates a Verification bundle for repository `R`, base `B`, candidate `C`, and recipe `V`.
8. The publication service pushes exactly `C`, reads back the branch and draft-PR head, and records the result.
9. Unprivileged PR CI runs against the exact head and reports its own SHA-bound evidence. The PR Review Brief distinguishes local evidence, remote CI, acceptance mapping, and claims.
10. A human reviews the exact current change and gives the explicit merge instruction. Verification supports that decision but does not replace it.

## Required adversarial fixture matrix

| Fixture                                                  | Required outcome                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Real regression hidden by an agent summary               | Trusted regression Verifier fails; summary has no authority                        |
| Candidate deletes/skips existing tests                   | Trusted/base suite still runs; sensitive change blocks absent separate approval    |
| Candidate prints fake success or writes forged evidence  | Recorder ignores candidate output as authority and surfaces tampering              |
| Formatter/generator changes files                        | Candidate-not-canonical failure with diagnostic patch; no automatic commit         |
| Candidate/branch changes after verification              | Bundle becomes stale; publisher refuses mismatch                                   |
| Base and candidate fail identically                      | Pre-existing failure remains non-passing                                           |
| Bounded repeats disagree                                 | Inconclusive/flaky, never collapsed into pass                                      |
| Required service/platform is unavailable                 | Infrastructure-error or unsupported/not-run, never green                           |
| Candidate alters recipe/config/fixtures                  | Immutable approved recipe remains active; proposal reported separately             |
| Exit zero but required output is absent/malformed        | Inconclusive Verifier contract failure                                             |
| Output is truncated or sanitized                         | Condition remains visible and follows the declared log policy                      |
| Timeout or uncertain cancellation                        | Infrastructure-error/unknown; publication blocked                                  |
| Cross-attempt evidence submission                        | Attempt/fencing binding rejects it                                                 |
| Evidence is for SHA A but branch points to SHA B         | Publication refused or reconciled as unknown                                       |
| Candidate accesses harness/store/publication credentials | Boundary fails closed; condition is non-waivable                                   |
| Documentation-only profile                               | Only approved applicable Verifiers run; no agent-selected skip                     |
| Code task has no applicable correctness Verifier         | Unsupported/needs-information; no publishable green result                         |
| Mutating preparation poisons a later check               | Fresh checkout or declared pipeline-state validation exposes the mutation          |
| Recipe is revoked after verification but before push     | Evidence becomes stale and publication stops                                       |
| Remote CI reports skipped/neutral as successful          | Workbench still shows mandatory Verifier as not-run unless its own evidence passed |

Use disposable repositories, synthetic secrets, fake publication read-backs, and approved bounded execution profiles. Do not use real client infrastructure or production credentials.

## Responsibility boundaries

| Responsibility                                                           | Owner     |
| ------------------------------------------------------------------------ | --------- |
| Fixture-driven suites, full PR validation, packaged test seams           | #117      |
| Current-SHA CI/local/claimed/missing evidence presentation               | #124      |
| Optional benchmark and performance evidence                              | #129/#134 |
| Static Command candidate discovery and effects                           | #135      |
| Capability, credential, and untrusted-content policy                     | #161      |
| Issue brief, task profile, readiness, and initial Verifier distinction   | #162      |
| Execution workspace/backend enforcement                                  | #163      |
| Attempts, fencing, reconciliation, retention, and unknown outcomes       | #165      |
| Verification recipe, evidence, bundle, eligibility, and exception policy | #166      |
| Exact draft-PR publication and delivery interaction                      | #167      |
| Repair policy, retries, and budgets                                      | #168      |
| Human merge decision                                                     | ADR 0011  |

This decision creates no duplicate test framework, command scanner, benchmark engine, worktree manager, workflow state machine, review UI, or publication service. It authorizes documentation and later disposable fixture validation only—not implementation, backend selection, CI changes, provider use, host-repository execution, branch push, PR creation, merge, deployment, or pilot.
