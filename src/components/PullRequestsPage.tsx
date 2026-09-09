import { useEffect, useRef, useState } from "react";
import { GitPullRequest, Square } from "lucide-react";

import { DraftPanel, UnconfiguredHint } from "@/components/DraftPanel";
import { IssueAgentPanel } from "@/components/IssueAgentPanel";
import { ReviewEngines } from "@/components/ReviewEngines";
import { ReviewHistoryPanel } from "@/components/ReviewHistoryPanel";
import { ReviewRunPanel } from "@/components/ReviewRunPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  boardState,
  emptyBoard,
  failDraft,
  NETWORK_ERROR,
  resolveDraft,
  startDraft,
  type AiDraftPayload,
  type DraftBoard,
  type DraftState,
} from "@/lib/draft-state";
import {
  emptyReviewRun,
  runBusy,
  runCancelFailed,
  runEvent,
  runFailed,
  runStarted,
  type ReviewRunState,
} from "@/lib/review-run-state";
import { ReviewRunHttpError, cancelReviewRun, streamReviewRun } from "@/lib/review-runs";
import { parseReviewHistory } from "@/schema";
import {
  reviewEngines,
  type Engine,
  type PullRequestRecord,
  type ReviewEngine,
  type ReviewEngineHealth,
  type ReviewHistoryEntry,
} from "@/types";

// The pull-requests page (ticket #38): the open pull requests of the host
// repo, synced into the snapshot, each with a one-shot "Draft description"
// action. Host-repo content leaves the machine only on that explicit click,
// and the request carries nothing but the PR number — the server assembles
// the prompt from its own records (tickets #37, #79). `aiConfigured` is the
// health probe's verdict, passed in as data: null is "unknown yet", false
// renders the configuration hint instead of a broken action. All draft
// state decisions live in the pure board (src/lib/draft-state.ts); this
// container only fires the fetch and hands events back.

