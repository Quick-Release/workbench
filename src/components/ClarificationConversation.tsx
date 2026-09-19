import { useState } from "react";

import { useClarificationConversation } from "../hooks/use-clarification-conversation";
import type { ClarificationEventEnvelope } from "../schema";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

// The managed conversation surface (spec #221, ticket #232): the
// clarification conversation in the dashboard — streamed text and tool
// activity from the run's durable ledger, the Developer's prompt/steer/
// queue as explicit distinct acts, stop-turn as a two-step confirm that
// clears the queue first, runtime dialogs as answerable typed questions,
// unsupported widgets as the capability list, and an operational timeline
// that references the conversation without duplicating it. Provider and
// data destination stay visible at the top: what this conversation is
// authorized to touch is always on the record.

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

export const ClarificationConversation = ({ issueNumber }: { issueNumber: number }) => {
  const { section, conversationState, absent, failure, reload, sendCommand } =
    useClarificationConversation(issueNumber);
  const [draft, setDraft] = useState("");
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
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
    } else {
      setCommandError(null);
    }
    setSubmissionId(globalThis.crypto.randomUUID());
    void reload();
    return true;
  };

  const submit = async (kind: "prompt" | "steer" | "queue") => {
    if (draft.trim() === "") return;
    const answered = await dispatch({ kind, text: draft });
    // An unanswered submission keeps its draft: the retry is the same act,
    // under the same request id.
    if (answered) setDraft("");
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

  const timeline = events.filter(
    ({ event }) =>
      event.type === "lifecycle" ||
      (event.type === "operational" && !event.kind.startsWith("conversation.")),
  );

  return (
    <div data-slot="clarification-conversation" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{section.run.state}</Badge>
        <span className="text-xs text-muted-foreground">provider · {provider}</span>
        {model && <span className="text-xs text-muted-foreground">model · {model}</span>}
        <span className="text-xs text-muted-foreground">destination · {destination}</span>
      </div>

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
          value={draft}
          placeholder={
            inFlight
              ? "steer the live turn, or queue this for after it settles"
              : "what should the clarification look at next?"
          }
          onChange={(event) => setDraft(event.target.value)}
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

      <div data-slot="clarification-timeline" className="flex flex-col gap-1 border-t pt-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Run timeline
        </p>
        {timeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">nothing operational has happened yet</p>
        ) : (
          timeline.map((frame) => {
            const { event } = frame;
            // Conversations never appear here — the timeline references the
            // stream above, it does not repeat it.
            if (event.type === "conversation") return null;
            return (
              <p
                key={event.type === "operational" ? event.kind : `${event.type}-${event.id}`}
                className="text-xs text-muted-foreground"
              >
                {event.type === "operational"
                  ? event.kind.replaceAll(".", " · ")
                  : `attempt ${event.state}`}
              </p>
            );
          })
        )}
        <p className="text-xs text-muted-foreground italic">
          the conversation streams above — this timeline references it, never repeats it
        </p>
      </div>
    </div>
  );
};
