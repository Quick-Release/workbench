import { applyD1Migrations, env, runDurableObjectAlarm } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

import { agentRoute, hoursAgo, requestDigest, submit } from "./agent.fixtures.mjs";

// The agent's daily tick (#33), exercised through the runtime's alarm
// invocation. This file runs in its own workerd project whose binding sets
// the tick to one second, so a forced alarm deterministically finds it due.
// Only tick-driven tests belong here: at one second a real tick also fires
// on its own, within a second of arming (the SDK truncates the due time to
// whole seconds), so a test that asserts on-demand run history alone would
// race it (#261). Those live in agent.runtime.test.mjs, at the daily default.

beforeAll(async () => {
  await applyD1Migrations(env.D1_DB, env.TEST_MIGRATIONS);
});

it("persists a digest on the scheduled tick without any request", async () => {
  // A repo of its own, so no other test's digest runs can masquerade as
  // this tick's. Waking the agent once through the authenticated route
  // arms the schedule; the tick itself then runs alarm-driven, with no
  // digest-serving request involved.
  const tickRepo = "git@github.com:acme/tick-runs.git";
  const tickRoute = agentRoute(tickRepo);
  const tickStub = env.SubmissionReviewAgent.get(
    env.SubmissionReviewAgent.idFromName(encodeURIComponent(tickRepo)),
  );

  await submit(tickRepo, "f0".repeat(20), "feat: before arming", hoursAgo(2));
  const armedBody = await (await requestDigest(tickRoute)).json();
  expect(armedBody.digest.total).toBe(1);

  // Past the one-second test interval, the forced alarm finds the tick due
  // and it persists the digest from the rows as they are now — a request
  // to the agent route is never made.
  await submit(tickRepo, "f1".repeat(20), "feat: before the tick", hoursAgo(1));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(await runDurableObjectAlarm(tickStub)).toBe(true);

  const nextBody = await (await requestDigest(tickRoute)).json();
  expect(nextBody.digest.total).toBe(2);
  // Every run persisted between the two requests was a tick's, and the
  // second submission landed before any of them: the previous run already
  // counted it.
  expect(nextBody.previous.total).toBe(2);
  expect(nextBody.previous.computedAt).not.toBe(armedBody.digest.computedAt);
});
