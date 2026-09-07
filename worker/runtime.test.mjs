import { expect, it } from "vitest";

import { SELF } from "cloudflare:test";

// The worker's HTTP contract (ticket #29), driven inside the real workerd
// runtime through the worker's own fetch handler — the same requests-in,
// responses-out shape the runtime-free tests use, now executed the way
// production executes it. This is the tracer that proves the harness: the
// unauthenticated health endpoint answering ok. The test config carries no
// TELEMETRY_INGEST_TOKEN binding (alchemy injects that secret at deploy),
// so authenticated-path runtime tests will need to supply it themselves.

it("serves healthz without a token inside the real runtime", async () => {
  const response = await SELF.fetch("https://example.com/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
