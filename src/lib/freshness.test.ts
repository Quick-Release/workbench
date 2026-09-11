import { describe, expect, it } from "vite-plus/test";

import { syncedAgo } from "./freshness";

// GH-145: the header freshness chip's derivation. Freshness means sync
// completion; the stamp is the snapshot's syncedAt.
describe("syncedAgo", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");

  it("reads sub-minute freshness in seconds", () => {
    expect(syncedAgo("2026-09-11T11:59:18Z", now)).toEqual({ text: "42s ago", stale: false });
  });

  it("reads minutes, hours, and days", () => {
    expect(syncedAgo("2026-09-11T11:55:00Z", now)?.text).toBe("5m ago");
    expect(syncedAgo("2026-09-11T09:00:00Z", now)?.text).toBe("3h ago");
    expect(syncedAgo("2026-09-09T12:00:00Z", now)?.text).toBe("2d ago");
  });

  it("turns stale past the staleness threshold", () => {
    expect(syncedAgo("2026-09-11T11:55:00Z", now)?.stale).toBe(false);
    expect(syncedAgo("2026-09-11T11:45:00Z", now)?.stale).toBe(true);
  });

  it("tolerates a future stamp as just now", () => {
    expect(syncedAgo("2026-09-11T12:00:05Z", now)).toEqual({ text: "just now", stale: false });
  });

  it("returns null for an unparsable stamp", () => {
    expect(syncedAgo("not a date", now)).toBeNull();
  });
});
