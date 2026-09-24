import { useRef, useState } from "react";

import {
  discardable,
  ownershipFor,
  returnCard,
  statusPanels,
  timelineSegments,
  usageTotalsLine,
} from "../lib/clarification-inspection";
import type { StatusPanel } from "../lib/clarification-inspection";
import { useClarificationConversation } from "../hooks/use-clarification-conversation";
import { useClarificationDraft } from "../hooks/use-clarification-draft";
import type { ClarificationEventEnvelope } from "../schema";
import { Button } from "./ui/button";

// The managed conversation surface (spec #221, ticket #232) and the
// inspection display built over it (ticket #237, Factory 11): the
// clarification conversation in the dashboard — streamed text and tool
// activity from the run's durable ledger, the Developer's prompt/steer/
// queue as explicit distinct acts, stop-turn as a two-step confirm, runtime
// dialogs as answerable typed questions — plus the inspection layer:
// status as panels, one per axis, each in its owner's vocabulary and never
// one merged word; an operational timeline segmented by attempt with raw
// detail behind expands and the conversation referenced, never duplicated;
// the "Where you left off" return card with exactly one primary next safe
// action; the ownership line and the controls-moved notice; and the single
// destructive action, the discard, behind a typed confirmation.

// The pending follow-ups, derived from the ledger: a queued entry is live
// until the evidence says it cleared, stopped, or delivered.
type Ledger = readonly ClarificationEventEnvelope[];

const pendingQueue = (events: Ledger) => {
  const queued = new Map<string, string>();
  const cleared = new Set<string>();
  for (const { event } of events) {
    if (event.type === "operational") {
      const data = event.data as Record<string, unknown>;
      if (event.kind === "conversation.follow-up-queued" && typeof data.text === "string")
        queued.set(String(data.requestId), data.text);
      if (
        (event.kind === "conversation.queue-cleared" ||
          event.kind === "conversation.turn-stopped") &&
        Array.isArray(data.cleared)
      )
        for (const entry of data.cleared as { requestId?: unknown }[])
          if (typeof entry?.requestId === "string") cleared.add(entry.requestId);
    }
    // A delivered follow-up rode the runtime's own follow_up operation.
    if (event.type === "conversation") {
      const frame = event.session.event as { type?: unknown; id?: unknown };
      if (frame.type === "follow_up" && typeof frame.id === "string") cleared.add(frame.id);
    }
  }
  // An entry without a request id could never be matched against a clear
  // or a delivery — it would queue forever, so it is not an entry.
  return [...queued].filter(
    ([requestId, text]) => requestId !== "undefined" && text !== "" && !cleared.has(requestId),
  );
};

// Whether a turn is live, from the evidence: a prompt whose settlement or
// stop has not been observed yet. A prompt the runtime never accepted
// (its acceptance failed) freed the floor when it failed.
const turnInFlight = (events: Ledger) => {
  let live = false;
  for (const { event } of events) {
    if (event.type === "operational" && event.kind === "conversation.prompt") live = true;
    if (event.type === "operational" && event.kind === "conversation.turn-stopped") live = false;
    if (event.type === "operational" && event.kind === "conversation.prompt-failed") live = false;
    if (event.type === "conversation") {
      const frame = event.session.event as { type?: unknown };
      if (frame.type === "agent_settled") live = false;
    }
  }
  return live;
};

