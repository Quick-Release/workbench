import { useEffect, useState } from "react";

import {
  fetchClarificationManifest,
  startClarification,
  useClarificationInspection,
  type SeamError,
} from "../hooks/use-clarification-inspection";
import {
  actionMatrix,
  cancelTargetOf,
  operationalTimeline,
  ownershipFor,
  returnCardFor,
  statusAxes,
  toneClass,
  turnInFlight,
  type ActionClass,
  type ActionId,
  type InspectionTone,
  type MatrixAction,
} from "../lib/clarification-inspection";
import { ownRequestIds } from "../lib/clarification-viewer";
import { cn } from "../lib/utils";
import type { ClarificationManifestResult } from "../types";
import {
  ClarificationConversationView,
  type ClarificationConversationModel,
} from "./ClarificationConversation";
import { useClarificationConversation } from "../hooks/use-clarification-conversation";
import { Button } from "./ui/button";

// The run section of the issue panel (spec #221, ticket #237; Factory 11,
// #169): a thin container over the pure inspection projection
// (lib/clarification-inspection.ts). It renders the "controls moved"
// notice, the "Where you left off" return card, the status panel per axis,
// the operational timeline segmented by attempt, and the action matrix —
// direct, two-step confirm, the single typed destructive discard, and the
// fresh approvals that always render the manifest first. Workflow phases
// are GitHub's and never appear here; run state is Workbench's.

const sectionLabel = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

const Word = ({ word, tone }: { word: string; tone: InspectionTone }) => (
  <span
    data-slot="inspection-word"
    data-tone={tone}
    className={cn("inline-flex rounded-md border px-1.5 py-0.5 font-mono text-xs", toneClass[tone])}
  >
    {word}
  </span>
);

const isError = (value: unknown): value is SeamError =>
  value !== null && typeof value === "object" && "error" in value;

const newRequestId = () => globalThis.crypto.randomUUID();

