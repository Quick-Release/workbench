import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

// The clarification context collector (spec #221, ticket #229, ADR 0017):
// assembles one immutable, versioned Context packet for one Clarification
// attempt and reports clarification readiness as separate dimensions. The
// packet is evidence for the conversation — never permission to execute
// commands or broaden the capability profile (ADR 0016).
//
// The tracker read is this module's own code implementing ticket 02's
// complete paginated read contract, not a call into the sync tracker
// adapter: the capability broker owns its reads, so no shared paging
// shortcut can silently change the contract under it. The walk stops when a
// short page arrives, reports cap truncation instead of silently stopping,
// and never throws on a failed page — a failed page is a typed `failed`
// with a coverage warning. Continuation counts the *raw* page: the
// issue-list endpoints mix pull requests into their responses, so a
// filtered count on a full page would stop the walk early (GH-136).
//
// Readiness is multi-dimensional and never a score: tracker eligibility,
// brief completeness, host capability, research sufficiency, and
// authorization, each reporting `ready`, `needs-information`,
// `unsupported`, or `unknown`. `blocked` is only ever a reason an axis
// carries, never a fifth verdict. An incomplete read — a failed first or
// later page, or cap truncation — withholds readiness (`unknown`) rather
// than treating missing evidence as absence of blockers, and an empty
// blocker list on a complete read yields unblocked.
//
// Provenance is the packet's honesty contract: every evidence item carries
// its source, locator, observed revision or hash, retrieval time, and
// uncertainty. Assembly refuses unprovenanced evidence instead of guessing
// it. The assembled packet is frozen and digest-pinned: its sha-256 digest
// is the attempt's context identity, so a material change — a different
// issue revision above all — is a new attempt, never an edit in place.
//
// The resolved host and repository context comes from canonical,
// symlink-safe reads: the repository root resolves through realpath first,
// a manifest resolving outside that root is a typed denial, and only
// declarative manifest fields are read — no scripts, no installs, no
// registries, and discovered commands are never execution permission.
//
// Staging is the packet's egress half: private repository and issue content
// may land only on destinations the manifest records as approved, and a
// research egress destination is never eligible — private content never
// enters public queries.

export const CONTEXT_PACKET_VERSION = "context-packet/v1";

export const READINESS_VERDICTS = ["ready", "needs-information", "unsupported", "unknown"];

export const READINESS_AXES = [
  "tracker-eligibility",
  "brief-completeness",
  "host-capability",
  "research-sufficiency",
  "authorization",
];

// The read contract's pagination constants — pinned here, in the collector
// that answers for them, not imported from the sync tracker.
export const PER_PAGE = 100;
export const MAX_PAGES = 10;

const hashOf = (value) => createHash("sha256").update(value).digest("hex");

const isIssue = (entry) =>
  entry && typeof entry === "object" && typeof entry.number === "number" && !entry.pull_request;

