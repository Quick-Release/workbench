import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_PACKET_VERSION,
  READINESS_AXES,
  READINESS_VERDICTS,
  assembleContextPacket,
  collectTrackerContext,
  readinessFor,
  repositoryContextFor,
  stagePrivateContent,
  verifyPacketFreshness,
} from "./context-packet.mjs";

// Contract tests for context packet assembly and multi-dimensional readiness
// (spec #221, ticket #229, ADR 0017). Everything runs on fixture pages and
// an injected clock — no real tracker, no real filesystem, no network. The
// seams are the spec's: the tracker/context read port (its own complete
// paginated read, ticket 02's contract), the readiness evaluation, the
// packet assembly with provenance and revision pinning, and the
// private-content staging gate.

const CLOCK = () => "2026-09-18T12:00:00.000Z";

const ENABLED_POSTURE = { posture: "enabled", available: false };
const DISABLED_POSTURE = { posture: "disabled", available: false };
const INVALID_POSTURE = {
  posture: "invalid",
  available: false,
  reasons: ["clarification.provider is required when clarification is enabled"],
};

// A well-formed provenance record — the shape assembly enforces on every
// evidence item.
const provenance = (overrides = {}) => ({
  source: "public-research",
  locator: "https://docs.example.test/guide",
  observedHash: "sha-256:deadbeef",
  retrievedAt: "2026-09-18T09:00:00.000Z",
  uncertainty: "",
  ...overrides,
});

const MANIFEST = {
  provider: "pi/codex-oauth",
  dataDestination: "workbench-run-record-store",
  approvedDestinations: ["workbench-run-record-store"],
  egressDestinations: ["public-web-documentation"],
  publication: "Publishing is NOT granted by this approval",
};

// One fully collected tracker context: issue read, blockers, provenance.
const collectedWith = async (blockedByPages, issueOverrides = {}) => {
  const issue = { ...HOST_ISSUE, ...issueOverrides };
  return collectTrackerContext({
    repo: "Quick-Release/workbench",
    issueNumber: 229,
    apiBase: "https://api.github.com",
    fetchImpl: fixtureFetch([issueRoute(issue), blockedByRoute(blockedByPages)]),
    clock: CLOCK,
  });
};

const researchItem = (overrides = {}) => ({
  content: "version-matched documentation says the flag is stable",
  provenance: provenance(),
  ...overrides,
});