const eventRow = (envelope: ClarificationEventEnvelope) => {
  const { event } = envelope;
  if (event.type === "lifecycle")
    return (
      <p key={envelope.cursor} className="text-xs text-muted-foreground italic">
        attempt moved to {event.state}
      </p>
    );
  if (event.type === "operational") {
    const frame = conversationOperationalRow(event.kind, event.data as Record<string, unknown>);
    if (frame === null) return null;
    return (
      <p key={envelope.cursor} className="text-xs text-muted-foreground">
        {frame}
      </p>
    );
  }
  const runtime = event.session.event as { type?: string; text?: string; tool?: string };
  if (runtime.type === "message_update")
    return (
      <p key={envelope.cursor} className="text-sm">
        {runtime.text}
      </p>
    );
  if (runtime.type === "tool_execution")
    return (
      <p key={envelope.cursor} className="font-mono text-xs text-muted-foreground">
        tool · {runtime.tool}
      </p>
    );
  if (runtime.type === "accepted" || runtime.type === "agent_settled") return null;
  // Unknown and malformed frames are evidence, never a silent drop.
  return (
    <p key={envelope.cursor} className="font-mono text-xs text-muted-foreground">
      frame · {String(runtime.type ?? "untyped")}
    </p>
  );
};

const conversationOperationalRow = (kind: string, data: Record<string, unknown>) => {
  // Refusals and post-dispatch failures are rows of their own — evidence
  // the runtime never accepted (or never settled) the work, next to the
  // intent that says it was asked for.
  const base = kind.slice("conversation.".length);
  if (base.endsWith("-refused"))
    return `refused · ${base.replace(/-refused$/, "")} (${String(data.code)})`;
  if (base.endsWith("-failed"))
    return `not accepted · ${base.replace(/-failed$/, "")} (${String(data.code)})`;
  if (kind === "conversation.stream-failed")
    return `the live stream ended unexpectedly (${String(data.code)})`;
  if (kind === "conversation.prompt") return `you · ${String(data.text)}`;
  if (kind === "conversation.steer") return `steer · ${String(data.text)}`;
  if (kind === "conversation.follow-up-queued") return `queued · ${String(data.text)}`;
  if (kind === "conversation.queue-cleared") return "the follow-up queue was cleared";
  if (kind === "conversation.turn-stopped")
    return `turn stopped — cleared ${
      Array.isArray(data.cleared) ? data.cleared.length : 0
    } queued follow-up(s)`;
  if (kind === "conversation.dialog-answered") return `dialog answered: ${String(data.dialogId)}`;
  if (kind === "conversation.dialog-cancelled") return `dialog cancelled: ${String(data.dialogId)}`;
  return null;
};

// Unknown renders as the word — styled in the amber family, never green,
// never a spinner posing as progress (Factory 11).
const UnknownWord = () => (
  <span className="text-amber-600" data-unknown="true">
    unknown
  </span>
);

const axisLabel = (axis: StatusPanel["axis"]) => {
  switch (axis) {
    case "run":
      return "Run lifecycle";
    case "attempts":
      return "Attempts";
    case "conversation":
      return "Conversation";
    case "readiness":
      // One dimension of CONTEXT.md's Readiness — brief completeness — is
      // what the record holds post-start; the rest renders with the
      // manifest. The label says which dimension is speaking.
      return "Readiness — brief completeness";
    case "usage":
      return "Usage";
  }
};

const StatusPanels = ({ panels }: { panels: StatusPanel[] }) => (
  <div data-slot="clarification-status-panels" className="flex flex-col gap-2">
    {panels.map((panel) => (
      <div
        key={panel.axis}
        data-slot="clarification-axis"
        data-axis={panel.axis}
        className="flex flex-col gap-0.5"
      >
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {axisLabel(panel.axis)}
        </p>
        <StatusPanelBody panel={panel} />
      </div>
    ))}
  </div>
);

