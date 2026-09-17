import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { evaluateClarificationPosture } from "./posture.mjs";

test("an absent block and a switched-off block are disabled", () => {
  deepStrictEqual(evaluateClarificationPosture(undefined), {
    posture: "disabled",
    available: false,
  });
  deepStrictEqual(evaluateClarificationPosture({ enabled: false }), {
    posture: "disabled",
    available: false,
  });
  // Other fields cannot half-enable a switched-off block.
  deepStrictEqual(
    evaluateClarificationPosture({ enabled: false, provider: "openai-codex-oauth" }),
    { posture: "disabled", available: false },
  );
});

test("an enabled block missing a posture element is invalid, naming each", () => {
  const bare = evaluateClarificationPosture({ enabled: true });
  strictEqual(bare.posture, "invalid");
  strictEqual(bare.available, false);
  deepStrictEqual(bare.reasons, [
    "clarification.provider is required when clarification is enabled",
    "clarification.dataDestination is required when clarification is enabled",
  ]);

  const half = evaluateClarificationPosture({
    enabled: true,
    provider: "openai-codex-oauth",
  });
  deepStrictEqual(half.reasons, [
    "clarification.dataDestination is required when clarification is enabled",
  ]);
});

test("an enabled block reports its problems and its missing elements together", () => {
  const posture = evaluateClarificationPosture({
    enabled: true,
    provider: " ",
    dataDestination: undefined,
    problems: ["clarification.provider must be a non-empty string"],
  });
  strictEqual(posture.posture, "invalid");
  deepStrictEqual(posture.reasons, [
    "clarification.provider must be a non-empty string",
    "clarification.dataDestination is required when clarification is enabled",
  ]);
});

test("problems report invalid even while the capability stays off", () => {
  const posture = evaluateClarificationPosture({
    enabled: false,
    problems: ["clarification must be an object"],
  });
  strictEqual(posture.posture, "invalid");
  deepStrictEqual(posture.reasons, ["clarification must be an object"]);
});

test("a complete enabled block is enabled but never available in this build", () => {
  deepStrictEqual(
    evaluateClarificationPosture({
      enabled: true,
      provider: "openai-codex-oauth",
      dataDestination: "https://api.openai.com",
      problems: [],
    }),
    { posture: "enabled", available: false },
  );
});
