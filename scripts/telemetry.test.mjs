import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentUsageFromSessions,
  buildTelemetryPayload,
  identityKey,
  recordHealthError,
  reportTelemetry,
  resolveIdentity,
} from "./telemetry.mjs";

// The client-side Telemetry tracer (ticket #14) and its enrichment
// (#15): payload assembly, daily dedup over a local git-ignored state
// file, identity resolution (gh, then git email, then null), swallowed
// delivery failures, demo skip, and the sessions/health folds. Network
// and git are injected; state lives in a temp directory.

const app = () => mkdtempSync(join(tmpdir(), "telemetry-"));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const ENV = {
  WORKBENCH_TELEMETRY_URL: "https://telemetry.example.com",
  TELEMETRY_INGEST_TOKEN: "ingest-token",
};

const identityGh = { runGh: async () => "ada", runGit: async () => "ada@acme.dev" };

test("resolveIdentity prefers the gh login, falls back to git email, then null", async () => {
  deepStrictEqual(await resolveIdentity({ runGh: async () => "ada", runGit: async () => "x@y" }), {
    login: "ada",
  });
  deepStrictEqual(
    await resolveIdentity({
      runGh: async () => Promise.reject(new Error("no gh")),
      runGit: async () => "ada@acme.dev",
    }),
    { email: "ada@acme.dev" },
  );
  deepStrictEqual(
    await resolveIdentity({
      runGh: async () => Promise.reject(new Error("no gh")),
      runGit: async () => "",
    }),
    null,
  );
});

test("identityKey falls back to anon", () => {
  strictEqual(identityKey({ login: "ada" }), "ada");
  strictEqual(identityKey(null), "anon");
});

test("buildTelemetryPayload carries the daily payload shape and omits absent folds", () => {
  const payload = buildTelemetryPayload({
    identity: { login: "ada" },
    repositoryUrl: "https://github.com/acme/widgets.git",
    version: "0.9.0",
    os: "linux",
    node: "v24.0.0",
    day: "2026-09-08",
    sentAt: "2026-09-08T10:00:00.000Z",
  });
  deepStrictEqual(payload, {
    day: "2026-09-08",
    sentAt: "2026-09-08T10:00:00.000Z",
    repoRemote: "https://github.com/acme/widgets.git",
    developer: { login: "ada" },
    workbench: { version: "0.9.0", os: "linux", node: "v24.0.0" },
  });
  strictEqual("agentUsage" in payload, false);
  strictEqual("errors" in payload, false);
});

test("agent usage folds session aggregates when enabled and is absent when disabled", () => {
  const sessions = {
    enabled: true,
    perModel: [
      {
        provider: "p",
        model: "GLM",
        requests: 4,
        inputTokens: 100,
        outputTokens: 50,
        cacheTokens: 10,
        modelMs: 5,
      },
      {
        provider: "p",
        model: "Luna",
        requests: 2,
        inputTokens: 20,
        outputTokens: 10,
        cacheTokens: 0,
        modelMs: 2,
      },
    ],
    sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
  };
  deepStrictEqual(agentUsageFromSessions(sessions), {
    models: ["GLM", "Luna"],
    requests: 6,
    inputTokens: 120,
    outputTokens: 60,
    sessions: 3,
  });
  strictEqual(agentUsageFromSessions({ enabled: false }), undefined);
});

