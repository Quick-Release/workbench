// The live refresh scheduler's pure half (GH-136): when the seam's live read
// repeats while the dashboard is active. A healthy 60-second cadence meets
// the documented polling target; every error doubles the wait up to a
// five-minute ceiling, and visibility gates everything — a hidden tab polls
// nothing, and a static snapshot (no reachable seam) never polls at all.
export const LIVE_REFRESH_BASE_MS = 60_000;
export const LIVE_REFRESH_MAX_MS = 300_000;

export const nextRefreshDelayMs = (consecutiveErrors: number): number =>
  Math.min(LIVE_REFRESH_BASE_MS * 2 ** Math.max(0, consecutiveErrors), LIVE_REFRESH_MAX_MS);

export const shouldRefreshNow = ({
  mode,
  visible,
  inFlight,
  dueAt,
  now,
}: {
  mode: "live" | "static";
  visible: boolean;
  inFlight: boolean;
  dueAt: number;
  now: number;
}): boolean => mode === "live" && visible && !inFlight && now >= dueAt;
