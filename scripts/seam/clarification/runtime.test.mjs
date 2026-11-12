import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import test from "node:test";

import { clarificationRuntimeLoader, hostRepoSlug } from "./runtime.mjs";

test("the host repo slug fails closed instead of guessing", () => {
  strictEqual(
    hostRepoSlug("https://github.com/Quick-Release/workbench"),
    "Quick-Release/workbench",
  );
  strictEqual(
    hostRepoSlug("https://github.com/Quick-Release/workbench/"),
    "Quick-Release/workbench",
  );
  strictEqual(
    hostRepoSlug("https://github.com/Quick-Release/workbench.git"),
    "Quick-Release/workbench",
  );
  strictEqual(hostRepoSlug(undefined), undefined);
  strictEqual(hostRepoSlug("https://github.com/"), undefined);
  strictEqual(hostRepoSlug("not a url"), undefined);
});

test("the runtime loader refuses a disabled install and an enabled install with no host repo", async () => {
  const dormant = clarificationRuntimeLoader({
    hostRoot: "/tmp/unused",
    loadConfig: async () => ({
      repositoryUrl: "https://github.com/Quick-Release/workbench",
      clarification: {
        enabled: false,
        provider: undefined,
        dataDestination: undefined,
        problems: [],
      },
    }),
    openStore: () => {
      throw new Error("a dormant install never opens the store");
    },
  });
  const dormantRuntime = await dormant();
  strictEqual(dormantRuntime.posture.posture, "disabled");
  strictEqual(dormantRuntime.coordinator, null);

  const slugless = clarificationRuntimeLoader({
    hostRoot: "/tmp/unused",
    loadConfig: async () => ({
      repositoryUrl: undefined,
      clarification: {
        enabled: true,
        provider: "openai-codex-oauth",
        dataDestination: "https://api.openai.com",
        problems: [],
      },
    }),
    openStore: () => {
      throw new Error("an install without a host repo never opens the store");
    },
  });
  const sluglessRuntime = await slugless();
  strictEqual(sluglessRuntime.posture.posture, "invalid");
  match(sluglessRuntime.posture.reasons[0], /repositoryUrl/);
  strictEqual(sluglessRuntime.coordinator, null);
});

test("the runtime loader opens the durable store once, at the host repo's own path", async () => {
  const opened = [];
  const loader = clarificationRuntimeLoader({
    hostRoot: "/tmp/host-repo",
    loadConfig: async () => ({
      repositoryUrl: "https://github.com/Quick-Release/workbench",
      clarification: {
        enabled: true,
        provider: "openai-codex-oauth",
        dataDestination: "https://api.openai.com",
        problems: [],
      },
    }),
    openStore: (args) => {
      opened.push(args);
      return { hostRepo: args.hostRepo, close() {}, createRun() {} };
    },
    token: async () => "",
  });

  const runtime = await loader();
  strictEqual(runtime.posture.posture, "enabled");
  strictEqual(typeof runtime.coordinator.manifest, "function");
  strictEqual(typeof runtime.coordinator.start, "function");
  deepStrictEqual(opened, [
    {
      hostRepo: "Quick-Release/workbench",
      databasePath: "/tmp/host-repo/.workbench/clarification/runs.sqlite",
    },
  ]);

  // The store opens once and stays open — records outlive requests.
  const again = await loader();
  deepStrictEqual(opened.length, 1);
  // So does the coordinator (ticket #237): the leases it holds and the live
  // sessions it drives are controller state a request must not drop.
  strictEqual(again.coordinator, runtime.coordinator);
});

test("a changed declared provider composes a fresh coordinator over the same store", async () => {
  let provider = "openai-codex-oauth";
  const loader = clarificationRuntimeLoader({
    hostRoot: "/tmp/host-repo",
    loadConfig: async () => ({
      repositoryUrl: "https://github.com/Quick-Release/workbench",
      clarification: {
        enabled: true,
        provider,
        dataDestination: "https://api.openai.com",
        problems: [],
      },
    }),
    openStore: (args) => ({ hostRepo: args.hostRepo, close() {}, createRun() {} }),
    token: async () => "",
  });
  const first = await loader();
  provider = "another-provider";
  const second = await loader();
  ok(first.coordinator !== second.coordinator);
});