function PullRequestRow({
  record,
  state,
  aiConfigured,
  onStart,
  engineReady,
  reviewRun,
  onReview,
  onCancelReview,
}: {
  record: PullRequestRecord;
  state: DraftState;
  aiConfigured: boolean | null;
  onStart: (pr: number) => void;
  engineReady: Record<ReviewEngine, boolean>;
  reviewRun: ReviewRunState;
  onReview: (pr: number, engine: ReviewEngine) => void;
  onCancelReview: (engine: ReviewEngine) => void;
}) {
  const unconfigured = aiConfigured === false;
  return (
    <li
      data-slot="pull-request-row"
      data-pr={record.number}
      className="border-b py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={record.url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline-offset-4 hover:underline"
        >
          #{record.number}
        </a>
        <span className="text-sm font-medium">{record.title}</span>
        {record.isDraft && <Badge variant="outline">draft</Badge>}
        <span className="font-mono text-xs text-muted-foreground">
          {record.head} → {record.base}
        </span>
        <span className="text-xs text-muted-foreground">{record.author}</span>
        <div className="ml-auto flex items-center gap-1">
          {(Object.keys(engineReady) as ReviewEngine[]).map((engine) => (
            <Button
              key={engine}
              type="button"
              variant="outline"
              size="xs"
              // Reviews ride their own engine's health, not the AI
              // provider key the draft action needs; and the page holds one
              // run at a time, so starting another would orphan the first
              // run's panel and its cancel affordance.
              disabled={!engineReady[engine] || reviewRun.phase === "running"}
              title={
                !engineReady[engine]
                  ? `${engine} is not ready to run a review`
                  : reviewRun.phase === "running"
                    ? "a review is already running — cancel it first"
                    : undefined
              }
              onClick={() => onReview(record.number, engine)}
            >
              <Square aria-hidden />
              Review · {engine}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={unconfigured}
            onClick={() => onStart(record.number)}
          >
            <GitPullRequest aria-hidden />
            Draft description
          </Button>
        </div>
      </div>
      {state.phase !== "idle" && <DraftPanel state={state} />}
      {reviewRun.pr === record.number && reviewRun.phase !== "idle" && (
        <ReviewRunPanel run={reviewRun} onCancel={onCancelReview} />
      )}
    </li>
  );
}

export function PullRequestsPage({
  pullRequests,
  aiConfigured,
  engineHealth = null,
}: {
  pullRequests: readonly PullRequestRecord[];
  aiConfigured: boolean | null;
  // The review runner's health verdict (ticket #24): the route probes
  // /api/review/health on load and hands the per-engine states down as data;
  // null is "unknown yet" and renders the probing hint.
  engineHealth?: readonly ReviewEngineHealth[] | null;
}) {
  const [board, setBoard] = useState<DraftBoard>(emptyBoard);
  // The review-run board (ticket #26): the page holds one run at a time and
  // renders it inside the row of the PR it reviews.
  const [reviewRun, setReviewRun] = useState<ReviewRunState>(emptyReviewRun);
  // The live session: the abort handle for the in-flight request plus the
  // token the board handed it, so its resolution can be identified. Refs,
  // not state — they update synchronously across rapid clicks.
  const sessionRef = useRef<{ controller: AbortController; token: number } | null>(null);

  // The token marks which in-flight run a state belongs to: the server
  // allows one run per engine, so a second engine's start must not inherit
  // the first engine's still-streaming events.
  const runToken = useRef(0);
  // The live run's abort handle: navigating away releases the SSE connection
  // instead of leaving it streaming behind a page that is gone.
  const runAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => runAbortRef.current?.abort(), []);
  // A cancellation that raced the run's registration — its POST landed
  // before the start POST had claimed its engine — is remembered here and
  // replayed the moment the run registers, instead of being dropped on the
  // benign no_run answer. Keyed by the run's token, so it can only ever
  // fire for the run it was asked of.
  const pendingCancelRef = useRef<{ token: number; engine: Engine } | null>(null);
  // The session run history (ticket #27): what the dev server remembers
  // about already-finished runs. The page fetches it on load and refetches
  // whenever a run ends; the server owns the record, so a dev-server
  // restart resets it. null is "not fetched yet" — the panel stays hidden
  // rather than guessing.
  const [runHistory, setRunHistory] = useState<readonly ReviewHistoryEntry[] | null>(null);
  const refreshHistory = async () => {
    try {
      const response = await fetch("/api/review/history");
      if (!response.ok) return;
      setRunHistory(parseReviewHistory(await response.json()).runs);
    } catch {
      // Unreachable server: the last known list stays on screen.
    }
  };
  useEffect(() => {
    void refreshHistory();
  }, []);

  const cancelOnce = (
    engine: Engine,
    token: number,
    apply: (updater: (current: ReviewRunState) => ReviewRunState) => void,
  ) => {
    cancelReviewRun()(engine).catch((error) => {
      // A no_run refusal while the run is still claiming its engine is the
      // registration race: keep the intent. Once the run has registered (or
      // already ended) the same answer means there is truly nothing to
      // cancel, and the silence is benign.
      const benign =
        error instanceof ReviewRunHttpError &&
        error.status === 404 &&
        error.payload?.error === "no_run";
      if (benign) {
        pendingCancelRef.current = { token, engine };
        return;
      }
      // Scoped to the run that was cancelled, and the run stays running with
      // its Cancel button: a failed cancel is retryable, never terminal.
      const failure =
        error instanceof ReviewRunHttpError
          ? (error.payload?.message ?? `cancel failed with status ${error.status}`)
          : "cancel could not reach the server — the run may still be going";
      apply((current) => (current.token === token ? runCancelFailed(current, failure) : current));
    });
  };

  // The one consumer both boards share: drive the SSE stream into the board
  // handed in, mapping the server's typed rejections onto it. The boards are
  // separate because the server runs one review and one agent run at a time.
  const consumeRun = (
    request: { engine: Engine; pr: number } | { engine: Engine; issue: number; model?: string },
    token: number,
    controller: AbortController,
    apply: (updater: (current: ReviewRunState) => ReviewRunState) => void,
  ) => {
    void (async () => {
      try {
        // The first event is the proof of registration: a cancellation that
        // raced it replays here, before any further output is streamed.
        let registered = false;
        for await (const event of streamReviewRun({ ...request, signal: controller.signal })) {
          if (!registered) {
            registered = true;
            if (pendingCancelRef.current?.token === token) {
              const replay = pendingCancelRef.current;
              pendingCancelRef.current = null;
              cancelOnce(replay.engine, token, apply);
            }
          }
          apply((current) => (current.token === token ? runEvent(current, event) : current));
        }
        // A stream that ends without an exit — server crash, dropped
        // connection — must not leave the run running forever.
        apply((current) =>
          current.token === token && current.phase === "running"
            ? runFailed(current, "the run stream ended before the run finished")
            : current,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ReviewRunHttpError && error.status === 409 && error.payload?.message) {
          const message = error.payload.message;
          apply((current) => (current.token === token ? runBusy(current, message) : current));
        } else if (error instanceof ReviewRunHttpError) {
          // The server answered with its own complaint (unknown PR, bad
          // request, runner failure) — show it rather than guessing.
          const failure = error.payload?.message ?? `the run failed with status ${error.status}`;
          apply((current) => (current.token === token ? runFailed(current, failure) : current));
        } else {
          apply((current) =>
            current.token === token
              ? runFailed(current, "the run endpoint is unreachable")
              : current,
          );
        }
      } finally {
        // The run is over one way or another: the session history now has
        // its outcome, whatever the panel shows.
        void refreshHistory();
      }
    })();
  };

  const runReview = (pr: number, engine: ReviewEngine) => {
    const token = ++runToken.current;
    const controller = new AbortController();
    runAbortRef.current = controller;
    setReviewRun(runStarted(engine, pr, token));
    consumeRun({ engine, pr }, token, controller, setReviewRun);
  };

  const cancelReview = (engine: ReviewEngine) => {
    const token = reviewRun.token;
    // A retry clears the previous attempt's notice up front.
    setReviewRun((current) => (current.cancelError ? { ...current, cancelError: null } : current));
    cancelOnce(engine, token, setReviewRun);
  };

  // The issue-agent board (issue #40): its own state, its own engine slot —
  // an agent run and a review can stream side by side.
  const [agentRun, setAgentRun] = useState<ReviewRunState>(emptyReviewRun);
  const agentAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => agentAbortRef.current?.abort(), []);

  const runAgent = (issue: number, model?: string) => {
    const token = ++runToken.current;
    const controller = new AbortController();
    agentAbortRef.current = controller;
    setAgentRun(runStarted("opencode", { issue, model }, token));
    consumeRun(
      { engine: "opencode", issue, ...(model ? { model } : {}) },
      token,
      controller,
      setAgentRun,
    );
  };

  const cancelAgent = () => {
    const token = agentRun.token;
    setAgentRun((current) => (current.cancelError ? { ...current, cancelError: null } : current));
    cancelOnce("opencode", token, setAgentRun);
  };

  // A review action is live only when that engine's health probe said ready
  // (ticket #24: not-ready engines cannot be started); while the probe is
  // unknown every review action stays off rather than guessing.
  const engineReady = Object.fromEntries(
    reviewEngines.map((engine) => [
      engine,
      engineHealth?.some((health) => health.engine === engine && health.state === "ready") ?? false,
    ]),
  ) as Record<ReviewEngine, boolean>;

  const runDraft = (pr: number) => {
    sessionRef.current?.controller.abort();
    const controller = new AbortController();
    const token = (sessionRef.current?.token ?? 0) + 1;
    sessionRef.current = { controller, token };
    setBoard((current) => startDraft(current, pr));

    void (async () => {
      try {
        const response = await fetch("/api/ai/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pr }),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as AiDraftPayload;
        setBoard((current) => resolveDraft(current, pr, token, response.status, payload));
      } catch {
        setBoard((current) => failDraft(current, pr, token, NETWORK_ERROR));
      }
    })();
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <GitPullRequest className="size-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Pull requests</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        The host repo's open pull requests, read from the synced snapshot. Drafting a description
        sends only the PR number to the local dev server, which assembles the prompt from its own
        records — the draft lands here for you to copy, edit, or discard.
      </p>
      <ReviewEngines health={engineHealth} />
      {aiConfigured === false && (
        <p data-slot="ai-unconfigured" className="text-sm text-muted-foreground">
          <UnconfiguredHint />
        </p>
      )}
      {pullRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open pull requests collected yet — run <code>pnpm sync</code> to collect them.
        </p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <strong>{pullRequests.length}</strong> open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul>
              {pullRequests.map((record) => (
                <PullRequestRow
                  key={record.number}
                  record={record}
                  state={boardState(board, record.number)}
                  aiConfigured={aiConfigured}
                  onStart={runDraft}
                  engineReady={engineReady}
                  reviewRun={reviewRun}
                  onReview={runReview}
                  onCancelReview={cancelReview}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <IssueAgentPanel
        health={engineHealth?.find((entry) => entry.engine === ("opencode" as Engine)) ?? null}
        run={agentRun}
        onStart={runAgent}
        onCancel={cancelAgent}
      />
      <ReviewHistoryPanel
        history={runHistory}
        onRerun={(entry) =>
          entry.issue !== undefined
            ? runAgent(entry.issue)
            : runReview(entry.pr as number, entry.engine as ReviewEngine)
        }
      />
    </div>
  );
}
