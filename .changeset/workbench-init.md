---
"@quick-release/workbench": minor
---

Add `workbench init`: an interactive subcommand that scaffolds `workbench.config.json` with clack prompts (per-field Zod validation, defaults inferred from git remotes, overwrite confirmation for existing configs). Falls back to a printed setup recipe in non-interactive environments. The default pipeline gains clack-formatted status output (intro, sync spinner, dev-server notice) and stays fully non-interactive.