const issueUrl = (apiBase, repo, path = "", params = {}) => {
  const url = new URL(`${apiBase}/repos/${repo}/issues${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
};

const readJson = async (fetchImpl, url) => {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`tracker returned HTTP ${response.status}`);
  return response.json();
};

// The readiness axes speak only their four verdicts. `blocked` is a reason
// an axis carries ("blocked by GH-226"), never a fifth verdict.
const axis = (name, verdict, reasons = []) => ({ axis: name, verdict, reasons: [...reasons] });

// Multi-dimensional readiness over the evidence at hand. Every axis is
// independent; there is deliberately no composite score. An incomplete
// tracker read — failed page or cap truncation — lands the tracker axis on
// `unknown`: missing evidence is never read as absence of blockers.
export const readinessFor = ({
  collected,
  posture,
  draft = null,
  research = [],
  researchWarnings = [],
  manifest = null,
}) => {
  const incompleteRead = !collected || collected.failed || collected.capped || !collected.revision;
  const tracker = incompleteRead
    ? axis(
        "tracker-eligibility",
        "unknown",
        collected?.warnings?.length
          ? collected.warnings
          : ["the tracker read is incomplete; readiness is withheld"],
      )
    : collected.blockers.length > 0
      ? axis(
          "tracker-eligibility",
          "needs-information",
          collected.blockers.map((entry) => `blocked by GH-${entry.number}`),
        )
      : axis("tracker-eligibility", "ready");

  const brief = draft
    ? draft.gaps?.length
      ? axis("brief-completeness", "needs-information", draft.gaps)
      : axis("brief-completeness", "ready")
    : axis("brief-completeness", "needs-information", ["no Clarification draft exists yet"]);

  const host =
    posture?.posture === "enabled"
      ? axis("host-capability", "ready")
      : posture?.posture === "invalid"
        ? axis("host-capability", "unknown", posture.reasons)
        : axis("host-capability", "unsupported", [
            "owned clarification is not enabled on this install",
          ]);

  const researchSufficiency = researchWarnings.length
    ? axis("research-sufficiency", "unknown", researchWarnings)
    : research.length > 0
      ? axis("research-sufficiency", "ready")
      : axis("research-sufficiency", "needs-information", [
          "no approved research has been collected yet",
        ]);

  const authorization = manifest
    ? axis("authorization", "ready")
    : axis("authorization", "unsupported", [
        "no data-flow/authorization manifest is recorded for this attempt",
      ]);

  return {
    axes: [tracker, brief, host, researchSufficiency, authorization],
  };
};

const packetError = (code, message) => Object.assign(new Error(message), { code });

// Provenance is required, not decorative: source, locator, retrieval time,
// and uncertainty are always present, and the item pins an observed
// revision or an observed hash. Anything less is not evidence.
const requireProvenance = (provenance, what) => {
  const missing =
    !provenance || typeof provenance !== "object"
      ? ["source", "locator", "observedRevision or observedHash", "retrievedAt", "uncertainty"]
      : [
          ...(typeof provenance.source !== "string" || provenance.source === "" ? ["source"] : []),
          ...(typeof provenance.locator !== "string" || provenance.locator === ""
            ? ["locator"]
            : []),
          ...(!(
            (typeof provenance.observedRevision === "string" &&
              provenance.observedRevision !== "") ||
            (typeof provenance.observedHash === "string" && provenance.observedHash !== "")
          )
            ? ["observedRevision or observedHash"]
            : []),
          ...(typeof provenance.retrievedAt !== "string" || provenance.retrievedAt === ""
            ? ["retrievedAt"]
            : []),
          ...(typeof provenance.uncertainty !== "string" ? ["uncertainty"] : []),
        ];
  if (missing.length > 0)
    throw packetError(
      "missing_provenance",
      `${what} carries no provenance (missing: ${missing.join(", ")}) — evidence without provenance is not evidence`,
    );
};

// Canonical JSON: sorted keys, no whitespace — the bytes the digest is
// taken over, so two assemblies of the same content address the same
// packet regardless of key order.
const canonicalJson = (value) => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// The resolved host and repository context: the canonical root plus the
// declared facts of the repository's own manifest. Reads are canonical and
// symlink-safe — the root resolves through realpath first, and a manifest
// that resolves outside that canonical root is a typed denial, never a
// read. Only declarative manifest fields (name, version) are read: no
// scripts run, nothing is installed, no registry is contacted, and
// discovered commands are never execution permission (ADR 0017). An
// absent manifest is recorded as uncertainty — never guessed at.
export const repositoryContextFor = async ({ root, clock }) => {
  if (!root || typeof root !== "string")
    throw packetError("invalid_request", "the repository context resolves a root path");
  const canonicalRoot = await realpath(root);
  const manifestPath = join(canonicalRoot, "package.json");

  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      return {
        root: canonicalRoot,
        facts: [],
        uncertainty: [
          `the repository root ${canonicalRoot} declares no package.json; no declared facts were collected`,
        ],
      };
    throw packetError(
      "repository_read_failed",
      `the repository manifest could not be read (${error instanceof Error ? error.message : "read failed"})`,
    );
  }

  const canonicalManifest = await realpath(manifestPath);
  if (!canonicalManifest.startsWith(canonicalRoot + sep))
    throw packetError(
      "symlink_escape",
      `the declared manifest at ${manifestPath} resolves to ${canonicalManifest}, outside the repository root — canonical reads never follow a symlink escape`,
    );

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw packetError(
      "repository_read_failed",
      "the repository's package.json is not valid JSON; its declared facts were not collected",
    );
  }

  const observedHash = `sha-256:${hashOf(raw)}`;
  const factProvenance = (locator) => ({
    source: "host-repository",
    locator,
    observedHash,
    retrievedAt: clock(),
    uncertainty: "",
  });
  const facts = [];
  if (typeof manifest.name === "string")
    facts.push({
      kind: "declared-manifest",
      name: "package.json name",
      value: manifest.name,
      provenance: factProvenance(canonicalManifest),
    });
  if (typeof manifest.version === "string")
    facts.push({
      kind: "declared-manifest",
      name: "package.json version",
      value: manifest.version,
      provenance: factProvenance(canonicalManifest),
    });
  return { root: canonicalRoot, facts, uncertainty: [] };
};

// One immutable, versioned Context packet for one Clarification attempt.
// The packet pins the issue revision, the related planning records, the
// selected skills, the approved research, the readiness dimensions, the
// coverage warnings, and the data-flow/authorization manifest — and every
// evidence item it accepts must carry provenance or assembly fails closed.
// The digest is the attempt's context identity: the same content always
// assembles to the same digest, so any material change is detectable and
// becomes a new attempt instead of an edit in place.
export const assembleContextPacket = ({
  collected,
  posture,
  draft = null,
  repository = null,
  skills = [],
  research = [],
  researchWarnings = [],
  manifest = null,
  clock,
}) => {
  if (!collected || !collected.revision || !collected.issue)
    throw packetError(
      "incomplete_context",
      "the tracker context is incomplete — an attempt assembles only over a fully collected issue read",
    );

  requireProvenance(
    collected.issueProvenance,
    `the issue ${collected.repo}#${collected.issue.number}`,
  );
  for (const record of collected.blockers)
    requireProvenance(record.provenance, `the planning record GH-${record.number}`);
  for (const skill of skills)
    requireProvenance(skill.provenance, `the selected skill "${skill.name}"`);
  if (repository)
    for (const fact of repository.facts)
      requireProvenance(fact.provenance, `the repository fact "${fact.name}"`);
  for (const item of research) requireProvenance(item.provenance, "an approved research item");

  const readiness = readinessFor({
    collected,
    posture,
    draft,
    research,
    researchWarnings,
    manifest,
  });
  const coverageWarnings = [...(collected.warnings ?? []), ...researchWarnings];

  const packet = {
    version: CONTEXT_PACKET_VERSION,
    assembledAt: clock(),
    issue: {
      number: collected.issue.number,
      title: collected.issue.title,
      state: collected.issue.state,
      revision: collected.revision,
      provenance: collected.issueProvenance,
    },
    repository,
    planningRecords: collected.blockers,
    skills,
    research,
    readiness,
    coverageWarnings,
    manifest,
  };
  const digest = `sha-256:${hashOf(canonicalJson(packet))}`;
  return deepFreeze({ ...packet, digest });
};