// A real temporary repository root — the repository-context reads run
// against the real filesystem, like the store tests run real SQLite.
const withRepository = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-repo-"));
  const root = join(directory, "host-repo");
  const outside = join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@acme/host", version: "1.2.3", scripts: { build: "rm -rf /" } }),
  );
  try {
    return await fn({ root, outside, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const HOST_ISSUE = {
  number: 229,
  title: "Clarification 08 — context packet assembly",
  body: "Assemble the Context packet.",
  state: "open",
  updated_at: "2026-09-18T10:00:00.000Z",
};

const blocker = (number, updatedAt = "2026-09-01T00:00:00.000Z") => ({
  number,
  title: `Blocker ${number}`,
  state: "open",
  updated_at: updatedAt,
});

// A fixture transport: [pathname, handler(url)] pairs, matched on the
// request's exact pathname so `/issues/229` never collides with
// `/issues/229/dependencies/blocked_by`. The handler returns the JSON
// payload, or an Error to fail that request. Anything unscripted is itself
// a failure.
const fixtureFetch = (routes) => async (url) => {
  const pathname = new URL(url).pathname;
  const route = routes.find(([pattern]) => pathname === pattern);
  if (!route) throw new Error(`unexpected request: ${pathname}`);
  const payload = route[1](String(url));
  if (payload instanceof Error) throw payload;
  return { ok: true, json: async () => payload };
};

const pageOf = (url) => Number(new URL(url).searchParams.get("page") ?? "1");

const collect = (routes, overrides = {}) =>
  collectTrackerContext({
    repo: "Quick-Release/workbench",
    issueNumber: 229,
    token: "token",
    apiBase: "https://api.github.com",
    fetchImpl: fixtureFetch(routes),
    clock: CLOCK,
    ...overrides,
  });

const issueRoute = (issue = HOST_ISSUE) => [
  "/repos/Quick-Release/workbench/issues/229",
  () => issue,
];

const blockedByRoute = (pages) => [
  "/repos/Quick-Release/workbench/issues/229/dependencies/blocked_by",
  (url) => pages[pageOf(url) - 1],
];

test("a multi-page blocked-by list is read completely within the cap", async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => blocker(i + 1));
  const secondPage = [blocker(101), blocker(102)];
  const collected = await collect([issueRoute(), blockedByRoute([firstPage, secondPage])]);

  strictEqual(collected.failed, false);
  strictEqual(collected.capped, false);
  strictEqual(collected.blockers.length, 102);
  deepStrictEqual(collected.blockers.map((entry) => entry.number).slice(-2), [101, 102]);
  deepStrictEqual(collected.warnings, []);
});

test("a failed first page withholds readiness and never reports unblocked", async () => {
  const collected = await collect([issueRoute(), blockedByRoute([new Error("HTTP 502")])]);

  strictEqual(collected.failed, true);
  strictEqual(collected.blockers.length, 0);
  ok(collected.warnings.length > 0);

  const tracker = readinessFor({ collected, posture: ENABLED_POSTURE }).axes.find(
    (axis) => axis.axis === "tracker-eligibility",
  );
  strictEqual(tracker.verdict, "unknown");
  deepStrictEqual(tracker.reasons, collected.warnings);
});

test("a failed later page withholds readiness after the first page succeeded", async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => blocker(i + 1));
  const collected = await collect([
    issueRoute(),
    blockedByRoute([firstPage, new Error("HTTP 502")]),
  ]);

  strictEqual(collected.failed, true);
  strictEqual(collected.blockers.length, 100);
  ok(collected.warnings.some((warning) => warning.includes("first 100")));

  const tracker = readinessFor({ collected, posture: ENABLED_POSTURE }).axes.find(
    (axis) => axis.axis === "tracker-eligibility",
  );
  strictEqual(tracker.verdict, "unknown");
});

test("cap truncation withholds readiness", async () => {
  const fullPages = Array.from({ length: 10 }, (_, p) =>
    Array.from({ length: 100 }, (_, i) => blocker(p * 100 + i + 1)),
  );
  const collected = await collect([issueRoute(), blockedByRoute(fullPages)], { maxPages: 10 });

  strictEqual(collected.capped, true);
  strictEqual(collected.failed, false);
  ok(collected.warnings.some((warning) => warning.includes("cap")));

  const tracker = readinessFor({ collected, posture: ENABLED_POSTURE }).axes.find(
    (axis) => axis.axis === "tracker-eligibility",
  );
  strictEqual(tracker.verdict, "unknown");
});

test("a complete read with an empty blocker list yields unblocked", async () => {
  const collected = await collect([issueRoute(), blockedByRoute([[]])]);

  strictEqual(collected.failed, false);
  strictEqual(collected.capped, false);
  deepStrictEqual(collected.warnings, []);

  const tracker = readinessFor({ collected, posture: ENABLED_POSTURE }).axes.find(
    (axis) => axis.axis === "tracker-eligibility",
  );
  strictEqual(tracker.verdict, "ready");
  deepStrictEqual(tracker.reasons, []);
});

