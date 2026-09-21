import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadWorkbenchConfig } from "../../host/config.mjs";
import { tokenFromGhCli } from "../../tracker/index.mjs";
import { collectTrackerContext } from "./context-packet.mjs";
import { clarificationError, createClarificationCoordinator } from "./coordinator.mjs";
import { evaluateClarificationPosture } from "./posture.mjs";
import { publishIssueBodyViaRest } from "./approval.mjs";
import { openClarificationStore } from "./store.mjs";

// The enabled install's clarification runtime (spec #221, ticket #230):
// the production composition of the coordinator's ports. This module owns
// the wiring — where the durable store lives, how the tracker is read,
// what answers when the managed runtime is absent — so the seam's route
// handlers stay pure and the coordinator stays transport-free.
//
// The durable store opens once per host repo at its database path under
// the host repo and stays open — records outlive requests. The tracker
// read is the clarification collector with the host's own gh credentials,
// which never travel further. The managed session port has no runtime
// wiring in this build — its command and credentials have no
// configuration surface yet — so it answers the typed denial, which the
// coordinator records as the attempt's durable evidence with the run
// parked awaiting-human. Everything resolves per request from the host
// repo's workbench.config.json, so a config edit shows up without a
// restart.

// The host repo's owner/name slug: the scoping key every durable
// clarification record carries. Derived from the configured repositoryUrl;
// a URL that yields no clean owner/name leaves the slug undefined and the
// capability fails closed rather than guessing where records belong.
export const hostRepoSlug = (repositoryUrl) => {
  if (!repositoryUrl) return undefined;
  try {
    const slug = new URL(repositoryUrl).pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .join("/")
      .replace(/\.git$/, "");
    return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug) ? slug : undefined;
  } catch {
    return undefined;
  }
};

export const clarificationRuntimeLoader = ({
  hostRoot,
  loadConfig = async () => loadWorkbenchConfig(hostRoot),
  clock = () => new Date().toISOString(),
  openStore = openClarificationStore,
  token = tokenFromGhCli,
  fetchImpl = fetch,
} = {}) => {
  let store;
  const readContext = async (slug, issueNumber) => {
    if (!slug)
      throw clarificationError(
        "context_unavailable",
        "this install declares no repositoryUrl — the host repository is unknown, so no tracker context can be collected",
      );
    const credentials = await token();
    if (!credentials)
      throw clarificationError(
        "context_unavailable",
        "the host tracker credentials are unreadable (gh auth token) — the tracker context withholds",
      );
    return collectTrackerContext({
      repo: slug,
      issueNumber,
      token: credentials,
      fetchImpl,
      clock,
    });
  };
  // The issue-body write the publication approval dispatches (ticket #234):
  // the capability's one tracker mutation, through the same credentials
  // that never travel further. Unreadable credentials are a typed
  // pre-dispatch refusal — never a blind attempt.
  const updateIssueBody = async (slug, issueNumber, body) => {
    if (!slug)
      throw clarificationError(
        "context_unavailable",
        "this install declares no repositoryUrl — the host repository is unknown, so nothing can be published",
      );
    const credentials = await token();
    if (!credentials)
      throw clarificationError(
        "context_unavailable",
        "the host tracker credentials are unreadable (gh auth token) — the issue-body write was not dispatched",
      );
    return publishIssueBodyViaRest({
      repo: slug,
      issueNumber,
      body,
      token: credentials,
      fetchImpl,
    });
  };
  return async () => {
    const config = await loadConfig();
    const posture = evaluateClarificationPosture(config.clarification);
    const slug = hostRepoSlug(config.repositoryUrl);
    if (posture.posture === "enabled" && !slug)
      return {
        posture: {
          posture: "invalid",
          available: false,
          reasons: [
            "workbench.config.json declares no repositoryUrl — an enabled clarification needs its host repository",
          ],
        },
        coordinator: null,
      };
    if (posture.posture !== "enabled") return { posture, coordinator: null };

    if (!store || store.hostRepo !== slug) {
      store?.close();
      const databasePath = join(hostRoot, ".workbench", "clarification", "runs.sqlite");
      await mkdir(dirname(databasePath), { recursive: true });
      store = { hostRepo: slug, database: openStore({ hostRepo: slug, databasePath }) };
    }
    return {
      posture,
      coordinator: createClarificationCoordinator({
        store: store.database,
        tracker: {
          readContext: ({ issueNumber }) => readContext(slug, issueNumber),
          updateIssueBody: ({ issueNumber, body }) => updateIssueBody(slug, issueNumber, body),
        },
        sessions: {
          start: async () => {
            throw clarificationError(
              "runtime_unconfigured",
              "the managed clarification runtime has no wiring on this install yet — its command and credentials have no configuration surface in this build",
            );
          },
        },
        clock,
        provider: config.clarification.provider,
        dataDestination: config.clarification.dataDestination,
        hostRepo: slug,
      }),
    };
  };
};
