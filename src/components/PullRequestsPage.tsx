import { useRef, useState } from "react";
import { GitPullRequest } from "lucide-react";

import { DraftPanel } from "@/components/DraftPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { draftingState, idleState, mapDraftResponse, type DraftState } from "@/lib/draft-state";
import type { PullRequestRecord } from "@/types";

// The pull-requests page (ticket #38): the open pull requests of the host
// repo, synced into the snapshot, each with a one-shot "Draft description"
// action. Host-repo content leaves the machine only on that explicit click,
// and the request carries nothing but the PR number — the server assembles
// the prompt from its own records (tickets #37, #79). `aiConfigured` is the
// health probe's verdict, passed in as data: null is "unknown yet", false
// renders the configuration hint instead of a broken action.

const NETWORK_ERROR =
  "could not reach the draft endpoint — is `pnpm dev` running with the AI middleware loaded?";

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
}: {
  pullRequests: readonly PullRequestRecord[];
  aiConfigured: boolean | null;
}) {
  const [drafts, setDrafts] = useState<Record<number, DraftState>>({});
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<number | null>(null);

  const startDraft = (pr: number) => {
    // One draft in flight at a time: starting another aborts the previous
    // request and resets its row, so the stale response — rejected or
    // arrived late — can never clobber the newer panel. Every set below is
    // guarded by controller ownership for the same reason.
    controllerRef.current?.abort();
    const previous = inFlightRef.current;
    if (previous !== null && previous !== pr) {
      setDrafts((current) => ({ ...current, [previous]: idleState }));
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = pr;
    setDrafts((current) => ({ ...current, [pr]: draftingState }));

    void (async () => {
      try {
        const response = await fetch("/api/ai/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pr }),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as {
          title?: unknown;
          body?: unknown;
          message?: unknown;
          error?: unknown;
        } | null;
        if (controllerRef.current !== controller) return;
        setDrafts((current) => ({ ...current, [pr]: mapDraftResponse(response.status, payload) }));
      } catch {
        if (controllerRef.current !== controller) return;
        setDrafts((current) => ({ ...current, [pr]: { phase: "error", message: NETWORK_ERROR } }));
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (inFlightRef.current === pr) inFlightRef.current = null;
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
      {aiConfigured === false && (
        <p data-slot="ai-unconfigured" className="text-sm text-muted-foreground">
          No model provider key is configured — set <code>ANTHROPIC_API_KEY</code> in{" "}
          <code>.env</code> and restart <code>pnpm dev</code> to enable drafting.
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
                  state={drafts[record.number] ?? idleState}
                  aiConfigured={aiConfigured}
                  onStart={startDraft}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