// The freshness check a later gate performs against the packet: the pinned
// revision against a fresh read, and — when an approval is in play — the
// approved context digest against the packet's own. Any drift is a typed
// denial: the packet is never patched, a new attempt assembles a new one.
export const verifyPacketFreshness = ({ packet, revision, digest }) => {
  if (digest !== undefined && digest !== packet.digest)
    throw packetError(
      "digest_mismatch",
      `the approved context digest does not match this packet — the approval cannot travel to different evidence`,
    );
  const pinned = packet.issue.revision;
  if (revision.updatedAt !== pinned.updatedAt || revision.bodyHash !== pinned.bodyHash)
    throw packetError(
      "material_change",
      `the issue now reads at revision ${revision.updatedAt} (${revision.bodyHash}) but the packet pinned ${pinned.updatedAt} (${pinned.bodyHash}) — a material change means a new attempt`,
    );
  return { fresh: true };
};

// The private-content staging gate. Private repository and issue content
// may land only on destinations the packet's manifest records as approved
// — and a research egress destination is never eligible, even if a corrupt
// manifest listed it as approved too (the egress list wins, fail closed).
// Staging proves what moved by content hash, so the packet's manifest and
// the staging record agree on what went where.
export const stagePrivateContent = ({ manifest, destination, content, clock }) => {
  if (!manifest || !Array.isArray(manifest.approvedDestinations))
    throw packetError(
      "unapproved_destination",
      `no data-flow/authorization manifest is recorded — "${destination}" cannot receive private content`,
    );
  if (
    Array.isArray(manifest.egressDestinations) &&
    manifest.egressDestinations.includes(destination)
  )
    throw packetError(
      "private_egress_denied",
      `"${destination}" is a research egress destination — private repository and issue content never enters public queries`,
    );
  if (!manifest.approvedDestinations.includes(destination))
    throw packetError(
      "unapproved_destination",
      `"${destination}" is not an approved destination in this attempt's manifest (approved: ${manifest.approvedDestinations.join(", ") || "none"})`,
    );
  return {
    destination,
    stagedAt: clock(),
    contentHash: `sha-256:${hashOf(content)}`,
  };
};

