import { useRef, useState } from "react";
import { GitPullRequest } from "lucide-react";

import { DraftPanel, UnconfiguredHint } from "@/components/DraftPanel";
import { ReviewEngines } from "@/components/ReviewEngines";
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
import type { PullRequestRecord, ReviewEngineHealth } from "@/types";

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
}: {
  record: PullRequestRecord;
  state: DraftState;
  aiConfigured: boolean | null;
  onStart: (pr: number) => void;
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
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-auto"
          disabled={unconfigured}
          onClick={() => onStart(record.number)}
        >
          <GitPullRequest aria-hidden />
          Draft description
        </Button>
      </div>
      {state.phase !== "idle" && <DraftPanel state={state} />}
    </li>
  );
}

export function PullRequestsPage({
  pullRequests,
  aiConfigured,
  reviewHealth = null,
}: {
  pullRequests: readonly PullRequestRecord[];
  aiConfigured: boolean | null;
  // The review runner's health verdict (ticket #24): the route probes
  // /api/review/health on load and hands the per-engine states down as data;
  // null is "unknown yet" and renders the probing hint.
  reviewHealth?: readonly ReviewEngineHealth[] | null;
}) {
  const [board, setBoard] = useState<DraftBoard>(emptyBoard);
  // The live session: the abort handle for the in-flight request plus the
  // token the board handed it, so its resolution can be identified. Refs,
  // not state — they update synchronously across rapid clicks.
  const sessionRef = useRef<{ controller: AbortController; token: number } | null>(null);

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
      <ReviewEngines engines={reviewHealth} />
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
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
