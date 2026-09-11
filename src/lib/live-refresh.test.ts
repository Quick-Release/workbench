import { describe, expect, it } from "vite-plus/test";

import {
  LIVE_REFRESH_BASE_MS,
  LIVE_REFRESH_MAX_MS,
  nextRefreshDelayMs,
  shouldRefreshNow,
} from "./live-refresh";

describe("live refresh cadence (GH-136)", () => {
  it("polls at the documented 60s target while healthy", () => {
    expect(LIVE_REFRESH_BASE_MS).toBe(60_000);
    expect(nextRefreshDelayMs(0)).toBe(60_000);
  });

  it("doubles the wait on every consecutive error, capped at five minutes", () => {
    expect(nextRefreshDelayMs(1)).toBe(120_000);
    expect(nextRefreshDelayMs(2)).toBe(240_000);
    expect(nextRefreshDelayMs(3)).toBe(LIVE_REFRESH_MAX_MS);
    expect(nextRefreshDelayMs(10)).toBe(LIVE_REFRESH_MAX_MS);
  });

  it("refreshes only when live, visible, idle, and due", () => {
    const due = { inFlight: false, dueAt: 100, now: 100 };
    expect(shouldRefreshNow({ ...due, mode: "live", visible: true })).toBe(true);
    expect(shouldRefreshNow({ ...due, mode: "static", visible: true })).toBe(false);
    expect(shouldRefreshNow({ ...due, mode: "live", visible: false })).toBe(false);
    expect(shouldRefreshNow({ ...due, mode: "live", visible: true, inFlight: true })).toBe(false);
    expect(shouldRefreshNow({ ...due, mode: "live", visible: true, now: 99 })).toBe(false);
  });
});
