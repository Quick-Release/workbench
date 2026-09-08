import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { extractChangelogSection, tagNameFor, taggedRelease } from "./tagged-release.mjs";

// The release-finisher (ticket #77): after the changesets action publishes,
// this script tags the version the repo's way (v-prefixed, on the version
// commit), pushes the tag, and creates the GitHub release from the
// CHANGELOG section — the parts changesets v3's lightweight tags and the
// action's --follow-tags push silently skip. Runners are injected, so the
// tests pin the whole flow without touching git, gh, or the network.

const CHANGELOG = `# @quick-release/workbench

## 0.8.0

### Minor Changes

- 877b9e4: Session capture (ticket #35): the capture proxy lands.

## 0.7.0

### Minor Changes

- 891b142: The daily scheduled digest (ticket #33) measures the backlog.
`;

test("names the tag the repo's way", () => {
  strictEqual(tagNameFor("0.8.0"), "v0.8.0");
});

test("extracts exactly one version's changelog section", () => {
  const section = extractChangelogSection(CHANGELOG, "0.8.0");
  strictEqual(
    section,
    "### Minor Changes\n\n- 877b9e4: Session capture (ticket #35): the capture proxy lands.",
  );
  strictEqual(extractChangelogSection(CHANGELOG, "9.9.9"), null);
});

test("tags, pushes, and releases an untagged version", async () => {
  const calls = [];
  const result = await taggedRelease({
    version: "0.8.0",
    changelog: CHANGELOG,
    hasTag: async (name) => {
      calls.push(`hasTag ${name}`);
      return false;
    },
    tag: async (name) => calls.push(`tag ${name}`),
    pushTag: async (name) => calls.push(`push ${name}`),
    createRelease: async ({ tag, title, body }) => {
      calls.push(`release ${tag}`);
      deepStrictEqual([tag, title], ["v0.8.0", "v0.8.0"]);
      strictEqual(body.includes("Session capture (ticket #35)"), true);
      strictEqual(body.includes("daily scheduled digest"), false);
      return { url: `https://github.com/acme/releases/tag/${tag}` };
    },
  });
  strictEqual(result.action, "tagged");
  strictEqual(result.released, true);
  deepStrictEqual(calls, ["hasTag v0.8.0", "tag v0.8.0", "push v0.8.0", "release v0.8.0"]);
});

test("does nothing when the tag already exists", async () => {
  const calls = [];
  const result = await taggedRelease({
    version: "0.8.0",
    changelog: CHANGELOG,
    hasTag: async () => {
      calls.push("hasTag v0.8.0");
      return true;
    },
    tag: async (name) => calls.push(`tag ${name}`),
    pushTag: async (name) => calls.push(`push ${name}`),
    createRelease: async () => calls.push("release"),
  });
  strictEqual(result.action, "none");
  deepStrictEqual(calls, ["hasTag v0.8.0"]);
});

test("still tags and pushes when there is no changelog section to publish", async () => {
  const calls = [];
  const result = await taggedRelease({
    version: "9.9.9",
    changelog: CHANGELOG,
    hasTag: async () => false,
    tag: async (name) => calls.push(`tag ${name}`),
    pushTag: async (name) => calls.push(`push ${name}`),
    createRelease: async () => {
      calls.push("release");
      throw new Error("no notes, no release");
    },
  });
  strictEqual(result.action, "tagged");
  strictEqual(result.released, false);
  deepStrictEqual(calls, ["tag v9.9.9", "push v9.9.9"]);
});