const StatusPanelBody = ({ panel }: { panel: StatusPanel }) => {
  if (panel.axis === "run")
    return (
      <p className="text-xs">
        {panel.state === "unknown" ? <UnknownWord /> : panel.state}
        {panel.discardedAt && (
          <span className="text-muted-foreground"> · evidence discarded {panel.discardedAt}</span>
        )}
      </p>
    );
  if (panel.axis === "attempts")
    return (
      <div className="flex flex-col gap-0.5">
        {panel.attempts.length === 0 ? (
          <p className="text-xs text-muted-foreground">no attempts yet</p>
        ) : (
          panel.attempts.map((attempt, index) => (
            <p key={attempt.attemptId} className="text-xs">
              attempt {index + 1} · {attempt.state === "unknown" ? <UnknownWord /> : attempt.state}{" "}
              <span className="text-muted-foreground">({attempt.origin})</span>
            </p>
          ))
        )}
      </div>
    );
  if (panel.axis === "conversation")
    return (
      <p className="text-xs">
        {panel.state === "unknown" ? <UnknownWord /> : panel.state}
        {!panel.live && <span className="text-muted-foreground"> · no live session</span>}
      </p>
    );
  if (panel.axis === "readiness")
    return (
      <p className="text-xs">
        {panel.verdict === "unknown" ? <UnknownWord /> : panel.verdict}
        {panel.verdict === "needs-information" && panel.gapCount > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · {panel.gapCount} {panel.gapCount === 1 ? "gap" : "gaps"}
          </span>
        )}
      </p>
    );
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs">{usageTotalsLine(panel.totals)}</p>
      {panel.lines.map((line) => (
        <p key={line.lineId} className="font-mono text-xs text-muted-foreground">
          {line.kind} · {line.unit}
          {line.value !== null ? ` · ${line.value}` : ""}
          {line.detail !== undefined ? ` · ${JSON.stringify(line.detail)}` : ""}
        </p>
      ))}
    </div>
  );
};

const ownershipWords = (ownership: ReturnType<typeof ownershipFor>) => {
  if (ownership.state === "unheld") return "controls unheld — the next action acquires them";
  if (ownership.state === "held")
    return `controls held by this install's coordinator until ${ownership.expiresAt}`;
  return `controls held by ${ownership.owner} until ${ownership.expiresAt}`;
};

const DialogAnswer = ({
  dialog,
  onAnswer,
  onCancel,
}: {
  dialog: { dialogId: string; kind: string; request: unknown };
  onAnswer: (value: unknown) => void;
  onCancel: () => void;
}) => {
  const request = dialog.request as { options?: unknown } | null;
  const [text, setText] = useState("");
  const answerText = () => {
    if (text.trim() !== "") onAnswer(text);
    setText("");
  };
  return (
    <div
      data-slot="clarification-dialog"
      data-dialog-id={dialog.dialogId}
      className="flex flex-col gap-1 rounded-md border p-2"
    >
      <p className="text-xs font-medium">the runtime asks a question ({dialog.kind})</p>
      {dialog.kind === "select" && Array.isArray(request?.options) ? (
        <div className="flex flex-wrap gap-1">
          {(request.options as unknown[]).map((option) => (
            <Button
              key={String(option)}
              size="sm"
              variant="outline"
              onClick={() => onAnswer(option)}
              aria-label={`answer ${String(option)}`}
            >
              {String(option)}
            </Button>
          ))}
        </div>
      ) : dialog.kind === "confirm" ? (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAnswer(true)}
            aria-label="confirm yes"
          >
            yes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAnswer(false)}
            aria-label="confirm no"
          >
            no
          </Button>
        </div>
      ) : (
        <div className="flex gap-1">
          <input
            className="w-full rounded-md border bg-transparent px-2 py-1 text-xs"
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="dialog answer"
          />
          <Button size="sm" variant="outline" onClick={answerText}>
            answer
          </Button>
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={onCancel} aria-label="cancel dialog">
        cancel — never a default answer
      </Button>
    </div>
  );
};

