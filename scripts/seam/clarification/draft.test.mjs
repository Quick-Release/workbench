import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import test from "node:test";

import { READINESS_VERDICTS } from "./context-packet.mjs";
import {
  BRIEF_COMPLETENESS_VERDICTS,
  DRAFT_ENVELOPE_VERSION,
  PROVENANCE_KINDS,
  TASK_PROFILES,
  briefCompletenessFor,
  briefGapsFor,
  publicationBodyFor,
  renderIssueBodyDiff,
  validateClarificationDraft,
} from "./draft.mjs";
import {
  clarificationDraftProvenanceKinds,
  clarificationDraftVersion,
  clarificationTaskProfiles,
} from "../../../src/types.ts";

// Contract tests for the Clarification draft (spec #221, ticket #233, ADR
// 0017): the attempt's proposal as a typed document — task profiles gating
// brief completeness, every claim carrying its provenance kind, the issue
// body publication would write serialized deterministically, and the
// visible diff rendered from exactly that serialization. Everything here is
// pure: no store, no tracker, no clock.

test("the draft's vocabulary never drifts from the browser-facing mirrors", () => {
  // The draft module owns the task-profile and provenance-kind vocabularies;
  // the browser-facing schema mirrors them for validation. Neither side may
  // move without the other — the same fence the store keeps for the
  // lifecycle states.
  deepStrictEqual([...TASK_PROFILES], [...clarificationTaskProfiles]);
  deepStrictEqual([...PROVENANCE_KINDS], [...clarificationDraftProvenanceKinds]);
  strictEqual(DRAFT_ENVELOPE_VERSION, clarificationDraftVersion);
});

test("the brief-completeness verdicts are the readiness vocabulary's own", () => {
  // The draft read answers only the two verdicts brief completeness can
  // honestly carry, and they must remain members of the multi-dimensional
  // readiness vocabulary — never a fifth word.
  for (const verdict of BRIEF_COMPLETENESS_VERDICTS)
    ok(READINESS_VERDICTS.includes(verdict), `"${verdict}" is a readiness verdict`);
  deepStrictEqual([...BRIEF_COMPLETENESS_VERDICTS], ["ready", "needs-information"]);
});

const provenance = (overrides = {}) => ({
  kind: "model",
  source: "clarification conversation",
  locator: "attempt_1 turn 3",
  ...overrides,
});

const bugDraft = (overrides = {}) => ({
  version: DRAFT_ENVELOPE_VERSION,
  profile: "bug",
  behavior: "the sync command exits 0 on a clean tree",
  observation: "it exits 1 with a lockfile warning",
  reproduction: "run pnpm sync on a clean checkout",
  boundary: "",
  scope: "scripts/sync only; no tracker writes",
  exclusions: ["the pack-smoke harness"],
  acceptance: ["sync exits 0 on a clean tree"],
  dependencies: "",
  performanceClaim: "",
  performanceEvidence: "",
  assumptions: [
    {
      label: "lockfile version",
      text: "lockfile v9 stays",
      material: false,
      provenance: provenance(),
    },
  ],
  evidence: [
    {
      claim: "sync reads the lockfile",
      provenance: provenance({ kind: "tracker", source: "issue", locator: "#230 body" }),
    },
  ],
  ...overrides,
});

test("a valid draft validates and comes back unchanged", () => {
  const draft = bugDraft();
  deepStrictEqual(validateClarificationDraft(draft), draft);
});

test("a draft that is not shaped like the contract is refused with every reason named", () => {
  throws(
    () => validateClarificationDraft(bugDraft({ version: "clarification-draft/v2" })),
    (error) => error.code === "invalid_draft" && /envelope/.test(error.message),
  );
  throws(
    () => validateClarificationDraft(bugDraft({ profile: "chore" })),
    (error) =>
      error.code === "invalid_draft" &&
      /bug, refactor, feature-request, unknown/.test(error.message),
  );
  throws(
    () => validateClarificationDraft(bugDraft({ behavior: 7 })),
    (error) => error.code === "invalid_draft" && /behavior must be a string/.test(error.message),
  );
  throws(
    () => validateClarificationDraft(bugDraft({ exclusions: ["", "ok"] })),
    (error) => error.code === "invalid_draft" && /exclusions/.test(error.message),
  );
  throws(
    () => validateClarificationDraft(bugDraft({ scope: undefined })),
    (error) => error.code === "invalid_draft" && /scope must be a string/.test(error.message),
  );
  // A field the contract never declared is not a draft field.
  throws(
    () => validateClarificationDraft(bugDraft({ verdict: "ready" })),
    (error) => error.code === "invalid_draft" && /"verdict" is not a field/.test(error.message),
  );
});