test("the packet is versioned, digest-pinned, and pins the issue revision, evidence, readiness, and manifest", async () => {
  const collected = await collectedWith([[blocker(226)]]);
  const packet = assembleContextPacket({
    collected,
    posture: ENABLED_POSTURE,
    research: [researchItem()],
    manifest: MANIFEST,
    clock: CLOCK,
  });

  strictEqual(packet.version, CONTEXT_PACKET_VERSION);
  ok(/^sha-256:[0-9a-f]{64}$/.test(packet.digest), "the digest is a sha-256 content address");
  strictEqual(packet.assembledAt, "2026-09-18T12:00:00.000Z");
  strictEqual(packet.issue.revision.updatedAt, "2026-09-18T10:00:00.000Z");
  ok(packet.issue.revision.bodyHash === packet.issue.provenance.observedHash);
  strictEqual(packet.planningRecords.length, 1);
  strictEqual(packet.planningRecords[0].number, 226);
  deepStrictEqual(packet.skills, []);
  strictEqual(packet.research.length, 1);
  deepStrictEqual(
    packet.readiness.axes.map((a) => a.axis),
    READINESS_AXES,
  );
  deepStrictEqual(packet.coverageWarnings, []);
  deepStrictEqual(packet.manifest, MANIFEST);
  ok(packet.manifest.publication.includes("Publishing is NOT granted"));
});

test("the digest is content address: same inputs bind the same packet, changed evidence binds a new one", async () => {
  const collected = await collectedWith([[]]);
  const again = await collectedWith([[]]);
  const same = assembleContextPacket({
    collected: again,
    posture: ENABLED_POSTURE,
    manifest: MANIFEST,
    clock: CLOCK,
  });
  const first = assembleContextPacket({
    collected,
    posture: ENABLED_POSTURE,
    manifest: MANIFEST,
    clock: CLOCK,
  });
  strictEqual(same.digest, first.digest);

  const changedIssue = await collectedWith([[]], {
    updated_at: "2026-09-19T08:00:00.000Z",
  });
  const changed = assembleContextPacket({
    collected: changedIssue,
    posture: ENABLED_POSTURE,
    manifest: MANIFEST,
    clock: CLOCK,
  });
  ok(changed.digest !== first.digest, "a new issue revision is a different context");
});

test("coverage warnings ride the packet", async () => {
  const collected = await collect([issueRoute(), blockedByRoute([new Error("HTTP 502")])]);
  const packet = assembleContextPacket({
    collected,
    posture: ENABLED_POSTURE,
    researchWarnings: ["the retrieved documentation page was truncated"],
    manifest: MANIFEST,
    clock: CLOCK,
  });
  ok(
    packet.coverageWarnings.some((warning) => warning.includes("withheld")),
    "the collector's warning rides the packet",
  );
  ok(packet.coverageWarnings.includes("the retrieved documentation page was truncated"));
});

test("assembly refuses evidence without provenance", async () => {
  const collected = await collectedWith([[]]);
  throws(
    () =>
      assembleContextPacket({
        collected,
        posture: ENABLED_POSTURE,
        research: [{ content: "an unsourced claim" }],
        manifest: MANIFEST,
        clock: CLOCK,
      }),
    (error) => error.code === "missing_provenance",
  );
  throws(
    () =>
      assembleContextPacket({
        collected,
        posture: ENABLED_POSTURE,
        research: [researchItem({ provenance: provenance({ retrievedAt: undefined }) })],
        manifest: MANIFEST,
        clock: CLOCK,
      }),
    (error) => error.code === "missing_provenance",
  );
});

test("the assembled packet is immutable", async () => {
  const collected = await collectedWith([[]]);
  const packet = assembleContextPacket({
    collected,
    posture: ENABLED_POSTURE,
    manifest: MANIFEST,
    clock: CLOCK,
  });
  throws(() => {
    packet.issue.revision.updatedAt = "tampered";
  }, TypeError);
  throws(() => {
    packet.planningRecords = [];
  }, TypeError);
});

test("a material change means a new attempt; the same revision stays fresh", async () => {
  const collected = await collectedWith([[]]);
  const packet = assembleContextPacket({
    collected,
    posture: ENABLED_POSTURE,
    manifest: MANIFEST,
    clock: CLOCK,
  });

  deepStrictEqual(verifyPacketFreshness({ packet, revision: packet.issue.revision }), {
    fresh: true,
  });
  deepStrictEqual(
    verifyPacketFreshness({ packet, revision: packet.issue.revision, digest: packet.digest }),
    { fresh: true },
  );

  throws(
    () =>
      verifyPacketFreshness({
        packet,
        revision: {
          updatedAt: "2026-09-19T08:00:00.000Z",
          bodyHash: packet.issue.revision.bodyHash,
        },
      }),
    (error) => error.code === "material_change",
  );
  throws(
    () =>
      verifyPacketFreshness({
        packet,
        revision: packet.issue.revision,
        digest: "sha-256:" + "0".repeat(64),
      }),
    (error) => error.code === "digest_mismatch",
  );
});

