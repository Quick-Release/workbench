# Opinions ship as a versioned Factory baseline; host repos declare adoption; the runtime stays single-host

Status: accepted

Work item: none yet. Research and owner acceptance: `docs/research/software-factory-adoption-model.md` (PR #258, 2026-11-04).

Workbench is the foundation of the company's software factory: one set of opinions, applied to many host repos. Until now those opinions were spread over five unnamed places:

- defaults hard-coded in the package (`scripts/tracker/labels.mjs`, `src/data/skill-flow.mjs`);
- skills installed from upstream HEAD (`skills@latest … --all`);
- conventions docs copied into each host;
- tracker labels created by hand;
- gates that exist only in Workbench's own repository.

None of these was versioned, and nothing recorded which opinions a given host follows.

We decided on three things:

1. **One Factory baseline.** The opinions become one versioned artefact. The first one is the company baseline, `quick-release`, which ships as a module inside `@quick-release/workbench` and is versioned with the package.
2. **A committed Baseline adoption in each host repo.** Each host commits `.workbench/baseline.json`, which records `baseline: { id, version }`, the declared deviations, and `minWorkbenchVersion`. `workbench.config.json` stays local and uncommitted, because it mixes host data with each Developer's own opt-ins (sessions, clarification provider, theme). Committing it would push one Developer's opt-ins onto everyone, against the opt-in postures of ADRs 0014 and 0016.
3. **The runtime stays single-host.** One running instance still serves exactly one host repo. ADRs 0005, 0013 and 0020–0022 stand unchanged.

Skills are pinned as follows:

- The baseline pins `mattpocock/skills` and `Effect-TS/skills` to reviewed commit SHAs.
- Company-specific skills live in a company skills source that the baseline also pins.
- An upstream skill is forked only when it needs a change upstream won't take.
- Skills are not packaged as a Claude-only marketplace while Codex and Pi also run in the workflow (ADR 0018).

Hosts without a `package.json` get a first-class machine-level install (`npx @quick-release/workbench@<version>` or a global install):

- Workbench refuses to start below the adoption record's `minWorkbenchVersion`, and warns when it is more than one minor version ahead.
- The baseline ships a Renovate preset with a regex manager, so these hosts also receive upgrade PRs.
- 35 of the org's roughly 101 active repositories are PHP, so this path can't be second-class.

## Considered options

- **Keep opinions implicit inside each install (today's model)** — rejected: two hosts set up a week apart get different skills, and nothing can tell a host's deliberate deviation from accidental drift.
- **A central, repo-agnostic factory serving many host repos** — rejected:
  - it reverses ADR 0005's localhost seam;
  - it needs a multi-repo authority model that ADRs 0020–0022 don't have;
  - it can't ship under ADR 0013's public posture;
  - it would move code and issue content off the Developer's machine, against ADR 0001's "numbers, never content".

  If hosted execution comes back, #174 is the entry point.

- **A separate baseline package or Git repo now** — deferred: there is one opinion owner and one adopting host. The `id` field is shaped so that a later baseline can be resolved as a package or Git ref, the way Renovate resolves `extends`. The extraction happens when a second baseline exists.
- **Commit `workbench.config.json` as the adoption record** — rejected for the opt-in reason above.

## Consequences

- A host with no adoption record is treated as following the implicit baseline of its installed package version, which is exactly today's behaviour.
- The baseline fixes which opinions a host may deviate from, by opinion kind:

  | Opinion kind                        | How a host may deviate                                                                                                                      |
  | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | Label strings and triage role names | May be renamed through the adoption record. The role set itself is fixed.                                                                   |
  | Workflow phases                     | Fixed (ADRs 0007, 0010).                                                                                                                    |
  | Skills                              | Additions are free. Removing a baseline skill, or pinning one newer than the baseline, is a declared deviation. Pinning one older is drift. |
  | Conventions docs                    | May be customised.                                                                                                                          |
  | Gates                               | Not overridable here (ADR 0026).                                                                                                            |

  A host whose contract needs a different review flow gets a separate baseline id, not an override.

- Committing `.workbench/baseline.json` makes `.workbench/` partly tracked, so `workbench init` writes the gitignore negation. Moving run state out of the checkout into a machine-level store, as Factory 07 already wanted, gains urgency.
- Internal installs add the baseline id and version and the Conformance report counts to Telemetry. This is numbers only, within ADR 0001's posture; public installs report nothing, as ADR 0013 sets out. A cross-repo portfolio view is deferred until about five hosts have adopted.