test("every claim must carry a provenance kind, a source, and a locator", () => {
  // A claim that cannot show where it came from is not a claim — the same
  // posture the context packet's provenance gate takes, one tier down.
  throws(
    () =>
      validateClarificationDraft(
        bugDraft({
          evidence: [
            {
              claim: "sync reads the lockfile",
              provenance: { kind: "gossip", source: "x", locator: "y" },
            },
          ],
        }),
      ),
    (error) => error.code === "invalid_draft" && /provenance kind/.test(error.message),
  );
  throws(
    () =>
      validateClarificationDraft(
        bugDraft({
          assumptions: [{ label: "l", text: "t", material: false, provenance: { kind: "model" } }],
        }),
      ),
    (error) =>
      error.code === "invalid_draft" &&
      /names no source/.test(error.message) &&
      /names no locator/.test(error.message),
  );
  throws(
    () =>
      validateClarificationDraft(bugDraft({ evidence: [{ claim: "", provenance: provenance() }] })),
    (error) => error.code === "invalid_draft" && /carries no claim/.test(error.message),
  );
  throws(
    () =>
      validateClarificationDraft(
        bugDraft({
          assumptions: [{ label: "", text: "t", material: false, provenance: provenance() }],
        }),
      ),
    (error) => error.code === "invalid_draft" && /carries no label/.test(error.message),
  );
});

test("an unmet task-profile minimum is a named gap", () => {
  // Bug minimums (the task-brief research table): expected behavior, actual
  // behavior, reproduction or an explicit reproduction limit, bounded
  // scope, observable acceptance.
  deepStrictEqual(briefGapsFor(bugDraft()), []);
  deepStrictEqual(briefGapsFor(bugDraft({ observation: "", reproduction: "" })), [
    "no actual behavior is written",
    "neither a reproduction nor an explicit reproduction limit is written",
  ]);
});

test("a refactor is gated on exclusions and evidence for performance claims", () => {
  const refactor = bugDraft({
    profile: "refactor",
    behavior: "behavior is preserved",
    observation: "",
    reproduction: "",
    exclusions: [],
  });
  deepStrictEqual(briefGapsFor(refactor), ["no exclusions are declared"]);
  deepStrictEqual(
    briefGapsFor({
      ...refactor,
      exclusions: ["no public API changes"],
      performanceClaim: "30% faster",
    }),
    ["a performance claim is written without evidence for it"],
  );
  deepStrictEqual(
    briefGapsFor({
      ...refactor,
      exclusions: ["no public API changes"],
      performanceClaim: "30% faster",
      performanceEvidence: "bench from the pack-smoke harness",
    }),
    [],
  );
});

test("a feature request is gated on its boundary and its dependencies or decisions", () => {
  const feature = bugDraft({
    profile: "feature-request",
    behavior: "the panel renders the draft",
    observation: "",
    reproduction: "",
  });
  deepStrictEqual(briefGapsFor(feature), [
    "no user/system boundary is written",
    "no relevant dependencies or decisions are recorded",
  ]);
  deepStrictEqual(
    briefGapsFor({
      ...feature,
      boundary: "the Developer in the issue panel",
      dependencies: "none identified",
    }),
    [],
  );
});

test("an unclassified profile stays needs-information and is never silently a feature", () => {
  const gaps = briefGapsFor(bugDraft({ profile: "unknown" }));
  deepStrictEqual(gaps, [
    "the task profile is unclassified — the Developer classifies it; it is never silently a feature",
  ]);
});

test("a material assumption cannot silently pass brief completeness", () => {
  const draft = bugDraft({
    assumptions: [
      {
        label: "scope",
        text: "the tracker API stays stable",
        material: true,
        provenance: provenance(),
      },
    ],
  });
  deepStrictEqual(briefGapsFor(draft), [
    'the material assumption "scope" needs the Developer\'s resolution',
  ]);
});

test("brief completeness is ready exactly when no gap remains", () => {
  deepStrictEqual(briefCompletenessFor(bugDraft()), { verdict: "ready", gaps: [] });
  const incomplete = briefCompletenessFor(bugDraft({ scope: "" }));
  strictEqual(incomplete.verdict, "needs-information");
  deepStrictEqual(incomplete.gaps, ["no bounded scope is written"]);
});

