---
"@quick-release/workbench": patch
---

Fixed: git probes no longer inherit the caller's git context. A pre-commit hook exports `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` to everything it spawns — including the test suite behind the new pre-commit gate — which redirected `workbench init`'s origin probe (deadlocking its suite) and made `prepare`'s repo detection treat any directory as a repository (pointing the caller's `core.hooksPath` at workbench). The init and prepare git subprocesses, and the suites' fixture git calls, now strip that context.
