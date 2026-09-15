# Factory 09 — Safe, idempotent draft-PR delivery and human review

Status: accepted research/design decision

Work item: [GH-167](https://github.com/Quick-Release/workbench/issues/167)

Prerequisites: [GH-161 Resolution](https://github.com/Quick-Release/workbench/issues/161#issuecomment-5661413138), [GH-165 Resolution](https://github.com/Quick-Release/workbench/issues/165#issuecomment-5663200374), [GH-166 Resolution](https://github.com/Quick-Release/workbench/issues/166#issuecomment-5672579648)

Related ownership: [GH-124](https://github.com/Quick-Release/workbench/issues/124), [ADR 0011](../adr/0011-human-review-gates-merges.md), [ADR 0016](../adr/0016-clarification-threat-model-and-credential-boundaries.md), [ADR 0020](../adr/0020-durable-run-ownership-and-reconciliation.md), [ADR 0021](../adr/0021-independent-verification-and-revision-bound-evidence.md), [ADR 0022](../adr/0022-safe-idempotent-draft-pr-publication.md)

## Decision in brief

A future Workbench coding profile will publish through a deep **Publisher** module, not from the candidate Execution workspace and not with the candidate's credentials. Its entire external interface is:

```text
publish(intent, approval)
reconcile(id)
```

A separate, single-use **Publication approval** authorizes completion of one exact **Publication intent**. The intent binds the canonical GitHub repository ID and name, an approved same-repository base ref and SHA, the exact Candidate commit, Verification bundle digest, Review payload digest, Delivery profile digest, publishing credential identity, and a Publisher-derived immutable branch `workbench/p-<opaque-id>`. Workbench durably commits that authority before the first remote mutation. Expiry, revocation, or cancellation permits reconciliation reads only; it never authorizes another write.

The first Publisher has exactly two remote write operations:

1. conditionally create the absent immutable branch at the exact Candidate commit, transferring the trusted Git objects as part of that operation; and
2. create the exact draft pull request.

It cannot update or delete a ref, force-push, edit PR metadata, close, reopen, mark ready, approve, merge, label, comment, request reviewers, rerun a workflow, change settings, or deploy. A different candidate receives a new intent, branch, Verification bundle, Review payload, approval, and PR.

This contract promises one durable intent, observation before action, and evidence-backed convergence. It does **not** promise exactly-once GitHub requests, webhook delivery, workflow execution, notifications, previews, or other external side effects. Unknown outcomes remain unknown until reconciliation establishes otherwise. In particular, GitHub documents no idempotency key for pull-request creation, so a lost PR-create response followed by no matching PR is not automatically retried.

A Published draft is not automatically Ready for human review. Readiness additionally requires a current #124 PR Review Brief, Delivery profile, and required CI that actually executed and passed for the exact current head. Missing, pending, stale, skipped, neutral, cancelled, or failing checks are non-ready. Human review, an exact-revision Human merge instruction, and merge remain later and distinct states.

## Scope and evidence boundary

This note records the human-accepted delivery decision and test contract. It is research/design only. It does not implement a Publisher, credential broker, operational store, adapter, verifier, CI workflow, Review Brief, or UI. It authorizes no real token minting, Git object transfer, branch creation, pull request, workflow run, setting change, merge, release, deployment, package installation, candidate execution, or client-infrastructure experiment.

Agent-assisted research inspected local source and GitHub settings read-only on **2026-09-15**. The checkout and GitHub `main` were at [`c1676b9`](https://github.com/Quick-Release/workbench/commit/c1676b9ad44d111261beacbb02e036aae845ad3f). Existing uncommitted publication glossary additions in [`CONTEXT.md`](../../CONTEXT.md) were treated as accepted vocabulary rather than as committed baseline evidence. Fact-finding ran no project command, candidate execution, GitHub publication, merge, workflow dispatch, deployment, or client-infrastructure experiment; repository validation for the resulting documentation is recorded separately below.

External facts below use official GitHub and Git primary documentation inspected on 2026-09-15. GitHub REST links select API version `2026-03-10`; repository observations were made through read-only REST and GraphQL queries. An API snapshot is evidence at an observation time, not a guarantee that policy or integrations remain unchanged.

## Accepted decision lineage

This decision composes, rather than redefines, its prerequisites:

- #161 and ADR 0016 make untrusted repository, issue, tool, and model content data rather than authority. Credentials stay behind typed, least-privilege adapters, and uncertainty fails closed.
- #165 and ADR 0020 own durable run/attempt records, fenced ownership, pre-dispatch persistence, Unknown outcomes, cancellation semantics, reconciliation, and human resolution. Durable state does not make external dispatch exactly once.
- #166 and ADR 0021 own the immutable Candidate commit, independent Verification recipe/evidence, Verification exceptions, content-addressed Verification bundle, and Inner publication gate. The Publisher cannot reinterpret non-passing evidence or manufacture eligibility.
- #124 owns the intent-versus-change analysis and evidence presentation. It supplies the immutable pre-publication Review payload, then combines it with the Publication receipt and live remote evidence in a refreshable PR Review Brief. The Publisher verifies and delivers the payload; it does not infer or refresh it.
- ADR 0011 owns the human merge gate. Automated review, GitHub approval state, mergeability, Publisher success, and green checks do not replace the Developer's explicit merge instruction.

## Observed Workbench baseline — 2026-09-15

This section is observation, not the accepted future contract.

### Current issue-agent path

At [`c1676b9`](https://github.com/Quick-Release/workbench/blob/c1676b9ad44d111261beacbb02e036aae845ad3f/scripts/seam/review/opencode-engine.mjs), `scripts/seam/review/opencode-engine.mjs`:

1. force-removes a deterministic temporary worktree;
2. creates/resets `agent/issue-<issue>` from the selected base branch;
3. runs OpenCode with tool-level denials for selected push/PR commands;
4. runs `git add -A`;
5. runs `git commit`;
6. runs `git push -u origin <branch>`; and
7. runs ambient `gh pr create --draft` with `Fixes #<issue>` in the body.

The useful separation is that the prompt denies publication while the Workbench plan performs it. It is not yet an enforceable Publisher boundary: staging and commit occur in the candidate worktree; Git and `gh` use ambient process/configuration/credentials; there is no independent final verifier, durable Publication intent, single-use publication approval, conditional immutable branch, trusted object source, exact PR identity, read-back, or partial-failure reconciliation. Retry resets the reusable local branch, and the PR body uses a closing keyword by default.

The current [pre-commit hook](https://github.com/Quick-Release/workbench/blob/c1676b9ad44d111261beacbb02e036aae845ad3f/.githooks/pre-commit) may install dependencies, runs `pnpm check` and `pnpm test`, and notes that `git commit --no-verify` bypasses it. `pnpm check` can regenerate `src/data.generated.ts`. This is Developer feedback with candidate-controlled execution effects, not independent publication evidence.

### Current GitHub policy and integrations

Read-only repository, branch-protection, ruleset, Actions, workflow, environment, deployment, and webhook observations found:

- canonical repository `Quick-Release/workbench`, numeric repository ID `1355020912`, public visibility, and default branch `main` at `c1676b9ad44d111261beacbb02e036aae845ad3f` ([repository API](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#get-a-repository));
- `main` protected against force pushes and deletion, with conversation resolution enabled, but no required status checks and no effective required approving-review rule; there were no repository rulesets ([branch-protection API](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2026-03-10#get-branch-protection), [rulesets API](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10#get-all-repository-rulesets));
- repository auto-merge disabled;
- Actions enabled with all actions allowed and SHA pinning not required; default workflow-token permissions were read-only, while workflows could approve pull-request reviews;
- no repository webhooks and no recorded deployments returned by the inspected endpoints, but those observations do not enumerate every GitHub App, dynamic workflow, notification, organization policy, or external integration;
- two visible workflows: the checked-in Release workflow and a dynamic Copilot pull-request-reviewer workflow. The dynamic integration is direct evidence that checked-in YAML and repository-webhook listings are not a complete side-effect inventory.

The checked-in [Release workflow](https://github.com/Quick-Release/workbench/blob/c1676b9ad44d111261beacbb02e036aae845ad3f/.github/workflows/release.yml) triggers only on a push to `main`. It installs dependencies, runs `pnpm check` but not `pnpm test`, and then enters credentialed package/release behavior with `contents: write`, `packages: write`, and `pull-requests: write`. It is not exact-head pull-request CI. GitHub documents that both `push` and `pull_request` events can start workflows, and a `pull_request` workflow's default activity set includes `opened`; draft creation does not create a secret or no-side-effect boundary ([workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)). Draft state prevents merge until the PR is marked ready, but does not unsubscribe observers or suppress the general event surface ([draft-stage documentation](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request)).

Issue #124 remains open and the repository has no implemented Review Brief that can own the accepted Review payload. The repository has no required exact-head PR checks, no PR validation workflow, and only a procedural human-review rule in ADR 0011. Therefore current Workbench cannot satisfy **Ready for human review** under this decision. Auto-merge is off, but that alone does not establish the accepted exact-revision human gate. Dynamic and external integration visibility is incomplete, so the current repository also lacks an approvable first-release Delivery profile without additional maintainer inventory.

## Primary-source findings that constrain the design

### Git object transfer and reference creation

Git commit identity covers the commit object's tree, parents, author/committer data, and message; changing those bytes creates a different object ID ([Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects#_commit_objects)). The Publisher must therefore transfer the publication-eligible Candidate commit rather than recreate “equivalent” content.

GitHub's REST Git database is split across blob, tree, commit, and reference endpoints ([Git database endpoints](https://docs.github.com/en/rest/git?apiVersion=2026-03-10)). `POST /git/refs` can create a reference only to an object already present in the repository; it does not transfer an existing local commit and all of its missing reachable objects in one call ([create a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#create-a-reference)). Reconstructing blobs, a tree, and a commit through multiple REST calls would introduce extra writes and risks producing a different commit.

The REST reference-update endpoint accepts a new `sha` and `force` flag but no expected-old SHA, so it is not an expected-old-value compare-and-swap and is forbidden for immutable publication ([update a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#update-a-reference)). Git's receive-pack protocol, by contrast, encodes reference creation as `zero-id new-id ref-name` and carries a packfile in the same push exchange ([Git pack protocol](https://git-scm.com/docs/gitprotocol-pack#_reference_update_request_and_packfile_transfer)). The first write therefore needs a trusted smart-Git implementation that uses conditional create semantics; a read followed by an unconditional update is unsafe.

GitHub's GraphQL `createCommitOnBranch` mutation appends **a new commit** whose parent is the branch's current head, even though it accepts `expectedHeadOid` ([GraphQL commits](https://docs.github.com/en/graphql/reference/commits#mutation-createcommitonbranch)). It solves a different problem and would violate the exact Candidate-commit invariant. GitHub's REST create-commit endpoint likewise constructs a commit from supplied message/tree/parents/identity fields rather than transferring the certified local object ([REST Git commits](https://docs.github.com/en/rest/git/commits?apiVersion=2026-03-10#create-a-commit)).

### Pull-request identity and idempotency

The documented create-PR request accepts fields such as `title`, `head`, `base`, `body`, and `draft`; it has no documented idempotency-key field or exactly-once guarantee ([create a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#create-a-pull-request)). The list endpoint can filter by state, head, and base, which supports reconciliation but does not make creation idempotent or make an empty read proof that an uncertain request never took effect ([list pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#list-pull-requests)).

GitHub permits title, body, state, and base changes through PR update operations ([update a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#update-a-pull-request)). A PR body is therefore mutable presentation, not authoritative evidence. Before GitHub assigns the PR's immutable remote ID, Workbench needs an Expected PR identity strong enough to distinguish the intended draft from an unrelated or duplicated PR. After assignment, reconciliation binds the number/database ID/node ID and preserves human changes rather than overwriting them.

Creating a PR can emit `pull_request.opened` to workflows, webhooks, and Apps ([Actions event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request), [webhook payload reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)). The `draft` flag controls review stage; it is not a confidentiality, credential, CI, webhook, notification, preview, or deployment boundary.

### Credential scope is broader than the two operations

A GitHub App installation token can be narrowed to selected repository IDs and permissions and expires after one hour ([installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation#generating-an-installation-access-token)). The first release chooses a token restricted to exactly one canonical repository and no longer-lived PAT or SSH credential.

Creating a Git ref requires `Contents: write`, while creating a PR requires `Pull requests: write` ([ref permissions](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#create-a-reference--fine-grained-access-tokens), [PR permissions](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#create-a-pull-request--fine-grained-access-tokens)). Those categories are substantially broader than one ref-create and one draft-PR-create: GitHub describes Contents permission as covering contents, commits, branches, releases, and merges, and Pull requests permission as covering PRs and related comments, assignees, labels, milestones, and merges ([GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2026-03-10)). Token scope is therefore defense in depth, not the operation boundary. A credential broker must enforce repository, ref, SHA, endpoint, method, and payload constraints and expose neither the token nor generic authenticated transport to candidate execution.

### Git invocation has executable side channels

Normal Git is not a safe privileged transport merely because the refspec is fixed:

- Git locates hooks under `$GIT_DIR/hooks` or `core.hooksPath`, and `git push` invokes `pre-push` unless bypassed ([Git hooks](https://git-scm.com/docs/githooks#_pre_push)).
- Credential helpers are external programs; helper values may be shell snippets beginning with `!` ([Git credentials](https://git-scm.com/docs/gitcredentials#_custom_helpers)).
- Git remote helpers execute `git remote-<transport>` implementations ([remote helpers](https://git-scm.com/docs/gitremote-helpers)), while Git configuration can replace SSH commands and rewrite transport URLs ([Git configuration](https://git-scm.com/docs/git-config)).
- Attribute filter drivers run clean/smudge/process commands when Git materializes or converts worktree content ([Git attributes](https://git-scm.com/docs/gitattributes#_filter)).
- Git LFS normally installs a pre-push hook that uploads associated objects to a separate LFS API ([Git LFS pre-push](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pre-push.adoc)).
- Signed pushes can invoke GPG and server-side push-certificate handling ([signed push](https://git-scm.com/docs/git-push#Documentation/git-push.txt---signedtruefalseif-asked)); signed commits themselves must already be part of the immutable Candidate commit ([GitHub signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).
- `.gitmodules` names submodule paths and remote URLs, and submodule checkout/fetch is a separate repository operation ([gitmodules](https://git-scm.com/docs/gitmodules)).

The Publisher consequently uses neither the candidate checkout nor candidate/global Git configuration, hooks, helpers, shell, `gh`, SSH agent, PAT, user credential store, or candidate executable. LFS uploads, signing operations, and credentialed submodule traversal are unsupported unless a future trusted profile adapter models and authorizes those extra side channels.

### Remote check and issue-link semantics

GitHub requires a required check against the latest commit, but treats `success`, `skipped`, and `neutral` as successful conclusions for its required-check gate ([required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#required-check-needs-to-succeed-against-the-latest-commit-sha)). Workbench deliberately adopts the stricter #166 rule: required exact-head CI must have actually executed and passed. GitHub-green skipped or neutral evidence remains non-ready.

GitHub's closing keywords (`close`, `fix`, and `resolve` variants) link and automatically close an issue when the PR is merged into the default branch ([linking a PR to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword)). The default Review payload uses a non-closing reference. A closing keyword is included only when the Publication intent explicitly binds the exact issue and the Developer approves that issue-closing consequence.

## Publisher authority and interface contract

### Deep external interface

The Publisher is one deep module at the publication seam. Callers and end-to-end tests learn only two operations:

```text
publish(intent, approval)
reconcile(id)
```

`publish` validates or creates the durable intent record, validates the approval, reconciles before action, and performs at most the still-missing authorized write. Repeating `publish` for the same intent is a request to converge that intent, not permission to create another intent or blindly replay a request. Changed bindings are rejected rather than treated as an update.

`reconcile` performs remote reads, verifies observations against the durable intent and receipt, and returns the current proven/unknown/conflict state. It accepts no mutation option. Approval expiry does not disable these reads, but no expired, revoked, cancelled, or mismatched authority may dispatch a write.

Production and deterministic fake GitHub adapters, trusted object-store access, token brokering, Git-protocol transport, clocks, and failure injection are internal seams. They are not exported as generic caller capabilities. There is no public `push`, `createBranch`, `createPr`, `updatePr`, `retry`, `cleanup`, `merge`, or raw-client method.

### Required Publication intent fields

The canonical intent record contains at least:

| Binding           | Required value                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract identity | Publisher contract version, intent ID, creation time, run ID, candidate-producing attempt ID, and initial fenced owner/generation                          |
| Host identity     | GitHub host, canonical numeric repository ID, node ID, and canonical `owner/name`                                                                          |
| Base              | Same-repository base ref, approved base SHA, and base-observation time                                                                                     |
| Candidate         | Exact commit object ID, tree object ID, ordered parent IDs, expected base/ancestry relation, and trusted-object-source locator/digest                      |
| Verification      | Verification bundle digest, recipe/aggregate eligibility references, and any valid #166 exception reference without rewriting its result                   |
| Review            | Review payload digest, immutable payload locator, exact initial title/body projection digest, issue references, and explicit closing/non-closing mode      |
| Delivery          | Delivery profile ID/version/digest, approval/expiry, API/adapter version, allowed integration snapshot, required checks, and privileged-path decision      |
| Authority policy  | Required approval class and exact authorized operation set; individual approval grants bind the intent digest in append-only receipt records               |
| Credential        | GitHub App ID, installation ID, selected repository ID, permission-set digest, broker identity, and expected GitHub actor; never token material            |
| Branch            | Publisher-derived full ref `refs/heads/workbench/p-<opaque-id>` and expected Candidate commit                                                              |
| Expected PR       | Canonical head repository/ref/SHA, base repository/ref/SHA, `draft: true`, intent marker, payload digest, receipt-root digest, and expected request digest |

Repository name alone is insufficient because names can be transferred or reused; repository ID alone is insufficient for human review. Both are bound and must agree. The opaque branch ID is generated by the Publisher, not accepted from issue text, agent output, a filesystem path, or the candidate. Opacity prevents untrusted naming and accidental issue-number collisions; it is not a secret or authorization mechanism.

### Publication approval

Publication approval is separate from implementation approval, Verification eligibility, a Verification exception, GitHub authentication, Review payload approval, and a later Human merge instruction. It is single-use authority to complete one unchanged Publication intent. A later #165 Execution attempt may act on that intent only when prior non-dispatch is proven or the specific operation is independently safe to converge despite a repeated dispatch, and only while exact authority remains valid. Current absence alone never proves either condition.

Before the first remote mutation, Workbench must durably commit:

- the complete immutable intent and every intent digest above;
- an append-only approval grant binding that intent digest, approving identity, nonce, issue time, expiry, and policy version;
- the two allowed write classes and current next operation;
- the #165 controller lease and fencing generation; and
- a content-addressed receipt root and pre-dispatch event.

A crash before that commit proves no authorized dispatch. A crash after the commit but before a response enters reconciliation. Expiry, revocation, cancellation, owner loss, or policy drift stops future dispatch. Reads may continue to identify what happened. If authority expires after branch creation, the Publisher does not create the PR without a new explicit approval for the unchanged intent; changed intent bindings always require a new intent.

### Candidate integrity invariant

For repository `R`, approved base `B`, Candidate commit `C`, tree `T`, ordered parents `P`, Verification bundle `V`, branch `H`, and Expected PR `Q`, every successful publication observation must preserve:

```text
intent.repository == approval.repository == profile.repository == remote.repository == R
intent.base == bundle.base == approved current base == B
hash(trusted commit bytes) == intent.candidate == bundle.candidate == C
decode(C).tree == intent.tree == bundle.tree == T
decode(C).parents == intent.parents == bundle.parents == P
remote(H).target == Q.head.sha == C
Q.head.repository == Q.base.repository == R
Q.base.ref == intent.base.ref
hash(review payload) == intent.review_payload_digest
hash(delivery profile) == intent.delivery_profile_digest
hash(verification bundle) == intent.verification_bundle_digest
```

The exact ancestry rule is part of the approved task/Verification profile; for the first release, `C` must have the approved `B` relation recorded by #166 and may not acquire a new parent through amend, rebase, merge, cherry-pick, or GraphQL commit creation. A matching tree with a different commit, parent, author, committer, message, or signature is not the Candidate commit.

The Publisher obtains `C` and its reachable objects from a trusted, immutable object source produced outside candidate credentials and outside the candidate Execution workspace. It verifies object hashes, type, tree, all parents, reachability, repository/base binding, bundle/payload/profile digests, and profile restrictions before transport. It does not stage, commit, amend, rebase, merge, sign, check out, run hooks, parse candidate configuration as policy, execute a shell, or run candidate files.

## Delivery profile

A **Delivery profile** is a host-maintainer-approved, versioned, expiring publication snapshot. It is not inferred on demand from a candidate and is not equivalent to whatever settings one API call happens to return.

It contains at least:

- canonical GitHub host and repository ID/name;
- approved same-repository base refs and reserved Publisher namespace;
- GitHub API and trusted adapter versions;
- approved GitHub App/installation identity, selected one-repository scope, exact permissions, expected actor, token TTL ceiling, and broker policy digest;
- branch protection, ruleset, merge, auto-merge, Actions, workflow-token, runner, environment, secret, and deployment observations;
- checked-in workflows/actions and organization/repository rules that can react to branch or PR events;
- known GitHub Apps, webhooks, dynamic workflows, bots, review tools, notifications, preview systems, deployment systems, and package/release integrations, including explicit visibility gaps;
- required exact-head CI identities, expected producer/App, event, SHA semantics, and freshness window;
- maintainer-defined privileged paths, including workflow, policy, ownership, deployment, credential, integration, LFS, signing, and submodule configuration;
- supported Git object format and ordinary-object constraints;
- profile approval, digest, issue time, expiry, revocation, and re-observation requirements.

Unknown, stale, contradictory, inaccessible, or newly changed policy/integration state fails closed. So does a candidate that touches any profile-defined privileged path or requires a workflow, policy, permission, secret, deployment, LFS, signing, submodule, fork, or cross-repository change. These first-release denials are non-waivable within Workbench. A human maintainer may choose to publish manually outside Workbench, but Workbench records its denial and does not lend its receipt, Verification status, credentials, or success language to that action.

## Publication protocol

The protocol is observation before action at every step:

1. **Accept one intent.** Canonicalize and digest all intent fields. Enforce uniqueness for the intent ID, branch, Expected PR marker, and approved candidate/repository tuple. Reject changed reuse.
2. **Commit authority.** Validate the separate approval and persist the intent, receipt root, operation plan, lease/fencing identity, and first pre-dispatch event before any remote write.
3. **Validate trusted inputs.** Load the Candidate only from the trusted object source; verify commit hash, type, tree, ordered parents, base relation, bundle eligibility, payload digest, profile digest/freshness, privileged paths, and credential identity.
4. **Observe the repository.** Read canonical repository ID/name, current base ref/SHA, branch state, matching PRs across all states, relevant policy/integration state, and rate/auth state. Unknown or mismatched reads stop.
5. **Reconcile the branch.** Apply the branch table below. Only proven absence with valid authority can reach write 1.
6. **Dispatch write 1 conditionally.** Persist dispatch intent, ask the narrow broker for the exact operation, and use a trusted smart-Git adapter to transfer only `C`'s required ordinary Git objects and issue a create command with zero expected old object ID for the exact reserved ref. Never use a mutable update.
7. **Read back write 1.** Verify repository, full ref, commit, tree, parents, and Candidate/bundle binding. A response without read-back is not success. A lost response enters reconciliation.
8. **Revalidate before write 2.** Re-read base, approval, lease, profile, branch, and PR set. Base drift after branch creation stops and retains branch-only evidence.
9. **Reconcile the Expected PR.** Apply the PR table below. Only proven absence when no PR-create attempt is uncertain can reach write 2.
10. **Dispatch write 2 exactly.** Persist dispatch intent and submit one same-repository create-PR request with exact head/base, title, body projection, receipt-root/payload markers, non-closing linkage by default, and `draft: true`.
11. **Read back write 2.** Bind the returned and re-read PR number/database ID/node ID; verify repository, head repository/ref/SHA, base ref and contemporaneous base SHA, initial draft state, marker, and payload/receipt digests. Record drift rather than editing it.
12. **Finalize evidence.** Append content-addressed request, response, read-back, error, rate, cancellation, and reconciliation records to the Publication receipt. Mark Published draft only when branch and PR identity are proven. Evaluate readiness separately.

GitHub rate-limit responses are scheduling evidence, not permission to replay a write. GitHub directs clients to respect `retry-after` or `x-ratelimit-reset` and use bounded backoff ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10#exceeding-the-rate-limit)). Workbench may automatically retry proven read-only requests after the documented delay. A rate/auth failure around a dispatched write follows the same Unknown-outcome reconciliation as a network timeout.

## Exactly allowed and forbidden remote effects

| Category                                                                                                     | First-release decision                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Read repository/base/ref/commit/tree/PR/check/policy state                                                   | Allowed for validation and reconciliation, including after write authority expires                             |
| Create reserved branch at `C`                                                                                | Allowed once, only with conditional absence semantics and valid exact authority                                |
| Create draft PR                                                                                              | Allowed once, only after branch proof and only with the exact approved request                                 |
| Update/reset/force-push/delete any ref                                                                       | Denied                                                                                                         |
| Push tags or additional refs                                                                                 | Denied                                                                                                         |
| Edit title/body/base/head/metadata after PR creation                                                         | Denied                                                                                                         |
| Close/reopen/convert-to-ready/convert-to-draft PR                                                            | Denied                                                                                                         |
| Approve/dismiss reviews/request reviewers/merge/enable auto-merge                                            | Denied                                                                                                         |
| Labels, assignees, milestones, comments, reactions, issue edits                                              | Denied                                                                                                         |
| Rerun/cancel workflows or create check/status results                                                        | Denied                                                                                                         |
| Change repository/org settings, branch protection, rulesets, Apps, hooks, permissions, secrets, environments | Denied                                                                                                         |
| Trigger or perform preview, package release, deployment, or cleanup                                          | Denied; incidental configured reactions must be known and approved as unprivileged or publication fails closed |

The broad installation token might technically permit some denied operations. The broker and Publisher implementation, not the token category, must make them unreachable.

## Idempotency and reconciliation

### Common rules

- Every `publish` begins with reconciliation; no “retry” path skips observation.
- Intent ID, Expected PR identity, branch, and receipt root deduplicate Workbench requests. They do not make GitHub execute exactly once.
- Reads and classifications are persisted before another dispatch decision.
- A successful HTTP/Git response is provisional until read-back matches the invariant.
- A timeout, disconnect, cancellation, controller loss, malformed response, or rate/auth error after dispatch is Unknown unless remote evidence proves the effect or proves non-dispatch.
- Cancellation prevents later dispatch. It cannot stop or roll back an already in-flight remote operation; an in-flight cancellation outcome is Unknown.
- Human changes are never “repaired” by update, force, delete, metadata edit, close/reopen, or compensation.
- Branch-only evidence, duplicate/ambiguous PR evidence, and historical closed/merged PR evidence are retained in the receipt.

### Branch reconciliation table

| Durable history and observed branch                                                                 | Classification                 | Automatic action                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| No branch dispatch recorded; branch proven absent; all bindings current                             | `branch_absent`                | Conditionally dispatch write 1                                                                                           |
| No branch dispatch recorded; branch exists at exact `C` but Workbench did not create it             | `unexpected_exact_ref`         | Stop for human identity resolution; matching SHA alone does not prove authority                                          |
| Branch-create dispatch recorded; branch exists at exact `C`; remote commit/tree/parents match       | `branch_created`               | Record read-back and continue if authority/base/profile remain current                                                   |
| Branch-create response lost; branch later exists at exact `C` and operation evidence/identity match | `branch_created_reconciled`    | Treat write 1 as satisfied; do not push again                                                                            |
| Branch-create response lost; branch read is Unknown                                                 | `branch_outcome_unknown`       | Reads only; no write                                                                                                     |
| Branch-create response lost; branch currently absent                                                | `branch_create_unknown_absent` | Do not auto-retry until non-effect is independently proven; absence alone may not settle an uncertain observation window |
| Conditional create rejects because ref exists, then ref reads exact `C`                             | `branch_collision_exact`       | Stop for human resolution unless prior Workbench dispatch evidence proves it is this intent                              |
| Branch exists at any SHA other than `C`                                                             | `branch_diverged`              | Stop; never update, reset, or force-push                                                                                 |
| Branch points to `C` but remote object metadata conflicts with intent/bundle                        | `candidate_integrity_failure`  | Non-waivable denial and quarantine evidence                                                                              |
| Branch was previously proven created but is now absent                                              | `branch_deleted_externally`    | Preserve deletion and receipt; never recreate automatically                                                              |
| Branch was previously proven created but now moved                                                  | `branch_edited_externally`     | Preserve human/external edit; never overwrite                                                                            |
| Repository ID/name or base/profile observation mismatches                                           | `publication_invalid`          | No write; follow base/policy rules below                                                                                 |
| Approval expired/revoked or cancellation recorded                                                   | `read_only_reconciliation`     | Continue reads; no branch write                                                                                          |

Conditional receive-pack can still have transport-level partial effects, such as transferred but unreachable objects when the ref update is not accepted. Those are not treated as publication success and may not be observable through ordinary repository reads; no cleanup write is authorized.

### Expected PR identity

Before GitHub assigns an ID, an Expected PR is the conjunction of:

- canonical head and base repository ID/name, both the approved host repository;
- exact Publisher branch and current head `C`;
- approved base ref and contemporaneous base `B`;
- `draft: true` at creation;
- unique Publication-intent marker;
- exact Review-payload digest and receipt-root digest;
- exact initial request/title/body digest; and
- explicit issue-link mode.

A branch, title, issue number, latest-created ordering, matching SHA, or payload marker alone is insufficient. Once a create response and read-back establish GitHub's PR number/database ID/node ID, those immutable remote identifiers become primary identity; mutable title/body/draft/base state is thereafter observed as human or external change, not overwritten.

### Pull-request reconciliation table

| Durable history and observed PR state                                                          | Classification               | Automatic action                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| No PR-create dispatch recorded; branch proven exact; no open or closed match; bindings current | `expected_pr_absent`         | Dispatch exact write 2                                                                                   |
| No PR-create dispatch recorded; one strict full-identity match exists                          | `unexpected_exact_pr`        | Stop for human resolution; no silent adoption without Workbench dispatch evidence                        |
| PR-create response received and read-back matches all initial fields                           | `published_draft`            | Bind remote IDs; perform no PR update                                                                    |
| PR-create response lost; exactly one strict full-identity draft match exists and head is `C`   | `published_draft_reconciled` | Bind remote IDs and treat write 2 as satisfied                                                           |
| PR-create response lost; no match is observed                                                  | `pr_create_unknown_no_match` | **Do not auto-retry.** Preserve branch-only evidence and await human resolution                          |
| PR-create response lost; PR reads fail, truncate, rate-limit, or are otherwise uncertain       | `pr_outcome_unknown`         | Reads only; no write                                                                                     |
| More than one strict or partial candidate exists                                               | `pr_ambiguous`               | Stop; do not choose “latest” and do not create another                                                   |
| One PR matches branch but not marker/payload/receipt/base/repository binding                   | `pr_partial_match`           | Stop; do not adopt or edit                                                                               |
| Known expected PR remains draft at `C`, but title/body was edited after identity was bound     | `published_human_edited`     | Preserve edit; receipt remains authoritative; surface projection drift                                   |
| Known expected PR was marked ready                                                             | `pr_ready_externally`        | Preserve transition; Publisher does not convert it back or equate it with Workbench readiness            |
| Known expected PR was closed without merge                                                     | `pr_closed_externally`       | Preserve history; do not reopen or create a replacement under the intent                                 |
| Known expected PR was reopened                                                                 | `pr_reopened_externally`     | Preserve history; reevaluate readiness, never claim the Publisher performed it                           |
| Known expected PR was merged                                                                   | `merged_observed`            | Record merge identity/evidence separately; never infer that the required Human merge instruction existed |
| Known expected PR base changed                                                                 | `pr_base_edited`             | Preserve edit; publication history remains, readiness is stale/denied                                    |
| PR head repository/ref/SHA is not the exact same-repo branch at `C`                            | `pr_head_diverged`           | Stop; never repair the branch or PR                                                                      |
| PR exists but the branch was deleted/moved                                                     | `pr_branch_conflict`         | Preserve both observations; no recreation or update                                                      |
| PR body loses the marker before an unknown create can be identified                            | `pr_identity_unproven`       | Do not adopt; human resolution required                                                                  |
| Approval expired/revoked or cancellation recorded                                              | `read_only_reconciliation`   | Continue reads; no PR write                                                                              |

Human edits are preserved because the Publication receipt and Review payload live outside mutable PR text. A known PR's body edit does not rewrite those records. Before remote identity is known, however, removing identity markers can make an uncertain create impossible to adopt safely; Workbench reports that uncertainty rather than overwriting the human's text.

## Base-drift policy

Base revision is authority and evidence, not merely the PR's target branch name. The Publisher checks the approved base ref against `B` before each write and during read-back:

| Drift time                                              | Required result                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before write 1                                          | Invalidate publication before any write. A new Candidate commit, Verification bundle, Review payload, Publication intent, branch, and approval are required                                                                          |
| After branch creation but before PR creation            | Stop. Retain the immutable branch and branch-only receipt evidence; do not create the PR. A new candidate/verification/intent/branch/PR flow is required                                                                             |
| During or after PR creation                             | Preserve the historical publication fact if branch/PR identity was established, but mark readiness stale. Do not rebase, update the branch, retarget, or edit the PR. A new candidate/verification/intent/branch/PR flow is required |
| After Ready for human review or Human merge instruction | Invalidate readiness/instruction for the old base observation. Human review must occur against the new exact revision set; the Publisher still performs no update or merge                                                           |

The PR create interface binds a base branch name, not an expected base SHA, so there is an unavoidable race between the final base read and GitHub's create operation. Post-create base read-back can classify drift but cannot make the operation atomic. This is one reason historical publication and current readiness are separate.

## Branch-policy alternatives and trade-off

| Alternative                                                     | Benefit                                                                                                  | Cost/risk                                                                                                                                 | Decision                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Reuse `agent/issue-<n>` and update/force it on retries          | One familiar branch/PR thread                                                                            | Movable authority, cross-attempt collision, stale evidence, complex CAS, and risk of overwriting human commits                            | Rejected                   |
| Update one Publisher branch with expected-old semantics         | Preserves discussion thread without force                                                                | GitHub REST PATCH has no expected-old-SHA CAS; even safe Git transport updates invalidate evidence/review and complicate Unknown outcomes | Rejected for first release |
| Delete/recreate a Publisher branch after failure                | Reclaims names                                                                                           | Destroys branch-only evidence, races readers/humans, and turns cleanup into another privileged write                                      | Rejected                   |
| One immutable Publisher branch and draft PR per exact candidate | Simple identity, read-only reconciliation after creation, no overwrite, durable partial-failure evidence | More branches/PRs and fragmented discussion after repair/base drift                                                                       | **Accepted**               |
| Fork/cross-repository head                                      | Separates branches from host repo                                                                        | Different identity, permission, workflow, secret, and head-repository semantics; broader credentials and reconciliation                   | Unsupported                |

The accepted policy deliberately favors integrity, locality of reconciliation, and protection of human edits over preserving one conversation across candidate revisions. Remote cleanup is a later, separately approved human operation, not Publisher compensation.

## Review payload and Publication receipt

### Review payload required fields

#124 owns the review content model. Before publication it supplies an immutable, content-addressed Review payload bound to the exact Candidate/base. That payload includes at least:

- issue identity, revision, approved intent, scope, exclusions, acceptance criteria, and explicit closing/non-closing linkage;
- exact canonical repository, base ref/SHA, Candidate commit/tree/parents, and changed paths/scope;
- acceptance-criterion-to-evidence mapping with source locators and explicit gaps;
- current-candidate Verification recipe, bundle, individual Verifier results, exceptions, freshness, and unverified claims;
- recorded local commands against known SHAs, agent/Developer-reported claims, missing pre-publication evidence, and the Delivery profile's expected exact-head remote checks;
- sensitive/privileged path assessment, expected workflow/integration side effects, and Delivery profile identity/digest;
- pre-publication failure, cancellation, retry, and repair history relevant to review;
- scope differences, missing requested tests/docs, unresolved questions, remaining uncertainty, and required human judgments; and
- payload schema/version, producer/provenance, creation time, expiry/freshness inputs, and digest.

The Publisher checks the supplied payload schema, digest, Candidate/base binding, and profile freshness. It does not generate acceptance mappings, infer intent from code, reinterpret a check name, remove uncertainty, convert an agent claim into evidence, or mutate the payload after publication. #124's refreshable PR Review Brief combines that immutable input with the Publication receipt, current PR head/base, publication history, current exact-head CI, and resulting staleness. Each readiness or Human merge instruction binds a specific current review snapshot; refreshing the Brief does not change the Publication intent.

### Publication receipt required fields

The authoritative Publication receipt is a Workbench-owned, content-addressed chain outside GitHub:

- the immutable **receipt root**, created before write 1, contains the full intent and approval bindings, expected operation plan, branch, Expected PR, payload/profile/bundle digests, credential identity, and initial policy observations;
- each append-only **operation record** identifies its previous/root digest, run/attempt/lease/fencing identity, operation type, durable pre-dispatch time, adapter/API version, exact request digest, bounded response status/headers and GitHub request ID, auth/rate classification, completion/cancellation/error state, and record digest;
- each **observation record** contains queried repository/ref/commit/PR/check/policy identity, observed values, observation time, uncertainty/coverage, and classification;
- the terminal/current receipt view records remote branch and PR IDs/URLs, exact read-backs, Published/readiness state, base/profile/payload freshness, human/external edits, failures, Unknown outcomes, and unresolved decisions.

The PR body is only a human-readable projection. Its initial exact text includes the issue intent summary, non-closing issue reference by default, base and Candidate IDs, changed-scope/evidence summary supplied by #124, uncertainty, side-effect posture, immutable intent marker, Review-payload digest, and receipt-root digest. Because write 2 assigns the PR's remote ID and later observations can extend the receipt, the body commits to the pre-publication receipt root; later content-addressed records link back to that root. No PR-body update is needed or allowed.

### Owner split

| Responsibility                                                                                                          | Owner                              |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Issue intent, acceptance mapping, changed scope, evidence categories, reviewer questions, and Review payload production | #124                               |
| Candidate commit, Verification recipe/evidence/bundle, eligibility, and Verification exceptions                         | #166 / ADR 0021                    |
| Run/attempt durability, lease/fencing, cancellation, Unknown state, and operational reconciliation                      | #165 / ADR 0020                    |
| Delivery profile, exact Publication intent/approval, trusted transfer, Expected PR, read-back, and Publication receipt  | #167                               |
| Capability, credential, and untrusted-content policy                                                                    | #161 / ADR 0016                    |
| Human review and exact-revision merge instruction                                                                       | ADR 0011                           |
| GitHub merge result                                                                                                     | Human/GitHub outside the Publisher |

## Delivery and review states

These facts must never collapse into one “successful agent run” status:

| State                       | Required evidence                                                                                                                            | Does not imply                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Verification eligible**   | Current publication-eligible Verification bundle for exact `R/B/C`, including any visible valid exception                                    | That every Verifier passed, publication authority, remote branch, PR, CI, review, or merge |
| **Publication approved**    | Valid single-use approval for the exact durable intent                                                                                       | A write occurred or remains safe to dispatch after expiry/cancellation                     |
| **Published draft**         | Receipt proves reserved branch and exact draft PR both exist at `C` with the expected initial identity                                       | Ready for review, CI success, approval, or merge                                           |
| **Ready for human review**  | Published draft; current #124 Brief/profile; base/read-back acceptable; every required exact-head check actually executed and passed for `C` | Human acceptance, exact merge instruction, or merge                                        |
| **Human merge instruction** | Developer explicitly approves exact `C`, current base observation, receipt, current #124 Brief, and required CI after review                 | That the Publisher may merge or that later revision/evidence drift is acceptable           |
| **Merged**                  | GitHub read-back proves the reviewed PR/revision was merged under the applicable human process                                               | Publication, CI, or review was valid unless their independent evidence also proves it      |

For Workbench readiness, required remote CI outcomes are:

| Exact-head CI observation                                                                                                                              | Readiness                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Required check executed against `C`, trusted producer matches profile, complete conclusion `success`, evidence fresh                                   | Satisfies that check                             |
| `skipped` or `neutral`                                                                                                                                 | Non-ready even if GitHub treats it as successful |
| Missing because no workflow/check exists or path filters omitted it                                                                                    | Non-ready                                        |
| `queued`, `pending`, `in_progress`, `requested`, or waiting for approval                                                                               | Non-ready                                        |
| `cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`, or infrastructure/collection Unknown                                          | Non-ready                                        |
| `failure`                                                                                                                                              | Non-ready                                        |
| Success for a different head, merge SHA without the profile's required head evidence, stale run, wrong App/producer, or ambiguous duplicate check name | Non-ready                                        |

The first supported code-task profile requires a non-empty maintainer-approved required-check set. An empty GitHub required-check configuration does not pass vacuously. Current Workbench therefore cannot reach Ready for human review.

## First-release restrictions

The first release, if separately implemented and approved, is limited to:

- GitHub.com and one exact canonical host repository per intent;
- same-repository base and head only;
- one ordinary immutable Candidate commit from the trusted object source;
- one Publisher-derived branch under `workbench/p-*`;
- one exact draft PR with non-closing issue linkage by default;
- one short-lived GitHub App installation token narrowed to that repository and brokered operations;
- known, maintainer-approved, unprivileged branch/PR integrations;
- a current Delivery profile with non-empty exact-head CI requirements; and
- read-only reconciliation after the two writes.

It does not support forks, cross-repository PRs, tags, multiple refs, mutable branches, stacked PRs, workflow or policy changes, deployment changes, privileged paths, LFS, signing side effects, submodule credential traversal, custom Git transports, remote helpers, SSH, PATs, ambient `gh`, auto-merge, Publisher merge, remote cleanup, or compensating deletes/edits.

## Adversarial acceptance matrix

All future acceptance evidence uses deterministic fake production-adapter behavior, disposable local/bare Git fixtures, and—only if separately approved—a disposable GitHub repository with synthetic credentials/data. No client or Workbench production repository is a test target.

| Case                                                                                                       | Required outcome                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Same `publish` request replayed before any dispatch                                                        | One intent/receipt root; reconciliation occurs; at most one conditional branch dispatch                                      |
| Same request replayed after branch success                                                                 | Branch read-back satisfies write 1; no second push; proceed only toward the missing PR write                                 |
| Same request replayed after Published draft                                                                | Return the reconciled receipt; no remote write                                                                               |
| Intent ID replayed with changed repo/base/candidate/bundle/payload/profile/credential/branch               | Reject as identity conflict; no read result may broaden it                                                                   |
| Approval replayed for another intent/repository/run or candidate-producing attempt                         | Reject; record typed denial                                                                                                  |
| Approval expires before write 1                                                                            | Reads only; no write                                                                                                         |
| Approval expires after branch creation                                                                     | Preserve branch-only evidence; no PR write without fresh exact approval                                                      |
| Approval revoked or cancellation recorded before dispatch                                                  | No later dispatch                                                                                                            |
| Cancellation while write is in flight                                                                      | Mark Unknown, reconcile; never claim cancellation prevented the effect                                                       |
| Candidate bytes do not hash to `C`                                                                         | Non-waivable integrity denial                                                                                                |
| Candidate tree or ordered parents differ from intent/bundle                                                | Non-waivable integrity denial                                                                                                |
| Candidate is same tree but amended/rebased/recreated commit                                                | Reject as different candidate                                                                                                |
| Candidate/base/bundle/payload/profile evidence is stale or cross-attempt                                   | Reject; no publication                                                                                                       |
| Base drifts before branch write                                                                            | No write; require complete new publication chain                                                                             |
| Base drifts after branch write                                                                             | Retain branch only; no PR; require complete new chain                                                                        |
| Base drifts during/after PR write                                                                          | Preserve historical publication, mark readiness stale, require complete new chain                                            |
| Reserved branch name collision at exact `C` without prior dispatch proof                                   | Do not adopt automatically; human resolution                                                                                 |
| Reserved branch collision at another SHA                                                                   | Conflict; never update/force/delete                                                                                          |
| Branch response lost, branch reads exact `C` with matching dispatch evidence                               | Reconcile success; no duplicate push                                                                                         |
| Branch response lost, branch absent                                                                        | Unknown/non-effect not assumed; no blind retry                                                                               |
| Branch response/read-back unavailable or inconsistent                                                      | Unknown; reads only                                                                                                          |
| Human moves or deletes published branch                                                                    | Preserve observation; never repair or recreate                                                                               |
| Smart-Git ref create rejects after object transfer                                                         | No Published state; retain partial/unknown evidence; no cleanup write                                                        |
| PR response lost, one strict Expected PR appears                                                           | Bind remote identity after full read-back; no duplicate create                                                               |
| PR response lost, no match appears                                                                         | `pr_create_unknown_no_match`; no automatic retry                                                                             |
| PR response lost, multiple/partial matches appear                                                          | Ambiguous; no adoption or create                                                                                             |
| Existing closed PR uses expected branch/marker                                                             | Preserve closed evidence; do not reopen or create a replacement                                                              |
| Human edits known PR title/body                                                                            | Preserve edit; receipt remains authoritative; surface projection drift                                                       |
| Human changes base, closes, reopens, or marks ready                                                        | Preserve and classify; Publisher performs no inverse or follow-up mutation                                                   |
| PR head/ref/repository differs or branch diverges                                                          | Conflict; no branch or PR repair                                                                                             |
| Closing keyword absent in approved payload                                                                 | PR uses non-closing reference                                                                                                |
| Closing keyword added by candidate/agent but not intent                                                    | Payload validation rejects it                                                                                                |
| Explicit closing mode approved for wrong issue/repository                                                  | Reject identity mismatch                                                                                                     |
| Candidate changes `.github/workflows/**` or profile-defined policy/deployment path                         | Non-waivable first-release denial, regardless of passing tests                                                               |
| Repository settings/rulesets/workflows/Apps/integrations differ from profile                               | Profile stale/unknown; no write                                                                                              |
| Integration inventory cannot establish privilege or side effects                                           | Fail closed; human may publish manually without Workbench success claim                                                      |
| Wrong App/installation/repository/permission set returned by broker                                        | Credential-boundary denial                                                                                                   |
| Token, PAT, SSH socket, `gh` auth, or credential helper visible to candidate                               | Security failure; no publication and evidence quarantined                                                                    |
| Token expires before dispatch                                                                              | No write; obtain valid brokered authority only while approval remains valid                                                  |
| 401/403 before proven dispatch                                                                             | Stop and diagnose; no broader credential fallback                                                                            |
| 401/403/429/timeout after possible dispatch                                                                | Unknown plus reconciliation; no blind write retry                                                                            |
| Read is rate-limited                                                                                       | Respect headers/backoff within bounds; no write based on stale cache                                                         |
| Candidate config sets `core.hooksPath` or malicious pre-push hook                                          | Marker executable never runs; trusted adapter ignores candidate Git config/hooks                                             |
| Candidate/global config defines shell credential helper, SSH command, URL rewrite, proxy, or remote helper | No helper/shell executes; brokered trusted transport only                                                                    |
| Candidate attributes define executable filter                                                              | Publisher never checks out/converts candidate content; filter does not run                                                   |
| Candidate contains LFS pointers or LFS config                                                              | Unsupported without trusted profile adapter; no partial Git-only publication                                                 |
| Candidate requires commit/push signing                                                                     | Unsupported unless signature already belongs to certified commit and trusted profile handles all checks without side effects |
| Candidate contains/changes submodule metadata or needs submodule credentials                               | Unsupported; no traversal or credential expansion                                                                            |
| PR creation emits workflow/webhook/bot/preview activity                                                    | Fake/disposable evidence inventories it; unexpected or privileged activity fails profile                                     |
| Required CI succeeds at exact `C` from approved producer                                                   | Satisfies only that remote check, not human review                                                                           |
| Required CI is skipped or neutral                                                                          | Non-ready despite GitHub's successful-required-check semantics                                                               |
| Required CI is missing/pending/stale/cancelled/failing                                                     | Non-ready                                                                                                                    |
| CI success belongs to another SHA, synthetic merge only, wrong producer, or ambiguous context              | Non-ready unless the profile explicitly requires and separately proves the relevant head evidence                            |
| Human merge instruction names an older candidate/base/review snapshot/profile/CI set                       | Stale; no merge authority                                                                                                    |
| Receipt record is missing, corrupt, reordered, cross-intent, or digest-invalid                             | No success/readiness claim; reconcile or quarantine                                                                          |
| Fake adapter injects a crash before/after every durable dispatch and read-back event                       | No duplicate automatic write and no false Published state                                                                    |

## Remaining risks

- GitHub provides no transaction spanning object transfer, ref creation, PR creation, event delivery, and Workbench receipt persistence. A crash can always leave branch-only, PR-unknown, or locally unrecorded-but-remotely-observable evidence.
- Git smart transport can transfer objects even when a ref update is rejected. Workbench cannot promise that no unreachable object reached GitHub and authorizes no cleanup.
- GitHub does not document a PR-create idempotency key or a read-after-write bound. Empty reconciliation reads after an uncertain create do not prove non-effect.
- The base branch can move between observation and PR creation because create-PR accepts a base ref, not an expected base SHA.
- GitHub App Contents/Pull requests write permissions are broader than the accepted operations. A compromised credential broker, Publisher, Workbench installation, host OS, or GitHub account can exceed this contract.
- Repository APIs and checked-in workflows cannot prove complete knowledge of organization rules, GitHub Apps, dynamic integrations, notifications, external bots, previews, or downstream deployments. Maintainer inventory can be wrong or become stale.
- Webhooks, workflows, notifications, external integrations, and provider-side retries may duplicate or reorder effects. The receipt records observations; it cannot make other systems exactly once.
- Commit hashes bind Git object bytes, not code safety, test adequacy, issue satisfaction, or reviewer judgment. Verification and human review remain independent.
- Human edits may remove PR markers or move/delete refs, making an uncertain operation impossible to identify automatically. Preserving the human change takes priority over automatic convergence.
- A malicious Developer or maintainer can approve unsafe policy or publish manually. Workbench can record a denial and refuse its own authority but cannot control external terminals or GitHub administrators.
- Current Workbench lacks the Publisher, broker, durable publication store, trusted object source, #124 Review payload, exact-head PR CI, complete integration inventory, and settings enforcement described here.

## Responsibility and non-goals

| Responsibility                                                                      | Owner                |
| ----------------------------------------------------------------------------------- | -------------------- |
| Threat model, capabilities, untrusted content, and credential boundaries            | #161 / ADR 0016      |
| Durable ownership, fencing, cancellation, reconciliation, and Unknown outcomes      | #165 / ADR 0020      |
| Candidate assembly, Verification recipe/evidence/bundle, and Inner publication gate | #166 / ADR 0021      |
| Safe exact draft publication, Delivery profile, Expected PR, and receipt            | #167 / this decision |
| Review payload generation and intent/evidence presentation                          | #124                 |
| Repair/retry budgets and candidate regeneration                                     | #168                 |
| Human inspection/intervention UX                                                    | #169                 |
| Human merge gate                                                                    | ADR 0011             |

This decision creates no generic GitHub client, shell runner, Git wrapper, workflow engine, second Verification system, Review Brief implementation, deployment system, or merge automation. It authorizes documentation and later fake/disposable-fixture evidence only. No implementation, real publication, real credential use, repository-policy change, workflow rerun, merge, release, deployment, or external side effect was performed or approved as part of this research.

## Validation

The documentation branch passed `pnpm check`, 555 Vitest tests, and 442 Node tests. Existing tracker warnings for ADRs 0001, 0003, and 0004 and dependency sourcemap warnings remained non-failing. These repository checks validate the documentation change; they are not evidence that the proposed Publisher or adversarial test contract has been implemented.
