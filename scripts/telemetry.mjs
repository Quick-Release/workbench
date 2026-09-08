import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { outcomesForRepository } from "./outcomes.mjs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// Telemetry (ticket #14, enriched by #15/#16): the client-side tracer
// bullet of the mandatory reporting flow (ADR 0001). At the end of every
// sync run one payload per Developer per host repo per UTC day is POSTed
// to the company endpoint: identity (gh login, falling back to git
// email, nullable), repo remote, workbench version, OS, Node, the
// session aggregates when the host's sessions opt-in is enabled
// (omitted — never zero-filled — otherwise), the Developer's Outcomes on
// GitHub remotes, and buffered health errors. Delivery failures are
// logged and swallowed; demo mode and an unconfigured endpoint send
// nothing. Numbers only: commit text, prompts, and file contents never
// enter the payload.

const execFileAsync = promisify(execFile);

export async function resolveIdentity({ runGh, runGit }) {
  try {
    const login = (await runGh(["api", "user", "--jq", ".login"])).trim();
    if (login) return { login };
  } catch {
    // gh unauthenticated or missing — fall through to git email.
  }
  try {
    const email = (await runGit(["config", "user.email"])).trim();
    if (email) return { email };
  } catch {
    // No git identity either — the payload still sends, with null identity.
  }
  return null;
}

export const identityKey = (identity) => identity?.login ?? identity?.email ?? "anon";

export const telemetryDay = (now = new Date()) => now.toISOString().slice(0, 10);

export function buildTelemetryPayload({
  identity = null,
  repositoryUrl,
  version,
  os,
  node,
  day = telemetryDay(),
  sentAt = new Date().toISOString(),
  agentUsage,
  outcomes,
  errors,
}) {
  const payload = {
    day,
    sentAt,
    repoRemote: repositoryUrl,
    developer: identity,
    workbench: { version, os, node },
  };
  if (agentUsage !== undefined) payload.agentUsage = agentUsage;
  if (outcomes !== undefined) payload.outcomes = outcomes;
  if (Array.isArray(errors) && errors.length > 0) payload.errors = errors;
  return payload;
}

// Agent usage reuses the existing sessions collector's aggregates; when
// the host's sessions opt-in is off, the field is omitted — Telemetry
// never reads the session database on its own authority.
export function agentUsageFromSessions(sessions) {
  if (!sessions?.enabled) return undefined;
  return {
    models: sessions.perModel.map((row) => row.model),
    requests: sessions.perModel.reduce((total, row) => total + row.requests, 0),
    inputTokens: sessions.perModel.reduce((total, row) => total + row.inputTokens, 0),
    outputTokens: sessions.perModel.reduce((total, row) => total + row.outputTokens, 0),
    sessions: sessions.sessions.length,
  };
}

// The state file lives under node_modules/.cache: git-ignored by default
// in every host repo and in this repository, so the daily marker and the
// health-error buffer never show up in a diff.
export const statePath = (appDirectory) =>
  join(appDirectory, "node_modules", ".cache", "workbench-telemetry-state.json");

function readState(appDirectory) {
  const path = statePath(appDirectory);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeState(appDirectory, state) {
  const path = statePath(appDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

// Health (ticket #15): uncaught errors ride the payload as an errors
// array instead of vanishing. Appending is fail-soft — health capture
// must never be the thing that breaks a run.
export function recordHealthError({ appDirectory, error, version }) {
  try {
    const state = readState(appDirectory);
    const errors = Array.isArray(state.errors) ? state.errors : [];
    errors.push({
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? ""),
      version,
      os: process.platform,
      node: process.version,
      at: new Date().toISOString(),
    });
    writeState(appDirectory, { ...state, errors });
    return true;
  } catch {
    return false;
  }
}

// The package constants with their environment overrides (tests and
// local development). An unconfigured endpoint sends nothing: the values
// are provisioned at the company install, not guessed.
function endpointConfig(env) {
  const url = env.WORKBENCH_TELEMETRY_URL ?? "";
  const token = env.TELEMETRY_INGEST_TOKEN ?? "";
  return { url, token };
}

export async function reportTelemetry({
  appDirectory,
  repositoryUrl,
  demo = false,
  env = process.env,
  sessions,
  version,
  runGh = (args) => execFileAsync("gh", args, { stdio: ["ignore", "pipe", "ignore"] }),
  runGit = (args) =>
    execFileAsync("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      cwd: rootDirectory ?? undefined,
    }),
  rootDirectory,
  fetchImpl = fetch,
  now = new Date(),
}) {
  if (demo) return { action: "skipped", reason: "demo" };
  const { url: endpoint, token } = endpointConfig(env);
  if (!endpoint || !token) return { action: "skipped", reason: "unconfigured" };

  try {
    const identity = await resolveIdentity({ runGh, runGit });
    const state = readState(appDirectory);
    const key = `${repositoryUrl}|${identityKey(identity)}`;
    const day = telemetryDay(now);
    if (state.lastSent?.[key] === day) return { action: "deduped", tag: day };

    const payload = buildTelemetryPayload({
      identity,
      repositoryUrl,
      version,
      os: process.platform,
      node: process.version,
      day,
      sentAt: now.toISOString(),
      agentUsage: agentUsageFromSessions(sessions),
      outcomes: await outcomesForRepository({
        repositoryUrl,
        login: identity?.login,
        env,
        fetchImpl,
      }),
      errors: Array.isArray(state.errors) ? state.errors : [],
    });

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`telemetry endpoint answered ${response.status}`);

    writeState(appDirectory, {
      ...state,
      lastSent: { ...state.lastSent, [key]: day },
      errors: [],
    });
    return { action: "sent", payload };
  } catch (cause) {
    console.warn(`telemetry: delivery failed (${String(cause?.message ?? cause)})`);
    return { action: "failed" };
  }
}
