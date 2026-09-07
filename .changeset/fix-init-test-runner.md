---
"@quick-release/workbench": patch
---

The `pnpm test` gate is green again on Node 22 and 24 (issue #69). The init suite drives clack through synthesized keypress events instead of raw keystroke bytes, whose terminal decoding garbled control keys on mock streams and deadlocked the interactive flow. Cancelling at the token-env prompt no longer crashes `runInit` with a TypeError; the cancel flows out to the caller's `isCancel` check like every other prompt.