const TimelineSegmentBlock = ({
  segment,
}: {
  segment: ReturnType<typeof timelineSegments>["segments"][number];
}) => (
  <div data-slot="clarification-segment" data-segment={segment.key} className="flex flex-col gap-1">
    <p className="text-xs font-medium text-muted-foreground">{segment.heading}</p>
    {segment.entries.length === 0 ? (
      <p className="text-xs text-muted-foreground italic">no recorded events</p>
    ) : (
      segment.entries.map((entry) =>
        entry.reference ? (
          <p key={`ref-${entry.cursor}`} className="text-xs text-muted-foreground italic">
            the conversation streamed on this attempt — the chat above holds it; this timeline never
            repeats it
          </p>
        ) : (
          <details key={entry.cursor} className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {entry.sentence}
              {entry.at ? <span className="text-muted-foreground/70"> · {entry.at}</span> : null}
            </summary>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
              {entry.detail}
            </pre>
            {entry.detailTruncated && <p>— truncated; the ledger holds the full event</p>}
          </details>
        ),
      )
    )}
  </div>
);

export const ClarificationConversation = ({ issueNumber }: { issueNumber: number }) => {
  const { section, conversationState, absent, failure, reload, sendCommand } =
    useClarificationConversation(issueNumber);
  // The readiness axis reads the draft's brief completeness (ADR 0017's
  // dimension): its owner's verdict, or unknown when no draft read exists.
  const draft = useClarificationDraft(issueNumber);
  const [draftText, setDraftText] = useState("");
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  // The courtesy notice, not the security: a write fenced by another
  // holder's lease tells the Developer the controls moved. Fencing is the
  // correctness mechanism; the composer stays usable — the next action
  // acquires implicitly.
  const [controlsMoved, setControlsMoved] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState("");
  const [discardPending, setDiscardPending] = useState(false);
  const [dismissedCard, setDismissedCard] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  // One request id per user submission: it stays stable across retries of
  // an ambiguous submission (the ledger dedups it, so a retry can never
  // double-send an accepted prompt) and is spent the moment the seam
  // definitively answers.
  const [submissionId, setSubmissionId] = useState(() => globalThis.crypto.randomUUID());

  if (absent) return null;
  if (!section)
    return (
      <p className="text-xs text-muted-foreground">
        {failure ?? "looking for this issue's clarification run…"}
      </p>
    );

  const attempt =
    section.attempts.find((candidate) => candidate.state !== "terminal") ?? section.attempts[0];
  const events: Ledger = section.events;
  const inFlight = turnInFlight(events);
  const queue = pendingQueue(events);
  const dialogs = conversationState?.pendingDialogs ?? [];
  const capabilities = conversationState?.unsupportedCapabilities ?? [];
  const dispatchIntent = (attempt?.dispatchIntent ?? null) as {
    provider?: unknown;
    dataDestination?: unknown;
    model?: unknown;
  } | null;
  const provider =
    typeof dispatchIntent?.provider === "string" ? dispatchIntent.provider : "unknown provider";
  const destination =
    typeof dispatchIntent?.dataDestination === "string"
      ? dispatchIntent.dataDestination
      : "unknown destination";
  const model = typeof dispatchIntent?.model === "string" ? dispatchIntent.model : null;

  const panels = statusPanels(section, {
    conversation: conversationState,
    readiness: draft.view ? { verdict: draft.view.briefCompleteness, gaps: draft.view.gaps } : null,
  });
  const card = returnCard(section);
  const cardKey = card ? `${card.reason}:${card.runState}:${section.latestCursor}` : null;
  const ownership = ownershipFor(section.lease ?? null);
  const timeline = timelineSegments(section);

  const dispatch = async (
    command:
      | { kind: "prompt" | "steer" | "queue"; text: string }
      | { kind: "clear-queue" }
      | { kind: "stop-turn" }
      | { kind: "answer-dialog"; dialogId: string; value: unknown }
      | { kind: "cancel-dialog"; dialogId: string },
  ): Promise<boolean> => {
    const result = await sendCommand(section.run.runId, attempt.attemptId, command, submissionId);
    // An unreachable seam is not an answer: the submission keeps its id, so
    // the Developer's retry dedups against the ledger. Anything else — a
    // typed result or a typed refusal — spends the id.
    if ("error" in result) {
      setCommandError(result.message);
      if (result.error === "unreachable") return false;
      // A fenced write means another holder has the controls: the courtesy
      // notice says so. Any other refusal is the command's own answer.
      if (result.error === "busy" || result.error.startsWith("lease_")) setControlsMoved(true);
    } else {
      setCommandError(null);
      setControlsMoved(false);
    }
    setSubmissionId(globalThis.crypto.randomUUID());
    void reload();
    return true;
  };

  const submit = async (kind: "prompt" | "steer" | "queue") => {
    if (draftText.trim() === "") return;
    const answered = await dispatch({ kind, text: draftText });
    // An unanswered submission keeps its draft: the retry is the same act,
    // under the same request id.
    if (answered) setDraftText("");
  };

  const act = async (
    command:
      | { kind: "clear-queue" }
      | { kind: "stop-turn" }
      | { kind: "answer-dialog"; dialogId: string; value: unknown }
      | { kind: "cancel-dialog"; dialogId: string },
  ) => {
    await dispatch(command);
    setConfirmingStop(false);
  };

  const discard = async () => {
    // The typed destructive confirmation: the input must echo the run id —
    // the one destructive action in the whole surface (Factory 11).
    if (discardConfirmation !== section.run.runId || discardPending) return;
    setDiscardPending(true);
    try {
      const response = await fetch(`/api/clarification/runs/${section.run.runId}/discard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: discardConfirmation }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setCommandError(body?.message ?? `the discard answered ${response.status}`);
      } else {
        setDiscardConfirmation("");
        setCommandError(null);
      }
    } catch {
      setCommandError("the clarification seam is unreachable");
    } finally {
      setDiscardPending(false);
      void reload();
    }
  };

  return (
    <div data-slot="clarification-conversation" className="flex flex-col gap-2">
      {card && cardKey !== dismissedCard && (
        <div
          data-slot="clarification-return-card"
          className="flex flex-col gap-1 rounded-md border border-amber-600/40 bg-amber-50 p-2 dark:bg-amber-950/20"
        >
          <p className="text-xs font-medium">Where you left off</p>
          <p className="text-xs">
            run · {card.runState === "unknown" ? <UnknownWord /> : card.runState}
            {card.attemptState && (
              <>
                {" "}
                · attempt {card.attemptState === "unknown" ? <UnknownWord /> : card.attemptState}
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{ownershipWords(ownership)}</p>
          {card.lastTrustedEvent && (
            <p className="text-xs text-muted-foreground">
              last trusted event · cursor {card.lastTrustedEvent.cursor} —{" "}
              {card.lastTrustedEvent.summary}
              {card.lastTrustedEvent.at ? ` · ${card.lastTrustedEvent.at}` : ""}
            </p>
          )}
          {card.missingDecision && <p className="text-xs">{card.missingDecision}</p>}
          <div>
            <Button
              size="sm"
              data-slot="clarification-primary-action"
              onClick={() => {
                if (card.primary.action === "follow-live") setDismissedCard(cardKey);
                else timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {card.primary.label}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">provider · {provider}</span>
        {model && <span className="text-xs text-muted-foreground">model · {model}</span>}
        <span className="text-xs text-muted-foreground">destination · {destination}</span>
      </div>

      <StatusPanels panels={panels} />

      <p data-slot="clarification-ownership" className="text-xs text-muted-foreground">
        {ownershipWords(ownership)}
      </p>

      {controlsMoved && (
        <p data-slot="clarification-controls-moved" className="text-xs text-amber-600">
          controls moved to another viewer — your last action was fenced, not applied; the next
          action acquires the controls
        </p>
      )}

      <div
        data-slot="clarification-stream"
        className="flex max-h-64 flex-col gap-1 overflow-y-auto"
      >
        {section.gap && (
          <p className="text-xs text-amber-600" data-slot="clarification-gap">
            gap — events before cursor {section.gap.firstRetainedCursor} are no longer retained
          </p>
        )}
        {events.map(eventRow)}
      </div>

      {conversationState?.available === false && (
        <p className="text-xs text-muted-foreground italic">
          the managed session is not live on this install — the recorded evidence above stays
          inspectable, and the conversation continues through a new attempt
        </p>
      )}

      {conversationState?.available &&
        dialogs.map((dialog) => (
          <DialogAnswer
            key={dialog.dialogId}
            dialog={dialog}
            onAnswer={(value) =>
              void act({ kind: "answer-dialog", dialogId: dialog.dialogId, value })
            }
            onCancel={() => void act({ kind: "cancel-dialog", dialogId: dialog.dialogId })}
          />
        ))}

      {capabilities.length > 0 && (
        <div data-slot="clarification-capabilities" className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            capabilities this surface cannot render
          </p>
          {capabilities.map((capability) => (
            <p key={capability.capability} className="font-mono text-xs text-muted-foreground">
              {capability.capability} ×{capability.count}
            </p>
          ))}
        </div>
      )}

      {queue.length > 0 && (
        <div data-slot="clarification-queue" className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">queued follow-ups</p>
          {queue.map(([requestId, text]) => (
            <p key={requestId} className="text-xs">
              {text}
            </p>
          ))}
          <Button size="sm" variant="outline" onClick={() => void act({ kind: "clear-queue" })}>
            clear the queue
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <textarea
          className="w-full rounded-md border bg-transparent px-2 py-1 text-sm"
          value={draftText}
          placeholder={
            inFlight
              ? "steer the live turn, or queue this for after it settles"
              : "what should the clarification look at next?"
          }
          onChange={(event) => setDraftText(event.target.value)}
          aria-label="conversation draft"
        />
        <div className="flex flex-wrap items-center gap-1">
          {inFlight ? (
            <>
              <Button size="sm" onClick={() => void submit("steer")} aria-label="steer the turn">
                steer
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void submit("queue")}
                aria-label="queue follow-up"
              >
                queue
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void submit("prompt")} aria-label="send prompt">
              send prompt
            </Button>
          )}
          {inFlight &&
            (confirmingStop ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => void act({ kind: "stop-turn" })}
                  aria-label="confirm stop turn"
                >
                  stop the turn — the queue clears with it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingStop(false)}>
                  keep going
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmingStop(true)}
                aria-label="stop turn"
              >
                stop the turn
              </Button>
            ))}
          {commandError && <span className="text-xs text-red-600">{commandError}</span>}
        </div>
      </div>

      <div
        ref={timelineRef}
        data-slot="clarification-timeline"
        className="flex flex-col gap-2 border-t pt-2"
      >
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Run timeline
        </p>
        {timeline.gapDivider && (
          <p className="text-xs text-amber-600" data-slot="clarification-gap-divider">
            — {timeline.gapDivider.hiddenCount} earlier events not retained —
          </p>
        )}
        {timeline.segments.every((segment) => segment.entries.length === 0) ? (
          <p className="text-xs text-muted-foreground">nothing operational has happened yet</p>
        ) : (
          timeline.segments.map((segment) => (
            <TimelineSegmentBlock key={segment.key} segment={segment} />
          ))
        )}
      </div>

      {discardable(section.run) && (
        <div
          data-slot="clarification-discard"
          className="flex flex-col gap-1 rounded-md border p-2"
        >
          <p className="text-xs font-medium">Discard retained evidence</p>
          <p className="text-xs text-muted-foreground">
            Discarding is unrecoverable: the run closes terminal and every retained event is purged.
            Type the run id ({section.run.runId}) to confirm — the only destructive action this
            surface has.
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <input
              className="w-full max-w-48 rounded-md border bg-transparent px-2 py-1 text-xs"
              value={discardConfirmation}
              onChange={(event) => setDiscardConfirmation(event.target.value)}
              aria-label="type the run id to confirm discarding retained evidence"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={discardConfirmation !== section.run.runId || discardPending}
              onClick={() => void discard()}
              aria-label="discard retained evidence"
            >
              discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
