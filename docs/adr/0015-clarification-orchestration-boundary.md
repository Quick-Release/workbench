# Keep clarification orchestration inside Workbench's seam

Status: accepted

Work item: GH-160

Workbench's first factory result is the embedded **Owned clarification** selected by #159, not a coding factory. Workbench therefore owns the deterministic clarification lifecycle, attempt/cancellation/retry rules, capability policy, saved draft, approval invalidation, and the one explicitly approved issue-body publication. Pi, through the shared conversation boundary proposed by #133, owns the runtime conversation and transcript; it proposes content and emits observations or typed capability requests but cannot transition Workbench state or publish to GitHub. The first adapter supports one reviewed Pi runtime behind a narrow port. Existing Review runs and Agent runs retain their contracts. No external factory runtime is adopted because Ramure, Symphony, and Mastra either add runtime and policy surfaces that overlap Workbench or couple the solution to assumptions not established for this product boundary; their useful patterns may be reused without taking their runtimes.

## Considered options

- **A generic factory runtime:** rejected. It would introduce a second authority for lifecycle, sessions, persistence, tracker integration, approvals, and packaging before the approved clarification problem requires those responsibilities.
- **Directly extend the review-shaped runner:** rejected as a domain contract. The existing seam and low-level process/event patterns are reusable, but clarification approval and issue-body publication must not inherit Review run or Agent run semantics.
- **Adopt Ramure, Symphony, or Mastra as the runtime:** rejected for the first result. Their inspected implementations provide useful patterns, but add dependencies or assumptions without evidence of improved intent clarification and would duplicate Workbench's tracker, skill, session, or approval responsibilities.
- **Use proposal-first skills only:** retained as the fallback and comparator. Embedding remains the selected interaction because the issue, proposal, and evidence stay together.

## Consequences

- Clarification state and Pi transcript have separate owners; Workbench must not create a competing transcript or event store.
- A saved draft is not an approval, and an approved issue-body diff does not authorize implementation, commands, labels, tickets, code changes, merge, or deployment.
- Provider/data-destination, scope, capability-policy, issue-revision, or incompatible contract changes invalidate pending approval.
- Browser disconnect may detach from a live owned attempt; process failure does not promise automatic recovery. Uncertain GitHub publication requires reconciliation before retry.
- #161 owns concrete threat and credential enforcement, #162 owns readiness/context depth, #164 owns Pi RPC-versus-SDK validation, and #165 owns durable storage and crash recovery. This ADR does not authorize implementation or select a database schema or workflow DSL.
