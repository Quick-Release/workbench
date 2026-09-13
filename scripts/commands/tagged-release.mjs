import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The release finisher (ticket #77). `changeset publish` under
// @changesets/cli 3.x creates lightweight npm-style tags and the
// changesets action pushes with `git push --follow-tags` — which only
// pushes annotated tags — so published versions silently never reach
// origin and no GitHub release is created. This script finishes the
// release the repo's way, deterministically: a v-prefixed tag on the
// version commit, pushed, plus a GitHub release whose notes are the
// version's CHANGELOG section. Tagging and releasing are keyed
// separately, so a rerun after a partial failure heals the missing half.
// The flow is injectable so the tests pin it without touching git, gh,
// or the network.

export const tagNameFor = (version) => `v${version}`;

// The notes for one version: its CHANGELOG section without the heading,
// or null when the changelog has no section for it.
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const section = lines
    .slice(start + 1, end === -1 ? lines.length : end)
    .join("\n")
    .trim();
  return section.length > 0 ? section : null;
}

export async function taggedRelease({
  version,
  changelog,
  hasTag,
  hasRelease,
  tag,
  pushTag,
  createRelease,
}) {
  const name = tagNameFor(version);
  let action = "none";
  if (!(await hasTag(name))) {
    await tag(name);
    await pushTag(name);
    action = "tagged";
  }

  const notes = changelog ? extractChangelogSection(changelog, version) : null;
  let released = false;
  if (notes) {
    if (!(await hasRelease(name))) {
      await createRelease({ tag: name, title: name, body: notes });
      released = true;
    }
  } else {
    console.warn(`tagged-release: no CHANGELOG section for ${version}; skipping the release`);
  }
  return { action, tag: name, released };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

async function main() {
  const version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
  const changelogPath = join(process.cwd(), "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";

  const result = await taggedRelease({
    version,
    changelog,
    hasTag: async (name) =>
      git(["ls-remote", "--tags", "origin", `refs/tags/${name}`]).trim().length > 0,
    hasRelease: async (name) => {
      try {
        execFileSync("gh", ["release", "view", name], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    tag: async (name) => {
      git(["tag", name]);
    },
    pushTag: async (name) => {
      git(["push", "origin", name]);
    },
    createRelease: async ({ tag, title, body }) => {
      const notesFile = join(tmpdir(), `${tag}-notes.md`);
      writeFileSync(notesFile, `${body}\n`);
      execFileSync(
        "gh",
        ["release", "create", tag, "--title", title, "--notes-file", notesFile, "--verify-tag"],
        {
          stdio: "inherit",
        },
      );
    },
  });
  console.log(
    `tagged-release: ${result.action} ${result.tag}${result.released ? " (release created)" : ""}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
