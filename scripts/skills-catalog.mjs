import { offlineFallbackCatalog } from "../src/data/skill-flow.ts";
import { mattPocockSkillSource } from "../src/lib/skills.ts";
import { installedSkillIds } from "./skills-api.mjs";

// ADR 0006: the Catalog (which skills exist, id + category) is fetched from
// mattpocock/skills at sync time — one recursive trees call, category from the
// upstream directory path. The fetch is fail-open: upstream → last-good
// generated data → the curated offline fallback. Sync never fails on catalog
// trouble; a firewalled host repo just degrades with a note.

const MATT_POCOCK_TREES_URL = `https://api.github.com/repos/${mattPocockSkillSource.repository}/git/trees/main?recursive=1`;

// Pure: the recorded trees payload → catalog entries. Every path under
// skills/<category>/<id>/SKILL.md is one skill, `deprecated` included — the
// merge rules on it (kept only when installed), so the walk must not
// preempt that ruling.
export const catalogFromTreePayload = (payload) => {
  const entries = (Array.isArray(payload?.tree) ? payload.tree : [])
    .map((entry) => {
      const match =
        typeof entry?.path === "string"
          ? entry.path.match(/^skills\/([^/]+)\/([^/]+)\/SKILL\.md$/)
          : null;
      return match ? { id: match[2], category: match[1] } : null;
    })
    .filter((entry) => entry !== null);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const upstreamCatalog = async ({ fetchImpl = globalThis.fetch, token = "" } = {}) => {
  if (typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(MATT_POCOCK_TREES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) return null;
    return catalogFromTreePayload(await response.json());
  } catch {
    return null;
  }
};

// The ADR 0006 rulings: upstream-new skills enter with their upstream category
// (the curated module leaves them unclassified); curated ids that vanish
// upstream are dropped unless installed — disk is the only truth for
// installed; `deprecated` is filtered unless installed. `degraded` reports a
// fetch that fell back to last-good or curated data.
export const mergeCatalog = ({ upstream, lastGood, fallback, installedIds }) => {
  const installed = new Set(installedIds);
  const source = upstream ?? (lastGood.length > 0 ? lastGood : fallback);
  const known = new Map(source.map((entry) => [entry.id, entry]));
  // A skill the current source no longer lists survives only if installed,
  // keeping its last-known category from the previous snapshot or the fallback.
  for (const entry of [...lastGood, ...fallback]) {
    if (!known.has(entry.id) && installed.has(entry.id)) known.set(entry.id, entry);
  }
  const skills = [...known.values()]
    .filter((entry) => entry.category !== "deprecated" || installed.has(entry.id))
    .map(skillSourceRecord)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { skills, degraded: upstream === null };
};

export const skillSourceRecord = (entry) => ({
  id: entry.id,
  category: entry.category,
  source: mattPocockSkillSource.id,
});

// Sync entry point: returns the catalog records for the snapshot plus the
// installed-state snapshot kept only for static-build degradation.
export const collectSkillsCatalog = async ({
  rootDirectory,
  lastGood = [],
  env = process.env,
  fetchImpl,
} = {}) => {
  const installedIds = await installedSkillIds(rootDirectory);
  const upstream = await upstreamCatalog({
    fetchImpl,
    token: typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "",
  });
  const { skills, degraded } = mergeCatalog({
    upstream,
    lastGood,
    fallback: offlineFallbackCatalog,
    installedIds,
  });
  return { skills, installedIds, degraded };
};