test("reportTelemetry sends once per day and records the marker", async () => {
  const dir = app();
  try {
    const posts = [];
    // Two egress targets flow through one fetch: the outcomes adapter's
    // GitHub call and the telemetry POST. Only the POST is counted.
    const fetchImpl = async (url, init) => {
      if (String(url) === ENV.WORKBENCH_TELEMETRY_URL) {
        posts.push({ url, init });
        return new Response("{}", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const first = await reportTelemetry({
      appDirectory: dir,
      repositoryUrl: "https://github.com/acme/widgets.git",
      env: ENV,
      version: "0.9.0",
      runGh: identityGh.runGh,
      runGit: identityGh.runGit,
      fetchImpl,
    });
    strictEqual(first.action, "sent");
    strictEqual(posts.length, 1);
    strictEqual(posts[0].init.headers.Authorization, "Bearer ingest-token");
    const body = JSON.parse(posts[0].init.body);
    strictEqual(body.developer.login, "ada");
    strictEqual(body.repoRemote, "https://github.com/acme/widgets.git");
    strictEqual(body.workbench.os, process.platform);

    const second = await reportTelemetry({
      appDirectory: dir,
      repositoryUrl: "https://github.com/acme/widgets.git",
      env: ENV,
      version: "0.9.0",
      runGh: identityGh.runGh,
      runGit: identityGh.runGit,
      fetchImpl,
    });
    strictEqual(second.action, "deduped");
    strictEqual(posts.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("a failing delivery is swallowed and does not mark the day", async () => {
  const dir = app();
  try {
    let attempts = 0;
    const failing = {
      appDirectory: dir,
      repositoryUrl: "https://github.com/acme/widgets.git",
      env: ENV,
      version: "0.9.0",
      runGh: identityGh.runGh,
      runGit: identityGh.runGit,
      fetchImpl: async (url) => {
        if (String(url) === ENV.WORKBENCH_TELEMETRY_URL) {
          attempts += 1;
          throw new Error("unreachable");
        }
        return new Response("[]", { status: 200 });
      },
    };
    strictEqual((await reportTelemetry(failing)).action, "failed");
    strictEqual((await reportTelemetry(failing)).action, "failed");
    strictEqual(attempts, 2, "a failed day is retried on the next sync");
  } finally {
    cleanup(dir);
  }
});

test("demo mode and an unconfigured endpoint send nothing", async () => {
  const dir = app();
  try {
    const posts = [];
    const base = {
      appDirectory: dir,
      repositoryUrl: "https://github.com/acme/widgets.git",
      version: "0.9.0",
      runGh: identityGh.runGh,
      runGit: identityGh.runGit,
      fetchImpl: async (url, init) => {
        if (String(url) === ENV.WORKBENCH_TELEMETRY_URL) {
          posts.push({ url, init });
          return new Response("{}", { status: 200 });
        }
        return new Response("[]", { status: 200 });
      },
    };
    strictEqual((await reportTelemetry({ ...base, demo: true, env: ENV })).action, "skipped");
    strictEqual(
      (
        await reportTelemetry({
          ...base,
          env: { WORKBENCH_TELEMETRY_URL: "", TELEMETRY_INGEST_TOKEN: "" },
        })
      ).action,
      "skipped",
    );
    strictEqual(posts.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("buffered health errors ride the payload and clear on success", async () => {
  const dir = app();
  try {
    await recordHealthError({ appDirectory: dir, error: new Error("boom"), version: "0.9.0" });
    const posts = [];
    const result = await reportTelemetry({
      appDirectory: dir,
      repositoryUrl: "https://github.com/acme/widgets.git",
      env: ENV,
      version: "0.9.0",
      runGh: identityGh.runGh,
      runGit: identityGh.runGit,
      fetchImpl: async (url, init) => {
        if (String(url) === ENV.WORKBENCH_TELEMETRY_URL) {
          posts.push({ url, init });
          return new Response("{}", { status: 200 });
        }
        return new Response("[]", { status: 200 });
      },
    });
    strictEqual(result.action, "sent");
    const body = JSON.parse(posts[0].init.body);
    strictEqual(body.errors.length, 1);
    strictEqual(body.errors[0].message, "boom");
    strictEqual(body.errors[0].version, "0.9.0");
    strictEqual(body.errors[0].os, process.platform);
    // The buffer cleared with the successful flush.
    const state = JSON.parse(
      readFileSync(join(dir, "node_modules", ".cache", "workbench-telemetry-state.json"), "utf8"),
    );
    deepStrictEqual(state.errors, []);
    strictEqual(
      existsSync(join(dir, "node_modules", ".cache", "workbench-telemetry-state.json")),
      true,
    );
  } finally {
    cleanup(dir);
  }
});
