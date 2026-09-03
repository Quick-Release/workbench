import { deepStrictEqual, strictEqual } from "node:assert";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectSessionUsage } from "./sessions.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}
const hasSqlite = Boolean(DatabaseSync);

// The fixture mirrors only the columns the aggregator selects; the real
// database carries more, and column drift is supposed to fail sync loudly.
const fixtureSchema = `
CREATE TABLE session (
  id text primary key,
  parent_id text,
  task_type text not null default 'interactive',
  directory text not null,
  title text not null,
  time_created integer not null,
  time_updated integer not null
);
CREATE TABLE model_usage (
  id integer primary key,
  session_id text not null,
  query_source text,
  provider_id text,
  model_id text,
  status text,
  started_at integer,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  cache_read_input_tokens integer,
  cache_creation_input_tokens integer
);
CREATE TABLE tool_usage (
  id integer primary key,
  session_id text not null,
  tool_name text,
  status text
);
`;

const ms = (iso) => Date.parse(iso);

const buildFixture = (directory) => {
  const database = new DatabaseSync(join(directory, "db.sqlite"));
  database.exec(fixtureSchema);
  database
    .prepare(
      "INSERT INTO session (id, parent_id, task_type, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sess_root-1",
      null,
      "interactive",
      join(directory, "checkout"),
      "Build the thing",
      ms("2026-09-01T10:00:00Z"),
      ms("2026-09-01T11:00:00Z"),
    );
  database
    .prepare(
      "INSERT INTO session (id, parent_id, task_type, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sess_child-1",
      "sess_root-1",
      "subagent_child",
      join(directory, "checkout"),
      "Explore side quest",
      ms("2026-09-01T10:30:00Z"),
      ms("2026-09-01T10:45:00Z"),
    );
  database
    .prepare(
      "INSERT INTO session (id, parent_id, task_type, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "sess_other-1",
      null,
      "interactive",
      join(directory, "elsewhere"),
      "Another repo",
      ms("2026-09-01T09:00:00Z"),
      ms("2026-09-01T09:30:00Z"),
    );

  const usage = database.prepare(
    "INSERT INTO model_usage (id, session_id, query_source, provider_id, model_id, status, started_at, duration_ms, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // Completed main-turn requests, spread across two days and two models.
  usage.run(
    1,
    "sess_root-1",
    "main_turn",
    "prov-a",
    "GLM-5.3-Flash",
    "completed",
    ms("2026-09-01T10:05:00Z"),
    1000,
    100,
    200,
    30,
    5,
  );
  usage.run(
    2,
    "sess_root-1",
    "main_turn",
    "prov-a",
    "GLM-5.3-Flash",
    "completed",
    ms("2026-09-01T10:20:00Z"),
    1500,
    50,
    300,
    0,
    0,
  );
  usage.run(
    3,
    "sess_child-1",
    "subagent",
    "prov-b",
    "GPT-5.6-Luna",
    "completed",
    ms("2026-09-01T10:35:00Z"),
    2000,
    400,
    500,
    10,
    0,
  );
  usage.run(
    4,
    "sess_root-1",
    "main_turn",
    "prov-a",
    "GLM-5.3-Flash",
    "completed",
    ms("2026-09-02T10:05:00Z"),
    1200,
    60,
    100,
    0,
    0,
  );
  // Noise that must never reach the aggregates.
  usage.run(
    5,
    "sess_root-1",
    "session_title",
    "prov-a",
    "GLM-5.3-Flash",
    "completed",
    ms("2026-09-01T10:01:00Z"),
    900,
    8000,
    10,
    0,
    0,
  );
  usage.run(
    6,
    "sess_root-1",
    "main_turn",
    "prov-a",
    "GLM-5.3-Flash",
    "error",
    ms("2026-09-01T10:10:00Z"),
    500,
    200,
    0,
    0,
    0,
  );

  const tools = database.prepare(
    "INSERT INTO tool_usage (id, session_id, tool_name, status) VALUES (?, ?, ?, ?)",
  );
  tools.run(1, "sess_root-1", "Edit", "completed");
  tools.run(2, "sess_root-1", "Edit", "completed");
  tools.run(3, "sess_root-1", "Write", "completed");
  tools.run(4, "sess_root-1", "Read", "completed");
  tools.run(5, "sess_child-1", "Write", "completed");
  database.close();
  return join(directory, "db.sqlite");
};

const withFixture = (run) => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-sessions-"));
  try {
    return run({ databasePath: buildFixture(directory), sourceRoot: join(directory, "checkout") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("collects scoped per-model-per-day aggregates from a session database", () => {
  if (!hasSqlite) return;
  withFixture(({ databasePath, sourceRoot }) => {
    const usage = collectSessionUsage({ databasePath, sourceRoot, now: "2026-09-03T00:00:00Z" });
    strictEqual(usage.enabled, true);
    strictEqual(usage.generatedAt, "2026-09-03T00:00:00Z");
    strictEqual(usage.perDay.length, 3);
    deepStrictEqualDay(usage.perDay[0], {
      day: "2026-09-01",
      model: "GLM-5.3-Flash",
      provider: "prov-a",
      requests: 2,
      sessions: 1,
      inputTokens: 150,
      outputTokens: 500,
      cacheTokens: 35,
      modelMs: 2500,
    });
    deepStrictEqualDay(usage.perDay[1], {
      day: "2026-09-01",
      model: "GPT-5.6-Luna",
      provider: "prov-b",
      requests: 1,
      sessions: 1,
      inputTokens: 400,
      outputTokens: 500,
      cacheTokens: 10,
      modelMs: 2000,
    });
    deepStrictEqualDay(usage.perDay[2], {
      day: "2026-09-02",
      model: "GLM-5.3-Flash",
      provider: "prov-a",
      requests: 1,
      sessions: 1,
      inputTokens: 60,
      outputTokens: 100,
      cacheTokens: 0,
      modelMs: 1200,
    });
  });
});

test("summarizes per-model totals ordered by output tokens", () => {
  if (!hasSqlite) return;
  withFixture(({ databasePath, sourceRoot }) => {
    const usage = collectSessionUsage({ databasePath, sourceRoot });
    strictEqual(usage.perModel.length, 2);
    strictEqual(usage.perModel[0].model, "GLM-5.3-Flash");
    strictEqual(usage.perModel[0].requests, 3);
    strictEqual(usage.perModel[0].outputTokens, 600);
    strictEqual(usage.perModel[0].sessions, 1);
    strictEqual(usage.perModel[1].model, "GPT-5.6-Luna");
    strictEqual(usage.perModel[1].outputTokens, 500);
  });
});

test("rolls up sessions scoped to the source root with tool counts", () => {
  if (!hasSqlite) return;
  withFixture(({ databasePath, sourceRoot }) => {
    const usage = collectSessionUsage({ databasePath, sourceRoot });
    strictEqual(usage.sessions.length, 2);
    const [root, child] = usage.sessions;
    strictEqual(root.id, "sess_root-1");
    strictEqual(root.taskType, "interactive");
    strictEqual(root.parent, "");
    strictEqual(root.title, "Build the thing");
    strictEqual(root.requests, 3);
    strictEqual(root.outputTokens, 600);
    strictEqual(root.modelMs, 3700);
    strictEqual(root.edits, 2);
    strictEqual(root.writes, 1);
    strictEqual(child.id, "sess_child-1");
    strictEqual(child.taskType, "subagent_child");
    strictEqual(child.parent, "sess_root-1");
    strictEqual(child.requests, 1);
    strictEqual(child.writes, 1);
    strictEqual(child.edits, 0);
    strictEqual(root.model, "GLM-5.3-Flash");
    strictEqual(child.model, "GPT-5.6-Luna");
    deepStrictEqual(usage.sessionsByDay, [
      { day: "2026-09-01", sessions: 2 },
      { day: "2026-09-02", sessions: 1 },
    ]);
  });
});

test("copies database sidecars and never mutates the source database", () => {
  if (!hasSqlite) return;
  withFixture(({ databasePath, sourceRoot }) => {
    // A leftover WAL sidecar must not break collection.
    copyFileSync(databasePath, `${databasePath}-wal`);
    const usage = collectSessionUsage({ databasePath, sourceRoot });
    strictEqual(usage.perModel.length, 2);
    strictEqual(existsSync(databasePath), true);
    rmSync(`${databasePath}-wal`);
  });
});

test("reports an empty payload when the database does not exist", () => {
  if (!hasSqlite) return;
  const usage = collectSessionUsage({
    databasePath: join(tmpdir(), "workbench-sessions-missing", "db.sqlite"),
    sourceRoot: tmpdir(),
    now: "2026-09-03T00:00:00Z",
  });
  strictEqual(usage.enabled, true);
  strictEqual(usage.perDay.length, 0);
  strictEqual(usage.perModel.length, 0);
  strictEqual(usage.sessions.length, 0);
});

function deepStrictEqualDay(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    strictEqual(actual[key], value, `${key}: ${actual[key]} != ${value}`);
  }
}
