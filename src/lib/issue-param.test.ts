import { describe, expect, it } from "vite-plus/test";

import { issueParamFromSearch, panelIdFor } from "./issue-param";

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