test("repository context reads the declared manifest through canonical, symlink-safe paths", async () => {
  await withRepository(async ({ root }) => {
    const context = await repositoryContextFor({ root, clock: CLOCK });
    strictEqual(context.root, await realpath(root));
    deepStrictEqual(context.uncertainty, []);

    const name = context.facts.find((fact) => fact.name === "package.json name");
    const version = context.facts.find((fact) => fact.name === "package.json version");
    strictEqual(name.value, "@acme/host");
    strictEqual(version.value, "1.2.3");
    strictEqual(name.provenance.source, "host-repository");
    strictEqual(name.provenance.retrievedAt, "2026-09-18T12:00:00.000Z");
    ok(
      name.provenance.observedHash.startsWith("sha-256:"),
      "the manifest read is pinned by a content hash",
    );
  });
});

test("a manifest that is a symlink out of the repository root is a typed denial, never a read", async () => {
  await withRepository(async ({ root, outside }) => {
    await writeFile(join(outside, "elsewhere.json"), '{"name":"@elsewhere/escape"}');
    await rm(join(root, "package.json"));
    await symlink(join(outside, "elsewhere.json"), join(root, "package.json"));

    await rejects(
      () => repositoryContextFor({ root, clock: CLOCK }),
      (error) =>
        error.code === "symlink_escape" && error.message.includes("outside the repository root"),
    );
  });
});

test("an absent declared manifest is recorded as uncertainty, never guessed", async () => {
  await withRepository(async ({ root }) => {
    await rm(join(root, "package.json"));
    const context = await repositoryContextFor({ root, clock: CLOCK });
    deepStrictEqual(context.facts, []);
    strictEqual(context.uncertainty.length, 1);
    ok(context.uncertainty[0].includes("package.json"));
  });
});

test("the resolved repository context rides the packet with its provenance", async () => {
  await withRepository(async ({ root }) => {
    const repository = await repositoryContextFor({ root, clock: CLOCK });
    const collected = await collectedWith([[]]);
    const packet = assembleContextPacket({
      collected,
      posture: ENABLED_POSTURE,
      repository,
      manifest: MANIFEST,
      clock: CLOCK,
    });
    strictEqual(packet.repository.root, await realpath(root));
    ok(packet.repository.facts.length > 0);
    ok(packet.repository.facts.every((fact) => fact.provenance.source === "host-repository"));
  });
});

test("private content stages only to approved destinations recorded in the manifest", async () => {
  const staged = await stagePrivateContent({
    manifest: MANIFEST,
    destination: "workbench-run-record-store",
    content: "issue body and repository facts — private content",
    clock: CLOCK,
  });
  strictEqual(staged.destination, "workbench-run-record-store");
  ok(staged.contentHash.startsWith("sha-256:"));

  throws(
    () =>
      stagePrivateContent({
        manifest: MANIFEST,
        destination: "public-web-search",
        content: "private content",
        clock: CLOCK,
      }),
    (error) => error.code === "unapproved_destination",
  );

  // An egress destination is never eligible for private content, even if a
  // corrupt manifest listed it as approved too.
  const poisoned = {
    ...MANIFEST,
    approvedDestinations: [...MANIFEST.approvedDestinations, "public-web-documentation"],
  };
  throws(
    () =>
      stagePrivateContent({
        manifest: poisoned,
        destination: "public-web-documentation",
        content: "private content",
        clock: CLOCK,
      }),
    (error) => error.code === "private_egress_denied",
  );

  throws(
    () =>
      stagePrivateContent({ manifest: null, destination: "anywhere", content: "x", clock: CLOCK }),
    (error) => error.code === "unapproved_destination",
  );
});

