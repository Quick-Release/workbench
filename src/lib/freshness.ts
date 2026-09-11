// GH-145: the header freshness chip's derivation. Freshness means sync
// completion — the snapshot's syncedAt — never the host repo's HEAD commit
// time the older snapshot stamp carries.
export const SYNCED_STALE_AFTER_MS = 10 * 60 * 1000;

export const syncedAgo = (
  syncedAt: string,
  now: number,
): { text: string; stale: boolean } | null => {
  const then = Date.parse(syncedAt);
  if (Number.isNaN(then)) return null;
  const age = Math.max(0, now - then);
  const text =
    age < 10_000
      ? "just now"
      : age < 60_000
        ? `${Math.floor(age / 1000)}s ago`
        : age < 3_600_000
          ? `${Math.floor(age / 60_000)}m ago`
          : age < 86_400_000
            ? `${Math.floor(age / 3_600_000)}h ago`
            : `${Math.floor(age / 86_400_000)}d ago`;
  return { text, stale: age >= SYNCED_STALE_AFTER_MS };
};
