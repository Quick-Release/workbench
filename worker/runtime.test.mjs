import { expect, it } from "vitest";

import { SELF } from "cloudflare:test";

// The behavioral seam (ticket #29): the same requests-in/responses-out
// grammar the runtime-free tests use, now driven inside the real workerd
// runtime through the worker's own fetch handler. This is the tracer that
// proves the harness — the unauthenticated health endpoint answering ok.

it("serves healthz without a token inside the real runtime", async () => {
  const response = await SELF.fetch("https://example.com/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