test("host capability follows the posture: enabled ready, disabled unsupported, invalid unknown with its reasons", () => {
  const enabled = readinessFor({ collected: null, posture: ENABLED_POSTURE });
  deepStrictEqual(
    enabled.axes.find((a) => a.axis === "host-capability"),
    { axis: "host-capability", verdict: "ready", reasons: [] },
  );

  const disabled = readinessFor({ collected: null, posture: DISABLED_POSTURE });
  const disabledAxis = disabled.axes.find((a) => a.axis === "host-capability");
  strictEqual(disabledAxis.verdict, "unsupported");

  const invalid = readinessFor({ collected: null, posture: INVALID_POSTURE });
  const invalidAxis = invalid.axes.find((a) => a.axis === "host-capability");
  strictEqual(invalidAxis.verdict, "unknown");
  deepStrictEqual(invalidAxis.reasons, INVALID_POSTURE.reasons);
});

test("brief completeness, research sufficiency, and authorization each answer from their own evidence", () => {
  const empty = readinessFor({ collected: null, posture: ENABLED_POSTURE });
  deepStrictEqual(
    empty.axes.find((a) => a.axis === "brief-completeness"),
    {
      axis: "brief-completeness",
      verdict: "needs-information",
      reasons: ["no Clarification draft exists yet"],
    },
  );
  deepStrictEqual(
    empty.axes.find((a) => a.axis === "research-sufficiency"),
    {
      axis: "research-sufficiency",
      verdict: "needs-information",
      reasons: ["no approved research has been collected yet"],
    },
  );
  deepStrictEqual(
    empty.axes.find((a) => a.axis === "authorization"),
    {
      axis: "authorization",
      verdict: "unsupported",
      reasons: ["no data-flow/authorization manifest is recorded for this attempt"],
    },
  );

  const gapped = readinessFor({
    collected: null,
    posture: ENABLED_POSTURE,
    draft: { gaps: ["the acceptance criteria are missing"] },
    research: [{ claim: "docs say X", provenance: provenance() }],
    researchWarnings: ["the retrieved documentation page was truncated"],
    manifest: MANIFEST,
  });
  deepStrictEqual(
    gapped.axes.find((a) => a.axis === "brief-completeness"),
    {
      axis: "brief-completeness",
      verdict: "needs-information",
      reasons: ["the acceptance criteria are missing"],
    },
  );
  const research = gapped.axes.find((a) => a.axis === "research-sufficiency");
  strictEqual(research.verdict, "unknown");
  deepStrictEqual(research.reasons, ["the retrieved documentation page was truncated"]);
  strictEqual(gapped.axes.find((a) => a.axis === "authorization").verdict, "ready");

  const complete = readinessFor({
    collected: null,
    posture: ENABLED_POSTURE,
    draft: { gaps: [] },
    research: [{ claim: "docs say X", provenance: provenance() }],
    manifest: MANIFEST,
  });
  strictEqual(complete.axes.find((a) => a.axis === "brief-completeness").verdict, "ready");
  strictEqual(complete.axes.find((a) => a.axis === "research-sufficiency").verdict, "ready");
});

test("open blockers on a complete read make the tracker axis needs-information with blocked as reasons, never a verdict", async () => {
  const collected = await collect([issueRoute(), blockedByRoute([[blocker(226), blocker(225)]])]);

  const readiness = readinessFor({ collected, posture: ENABLED_POSTURE });
  const tracker = readiness.axes.find((axis) => axis.axis === "tracker-eligibility");
  strictEqual(tracker.verdict, "needs-information");
  deepStrictEqual(tracker.reasons, ["blocked by GH-226", "blocked by GH-225"]);
  for (const axis of readiness.axes) {
    ok(READINESS_VERDICTS.includes(axis.verdict), `${axis.verdict} is a typed verdict`);
    ok(axis.verdict !== "blocked", "blocked is never a verdict");
  }
});
