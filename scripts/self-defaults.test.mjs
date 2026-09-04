import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { SELF_REPOSITORY, SELF_REPOSITORY_URL, servicesForSource } from "./self-defaults.mjs";

test("standalone source defaults to Workbench's GitHub issues", () => {
  deepStrictEqual(servicesForSource([], true), [
    {
      id: "github-issues",
      type: "github",
      label: "GitHub issues",
      repo: SELF_REPOSITORY,
    },
  ]);
  strictEqual(SELF_REPOSITORY_URL, "https://github.com/Quick-Release/workbench");
});

test("explicit services and host repositories do not receive the self default", () => {
  const configured = [{ id: "roadmap", type: "asana", projectGid: "project-1" }];
  strictEqual(servicesForSource(configured, true), configured);
  deepStrictEqual(servicesForSource([], false), []);
});
