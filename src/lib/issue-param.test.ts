import { describe, expect, it } from "vite-plus/test";

import {
  effortParamFromSearch,
  expandParamFromSearch,
  focusParamFromSearch,
  issueParamFromSearch,
  panelIdFor,
} from "./issue-param";

describe("the ?issue search-param grammar", () => {
  it("accepts an issue number, the new-issue sentinel, and nothing else", () => {
    expect(issueParamFromSearch({ issue: "60" })).toBe("60");
    expect(issueParamFromSearch({ issue: "new" })).toBe("new");
    expect(issueParamFromSearch({ issue: "GH-60" })).toBeUndefined();
    expect(issueParamFromSearch({ issue: 60 })).toBeUndefined();
    expect(issueParamFromSearch({ issue: ["60"] })).toBeUndefined();
    expect(issueParamFromSearch({})).toBeUndefined();
  });

  it("maps the param onto the panel's work-item id", () => {
    expect(panelIdFor("60")).toBe("GH-60");
    expect(panelIdFor("new")).toBe("new");
    expect(panelIdFor(undefined)).toBeNull();
  });
});

describe("the blocker graph's search-param grammar (ticket #61)", () => {
  it("accepts the panel's show-in-graph spellings — qualified effort, bare focus", () => {
    expect(effortParamFromSearch({ effort: "GH-41" })).toBe("GH-41");
    expect(effortParamFromSearch({ effort: "41" })).toBe("GH-41");
    expect(effortParamFromSearch({ effort: "nope" })).toBeUndefined();
    expect(focusParamFromSearch({ focus: "42" })).toBe("GH-42");
    expect(focusParamFromSearch({ focus: "GH-42" })).toBe("GH-42");
    expect(focusParamFromSearch({ focus: "new" })).toBeUndefined();
  });

  it("accepts the expand toggle as 1 or true and defaults to closed", () => {
    expect(expandParamFromSearch({ expand: "1" })).toBe(true);
    expect(expandParamFromSearch({ expand: "true" })).toBe(true);
    expect(expandParamFromSearch({ expand: "0" })).toBe(false);
    expect(expandParamFromSearch({})).toBe(false);
  });
});
