import { deepStrictEqual, ok, strictEqual } from "node:assert";
import test from "node:test";

import { LIVE_REFRESH_MAX_MS } from "../src/lib/live-refresh.ts";

import { AUTO_SYNC_CADENCE_MS, createAutoSync } from "./auto-sync.mjs";

const REPO = "Quick-Release/workbench";

// A GitHub issues-list probe answer: 200 carries a body and an ETag, 304
// answers empty with the not-modified status.
const probeResponse = (status, etag) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(etag ? [["etag", etag]] : []),
  json: async () => [],
});

const issuesUrl = () =>
  `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100&page=1`;

// The typed outcome applySyncTrigger returns on a successful sync; the leg
// ignores its payload, so the same literal serves every test.
const syncTriggered = () => ({
  ok: true,
  result: { message: "Synced, no warnings.", warnings: [], state: {} },
});

test("a tick with no browser presence probes nothing and syncs nothing", async () => {
  const fetches = [];
  const syncs = [];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async ({ run }) => {
      syncs.push(run);
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run: async () => {},
    fetchImpl: async (...args) => {
      fetches.push(args);
      return probeResponse(304, '"etag-1"');
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  await leg.tick();

  strictEqual(fetches.length, 0);
  strictEqual(syncs.length, 0);
});

test("a recent seam read plus a changed probe runs the sync trigger", async () => {
  const fetches = [];
  const syncs = [];
  const run = async () => {};
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async ({ appDirectory: directory, run: runner }) => {
      syncs.push({ appDirectory: directory, run: runner });
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run,
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return probeResponse(200, '"etag-1"');
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  leg.noteSeamRead();
  ok(await leg.tick());

  strictEqual(syncs.length, 1);
  strictEqual(syncs[0].appDirectory, "/tmp/app");
  strictEqual(syncs[0].run, run);
  strictEqual(fetches.length, 1);
  strictEqual(fetches[0].url, issuesUrl());
  strictEqual(fetches[0].options.headers.Authorization, "Bearer test-token");
  ok(!("If-None-Match" in fetches[0].options.headers));
});

test("a 304 probe rides If-None-Match and skips the sync at no rate cost", async () => {
  const fetches = [];
  const syncs = [];
  const answers = [probeResponse(200, '"etag-1"'), probeResponse(304)];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return answers[fetches.length - 1];
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  leg.noteSeamRead();
  ok(await leg.tick());
  ok(!(await leg.tick()));

  strictEqual(syncs.length, 1, "the 304 must not re-sync");
  strictEqual(fetches[1].options.headers["If-None-Match"], '"etag-1"');
});

test("a seam read older than the presence window keeps the leg asleep", async () => {
  const fetches = [];
  const syncs = [];
  let clock = 1_000;
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return probeResponse(200, '"etag-1"');
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => clock,
  });

  leg.noteSeamRead();
  clock += LIVE_REFRESH_MAX_MS;
  ok(!(await leg.tick()));

  strictEqual(fetches.length, 0, "a stale read must not even probe");
  strictEqual(syncs.length, 0);
});

test("a fresh seam read inside the window returns the leg to service", async () => {
  const fetches = [];
  const syncs = [];
  let clock = 1_000;
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return probeResponse(200, '"etag-1"');
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => clock,
  });

  leg.noteSeamRead();
  clock += LIVE_REFRESH_MAX_MS;
  clock += 1;
  ok(!(await leg.tick()));
  leg.noteSeamRead();
  ok(await leg.tick());

  strictEqual(fetches.length, 1);
  strictEqual(syncs.length, 1);
});

test("a tick never stacks a sync onto a sync that is still running", async () => {
  const fetches = [];
  const syncs = [];
  let releaseSync;
  const syncResult = {
    ok: true,
    result: { message: "Synced, no warnings.", warnings: [], state: {} },
  };
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      // Only the first sync is held open; a stacked call would sail through.
      if (syncs.length === 1)
        return new Promise((resolve) => {
          releaseSync = resolve;
        });
      return syncResult;
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return probeResponse(200, '"etag-1"');
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  leg.noteSeamRead();
  const first = leg.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  ok(!(await leg.tick()));
  releaseSync(syncResult);
  ok(await first);

  strictEqual(syncs.length, 1, "the overlapping tick must not start a second sync");
  strictEqual(fetches.length, 1, "the overlapping tick must not even probe");
});

test("a missing GitHub token skips the probe without syncing", async () => {
  const fetches = [];
  const syncs = [];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return syncTriggered();
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return probeResponse(200, '"etag-1"');
    },
    env: {},
    ghToken: async () => "",
    now: () => 1_000,
  });

  leg.noteSeamRead();
  ok(!(await leg.tick()));

  strictEqual(fetches.length, 0);
  strictEqual(syncs.length, 0);
});

test("a failed probe skips the tick without throwing", async () => {
  const syncs = [];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return syncTriggered();
    },
    run: async () => {},
    fetchImpl: async () => {
      throw new Error("network down");
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  leg.noteSeamRead();
  ok(!(await leg.tick()));

  strictEqual(syncs.length, 0);
});

test("start schedules the tick at the fixed cadence once; stop cancels it", () => {
  const scheduled = [];
  const cancelled = [];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => syncTriggered(),
    run: async () => {},
    env: { GITHUB_TOKEN: "test-token" },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return `timer-${scheduled.length}`;
    },
    cancel: (timer) => cancelled.push(timer),
  });

  leg.start();
  leg.start();
  strictEqual(scheduled.length, 1, "a restart must not stack timers");
  strictEqual(scheduled[0].ms, AUTO_SYNC_CADENCE_MS);
  leg.stop();
  leg.stop();
  deepStrictEqual(cancelled, ["timer-1"]);
});

test("the scheduled tick swallows a throwing leg so the interval never rejects", async () => {
  let scheduledFn;
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => {
      throw new Error("broken snapshot");
    },
    applySync: async () => syncTriggered(),
    run: async () => {},
    env: { GITHUB_TOKEN: "test-token" },
    schedule: (fn) => {
      scheduledFn = fn;
      return "timer-1";
    },
    cancel: () => {},
  });

  leg.start();
  await scheduledFn();
  ok(true, "the scheduled call returned instead of rejecting");
});

test("a changed probe after a 304 re-syncs and refreshes the stored etag", async () => {
  const fetches = [];
  const syncs = [];
  const answers = [
    probeResponse(200, '"etag-1"'),
    probeResponse(304),
    probeResponse(200, '"etag-2"'),
    probeResponse(304),
  ];
  const leg = createAutoSync({
    appDirectory: "/tmp/app",
    resolveRepo: async () => REPO,
    applySync: async () => {
      syncs.push(true);
      return { ok: true, result: { message: "Synced, no warnings.", warnings: [], state: {} } };
    },
    run: async () => {},
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return answers[fetches.length - 1];
    },
    env: { GITHUB_TOKEN: "test-token" },
    now: () => 1_000,
  });

  leg.noteSeamRead();
  ok(await leg.tick());
  ok(!(await leg.tick()));
  ok(await leg.tick());
  ok(!(await leg.tick()));

  strictEqual(syncs.length, 2);
  strictEqual(fetches[2].options.headers["If-None-Match"], '"etag-1"');
  strictEqual(fetches[3].options.headers["If-None-Match"], '"etag-2"');
});
