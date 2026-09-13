import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import {
  candidateFromCommit,
  candidatesFromLog,
  collectCommitCandidates,
} from "./commit-candidates.mjs";

// Highlights candidates (ticket #17): the v1 heuristic over the host
// repo's own git log — a candidate message has a body beyond the subject
// and references a ticket or issue, capped to the most recent 30. The git
// runner is injected, so nothing here touches a repository or the network.

test("a message with a body and a ticket reference is a candidate", () => {
  const candidate = candidateFromCommit({
    sha: "e5a7f30",
    author: "Ada Lovelace",
    date: "2026-09-03T10:00:00.000Z",
    message:
      "feat: dedupe table chrome after shadcn migration\n\nExtracts the shared table header.\n\nRefs: #11",
  });
  deepStrictEqual(candidate, {
    sha: "e5a7f30",
    subject: "feat: dedupe table chrome after shadcn migration",
    body: "Extracts the shared table header.\n\nRefs: #11",
    author: "Ada Lovelace",
    date: "2026-09-03T10:00:00.000Z",
    ticketRef: "#11",
  });
});

test("a subject-only message is not a candidate", () => {
  strictEqual(
    candidateFromCommit({
      sha: "e5a7f30",
      author: "Ada",
      date: "2026-09-03T10:00:00.000Z",
      message: "chore: release 0.4.0",
    }),
    null,
  );
});

test("a bodyless-ticket message without any reference is not a candidate", () => {
  strictEqual(
    candidateFromCommit({
      sha: "e5a7f30",
      author: "Ada",
      date: "2026-09-03T10:00:00.000Z",
      message: "fix: correct the offsets\n\nRewrites the sticky scroll math by hand.",
    }),
    null,
  );
});

test("a merge commit is not a candidate even with a body-like PR title", () => {
  strictEqual(
    candidateFromCommit({
      sha: "e5a7f30",
      author: "github-actions[bot]",
      date: "2026-09-03T10:00:00.000Z",
      message:
        "Merge pull request #86 from Quick-Release/agent/zcode/x\n\nfeat: some merged work (#85)",
    }),
    null,
  );
});

test("a reference in the subject counts when a body exists", () => {
  const candidate = candidateFromCommit({
    sha: "e5a7f30",
    author: "Ada",
    date: "2026-09-03T10:00:00.000Z",
    message: "feat: land the shell (issue 32)\n\nMounted around the outlet.",
  });
  strictEqual(candidate.ticketRef, "#32");
});

test("the log folds newest-first and caps at 30 candidates", () => {
  const record = (n, withBody) =>
    `sha-${n}\x1fAuthor ${n}\x1f2026-09-01T00:00:${String(n % 60).padStart(2, "0")}Z\x1ffeat: commit ${n}\n${withBody ? `Body for ${n}. Refs: #12\n` : ""}\x1e`;
  // 40 matching records, newest first (n descending).
  const log = Array.from({ length: 40 }, (_, i) => record(40 - i, true)).join("");
  const candidates = candidatesFromLog(log);
  strictEqual(candidates.length, 30);
  strictEqual(candidates[0].sha, "sha-40");
  strictEqual(candidates[29].sha, "sha-11");
});

test("non-matching commits are skipped, not capped", () => {
  const log = [
    ...Array.from(
      { length: 10 },
      (_, i) => `sha-a${i}\x1fA\x1f2026-09-01T00:00:00Z\x1fchore: ${i}\n\x1e`,
    ).join(""),
    `sha-b1\x1fA\x1f2026-09-01T00:00:00Z\x1ffeat: real one\n\nBody. Refs: #7\n\x1e`,
  ].join("");
  const candidates = candidatesFromLog(log);
  strictEqual(candidates.length, 1);
  strictEqual(candidates[0].sha, "sha-b1");
});

test("collectCommitCandidates drives git with the scan window and folds the log", async () => {
  const canned = "sha-1\x1fAda\x1f2026-09-01T00:00:00Z\x1ffeat: one\n\nBody one. Refs: #3\n\x1e";
  const calls = [];
  const candidates = await collectCommitCandidates({
    rootDirectory: "/repo",
    run: async (args) => {
      calls.push(args);
      return canned;
    },
  });
  strictEqual(calls.length, 1);
  strictEqual(calls[0][0], "log");
  strictEqual(
    calls[0].some((arg) => arg === "-1000"),
    true,
  );
  // Built from char codes so the assertion carries no invisible escapes.
  const SEP = String.fromCharCode(0x1f);
  const RECORD = String.fromCharCode(0x1e);
  strictEqual(calls[0].includes(`--pretty=format:%H${SEP}%an${SEP}%aI${SEP}%B${RECORD}`), true);
  strictEqual(candidates.length, 1);
  strictEqual(candidates[0].body, "Body one. Refs: #3");
});
