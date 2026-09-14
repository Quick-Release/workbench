# Factory 04: trusted task briefs, host readiness, and research context

Work item: GH-162

Research input for [#162](https://github.com/Quick-Release/workbench/issues/162), part of [#158](https://github.com/Quick-Release/workbench/issues/158). This note records the human-confirmed design decision after the Factory 04 grilling. It defines a context and readiness contract for the approved **Owned clarification** boundary; it does not authorize implementation, a pilot, provider usage, or a new execution capability.

## Decision in brief

Workbench will assemble a bounded, versioned **Context packet** for one **Clarification attempt**. The packet is an immutable projection of the selected issue, explicitly selected host-repository context, related planning records, installed skill inputs, and approved public research. It carries source provenance, freshness, content hashes, coverage warnings, and an authorization/data-flow manifest. It is evidence for a conversation, not permission to execute anything.

The packet feeds a task-profiled **Issue brief** contract. A **Clarification draft** may propose behavior, scope, exclusions, acceptance criteria, assumptions, and evidence, but a material gap remains visible until the Developer resolves it. An approved brief is the exact issue-body proposal the Developer accepts; publication is a separate, single-use issue update with a fresh revision check and read-back reconciliation.

Readiness is not one score. Workbench reports independent dimensions for tracker eligibility, brief completeness, host capability, research sufficiency, and authorization. Each dimension uses `ready`, `needs-information`, `unsupported`, or `unknown`; `blocked` is a reason, not a fifth top-level verdict. A clear implementation ticket may bypass clarification and use the existing flow.

Neither installed skills, issue text, repository instructions, external documentation, discovered commands, tool output, nor model output may expand the capability profile or approval. Project commands, package installation, registry resolution, scripts, hooks, tests, `--help`, source writes, Git operations, tracker writes, and publication outside the explicit issue-body approval remain outside this boundary.

## Provenance and method

The local baseline was inspected at [`7338a11535a145a1e46f4c571a89ab780c98d468`](https://github.com/Quick-Release/workbench/tree/7338a11535a145a1e46f4c571a89ab780c98d468), with the working tree clean. Relevant local sources included:

- `CONTEXT.md` and ADRs 0005, 0009, 0010, 0011, 0013, and 0014;
- `scripts/host/source-root.mjs`, `scripts/host/config.mjs`, `scripts/host/skills.mjs`, and `scripts/host/git-context.mjs`;
- `scripts/commands/sync-data.mjs`;
- `scripts/tracker/index.mjs`, `issues.mjs`, `edges.mjs`, `decisions.mjs`, and `gh-view.mjs`;
- `scripts/seam/routes/tools-api.mjs`, the request gate, and the existing AI sources;
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `skills-lock.json`;
- issues #120, #121, #125, #131, #132, #135, and the accepted Factory decisions #159–#161.

The fact-finding pass ran selected fixture suites with injected fakes: **76 tests passed**. No host project command, package script, model call, provider, GitHub publication, package installation, registry resolution, exploit, network probe, or pilot was run. Full project checks were not part of that read-only fact-finding pass; implementation validation remains a later development concern.

The external fact-finding pass consulted official documentation for [pnpm workspaces](https://pnpm.io/workspaces), [pnpm lockfiles](https://pnpm.io/lockfile), [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces), [npm package-lock](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json), [Yarn workspaces](https://yarnpkg.com/features/workspaces), [Bun workspaces](https://bun.sh/docs/pm/workspaces), [GitHub issues](https://docs.github.com/en/rest/issues/issues), [GitHub timelines](https://docs.github.com/en/rest/issues/timeline), [GitHub issue editing](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/editing-an-issue), [GitHub REST practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [GitHub webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [Better Auth versioned indexes](https://better-auth.com/llms.txt), [Better Auth's documentation MCP](https://better-auth.com/docs/ai-resources/mcp), and [Firecrawl's scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape).

## Current repository seam and gaps

Workbench already has useful collection and provenance precedents:

- `resolveSourceRoot()` handles an explicit source-root override, enclosing host repository, submodule superproject, demo source, standalone Workbench checkout, and fallback directory. The existing source-root tests cover these branches.
- `sync-data.mjs` assembles tracker state, blocker edges, map membership, ADRs, research-note artifacts, skills, configured services, Git branch/commit metadata, and optional session aggregates into a generated snapshot. It reports capped or failed tracker reads as warnings rather than treating missing data as empty certainty.
- The tracker separates open/unassigned/unblocked frontier eligibility from triage state, workflow phase, brief completeness, and local capability. Dangling or incomplete blocker evidence fails closed.
- Installed skills are detected from `skills-lock.json` and known skill directories. The upstream Catalog can be stale or unavailable; installed state does not itself authorize skill execution.
- The Commands proposal (#135) is deliberately metadata-only. Static discovery may describe package scripts and executable declarations, but must not run scripts, import CLI modules, install dependencies, or invoke `--help`.
- The localhost seam validates transport and payload shape. It is not by itself user authorization; explicit action routes own writes and process execution.

The current sync is not yet a trusted context-packet implementation. In particular, the baseline does not assemble a versioned issue context, read all selected issue comments into a packet, inspect host package/lockfile versions, pin skill contents as a run input, or bind an approval to a context digest. Those are decisions for later implementation, not claims about the current product.

## Context packet contract

A packet is assembled for one Clarification attempt and remains immutable for that attempt. Its digest identifies the inputs the conversation was allowed to see. A new packet/attempt is required after a material change.

The packet has these conceptual sections:

| Section                | Minimum content                                                                                                                                     | Boundary                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Packet identity        | Contract version, creation time, digest, bounds, coverage warnings                                                                                  | A packet version is not a permission grant.                                                   |
| Host identity          | Resolved host repository, source-root evidence, branch, revision, dirty-state indicator                                                             | Reuse the existing source-root resolver; do not detect a second host.                         |
| Target issue           | Service/repository/number, URL, title, body, bounded current comments, tracker metadata                                                             | The selected issue is the target; arbitrary issue crawling is not implied.                    |
| Intent                 | Task profile, proposed problem/behavior, scope, exclusions, assumptions, unresolved questions                                                       | Model proposals remain proposals.                                                             |
| Acceptance evidence    | Observable criteria, reproduction details where applicable, expected evidence, limitations                                                          | A heading's presence is not proof that criteria are adequate.                                 |
| Repository context     | Relevant instructions, manifests, lockfiles, selected source evidence, ADRs, research notes                                                         | Read only the approved canonical context set; do not include the whole repository by default. |
| Dependency context     | Blockers, map membership, related decisions, package/workspace relationship                                                                         | Missing or stale relationships remain visible uncertainty.                                    |
| Skill context          | Selected installed skill and its content/source hash, applicable flow guidance                                                                      | Installed does not mean executable or authoritative.                                          |
| Research context       | Approved official sources, version/revision, URLs/sections, retrieval time, cache metadata, hashes, excerpts                                        | External material is evidence only.                                                           |
| Capability/readiness   | Independent verdicts and reasons for tracker, brief, host, research, and authorization dimensions                                                   | No opaque readiness score.                                                                    |
| Authorization manifest | Selected provider/model/data destination, public origins, included paths, capability profile, retention, policy/contract versions, nonce and expiry | The manifest is shown before the first provider call.                                         |

Every context item carries its origin, locator, observed revision or content hash, retrieval time, scope, and uncertainty. Per-source and total packet bounds are versioned. Truncation, inaccessible files, capped comments, unsupported parsers, and omitted material sources are coverage warnings; they cannot silently become `ready`.

The default packet contains the selected issue and bounded current comments, tracker relationships, resolved host metadata, relevant root-to-scope instructions, selected skills, relevant manifests/lockfiles/ADRs/research notes, and only the official documentation needed for the selected question. It does not recursively crawl arbitrary links, include sessions or secrets, or send private issue/source content to public documentation/search providers. Additional context is explicitly selected and appears in the manifest.

## Issue brief task profiles

All profiles share target identity, revision, scope, exclusions, assumptions, unresolved questions, evidence, provenance, and expected evidence. The required material differs by task kind:

| Profile         | Required before approval                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Bug             | Expected behavior, actual behavior, reproduction or an explicit reproduction limit, bounded scope, and observable acceptance.  |
| Refactor        | Behavior-preservation goal, bounded scope, exclusions, observable acceptance, and explicit evidence for any performance claim. |
| Feature/request | Intended behavior, user/system boundary, scope, exclusions, acceptance, and relevant dependencies or decisions.                |
| Unknown         | Human classification or clarification; Workbench must not silently classify it as a feature.                                   |

A complete structural section does not establish semantic quality. The runtime may research facts and suggest answers, but product intent, scope, contradictory requirements, acceptance decisions, and material security/privacy/compatibility choices return to the Developer. Material assumptions cannot remain in an approved Issue brief. Minor uncertainty may remain visibly labelled.

## Provenance and authority

Provenance answers “where did this material come from and which revision was observed?” It does not answer “may this material grant permission?” Keep those separate:

- **Origin:** tracker, Developer input, host file, skill, dependency metadata, decision, external documentation, or model-derived.
- **Locator and freshness:** URL/path, issue/comment identity, commit or lockfile revision, content hash, retrieval time, and relevant API/cache metadata.
- **Claim state:** observed, derived, proposed, or unknown.
- **Authority:** evidence, host-policy input, Developer decision, or no authority. Authority is established by the Workbench contract or explicit Developer action, never merely by origin.

Issue text, comments, source, instructions, skills, docs, tool output, and model output are untrusted content. A model-generated explanation or an author-written command description cannot suppress conflicting source evidence or expand the capability profile.

## Revision and freshness rules

The target revision is a composite rather than GitHub `updated_at` alone. It includes the service/repository/issue identity, API version and fetch time, `updated_at`, title/body digest, selected comment IDs and content digest, and relevant tracker metadata digest. GitHub exposes issue bodies and comments through separate reads and does not establish a complete REST body-history feed; therefore Workbench must re-read the current issue immediately before publication and compare the exact expected body/diff.

The packet or approval becomes stale when any material input changes:

- selected issue title/body/comment or relevant tracker metadata;
- labels, assignees, blocker edges, map membership, or linked decisions;
- included file, instruction, ADR, research, manifest, lockfile, or skill hash;
- resolved dependency version or package/workspace scope;
- provider/model/data destination;
- capability, policy, or contract version;
- visible issue-body diff;
- expiry or prior use of the approval.

Unrelated repository changes need not invalidate the packet. A stale or replayed approval produces a typed denial and preserves local work.

## Host and dependency context

Host support begins with declarative metadata and never with package-manager execution. Recognized adapters may inspect:

- pnpm workspace declarations and `pnpm-lock.yaml`;
- npm workspaces and `package-lock.json`;
- Yarn workspace/package-manager metadata and `yarn.lock`;
- Bun workspaces and `bun.lock`.

A dependency record preserves the declared specifier, resolved version, workspace/package path, dependency role, peer context, overrides/catalogs, source protocol, integrity or revision, and platform/optional conditions where available. Multiple resolved versions remain distinct.

Manifest ranges are not exact versions. A missing, malformed, stale, or inconsistent lockfile does not trigger installation, registry resolution, or lockfile rewriting; it is `unknown`. Existing installed package metadata may corroborate a lockfile but cannot silently override conflicting evidence. A package-manager command is not a metadata read: installation can resolve, fetch, link, build, run lifecycle scripts, mutate lockfiles/caches, or access private registries.

Monorepos use declared workspace membership and an explicit package scope; recursive `package.json` discovery is not a project boundary. Non-Node hosts can be clarification-ready through the generic packet while implementation command/dependency capability remains `unknown` or `unsupported`.

## Documentation and public research

The documentation policy is:

1. use version-matched official documentation, release-tagged official source, or official tests;
2. use #132's version-aware official documentation broker when it has a matching source;
3. use optional Firecrawl only as a bounded retrieval transport, never as authority.

Public queries contain only the minimum generic library/topic/version information. Private issue text, private source, secrets, tokens, private registry URLs, and unrelated lockfile content do not enter public queries. A current page without a matching version is labelled current/unpinned; it cannot be presented as an installed-version prescription. Firecrawl cache age, PII controls, and response handling do not prove an upstream package or documentation revision.

Retrieved docs retain URL/section, source version or revision where available, retrieval time, cache metadata, and content hash. Missing, offline, stale, or version-inapplicable docs reduce research sufficiency to `unknown`; they do not trigger an unlabeled model-memory fallback. Documentation, skills, and fetched content cannot authorize tools or broaden scope.

## Readiness contract

Readiness is reported independently for at least these dimensions:

| Dimension            | `ready` means                                                                                      | `needs-information`                                                        | `unsupported`                                              | `unknown`                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Tracker eligibility  | Required issue identity/state/relationship facts are current and complete for the requested action | A human must resolve a tracker decision                                    | The requested tracker operation is outside the contract    | Reads are missing, capped, stale, or contradictory              |
| Brief completeness   | Required profile fields and observable acceptance are present without material contradiction       | Intent, scope, reproduction, acceptance, or a material decision is missing | The requested brief profile is not supported               | Evidence quality or applicability cannot be established         |
| Host capability      | Required host metadata/context sources are available                                               | A human must select/narrow the host context                                | Host type or requested capability has no supported adapter | Manifest/lockfile/source capability is unavailable or ambiguous |
| Research sufficiency | Relevant evidence is version-applicable, bounded, and provenance-bearing                           | A human must choose among material alternatives                            | Requested source/research route is outside policy          | Retrieval, version, freshness, or coverage is incomplete        |
| Authorization        | Current approval covers the exact host, packet, provider, destination, capability, and action      | Developer approval or correction is required                               | Requested action is outside the capability profile         | Binding, destination, or policy state cannot be verified        |

`blocked` is a dimension-specific reason, not another top-level verdict. A clarification may begin with an incomplete brief when the Developer explicitly starts it, but an approved Issue brief and publication may not hide `needs-information` or material `unknown` results. Tracker frontier eligibility is reported separately and is not silently equated with brief or implementation readiness.

## Clarification lifecycle

1. **Prepare:** Workbench reads bounded local/tracker metadata and shows the packet preview and readiness. It performs no model call, public research call, command execution, or tracker mutation.
2. **Start clarification:** the Developer approves the data-flow manifest, selected provider/model, public origins, capability profile, retention, and packet digest. This creates one approval-bound Clarification attempt.
3. **Draft:** Pi proposes behavior, scope, exclusions, acceptance, assumptions, and evidence. Workbench saves local drafts; saved work is not publication permission.
4. **Approve publication:** the Developer approves the exact visible issue-body diff.
5. **Publish and reconcile:** Workbench re-reads the issue, checks the composite revision, performs only the approved issue-body update, then reads the result back. An uncertain response is reconciled against actual tracker state before any retry.

Browser disconnect detaches from the view under the downstream session contract; interruption preserves incomplete work and requires an explicit retry. Provider, scope, packet, capability, or policy changes require a new start approval. Publication approval is single-use.

## Command and skill boundaries

A statically discovered command is a **command candidate**, not a verifier and not permission. #135 may report an exact script/declaration, working directory, effects, source evidence, and unresolved behavior without executing the command, importing project modules, installing dependencies, or invoking `--help`.

A future verifier must be separately reviewed and bound to an exact command, directory, revision, environment names, effects, fixtures/services, and expected evidence. Owned clarification has no project-command verifier capability.

A selected installed skill is a context input with a recorded source/hash. It is not an execution grant. Ask Matt remains a routing and preparation aid, not an automatic workflow transition or capability escalation.

## Ownership and reuse

| Concern                | Existing owner and Factory 04 extension                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starter preview/export | #120 owns the Developer-facing starter and bounded packet preview; it must not execute, call a model, or mutate the tracker.                            |
| Readiness              | #121 owns independent readiness dimensions and visible reasons; it must not become an opaque score or new state machine.                                |
| Host capability        | #125 owns source-root, manifest/lockfile, skill, service, and local capability discovery; it must remain read-only and host-specific.                   |
| Official patterns      | #132 owns version-aware official documentation retrieval and evidence; it must not send private repository content to public providers.                 |
| Commands               | #135 owns read-only command candidates; discovery cannot grant verifier permission.                                                                     |
| Pi review/conversation | #131 and #133 own the shared Pi conversation, transcript, and event semantics; the coordinator must not create a second chat/session system.            |
| Owned clarification    | The Workbench coordinator joins these records into the packet, owns attempt lifecycle and approval binding, and owns exact issue publication/read-back. |

Clear implementation tickets can bypass Owned clarification and enter the existing composable skill flow. There is no mandatory factory discovery phase, automatic skill chaining, readiness-label promotion, second readiness scorer, second command catalog, or second documentation broker.

## Worked fixture journeys

### Ready bug

A synthetic issue states the expected and actual behavior, gives a bounded reproduction description, defines in/out scope, and lists observable acceptance criteria. Static repository metadata identifies the relevant host/package and version-qualified official evidence. The packet reports complete provenance and no material contradictions. Owned clarification may start after the Developer approves the manifest. The Developer may approve and publish the exact issue-body diff; this still authorizes no reproduction command or code change.

### Ambiguous client report

A synthetic client issue says only “make invitations secure.” It does not establish expected behavior, tenant boundaries, scope, or acceptance. Research can surface documented options and questions, but the brief dimension is `needs-information`; the Developer must resolve the material choices. No implementation-ready brief or issue publication is allowed merely because the model produced a plausible proposal.

### Narrow refactor

A synthetic refactor request states the behavior to preserve, the bounded paths, exclusions, and acceptance. Clarification can be skipped and the existing implementation flow used. If clarification is chosen, an approved proposal still does not authorize source edits, tests, or a performance claim without evidence.

### Non-Node host

A synthetic non-Node host has a clear issue and repository instructions but no supported package-manager or command adapter. Generic clarification context can be `ready`; implementation command and dependency capability remains `unknown` or `unsupported`. Workbench must not invent a Node command or claim that a missing adapter proves the host cannot be implemented.

## Rejected alternatives and remaining uncertainty

- **One readiness score:** rejected because tracker eligibility, brief quality, host capability, research applicability, and authorization have different owners and failure meanings.
- **Runtime probing to fill context gaps:** rejected because `--help`, installation, imports, scripts, and tests can have side effects and do not create approval.
- **Latest documentation as the default:** rejected because it can describe a newer API than the resolved dependency.
- **Broad external crawling:** rejected because it increases private-data egress, prompt-injection surface, and unreviewable context.
- **A universal parser or language-specific gate:** rejected because generic clarification should work for non-Node hosts while unsupported implementation capabilities stay explicit.
- **Automatic factory phases:** rejected because clear tickets must retain the existing composable skill flow.

Numeric resource limits, concrete lockfile adapters, Pi transport, durable packet storage, OS-level isolation, coding profiles, verifier execution, detailed UI, and pilot criteria remain downstream decisions. This note does not claim that any current implementation enforces the contract.

## References

- [Factory 01 Resolution / #159](https://github.com/Quick-Release/workbench/issues/159)
- [Factory 02 Resolution / #160](https://github.com/Quick-Release/workbench/issues/160)
- [Factory 03 Resolution / #161](https://github.com/Quick-Release/workbench/issues/161)
- [Guided Skill Starter / #120](https://github.com/Quick-Release/workbench/issues/120)
- [Agent Readiness / #121](https://github.com/Quick-Release/workbench/issues/121)
- [Host Repo Doctor / #125](https://github.com/Quick-Release/workbench/issues/125)
- [Pi Review Sessions / #131](https://github.com/Quick-Release/workbench/issues/131)
- [Official Pattern Reviews / #132](https://github.com/Quick-Release/workbench/issues/132)
- [Commands catalog / #135](https://github.com/Quick-Release/workbench/issues/135)
- [ADR 0009: decisions and artifacts](../adr/0009-decisions-and-artifacts-collect-at-sync.md)
- [ADR 0014: Owned clarification boundary](../adr/0014-owned-clarification-boundary.md)
- [GitHub REST issue documentation](https://docs.github.com/en/rest/issues/issues)
- [GitHub REST timeline documentation](https://docs.github.com/en/rest/issues/timeline)
- [pnpm lockfile documentation](https://pnpm.io/lockfile)
- [npm package-lock documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json)
- [Yarn workspaces documentation](https://yarnpkg.com/features/workspaces)
- [Bun workspaces documentation](https://bun.sh/docs/pm/workspaces)
- [Better Auth versioned documentation indexes](https://better-auth.com/llms.txt)
- [Better Auth documentation MCP](https://better-auth.com/docs/ai-resources/mcp)
- [Firecrawl scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
