---
"@quick-release/workbench": minor
---

Pull-requests page: the open host-repo pull requests render from the synced snapshot (read-only rows with number, title, author, head → base, and draft flag) behind a new sidebar entry, and each row carries a one-shot "Draft description" action that posts only the PR number to the dev-server draft endpoint, shows a drafting state, and renders the returned title and body in a copyable panel; an in-flight draft is aborted by the next one, failures render readable errors, and a missing provider key renders a configuration hint instead of a broken action (#38).
