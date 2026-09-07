import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The ZCode CLI session database records every model request with its model
// id, tokens, and duration, plus per-session metadata. Only this database is
// read: the rollout JSONL logs carry full prompts and responses and must
// never reach the snapshot.

export const defaultSessionsDatabasePath = () =>
  join(homedir(), ".zcode", "cli", "db", "db.sqlite");

// Expands a leading ~ like a shell would, so config values such as
// ~/.zcode/cli/db/db.sqlite work without a shell involved.
export const resolveSessionsDatabasePath = (configuredPath) => {
  const base = configuredPath || defaultSessionsDatabasePath();
  if (base === "~") return homedir();
  if (base.startsWith("~/")) return join(homedir(), base.slice(2));
  return base;
};

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Old Node builds without the built-in sqlite module: the feature throws
  // a clear error at sync time instead of failing the import.
}

const DAY_MS = 86_400_000;

// Aggregates completed, non-title model requests and per-session rollups.
// The database is opened read-only against a temporary copy so a running
// ZCode instance (WAL mode) is never disturbed.
export const collectSessionUsage = ({ databasePath, sourceRoot, now }) => {
  const generatedAt = now || new Date().toISOString();
  const empty = {
    enabled: true,
    generatedAt,
    perDay: [],
    perModel: [],
    sessionsByDay: [],
    sessions: [],
  };
  if (!DatabaseSync) {
    throw new Error(
      "sessions sync requires a Node build with the built-in sqlite module (node:sqlite, Node >= 22.13)",
    );
  }
  // A missing database is a valid setup (no ZCode CLI on this machine); a
  // Node without sqlite support is not, and must fail loudly above.
  if (!existsSync(databasePath)) return empty;

  const stagingDirectory = mkdtempSync(join(tmpdir(), "workbench-sessions-db-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, join(stagingDirectory, `db.sqlite${suffix}`));
    }
    const database = new DatabaseSync(join(stagingDirectory, "db.sqlite"), { readOnly: true });
    try {
      return {
        enabled: true,
        generatedAt,
        ...aggregate(database, sourceRoot),
      };
    } finally {
      database.close();
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
};

const aggregate = (database, sourceRoot) => {
  // Title-generation requests are housekeeping, not work; only completed
  // requests carry trustworthy token counts.
  const usageRows = database
    .prepare(
      `SELECT session_id, provider_id, model_id, started_at, duration_ms,
              input_tokens, output_tokens,
              cache_read_input_tokens + cache_creation_input_tokens AS cache_tokens
       FROM model_usage
       WHERE status = 'completed' AND (query_source IS NULL OR query_source != 'session_title')`,
    )
    .all();
  const sessionRows = database
    .prepare(
      `SELECT id, parent_id, task_type, directory, title, time_created FROM session
       ORDER BY time_created`,
    )
    .all();
  const toolRows = database
    .prepare(
      `SELECT session_id, tool_name, COUNT(*) AS uses FROM tool_usage
       WHERE tool_name IN ('Edit', 'Write', 'Skill') GROUP BY session_id, tool_name`,
    )
    .all();

  const scoped = sessionRows.filter(
    (row) => row.directory === sourceRoot || row.directory.startsWith(`${sourceRoot}/`),
  );
  const scopedIds = new Set(scoped.map((row) => row.id));

  const perDay = new Map();
  const perModel = new Map();
  const sessionsByDay = new Map();
  const sessionTotals = new Map(
    scoped.map((row) => [
      row.id,
      {
        id: row.id,
        taskType: row.task_type,
        parent: row.parent_id || "",
        title: row.title,
        directory: row.directory,
        started: new Date(row.time_created).toISOString(),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        modelMs: 0,
        model: "",
        modelTokens: new Map(),
        edits: 0,
        writes: 0,
        skillCalls: 0,
      },
    ]),
  );
  for (const tool of toolRows) {
    const total = sessionTotals.get(tool.session_id);
    if (!total) continue;
    if (tool.tool_name === "Edit") total.edits = tool.uses;
    if (tool.tool_name === "Write") total.writes = tool.uses;
    if (tool.tool_name === "Skill") total.skillCalls = tool.uses;
  }

  for (const row of usageRows) {
    if (!scopedIds.has(row.session_id)) continue;
    const started = Number(row.started_at);
    // A completed request should always carry a timestamp; skip stray rows
    // rather than bucketing them under 1970.
    if (!Number.isFinite(started)) continue;
    const day = new Date(Math.floor(started / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    const daySessions = sessionsByDay.get(day) || new Set();
    daySessions.add(row.session_id);
    sessionsByDay.set(day, daySessions);
    const dayKey = `${day}\u0000${row.provider_id}\u0000${row.model_id}`;
    const modelKey = `${row.provider_id}\u0000${row.model_id}`;
    for (const [bucket, key] of [
      [perDay, dayKey],
      [perModel, modelKey],
    ]) {
      const entry = bucket.get(key) || {
        day,
        provider: row.provider_id || "",
        model: row.model_id || "",
        requests: 0,
        sessions: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        modelMs: 0,
      };
      entry.requests += 1;
      entry.sessions.add(row.session_id);
      entry.inputTokens += row.input_tokens || 0;
      entry.outputTokens += row.output_tokens || 0;
      entry.cacheTokens += row.cache_tokens || 0;
      entry.modelMs += row.duration_ms || 0;
      bucket.set(key, entry);
    }
    const total = sessionTotals.get(row.session_id);
    if (total) {
      total.requests += 1;
      total.inputTokens += row.input_tokens || 0;
      total.outputTokens += row.output_tokens || 0;
      total.modelMs += row.duration_ms || 0;
      const modelId = row.model_id || "";
      total.modelTokens.set(
        modelId,
        (total.modelTokens.get(modelId) || 0) + (row.output_tokens || 0),
      );
    }
  }

  for (const total of sessionTotals.values()) {
    let best = -1;
    for (const [modelId, tokens] of total.modelTokens) {
      if (tokens > best) {
        best = tokens;
        total.model = modelId;
      }
    }
    delete total.modelTokens;
  }

  const totals = (entry) => ({
    provider: entry.provider,
    model: entry.model,
    requests: entry.requests,
    sessions: entry.sessions.size,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheTokens: entry.cacheTokens,
    modelMs: entry.modelMs,
  });

  return {
    perDay: [...perDay.values()]
      .sort(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          (left.provider + left.model).localeCompare(right.provider + right.model),
      )
      .map((entry) => ({ day: entry.day, ...totals(entry) })),
    perModel: [...perModel.values()]
      .sort((left, right) => right.outputTokens - left.outputTokens)
      .map(totals),
    sessionsByDay: [...sessionsByDay.entries()]
      .map(([day, ids]) => ({ day, sessions: ids.size }))
      .sort((left, right) => left.day.localeCompare(right.day)),
    sessions: [...sessionTotals.values()]
      .map(({ modelTokens: _internal, ...row }) => row)
      .sort((left, right) => left.started.localeCompare(right.started)),
  };
};

export const sessionUsageDisabled = (generatedAt = new Date().toISOString()) => ({
  enabled: false,
  generatedAt,
  perDay: [],
  perModel: [],
  sessionsByDay: [],
  sessions: [],
});
