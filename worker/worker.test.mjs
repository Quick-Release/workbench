import { readFileSync } from "node:fs";
import { strictEqual, match } from "node:assert";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "./ingest.mjs";

const TOKEN = "ingest-token";

function createD1Double() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("./migrations/0001_init.sql", import.meta.url), "utf8");
  db.exec(schema);
  return {
    db,
    prepare(sql) {
      let params = [];
      return {
        bind(...args) {
          params = args.flat();
          return this;
        },
        async run() {
          db.prepare(sql).run(...params);
          return { success: true };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
      };
    },
  };
}

function request(path, { token = TOKEN, body, method = "POST" } = {}) {
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://telemetry.example.com${path}`, init);
}

const telemetryPayload = {
  day: "2026-09-03",
  sentAt: "2026-09-03T10:00:00.000Z",
  repoRemote: "git@github.com:acme/widgets.git",
  developer: { login: "ada", email: "ada@acme.dev" },
  workbench: { version: "0.1.0", os: "darwin", node: "22.13.0" },
};

const submissionPayload = {
  repoRemote: "git@github.com:acme/widgets.git",
  commitSha: "e5a7f30c0e40a5d9b6b1c2f9a4d3e2b1a0c9d8e7",
  subject: "feat: dedupe table chrome after shadcn migration",
  body: "Extracts the shared table header so both pages render identically.\n\nRefs: #11",
  author: "Ada Lovelace",
  submittedAt: "2026-09-03T10:00:00.000Z",
  developer: { login: "ada", email: "ada@acme.dev" },
  ticketRef: "#11",
};

async function callWorker(env, req) {
  return worker.fetch(req, { D1_DB: env.d1, TELEMETRY_INGEST_TOKEN: TOKEN });
}

test("healthz responds ok without auth", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(env, request("/healthz", { method: "GET", token: null }));
  strictEqual(response.status, 200);
});

test("valid telemetry payload is stored", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(env, request("/telemetry", { body: telemetryPayload }));
  strictEqual(response.status, 200);
  const rows = env.d1.db.prepare("SELECT * FROM telemetry").all();
  strictEqual(rows.length, 1);
  strictEqual(rows[0].day, "2026-09-03");
  strictEqual(rows[0].repo_remote, telemetryPayload.repoRemote);
  strictEqual(rows[0].developer_login, "ada");
  strictEqual(JSON.parse(rows[0].payload).workbench.version, "0.1.0");
});

test("valid submission is stored as pending for review", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(env, request("/submissions", { body: submissionPayload }));
  strictEqual(response.status, 200);
  const rows = env.d1.db.prepare("SELECT * FROM submissions").all();
  strictEqual(rows.length, 1);
  strictEqual(rows[0].commit_sha, submissionPayload.commitSha);
  strictEqual(rows[0].author, "Ada Lovelace");
  strictEqual(rows[0].status, "pending");
  strictEqual(rows[0].ticket_ref, "#11");
});

test("telemetry without a token is rejected", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(
    env,
    request("/telemetry", { token: null, body: telemetryPayload }),
  );
  strictEqual(response.status, 401);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 0);
});

test("telemetry with a wrong token is rejected", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(
    env,
    request("/telemetry", { token: "wrong", body: telemetryPayload }),
  );
  strictEqual(response.status, 401);
});

test("telemetry with a malformed body is rejected and stores nothing", async () => {
  const env = { d1: createD1Double() };
  const bad = { ...telemetryPayload, repoRemote: "" };
  const response = await callWorker(env, request("/telemetry", { body: bad }));
  strictEqual(response.status, 400);
  match(await response.text(), /repoRemote/);
  const response2 = await callWorker(env, request("/telemetry", { body: undefined }));
  strictEqual(response2.status, 400);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 0);
});

test("submission with an invalid commit sha is rejected", async () => {
  const env = { d1: createD1Double() };
  const response = await callWorker(
    env,
    request("/submissions", { body: { ...submissionPayload, commitSha: "nope" } }),
  );
  strictEqual(response.status, 400);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 0);
});

test("repeat telemetry for the same developer, repo, and day is a conflict", async () => {
  const env = { d1: createD1Double() };
  strictEqual(
    (await callWorker(env, request("/telemetry", { body: telemetryPayload }))).status,
    200,
  );
  const response = await callWorker(env, request("/telemetry", { body: telemetryPayload }));
  strictEqual(response.status, 409);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 1);
});

test("telemetry from another developer on the same day is accepted", async () => {
  const env = { d1: createD1Double() };
  strictEqual(
    (await callWorker(env, request("/telemetry", { body: telemetryPayload }))).status,
    200,
  );
  const other = { ...telemetryPayload, developer: { login: "grace" } };
  const response = await callWorker(env, request("/telemetry", { body: other }));
  strictEqual(response.status, 200);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 2);
});

test("the same developer with and without an email is still one identity per day", async () => {
  const env = { d1: createD1Double() };
  strictEqual(
    (await callWorker(env, request("/telemetry", { body: telemetryPayload }))).status,
    200,
  );
  const emailLost = { ...telemetryPayload, developer: { login: "ada" } };
  const response = await callWorker(env, request("/telemetry", { body: emailLost }));
  strictEqual(response.status, 409);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 1);
});

test("unidentified telemetry dedupes per repo and day too", async () => {
  const env = { d1: createD1Double() };
  const anonymous = { ...telemetryPayload, developer: null };
  strictEqual((await callWorker(env, request("/telemetry", { body: anonymous }))).status, 200);
  const response = await callWorker(env, request("/telemetry", { body: anonymous }));
  strictEqual(response.status, 409);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM telemetry").get().n, 1);
});

test("submission shas are normalized, so case differs only", async () => {
  const env = { d1: createD1Double() };
  strictEqual(
    (await callWorker(env, request("/submissions", { body: submissionPayload }))).status,
    200,
  );
  const upper = { ...submissionPayload, commitSha: submissionPayload.commitSha.toUpperCase() };
  const response = await callWorker(env, request("/submissions", { body: upper }));
  strictEqual(response.status, 409);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
});

test("a D1-wrapped unique violation is still a conflict", async () => {
  const inner = createD1Double();
  const d1 = {
    db: inner.db,
    prepare(sql) {
      const statement = inner.prepare(sql);
      const wrapper = {
        bind: (...args) => {
          statement.bind(...args);
          return wrapper;
        },
        run: async () => {
          throw new Error("D1_ERROR: UNIQUE constraint failed: telemetry.day: SQLSTATE 23505");
        },
      };
      return wrapper;
    },
  };
  const response = await callWorker({ d1 }, request("/telemetry", { body: telemetryPayload }));
  strictEqual(response.status, 409);
});

test("repeat submission of the same commit is a conflict", async () => {
  const env = { d1: createD1Double() };
  strictEqual(
    (await callWorker(env, request("/submissions", { body: submissionPayload }))).status,
    200,
  );
  const response = await callWorker(env, request("/submissions", { body: submissionPayload }));
  strictEqual(response.status, 409);
  strictEqual(env.d1.db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
});

test("unknown routes are not found", async () => {
  const env = { d1: createD1Double() };
  strictEqual((await callWorker(env, request("/nope", { body: {} }))).status, 404);
  strictEqual((await callWorker(env, request("/telemetry", { method: "GET" }))).status, 404);
});
