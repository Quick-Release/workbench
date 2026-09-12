// The auto-sync leg (GH-147): the dev-server side of the live board. While a
// browser has recently read the seam, a fixed-cadence tick asks GitHub with a
// conditional request whether the issues list changed — a 304 skips the sync
// at no rate cost — and a change runs the same sync-trigger action the
// dashboard's Run sync button uses, so stamp, warnings, and telemetry behave
// identically. An in-flight guard keeps ticks from stacking a sync onto a
// sync, and a browser that never reads the seam keeps the leg asleep: an
// unread board burns no quota.
import { LIVE_REFRESH_MAX_MS } from "../src/lib/live-refresh.ts";

import { GITHUB_API, PER_PAGE, githubHeaders, issuesUrl } from "./tracker/issues.mjs";
import { resolveGhToken } from "./tracker/index.mjs";

export const AUTO_SYNC_CADENCE_MS = 90_000;

// The presence window is the client lifecycle's worst-case error backoff: a
// visible tab re-reads the seam at least this often, so a last read older
// than the ceiling means no browser is keeping the board alive.
const PRESENCE_WINDOW_MS = LIVE_REFRESH_MAX_MS;

export const createAutoSync = ({
  appDirectory,
  resolveRepo,
  applySync,
  run,
  fetchImpl = globalThis.fetch,
  env = process.env,
  ghToken = async () => "",
  now = Date.now,
  schedule = (fn, ms) => {
    const timer = setInterval(() => fn(), ms);
    timer.unref?.();
    return timer;
  },
  cancel = (timer) => clearInterval(timer),
}) => {
  let lastSeamReadAt = -Infinity;
  let probeEtag = null;
  let syncing = false;

  const tick = async () => {
    // The mutex answers the tick before it probes: while a sync runs, later
    // ticks neither probe nor stack a second sync.
    if (syncing) return false;
    if (now() - lastSeamReadAt >= PRESENCE_WINDOW_MS) return false;
    const token = await resolveGhToken({ env, ghToken });
    if (!token) return false;
    const repo = await resolveRepo();
    if (!repo) return false;
    // The probe makes the sync sweep's own first-page request, so its ETag
    // speaks for exactly the list the sweep reads first.
    const url = issuesUrl(GITHUB_API, repo, "", {
      state: "open",
      per_page: PER_PAGE,
      page: 1,
    });
    try {
      const response = await fetchImpl(url, {
        headers: {
          ...githubHeaders(token),
          ...(probeEtag ? { "If-None-Match": probeEtag } : {}),
        },
      });
      // A 304 answers at no rate cost and means nothing changed; any other
      // failure skips the tick too — the chip's staleness is the signal, not
      // a console line per failed probe.
      if (response.status === 304 || !response.ok) return false;
      const etag = response.headers?.get?.("etag");
      if (etag) probeEtag = etag;
    } catch {
      return false;
    }
    syncing = true;
    try {
      await applySync({ appDirectory, run });
    } finally {
      syncing = false;
    }
    return true;
  };

  let timer = null;

  return {
    noteSeamRead: () => {
      lastSeamReadAt = now();
    },
    tick,
    // The interval callback swallows rejections: a tick's failure is
    // reported by the chip going stale, never by an unhandled rejection
    // taking the dev server down.
    start: () => {
      if (timer) return;
      timer = schedule(() => tick().catch(() => {}), AUTO_SYNC_CADENCE_MS);
    },
    stop: () => {
      if (!timer) return;
      cancel(timer);
      timer = null;
    },
  };
};
