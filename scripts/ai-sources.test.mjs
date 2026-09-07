import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { buildDraftPrompt } from "./ai-prompt.mjs";
import { gitCommitSubjectLister, ghPullRequestLoader, parseCommitSubjects } from "./ai-sources.mjs";

const fakePr = {
  number: 12,
  title: "Add a digest scheduler",
  head: "agent/pi/digest",
  base: "main",
  author: "vvaz",
  isDraft: false,
  body: "What: runs the digest nightly.",
};

test("builds a prompt from the PR record and the local commit style", () => {
  const prompt = buildDraftPrompt({
    pr: fakePr,
    commitSubjects: ["feat: nightly digest", "fix: tz drift"],
  });
  strictEqual(prompt.includes("Add a digest scheduler"), true);
  strictEqual(prompt.includes("agent/pi/digest"), true);
  strictEqual(prompt.includes("vvaz"), true);
  strictEqual(prompt.includes("feat: nightly digest"), true);
  // The draft instruction names the two fields the schema expects.
  strictEqual(prompt.toLowerCase().includes("title"), true);
  strictEqual(prompt.toLowerCase().includes("body"), true);
});

test("keeps the prompt useful when the record is sparse", () => {
  const prompt = buildDraftPrompt({
    pr: { ...fakePr, body: "", isDraft: true },
    commitSubjects: [],
  });
  strictEqual(prompt.includes("Add a digest scheduler"), true);
  strictEqual(prompt.includes("(none)"), true);
});

const run = async (file, args) => {
  if (file === "gh" && args[0] === "pr" && args[1] === "view" && args[2] === "12")
    return {
      stdout: JSON.stringify({
        number: 12,
        title: "Add a digest scheduler",
        headRefName: "agent/pi/digest",
        baseRefName: "main",
        author: { login: "vvaz" },
        isDraft: false,
        body: "What: runs the digest nightly.",
      }),
      stderr: "",
    };
  if (file === "git") return { stdout: "feat: a\n\nfix: b\n\n\nchore: c\n", stderr: "" };
  throw Object.assign(new Error(`command failed: ${file} ${args.join(" ")}`), { stderr: "boom" });
};

test("loads a pull request through the gh CLI and flattens the record", async () => {
  const load = ghPullRequestLoader({ run });
  deepStrictEqual(await load(12), fakePr);
});

test("surfaces gh failures as errors the handler can name", async () => {
  const load = ghPullRequestLoader({ run });
  await strictEqual(await load(999).catch(() => "threw"), "threw");
});

test("parses commit subjects from git log output, dropping blanks", () => {
  deepStrictEqual(parseCommitSubjects("feat: a\n\nfix: b\n\n\nchore: c\n"), [
    "feat: a",
    "fix: b",
    "chore: c",
  ]);
});

test("lists commit subjects fail-soft — a broken git history yields none", async () => {
  const list = gitCommitSubjectLister({
    run: async () => {
      throw Object.assign(new Error("fatal: not a git repository"), { stderr: "fatal" });
    },
  });
  deepStrictEqual(await list(), []);
});
