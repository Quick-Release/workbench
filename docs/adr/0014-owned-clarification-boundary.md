# Owned clarification stops at an explicitly approved issue brief

Status: accepted

Work item: GH-159

The Developer selected intent clarification, not issue-to-PR execution, as the first valuable result of the factory investigation. Workbench's approved product direction is an embedded clarification experience keeping the selected issue, researched proposal and evidence together: the agent proposes concrete behavior, scope and acceptance criteria with labeled assumptions; the Developer corrects them and explicitly approves the visible issue-body diff. This is a design decision, not shipped functionality or implementation authorization; the full Resolution belongs to [#159](https://github.com/Quick-Release/workbench/issues/159), supported by the [research note](../research/factory-first-run-boundary.md).

## Authority boundary

Starting an owned clarification run authorizes relevant host-repo/tracker reads and public-source research through the visibly selected model/data destination, not execution of project commands. Private repo/issue content must not appear in public web queries. Proposals, answers and evidence are saved; saved state is not publication permission. Workbench manages only clarification runs it starts. Externally started sessions remain observed, not controlled.

“Approve and update issue” accepts the displayed proposal and authorizes only its issue-body update. Material readiness gaps and unseen concurrent edits block approval/publication; uncertain publication must be reconciled before retry. Interruption preserves incomplete saved work and requires an explicit retry, without promising live-process recovery. Provider/scope changes or other writes require fresh approval. Brief approval never authorizes implementation, ticket creation, readiness-label changes, merge or deployment.

## Considered options

- **Proposal-first skills alone:** the smallest comparator and fallback. Embedding is chosen to keep issue, proposal and evidence together, not because a skill cannot propose intent. Its incremental value remains unproven.
- **Harden the existing issue runner:** separate maintenance, not a solution to the selected clarification problem by itself.
- **Managed coding runs or an external factory:** not required for an approved brief; no demonstrated clarification benefit justifies those responsibilities here. Architecture selection remains for #160.

## Consequences

- Narrows ADR 0005's deferred session authority: owned clarification may be acted on through the existing validated localhost seam; viewing external sessions does not grant control. Starting research and approving publication are distinct authorization events.
- Narrows ADR 0010's dashboard-prompt and cloud-model exclusions only for this clarification capability. Its coding runner retains its fixed prompt, local-model and draft-PR semantics. A later draft PR is not prior authorization for clarification or issue publication.
- The pilot cohort is the Developer's Linux setup, Pi with OpenAI Codex OAuth and one trusted GitHub host repo per install. This is not a general public-platform/provider support promise or approval for remote execution.
- No second implementation workflow: clear tickets can skip clarification through the existing flow without skipping that flow's safety checks. No automatic intake, project execution, code edits, ticket decomposition, fleets, external-session control, remote execution, merge or deployment in this scope.
- Persistence of proposals does not expand ADR 0009's modeled Artifact collector. Storage, runtime, enforcement mechanisms and bounded resource policies still need downstream decisions; no schema or runtime architecture is selected here.
- Evaluation uses existing internal reporting for content-free workflow events plus explicit Developer assessments for both approaches; elapsed model time is not active Developer effort. Proposals/prompts/source excerpts are not Telemetry, and public reporting remains dormant under ADR 0013. This does not create a new Session capture permission.
- The six-task value comparison and stop rule are prospective, not evidence of benefit. Failed value means return to useful skill behavior rather than expand into a coding factory; inconclusive evidence permits one bounded repeat and then reassessment. See the Resolution for the measurement contract.
