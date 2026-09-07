// Ingest endpoint for workbench Telemetry and Submissions (ADR 0001).
// A pure fetch handler: request + D1 binding in, response out, so the
// tests drive it directly without a runtime. Auth is a shared bearer
// token (registry membership is the company boundary); validation is
// strict on required identity fields and type-checked on enrichment.
// The deploy entry (worker.mjs) composes the same pieces with the Agents
// SDK mounted behind the gate.

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateDeveloper(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value))
    return "developer must be null or an object";
  for (const key of ["login", "email"]) {
    if (value[key] !== undefined && !isNonEmptyString(value[key]))
      return `developer.${key} must be a non-empty string`;
  }
  return null;
}

function validateWorkbench(value) {
  if (typeof value !== "object" || value === null) return "workbench must be an object";
  for (const key of ["version", "os", "node"]) {
    if (!isNonEmptyString(value[key])) return `workbench.${key} must be a non-empty string`;
  }
  return null;
}

function validateTelemetry(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return "body must be an object";
  if (!DAY.test(payload.day ?? "")) return "day must be a YYYY-MM-DD string";
  if (!isNonEmptyString(payload.sentAt)) return "sentAt must be a non-empty string";
  if (!isNonEmptyString(payload.repoRemote)) return "repoRemote must be a non-empty string";
  const developer = validateDeveloper(payload.developer);
  if (developer) return developer;
  const workbench = validateWorkbench(payload.workbench);
  if (workbench) return workbench;
  if (
    payload.agentUsage !== undefined &&
    (typeof payload.agentUsage !== "object" || payload.agentUsage === null)
  ) {
    return "agentUsage must be an object";
  }
  if (payload.errors !== undefined && !Array.isArray(payload.errors))
    return "errors must be an array";
  return null;
}

function validateSubmission(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return "body must be an object";
  if (!isNonEmptyString(payload.repoRemote)) return "repoRemote must be a non-empty string";
  if (typeof payload.commitSha !== "string" || !COMMIT_SHA.test(payload.commitSha))
    return "commitSha must be a git sha";
  if (!isNonEmptyString(payload.subject)) return "subject must be a non-empty string";
  if (typeof payload.body !== "string") return "body must be a string";
  if (!isNonEmptyString(payload.author)) return "author must be a non-empty string";
  if (!isNonEmptyString(payload.submittedAt)) return "submittedAt must be a non-empty string";
  const developer = validateDeveloper(payload.developer);
  if (developer) return developer;
  if (payload.ticketRef !== undefined && !isNonEmptyString(payload.ticketRef))
    return "ticketRef must be a non-empty string";
  return null;
}

// Constant-time so response timing leaks nothing about the token.
function tokenMatches(presented, expected) {
  if (!isNonEmptyString(expected)) return false;
  const a = typeof presented === "string" ? presented : "";
  const length = Math.max(a.length, expected.length);
  let diff = a.length === expected.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (expected.charCodeAt(i) | 0);
  }
  return diff === 0;
}

export function authorized(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return tokenMatches(match?.[1], env.TELEMETRY_INGEST_TOKEN);
}

export function unauthorized() {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

// The dispatch the deploy entry composes after the gate — the ingest
// routes plus the authenticated fallthrough. Named so worker.mjs can slot
// the agent route between the gate and this dispatch without duplicating
// either.
export async function routeIngest(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/telemetry") return ingestTelemetry(request, env);
  if (request.method === "POST" && pathname === "/submissions")
    return ingestSubmission(request, env);
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

async function readJson(request) {
  try {
    return { payload: await request.json() };
  } catch {
    return { error: "body must be valid JSON" };
  }
}

function conflict() {
  return Response.json({ ok: false, error: "duplicate: already received" }, { status: 409 });
}

// Both node:sqlite and D1 surface unique violations with this phrase in
// their (differently wrapped) error messages; anything else is a 500.
function isUniqueViolation(cause) {
  return /UNIQUE constraint failed/.test(String(cause?.message));
}

async function ingestTelemetry(request, env) {
  const { payload, error } = await readJson(request);
  if (error) return Response.json({ ok: false, error }, { status: 400 });
  const invalid = validateTelemetry(payload);
  if (invalid) return Response.json({ ok: false, error: invalid }, { status: 400 });

  try {
    await env.D1_DB.prepare(
      "INSERT INTO telemetry (day, repo_remote, developer_login, developer_email, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        payload.day,
        payload.repoRemote,
        payload.developer?.login ?? null,
        payload.developer?.email ?? null,
        JSON.stringify(payload),
        new Date().toISOString(),
      )
      .run();
  } catch (cause) {
    if (isUniqueViolation(cause)) return conflict();
    return Response.json({ ok: false, error: "storage failure" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

async function ingestSubmission(request, env) {
  const { payload, error } = await readJson(request);
  if (error) return Response.json({ ok: false, error }, { status: 400 });
  const invalid = validateSubmission(payload);
  if (invalid) return Response.json({ ok: false, error: invalid }, { status: 400 });

  try {
    await env.D1_DB.prepare(
      "INSERT INTO submissions (repo_remote, commit_sha, subject, body, author, developer_login, developer_email, ticket_ref, status, submitted_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
      .bind(
        payload.repoRemote,
        payload.commitSha.toLowerCase(),
        payload.subject,
        payload.body,
        payload.author,
        payload.developer?.login ?? null,
        payload.developer?.email ?? null,
        payload.ticketRef ?? null,
        payload.submittedAt,
        new Date().toISOString(),
      )
      .run();
  } catch (cause) {
    if (isUniqueViolation(cause)) return conflict();
    return Response.json({ ok: false, error: "storage failure" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }
    if (!authorized(request, env)) return unauthorized();
    return routeIngest(request, env);
  },
};
