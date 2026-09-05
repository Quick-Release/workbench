import { strictEqual, deepStrictEqual } from "node:assert";
import test from "node:test";

import { catalogFromTreePayload, mergeCatalog, skillSourceRecord } from "./skills-catalog.mjs";
import { mattPocockSkillSource } from "../src/lib/skills.ts";

// Recorded from GET https://api.github.com/repos/mattpocock/skills/git/trees/main?recursive=1
// (trimmed to the shapes the walk depends on).
const treePayload = {
  sha: "abc123",
  tree: [
    { path: "README.md", type: "blob" },
    { path: "skills/engineering/tdd/SKILL.md", type: "blob" },
    { path: "skills/engineering/tdd/loop.mjs", type: "blob" },
    { path: "skills/productivity/teach/SKILL.md", type: "blob" },
    { path: "skills/misc/git-guardrails-claude-code/SKILL.md", type: "blob" },
    { path: "skills/in-progress/retro/SKILL.md", type: "blob" },
    { path: "skills/engineering/brand-new-skill/SKILL.md", type: "blob" },
    { path: "skills/deprecated/old-thing/SKILL.md", type: "blob" },
    { path: "docs/skills/engineering/imposter/SKILL.md", type: "blob" },
  ],
  truncated: false,
};

test("walks one recursive trees payload into catalog entries with upstream categories", () => {
  deepStrictEqual(catalogFromTreePayload(treePayload), [
    { id: "brand-new-skill", category: "engineering" },
    { id: "git-guardrails-claude-code", category: "misc" },
    { id: "old-thing", category: "deprecated" },
    { id: "retro", category: "in-progress" },
    { id: "tdd", category: "engineering" },
    { id: "teach", category: "productivity" },
  ]);
});

test("the walk keeps deprecated entries so the merge can rule on them, misc literally", () => {
  const catalog = catalogFromTreePayload(treePayload);
  strictEqual(
    catalog.some((skill) => skill.id === "old-thing"),
    true,
  );
  strictEqual(
    catalog.some((skill) => skill.id === "git-guardrails-claude-code"),
    true,
  );
});

const fallback = [
  { id: "tdd", category: "engineering" },
  { id: "wizard", category: "engineering" },
  { id: "retro", category: "in-progress" },
];

test("upstream fetch feeds the catalog with the matt-pocock source", () => {
  const { skills, degraded } = mergeCatalog({
    upstream: catalogFromTreePayload(treePayload),
    lastGood: [],
    fallback,
    installedIds: [],
  });
  strictEqual(skills.length, 5);
  strictEqual(degraded, false);
  strictEqual(
    skills.some((skill) => skill.id === "wizard"),
    false,
  );
  deepStrictEqual(skillSourceRecord(skills[0]), {
    id: "brand-new-skill",
    category: "engineering",
    source: mattPocockSkillSource.id,
  });
});

test("an upstream-new skill enters the catalog alongside the curated set", () => {
  const { skills } = mergeCatalog({
    upstream: [
      { id: "brand-new-skill", category: "engineering" },
      { id: "tdd", category: "engineering" },
    ],
    lastGood: fallback,
    fallback,
    installedIds: [],
  });
  strictEqual(
    skills.some((skill) => skill.id === "brand-new-skill"),
    true,
  );
  strictEqual(
    skills.some((skill) => skill.id === "tdd"),
    true,
  );
});

test("a curated id that vanishes upstream is dropped unless installed", () => {
  const vanished = (installedIds) =>
    mergeCatalog({
      upstream: [{ id: "tdd", category: "engineering" }],
      lastGood: fallback,
      fallback,
      installedIds,
    }).skills.map((skill) => skill.id);

  deepStrictEqual(vanished([]), ["tdd"]);
  deepStrictEqual(vanished(["wizard"]), ["tdd", "wizard"]);
});

test("deprecated is filtered unless installed, including from a real upstream walk", () => {
  const merge = (installedIds) =>
    mergeCatalog({
      upstream: catalogFromTreePayload(treePayload),
      lastGood: [],
      fallback,
      installedIds,
    }).skills.map((skill) => skill.id);

  deepStrictEqual(
    merge([]).filter((id) => id === "old-thing"),
    [],
  );
  strictEqual(merge(["old-thing"]).includes("old-thing"), true);

  const { skills } = mergeCatalog({
    upstream: [
      { id: "tdd", category: "engineering" },
      { id: "old-thing", category: "deprecated" },
    ],
    lastGood: [],
    fallback,
    installedIds: ["old-thing"],
  });
  deepStrictEqual(
    skills.map((skill) => skill.id),
    ["old-thing", "tdd"],
  );
});

test("a failed fetch degrades to last-good data, then to the curated fallback", () => {
  const fromLastGood = mergeCatalog({
    upstream: null,
    lastGood: fallback,
    fallback: [{ id: "never-happens", category: "engineering" }],
    installedIds: [],
  });
  deepStrictEqual(
    fromLastGood.skills.map((skill) => skill.id),
    ["retro", "tdd", "wizard"],
  );
  strictEqual(fromLastGood.degraded, true);

  const fromFallback = mergeCatalog({
    upstream: null,
    lastGood: [],
    fallback,
    installedIds: [],
  });
  deepStrictEqual(
    fromFallback.skills.map((skill) => skill.id),
    ["retro", "tdd", "wizard"],
  );
  strictEqual(fromFallback.degraded, true);
});

test("a fresh install of a skill missing everywhere still lands with its last-known category", () => {
  const { skills } = mergeCatalog({
    upstream: [{ id: "tdd", category: "engineering" }],
    lastGood: [{ id: "remembered", category: "productivity" }],
    fallback,
    installedIds: ["remembered"],
  });
  deepStrictEqual(
    skills.map((skill) => skill.id),
    ["remembered", "tdd"],
  );
  deepStrictEqual(skills.find((skill) => skill.id === "remembered").category, "productivity");
});