// The fixed manifest every fresh approval renders before its one button:
// start and retry are the same explicit act on a visible manifest.
export const ManifestApproval = ({
  issueNumber,
  actLabel,
  onApprove,
  onDismiss,
}: {
  issueNumber: number;
  actLabel: string;
  onApprove: (manifest: ClarificationManifestResult) => Promise<string | null>;
  onDismiss: () => void;
}) => {
  const [manifest, setManifest] = useState<ClarificationManifestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchClarificationManifest(issueNumber).then((answer) => {
      if (cancelled) return;
      if (isError(answer)) setError(answer.message);
      else setManifest(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [issueNumber]);

  return (
    <div data-slot="clarification-manifest" className="flex flex-col gap-1 rounded-md border p-2">
      <p className="text-xs font-medium">What this approval grants</p>
      {manifest === null ? (
        <p className="text-xs text-muted-foreground">
          {error ?? "rendering the manifest from a fresh issue read…"}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5 text-xs">
          <li>
            issue #{manifest.issue.number} at revision{" "}
            <span className="font-mono">{manifest.issue.revision.updatedAt}</span>
          </li>
          <li>
            provider · {manifest.provider} — data destination · {manifest.dataDestination}
          </li>
          {manifest.capabilitySummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{manifest.egressStatement}</li>
          <li>{manifest.budgetLine}</li>
          <li className="font-medium">{manifest.noPublishingLine}</li>
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          disabled={manifest === null || pending}
          onClick={() => {
            if (manifest === null) return;
            setPending(true);
            void onApprove(manifest).then((failure) => {
              setPending(false);
              setError(failure);
            });
          }}
        >
          {actLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          not now
        </Button>
        {manifest !== null && error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
};

const CLASS_LABEL: Record<ActionClass, string> = {
  direct: "direct",
  "two-step": "two-step confirm",
  typed: "typed confirmation",
  "fresh-approval": "fresh approval",
};

export const ClarificationRunInspection = ({
  issueNumber,
  model,
}: {
  issueNumber: number;
  model: ClarificationConversationModel;
}) => {
  const { section, conversationState, following, detach, reconnect, reload } = model;
  const {
    inspection,
    reload: reloadInspection,
    runAction,
  } = useClarificationInspection(section?.run.runId ?? null, section?.latestCursor ?? 0);
  const [confirming, setConfirming] = useState<ActionId | null>(null);
  const [typed, setTyped] = useState("");
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardDismissed, setCardDismissed] = useState(false);
  // One request id per pending act, spent once the seam answers.
  const [requestId, setRequestId] = useState(newRequestId);

  if (section === null) return null;

  const turnLive = turnInFlight(section.events);
  const axes = statusAxes({ section, conversationState, inspection });
  const timeline = operationalTimeline(section);
  const ownership = ownershipFor({
    inspection,
    events: section.events,
    ownRequestIds: ownRequestIds(),
    now: Date.now(),
  });
  const card = cardDismissed ? null : returnCardFor({ section, inspection, ownership });
  const matrix = actionMatrix({ section, following, turnLive });

  const refresh = async () => {
    await reload();
    await reloadInspection();
  };

  const act = async (action: Parameters<typeof runAction>[0]) => {
    const answer = await runAction(action, requestId);
    if (isError(answer)) {
      setError(answer.message);
      // An unreachable seam is not an answer: the retry reuses the id.
      if (answer.error === "unreachable") return answer.message;
    } else {
      setError(null);
      setConfirming(null);
      setTyped("");
    }
    setRequestId(newRequestId());
    await refresh();
    return isError(answer) ? answer.message : null;
  };

  const trigger = (id: ActionId) => {
    setError(null);
    switch (id) {
      case "detach":
        detach();
        setNotice("detached — the run keeps going; reconnect to follow it again");
        return;
      case "reconnect":
      case "follow-live":
        setNotice(null);
        setCardDismissed(id === "follow-live");
        void reconnect().then(reloadInspection);
        return;
      case "reconcile":
        void refresh().then(() =>
          setNotice(
            `inspected at ${new Date().toISOString()} — read-only: the lease, attempts, termination and publication evidence below are fresh; nothing was changed`,
          ),
        );
        return;
      case "retry":
        setApproving(true);
        return;
      default:
        setConfirming(id);
    }
  };

  const confirmButton = (action: MatrixAction) => {
    if (action.id === "cancel-attempt") {
      const attemptId = cancelTargetOf(section);
      if (attemptId === null) return null;
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label="confirm cancel attempt"
          onClick={() => void act({ kind: "cancel-attempt", attemptId })}
        >
          cancel the attempt — evidence stays
        </Button>
      );
    }
    if (action.id === "retain-evidence")
      return (
        <Button
          size="sm"
          variant="outline"
          aria-label="confirm retain evidence"
          onClick={() => void act({ kind: "retain-evidence" })}
        >
          retain the evidence
        </Button>
      );
    if (action.id === "discard-evidence")
      return (
        <div data-slot="clarification-discard-confirm" className="flex flex-col gap-1">
          <p className="text-xs">
            Discarding deletes this run&apos;s retained event evidence. It cannot be recovered. Type
            the run id <span className="font-mono">{section.run.runId}</span> to confirm.
          </p>
          <input
            className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="type the run id to discard"
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={typed !== section.run.runId}
            aria-label="confirm discard evidence"
            onClick={() => void act({ kind: "discard-evidence", confirmation: typed })}
          >
            discard the evidence permanently
          </Button>
        </div>
      );
    return null;
  };

  return (
    <div data-slot="clarification-run-inspection" className="flex flex-col gap-3">
      {ownership.controlsMoved && (
        <p
          role="status"
          data-slot="clarification-controls-moved"
          className="rounded-md border border-amber-500/70 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
        >
          controls moved to another viewer — this tab is read-only until your next action, which
          acquires them again
        </p>
      )}

      {card && (
        <div
          data-slot="clarification-return-card"
          data-reason={card.reason}
          className="flex flex-col gap-2 rounded-md border p-2"
        >
          <p className="text-xs font-medium">Where you left off</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">State</dt>
            <dd>{card.fields.state}</dd>
            <dt className="text-muted-foreground">Ownership</dt>
            <dd>{card.fields.ownership}</dd>
            <dt className="text-muted-foreground">Last trusted event</dt>
            <dd>{card.fields.lastTrustedEvent}</dd>
            <dt className="text-muted-foreground">Changed files</dt>
            <dd>{card.fields.changedFiles}</dd>
            <dt className="text-muted-foreground">Checks</dt>
            <dd>{card.fields.checks}</dd>
            <dt className="text-muted-foreground">Missing decision</dt>
            <dd>{card.fields.missingDecision}</dd>
          </dl>
          <div>
            <Button
              size="sm"
              data-slot="clarification-return-primary"
              onClick={() => trigger(card.primary.id)}
            >
              {card.primary.label}
            </Button>
          </div>
        </div>
      )}

      {approving && (
        <ManifestApproval
          issueNumber={issueNumber}
          actLabel="Start fresh attempt"
          onDismiss={() => setApproving(false)}
          onApprove={async (manifest) => {
            const failure = await act({ kind: "retry", revision: manifest.issue.revision });
            if (failure === null) setApproving(false);
            return failure;
          }}
        />
      )}

      <div data-slot="clarification-status" className="grid grid-cols-1 gap-2 text-xs">
        <div data-slot="clarification-status-axis" data-axis="lifecycle">
          <p className={sectionLabel}>Run lifecycle · run record</p>
          <Word word={axes.lifecycle.word} tone={axes.lifecycle.tone} />
          {axes.lifecycle.note && <p className="text-muted-foreground">{axes.lifecycle.note}</p>}
        </div>
        <div data-slot="clarification-status-axis" data-axis="attempts">
          <p className={sectionLabel}>Attempts</p>
          {axes.attempts.map((line) => (
            <p key={line.attemptId} className="flex flex-wrap items-center gap-1">
              <span>attempt {line.ordinal}</span>
              <Word word={line.word} tone={line.tone} />
              {line.classification && (
                <span className="text-muted-foreground">
                  · {line.classification === "unknown" ? "outcome " : ""}
                  {line.classification}
                </span>
              )}
            </p>
          ))}
        </div>
        <div data-slot="clarification-status-axis" data-axis="conversation">
          <p className={sectionLabel}>Conversation · managed session</p>
          <Word word={axes.conversation.word} tone={axes.conversation.tone} />
          {axes.conversation.note && (
            <p className="text-muted-foreground">{axes.conversation.note}</p>
          )}
        </div>
        <div data-slot="clarification-status-axis" data-axis="readiness">
          <p className={sectionLabel}>Readiness</p>
          {axes.readiness.map((axis) => (
            <p key={axis.axis} className="flex flex-wrap items-center gap-1">
              <span>{axis.axis}</span>
              <Word word={axis.word} tone={axis.tone} />
              {axis.reasons.length > 0 && (
                <span className="text-muted-foreground">— {axis.reasons.join("; ")}</span>
              )}
            </p>
          ))}
        </div>
        <div data-slot="clarification-status-axis" data-axis="usage">
          <p className={sectionLabel}>Usage budget</p>
          {axes.usage.map((cell) => (
            <p key={cell.kind}>
              {cell.kind} · {cell.text}
            </p>
          ))}
        </div>
      </div>

      <div data-slot="clarification-timeline" className="flex flex-col gap-1 border-t pt-2">
        <p className={sectionLabel}>Run timeline</p>
        {timeline.gap && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-slot="timeline-gap">
            {timeline.gap.text}
          </p>
        )}
        {timeline.discarded && (
          <p className="text-xs text-muted-foreground" data-slot="timeline-discarded">
            {timeline.discarded}
          </p>
        )}
        {timeline.segments.length === 0 && !timeline.discarded && (
          <p className="text-xs text-muted-foreground">nothing operational has happened yet</p>
        )}
        {timeline.segments.map((segment) => (
          <div key={segment.key} data-slot="timeline-segment" className="flex flex-col gap-0.5">
            <p className="text-xs font-medium">{segment.heading}</p>
            {segment.entries.map((entry) => (
              <details key={entry.cursor} data-slot="timeline-entry" data-tone={entry.tone}>
                <summary
                  className={cn(
                    "cursor-pointer text-xs",
                    entry.tone === "unknown"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground",
                  )}
                >
                  {entry.text}
                </summary>
                <pre className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap">
                  {`#${entry.cursor}${entry.at ? ` · ${entry.at}` : ""}\n${JSON.stringify(entry.raw, null, 2)}`}
                </pre>
              </details>
            ))}
            {segment.conversationEvents > 0 && (
              <p data-slot="timeline-conversation-ref" className="text-xs text-muted-foreground">
                conversation — {segment.conversationEvents} event
                {segment.conversationEvents === 1 ? "" : "s"} on the conversation surface
              </p>
            )}
          </div>
        ))}
      </div>

      <div data-slot="clarification-actions" className="flex flex-col gap-1 border-t pt-2">
        <p className={sectionLabel}>Actions</p>
        {matrix.map((action) => (
          <div
            key={action.id}
            data-slot="clarification-action"
            data-action={action.id}
            data-class={action.class}
            className="flex flex-col gap-0.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              {action.surface === "run" ? (
                <Button
                  size="xs"
                  variant={action.destructive ? "destructive" : "outline"}
                  disabled={!action.available}
                  aria-label={action.label}
                  onClick={() => trigger(action.id)}
                >
                  {action.label}
                </Button>
              ) : (
                <span className="text-xs font-medium">{action.label}</span>
              )}
              <span className="text-[11px] text-muted-foreground">{CLASS_LABEL[action.class]}</span>
            </div>
            <p className="text-xs text-muted-foreground">{action.consequence}</p>
            {confirming === action.id && (
              <div className="flex flex-wrap items-center gap-1">
                {confirmButton(action)}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirming(null);
                    setTyped("");
                  }}
                >
                  keep it
                </Button>
              </div>
            )}
          </div>
        ))}
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
};

// The issue panel's run section: one read of the issue's run shared by the
// inspection and the conversation, so detach and reconnect move the one
// stream. With no run yet, the start entry renders the manifest first and
// then its single Start — a fresh approval, never a pretend-enabled button.
export const ClarificationRunSection = ({
  issueNumber,
  issueLabel,
}: {
  issueNumber: number;
  issueLabel: string;
}) => {
  const model = useClarificationConversation(issueNumber);
  const [approving, setApproving] = useState(false);
  const canStart =
    model.absent || (model.section !== null && model.section.run.state === "terminal");

  return (
    <div data-slot="clarification-run-section" className="flex flex-col gap-3">
      {canStart &&
        (approving ? (
          <ManifestApproval
            issueNumber={issueNumber}
            actLabel="Start"
            onDismiss={() => setApproving(false)}
            onApprove={async (manifest) => {
              const answer = await startClarification(issueNumber, manifest, newRequestId());
              // A denial still leaves the durable record behind: reload so
              // the run section renders it.
              await model.reload();
              if (
                isError(answer) &&
                answer.error !== "start_denied" &&
                answer.error !== "dispatch_unrecorded"
              )
                return answer.message;
              setApproving(false);
              return null;
            }}
          />
        ) : (
          <div>
            <Button
              size="sm"
              aria-label={`Clarify ${issueLabel}`}
              onClick={() => setApproving(true)}
            >
              Clarify
            </Button>
          </div>
        ))}
      {!model.absent && (
        <>
          <ClarificationRunInspection issueNumber={issueNumber} model={model} />
          <ClarificationConversationView model={model} />
        </>
      )}
    </div>
  );
};