test("the publication body serializes the draft deterministically, in a fixed order", () => {
  const body = publicationBodyFor(bugDraft());
  // The same draft always serializes to the same bytes.
  strictEqual(body, publicationBodyFor(bugDraft()));
  // Empty sections do not appear; present sections appear in fixed order.
  ok(!body.includes("User and system boundary"));
  ok(!body.includes("Dependencies and decisions"));
  const behaviorAt = body.indexOf("## Behavior");
  const actualAt = body.indexOf("## Actual behavior");
  const scopeAt = body.indexOf("## Scope");
  const exclusionsAt = body.indexOf("## Exclusions");
  const acceptanceAt = body.indexOf("## Acceptance criteria");
  const assumptionsAt = body.indexOf("## Assumptions");
  const evidenceAt = body.indexOf("## Evidence");
  ok(behaviorAt !== -1 && actualAt !== -1 && scopeAt !== -1);
  ok(behaviorAt < actualAt && actualAt < scopeAt && scopeAt < exclusionsAt);
  ok(exclusionsAt < acceptanceAt && acceptanceAt < assumptionsAt && assumptionsAt < evidenceAt);
});

test("the publication body carries assumption labels and provenance kinds", () => {
  const body = publicationBodyFor(bugDraft());
  ok(body.includes("- [lockfile version] lockfile v9 stays"));
  ok(body.includes("sync reads the lockfile (_tracker_: issue #230 body)"));
});

test("a material assumption is marked in the publication body", () => {
  const body = publicationBodyFor(
    bugDraft({
      assumptions: [
        {
          label: "scope",
          text: "the tracker API stays stable",
          material: true,
          provenance: provenance(),
        },
      ],
    }),
  );
  ok(body.includes("- [scope] (material) the tracker API stays stable"));
});

test("a performance claim serializes with its evidence named", () => {
  const body = publicationBodyFor(
    bugDraft({
      profile: "refactor",
      performanceClaim: "30% faster sync",
      performanceEvidence: "bench from the pack-smoke harness",
    }),
  );
  ok(
    body.includes(
      "## Performance claims\n\n30% faster sync\n\nEvidence: bench from the pack-smoke harness",
    ),
  );
});

test("an empty draft serializes to an empty body — honestly, never a placeholder", () => {
  const empty = bugDraft({
    behavior: "",
    observation: "",
    reproduction: "",
    scope: "",
    exclusions: [],
    acceptance: [],
    assumptions: [],
    evidence: [],
  });
  strictEqual(publicationBodyFor(empty), "");
});

test("the visible diff renders exactly the lines publication would write", () => {
  const before = "old issue body\nsecond line";
  const after = "old issue body\nnew body from the draft";
  const diff = renderIssueBodyDiff({ before, after });
  strictEqual(diff.unchanged, false);
  strictEqual(diff.added, 1);
  strictEqual(diff.removed, 1);
  deepStrictEqual(diff.lines, [
    { kind: "context", text: "old issue body" },
    { kind: "removed", text: "second line" },
    { kind: "added", text: "new body from the draft" },
  ]);
});

test("an identical body is unchanged with nothing added or removed", () => {
  const diff = renderIssueBodyDiff({ before: "same\nlines", after: "same\nlines" });
  strictEqual(diff.unchanged, true);
  strictEqual(diff.added, 0);
  strictEqual(diff.removed, 0);
  deepStrictEqual(diff.lines, [
    { kind: "context", text: "same" },
    { kind: "context", text: "lines" },
  ]);
});

test("a first publication on an empty body is everything added", () => {
  const diff = renderIssueBodyDiff({ before: "", after: "fresh\nbody" });
  strictEqual(diff.added, 2);
  strictEqual(diff.removed, 0);
  deepStrictEqual(diff.lines, [
    { kind: "added", text: "fresh" },
    { kind: "added", text: "body" },
  ]);
});

test("an oversized body still diffs exactly, without pretending minimality", () => {
  // Past the diff's line cap the renderer falls back to remove-all/add-all —
  // never wrong about what publication writes, only honest that it is not
  // minimal.
  const before = Array.from({ length: 2001 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 2001 }, (_, i) => `new ${i}`).join("\n");
  const diff = renderIssueBodyDiff({ before, after });
  strictEqual(diff.removed, 2001);
  strictEqual(diff.added, 2001);
  deepStrictEqual(diff.lines[0], { kind: "removed", text: "old 0" });
  deepStrictEqual(diff.lines[2001], { kind: "added", text: "new 0" });
});

test("the publication body is shaped by the task profile — no cross-profile leakage", () => {
  // Content written under one profile stays in the document but never
  // serializes into another profile's brief — the body is shaped by the
  // task profile the same way the completeness arithmetic is.
  const body = publicationBodyFor(
    bugDraft({
      boundary: "a boundary",
      dependencies: "a dependency",
      performanceClaim: "30% faster",
    }),
  );
  ok(!body.includes("User and system boundary"));
  ok(!body.includes("Dependencies and decisions"));
  ok(!body.includes("Performance claims"));

  // Reclassifying brings the profile's own fields back.
  const refactor = publicationBodyFor(
    bugDraft({ profile: "refactor", performanceClaim: "30% faster", performanceEvidence: "bench" }),
  );
  ok(refactor.includes("## Performance claims"));
});
