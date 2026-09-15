# Failure taxonomy, repair limits and usage budgets

Status: accepted

Work item: GH-168

Workbench will classify known run outcomes separately from Unknown outcomes and map each classification to an explicit, bounded next action. The first product remains read-only Owned clarification and permits no automatic implementation repair; after dispatch, execution/provider/tool retries and repairs are manual Developer actions that create fresh Execution attempts. Only one coordinator retry is allowed when durable evidence proves that no provider or tool dispatch occurred, and Pi automatic retries are disabled so provider activity cannot escape Workbench accounting. Read-only reconciliation and authorized same-intent publication convergence under #167 are not execution retries.

A durable Usage budget belongs to the Operational run record and spans attempts and restarts. Workbench-enforced resource limits are distinct from provider-reported tokens/cost, estimates, and unknown subscription availability. Unknown effects, quota, credentials, policy denial, unsupported environments, repeated failures, and uncertain cancellation fail closed or await human resolution; they never trigger blind replay, silent fallback, or invented success. A future coding profile must satisfy #162's brief/readiness boundary, #163's enforceable Execution backend, #165's durable ownership and reconciliation, #166's independent verification, #167's safe publication, and #169's intervention boundary, with justified numeric limits, before enabling coding repair or automatic recovery.

This decision preserves #160–#167's ownership boundaries: #165 owns durable attempts, fencing, reconciliation, and Unknown outcomes; #166 owns independent verification and invalidation after a new candidate; #167 owns publication reconciliation; #122 and #133/#164 retain checkpoint and Pi-session semantics. It authorizes documentation and later synthetic fixture validation only, not a retry implementation, provider use, coding execution, backend selection, or GitHub publication.