// The pinned issue revision: the tracker's own last-update timestamp plus
// the hash of the body as read — together, what "unchanged" means.
const revisionOf = (issue) => ({
  updatedAt: issue.updated_at,
  bodyHash: `sha-256:${hashOf(issue.body ?? "")}`,
});

// The complete paginated blocked-by walk: pages until a short page, the cap
// with a truncation warning, or a failed page with a coverage warning —
// never "no blockers" for evidence it did not collect.
const walkBlockedBy = async ({ apiBase, repo, issueNumber, fetchImpl, clock, maxPages }) => {
  const blockers = [];
  const warnings = [];
  let capped = false;
  let failed = false;
  for (let page = 1, hasMore = true; hasMore && page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await readJson(
        fetchImpl,
        issueUrl(apiBase, repo, `/${issueNumber}/dependencies/blocked_by`, {
          per_page: PER_PAGE,
          page,
        }),
      );
    } catch (error) {
      failed = true;
      warnings.push(
        `blocked-by list of ${repo}#${issueNumber} unavailable (${
          error instanceof Error ? error.message : "read failed"
        }); collected the first ${blockers.length} — readiness withheld`,
      );
      return { blockers, warnings, capped, failed };
    }
    const entries = Array.isArray(payload) ? payload : [];
    for (const entry of entries.filter(isIssue)) {
      blockers.push({
        number: entry.number,
        title: entry.title,
        state: entry.state,
        provenance: {
          source: "tracker",
          locator: `${repo}#${entry.number} blocked-by page ${page}`,
          observedRevision: entry.updated_at,
          retrievedAt: clock(),
          uncertainty: "",
        },
      });
    }
    hasMore = entries.length === PER_PAGE;
    if (!hasMore) break;
    if (page === maxPages) {
      capped = true;
      warnings.push(
        `blocked-by list of ${repo}#${issueNumber} stopped at the ${maxPages}-page cap; collected the first ${blockers.length} — readiness withheld`,
      );
    }
  }
  return { blockers, warnings, capped, failed };
};

// The collector port: one issue read plus its complete blocked-by read, over
// the injected transport. Nothing here throws for a tracker failure — the
// result carries what was collected, how it was bounded, and the warnings
// that ride the packet.
export const collectTrackerContext = async ({
  repo,
  issueNumber,
  apiBase = "https://api.github.com",
  fetchImpl,
  clock,
  maxPages = MAX_PAGES,
}) => {
  let issue;
  try {
    issue = await readJson(fetchImpl, issueUrl(apiBase, repo, `/${issueNumber}`));
  } catch (error) {
    return {
      repo,
      issue: null,
      revision: null,
      issueProvenance: null,
      blockers: [],
      warnings: [
        `${repo}#${issueNumber} unavailable (${
          error instanceof Error ? error.message : "read failed"
        }); the issue was not collected — readiness withheld`,
      ],
      capped: false,
      failed: true,
    };
  }

  const revision = revisionOf(issue);
  const issueProvenance = {
    source: "tracker",
    locator: `${repo}#${issue.number}`,
    observedRevision: revision.updatedAt,
    observedHash: revision.bodyHash,
    retrievedAt: clock(),
    uncertainty: "",
  };

  const blockedBy = await walkBlockedBy({ apiBase, repo, issueNumber, fetchImpl, clock, maxPages });
  return {
    repo,
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    },
    revision,
    issueProvenance,
    blockers: blockedBy.blockers,
    warnings: blockedBy.warnings,
    capped: blockedBy.capped,
    failed: blockedBy.failed,
  };
};
