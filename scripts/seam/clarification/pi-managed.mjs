import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

// The pi-managed/v1 adapter (spec #221, tickets #227 + #228, ADR 0018): the
// Workbench side of one managed Pi session. One clarification attempt gets
// one dedicated Pi conversation, one managed runtime spawned in RPC mode,
// and one session-file writer, in dedicated storage that never touches the
// Developer's personal Pi sessions.
//
// Ownership: Workbench owns the session's lifecycle, its writer claim, the
// versioned event envelope, and the session event cursor. Pi owns the
// conversation and its native transcript file — the adapter reads that file
// for history and never writes it. The runtime's own protocol details are
// the child's business; this adapter pins the handshake (the runtime's
// FIRST frame must be a hello announcing a supported protocol and, when the
// caller pins them, a supported runtime revision), wraps every observed
// frame in the versioned envelope with a monotonic cursor, and preserves
// unknown or malformed frames verbatim as evidence.
//
// Acceptance versus settlement: a runtime ack is acceptance; only the
// runtime's settle signal settles the one live turn. Assistant text,
// `agent_end`, compaction, and retry observations settle nothing — a
// runtime that ends or is disposed before settling rejects the turn;
// reconciliation over the durable run record is the coordinator's separate
// duty, and this adapter never reports success on its own.
//
// The control surface is explicit and Pi-shaped (steer, follow-up queue,
// clear-queue, stop-turn, terminate-runtime are distinct operations —
// nothing is implicit): steer rides the live turn; a follow-up queues
// behind it (bounded, FIFO) and rides Pi's `follow_up` operation once the
// floor frees, its ack its acceptance and the next settle its delivery's
// completion; clear-queue drops queued work and tells the runtime;
// stop-turn clears the queue FIRST, then aborts, and the settle that
// follows an abort is a cancelled outcome; terminate-runtime is destructive
// and typed-confirmed.
//
// The failure mapping is classified. An error frame correlated by id to an
// un-acknowledged command is that command's typed `rejected` — the Pi error
// travels verbatim and nothing parks. A `policy_denied` is a typed denial,
// never a park. Only an uncorrelated provider condition parks the session
// awaiting-human (auth and quota are named kinds, anything else is a
// provider failure all the same) with the provider-reported usage preserved
// verbatim — nothing is retried, re-targeted, or silently fallen back.
// Process death is recorded as exit evidence and the unsettled turn rejects
// with the documented Unknown outcome for reconciliation; no restart, no
// prompt replay.
//
// Extension UI: `select`, `confirm`, `input`, and `editor` dialogs surface
// as typed pending questions with cancellation and a bounded timeout (the
// timeout is typed evidence here and a typed cancellation to the runtime —
// never a default answer); unsupported widgets are preserved as evidence
// AND listed as unsupported capabilities — never dropped silently.
//
// The child is spawned with exactly the sanitized environment the caller
// passes and never inherits the host environment — that is where
// credentials live — and with automatic retries pinned off.

export const ADAPTER_VERSION = "pi-managed/v1";

// The handshake protocol versions this adapter speaks. A runtime announcing
// anything else is stopped and the start is a typed denial.
export const SUPPORTED_PROTOCOLS = ["1"];

// The pinned runtime switch that disables Pi's automatic provider retries —
// provider activity cannot escape Workbench accounting. Part of this
// adapter's pinned contract: it is reviewed against the pinned runtime
// revision whenever the runtime pin is.
export const RETRY_DISABLED_ARGS = ["--no-retry"];

// The session's own words for where it stands — never a claim about
// processes.
export const SESSION_STATES = ["ready", "waiting-for-input", "awaiting-human", "ended"];

// The extension dialogs this adapter can surface as typed questions; any
// other UI request is an unsupported capability, preserved and listed.
const DIALOG_KINDS = ["select", "confirm", "input", "editor"];

// The named provider failure kinds; anything else an error frame carries
// is a provider failure all the same.
const PROVIDER_FAILURE_KINDS = ["auth_required", "quota"];

const adapterError = (code, message) => Object.assign(new Error(message), { code });

// The typed errors that carry evidence beyond the code.
const typedError = (code, message, extra) => Object.assign(adapterError(code, message), extra);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeSessionId = (sessionId) => {
  if (sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId))
    throw adapterError(
      "invalid_session_id",
      "a session id may carry letters, digits, dashes, and underscores only",
    );
  return sessionId ?? `pi-session-${randomUUID()}`;
};

const decodeLine = (line) => {
  try {
    const event = JSON.parse(line);
    if (event === null || typeof event !== "object" || Array.isArray(event))
      return { type: "malformed", raw: line, origin: "adapter" };
    return event;
  } catch {
    return { type: "malformed", raw: line, origin: "adapter" };
  }
};

// Starts one managed session and resolves it once the runtime has completed
// the protocol handshake. Rejects with typed errors when the writer claim is
// contested or the runtime fails the pinned handshake; every denial path
// releases the writer claim, so a corrected runtime can retry.
export const startManagedSession = ({
  spawn,
  command = "pi",
  baseArgs = [],
  sessionRoot,
  sessionId,
  env,
  supportedProtocols = SUPPORTED_PROTOCOLS,
  allowedRuntimeVersions,
  eventBufferLimit = 1000,
  followUpLimit = 10,
  dialogTimeoutMs = 120_000,
  scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  cancelTimeout = (handle) => clearTimeout(handle),
}) => {
  if (typeof spawn !== "function")
    throw adapterError("invalid_adapter", "the adapter needs a spawn port");
  if (!sessionRoot || typeof sessionRoot !== "string")
    throw adapterError("invalid_adapter", "the adapter needs a dedicated session root");
  if (!isPlainObject(env))
    throw adapterError(
      "invalid_adapter",
      "the managed runtime needs an explicit sanitized child environment — the host environment is never inherited",
    );
  if (!Number.isInteger(eventBufferLimit) || eventBufferLimit < 1)
    throw adapterError(
      "invalid_adapter",
      "the event buffer limit must be an integer of at least 1",
    );
  if (!Number.isInteger(followUpLimit) || followUpLimit < 1)
    throw adapterError(
      "invalid_adapter",
      "the follow-up queue limit must be an integer of at least 1",
    );
  if (!Number.isInteger(dialogTimeoutMs) || dialogTimeoutMs < 1)
    throw adapterError(
      "invalid_adapter",
      "the dialog timeout must be a positive integer of milliseconds",
    );
  if (typeof scheduleTimeout !== "function" || typeof cancelTimeout !== "function")
    throw adapterError(
      "invalid_adapter",
      "the adapter needs schedule and cancel timeout ports for the bounded dialog timeout",
    );

  const id = sanitizeSessionId(sessionId);
  const sessionDirectory = join(sessionRoot, id);
  const sessionFile = join(sessionDirectory, "session.jsonl");
  const writerClaimPath = `${sessionFile}.writer`;
  const argv = [...baseArgs, "--mode", "rpc", ...RETRY_DISABLED_ARGS, "--session", sessionFile];

  return (async () => {
    // The single-writer claim: an exclusive create, so a second coordinator
    // over the same conversation is a typed refusal before any child is
    // spawned. The claim is released whenever the session ends — on dispose
    // and on every start denial — so a corrected runtime can retry.
    let writerClaim;
    try {
      await mkdir(sessionDirectory, { recursive: true });
      writerClaim = await openFile(writerClaimPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw adapterError(
        "session_writer_exists",
        `the session file "${sessionFile}" already has a writer — one runtime owns one conversation`,
      );
    }
    await writerClaim.writeFile(`${ADAPTER_VERSION}\n`);
    await writerClaim.close();
    const releaseWriterClaim = () => rm(writerClaimPath, { force: true });

    const child = spawn({ command, args: argv, env });
    let ended = false;
    let endReason = "requested";
    let exitStatus = null;
    let awaitingHuman = false;
    let cursor = 0;
    let oldestCursor = 1;
    const buffer = [];
    const liveTurns = [];
    const followUps = [];
    const pendingCommands = [];
    const pendingDialogs = new Map();
    const dialogTimeouts = new Map();
    const unsupportedCapabilities = new Map();
    const eventWaiters = [];
    const endWaiters = [];

    const endSession = (reason = "requested") => {
      if (ended) return;
      ended = true;
      endReason = reason;
      for (const handle of dialogTimeouts.values()) cancelTimeout(handle);
      dialogTimeouts.clear();
      for (const handler of endWaiters.splice(0)) handler();
      for (const waiter of eventWaiters.splice(0)) waiter();
    };

    const onEnd = (handler) => {
      if (ended) handler();
      else endWaiters.push(handler);
    };
    const waitForEvent = () =>
      new Promise((resolve) => {
        eventWaiters.push(resolve);
      });

    const writeFrame = (frame) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    };

    const disarmDialogTimeout = (dialogId) => {
      const handle = dialogTimeouts.get(dialogId);
      if (handle !== undefined) {
        cancelTimeout(handle);
        dialogTimeouts.delete(dialogId);
      }
    };

    // The typed cancellation of one pending dialog — the explicit cancel,
    // the bounded timeout, and the end drain all land here. Never a default
    // answer: the runtime is told the dialog was cancelled.
    const cancelDialogInternal = ({ dialogId }) => {
      if (pendingDialogs.get(dialogId) === undefined) return false;
      pendingDialogs.delete(dialogId);
      disarmDialogTimeout(dialogId);
      writeFrame({ type: "dialog_response", id: dialogId, cancelled: true });
      return true;
    };

    // One acceptance channel: an ack resolves it; a typed rejection, the
    // settle drain, or the end drain rejects it — it never dangles.
    const makeAcceptance = () => {
      let onAccepted;
      let onAcceptRejected;
      const accepted = new Promise((resolve, reject) => {
        onAccepted = resolve;
        onAcceptRejected = reject;
      });
      return { accepted, onAccepted, onAcceptRejected };
    };

    // One prompt-shaped turn: fresh identity, acceptance and settlement as
    // separate promises. Live turns and queued follow-ups share the shape;
    // a queued follow-up's promises travel to its caller at queue time and
    // only ride the wire when the floor frees.
    const makeTurn = (requestId) => {
      let settleResolve;
      let settleReject;
      const settled = new Promise((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
      });
      const { accepted, onAccepted, onAcceptRejected } = makeAcceptance();
      const turn = {
        requestId,
        stopped: false,
        accepted: false,
        onAccepted: () => {
          turn.accepted = true;
          onAccepted();
        },
        onAcceptRejected,
        onSettled: () => settleResolve({ requestId }),
        onSettleRejected: settleReject,
      };
      return { promises: { accepted, settled }, turn };
    };

    const rejectQueuedEntry = (entry, why) => {
      entry.turn.onAcceptRejected(why);
      entry.turn.onSettleRejected(why);
    };

    // A turn the Developer explicitly stopped never reports an outcome of
    // its own: cancelled, whatever the runtime does next.
    const stoppedTurnRejection = () =>
      adapterError("cancelled", "the turn was explicitly stopped — the outcome is cancelled");

    const dispatchPrompt = (turn, text) => {
      liveTurns.push(turn);
      writeFrame({ type: "prompt", id: turn.requestId, text });
    };

    const dispatchNextFollowUp = () => {
      if (ended || liveTurns.length > 0) return;
      const next = followUps.shift();
      if (next === undefined) return;
      // A queued follow-up rides Pi's own follow_up operation once the
      // floor frees: its ack is its acceptance, the next settle is its
      // delivery's completion — acceptance and delivery remain separate.
      liveTurns.push(next.turn);
      writeFrame({ type: "follow_up", id: next.turn.requestId, text: next.text });
    };

    // The queue clear: queued work is dropped outright — it will never
    // deliver — and the runtime is told to clear whatever it has queued
    // internally too. stop-turn runs this before its abort, in that order.
    const clearQueuedWork = (why) => {
      const cleared = followUps.splice(0);
      for (const entry of cleared) rejectQueuedEntry(entry, why);
      writeFrame({ type: "clear_queue", id: `req_${randomUUID()}` });
      return cleared;
    };

    // Every observed frame becomes evidence — a decoded event or a
    // malformed line preserved verbatim — under the versioned envelope with
    // its cursor. Frames also drive the typed outcomes: acks, settlement,
    // dialogs, unsupported widgets, and provider failures.
    const observeFrame = (event) => {
      cursor += 1;
      const envelope = { cursor, envelope: ADAPTER_VERSION, event };
      buffer.push(envelope);
      if (buffer.length > eventBufferLimit) {
        buffer.shift();
        oldestCursor = buffer[0].cursor;
      }
      if (event.type === "accepted") {
        for (const turn of liveTurns) {
          if (event.id === turn.requestId) turn.onAccepted();
        }
        const commandIndex = pendingCommands.findIndex((command) => command.requestId === event.id);
        if (commandIndex !== -1) pendingCommands.splice(commandIndex, 1)[0].onAccepted();
      }
      if (event.type === "agent_settled") {
        // Queued work delivers only when a turn actually settles: a settle
        // that leaves the floor free some other way (a rejection, a park)
        // delivers nothing — the coordinator owns what runs next then.
        let settledTurn = false;
        for (const turn of liveTurns.splice(0)) {
          if (turn.stopped) turn.onSettleRejected(stoppedTurnRejection());
          else {
            turn.onSettled();
            settledTurn = true;
          }
        }
        // A command the runtime settled without acknowledging will never be
        // acknowledged: its acceptance rejects rather than dangles.
        for (const command of pendingCommands.splice(0))
          command.onRejected(
            adapterError(
              "rejected",
              "the runtime settled the turn without acknowledging the command",
            ),
          );
        if (settledTurn) dispatchNextFollowUp();
      }
      if (DIALOG_KINDS.includes(event.type)) {
        const dialogId =
          typeof event.id === "string" && event.id !== "" ? event.id : `dialog_${randomUUID()}`;
        pendingDialogs.set(dialogId, { dialogId, kind: event.type, request: event });
        // A pending dialog is bounded: unanswered long enough, it is
        // cancelled — typed evidence here, typed cancellation to the
        // runtime. Never a default answer.
        dialogTimeouts.set(
          dialogId,
          scheduleTimeout(() => {
            if (ended || pendingDialogs.get(dialogId) === undefined) return;
            cancelDialogInternal({ dialogId });
            observeFrame({ type: "dialog_timeout", dialogId, origin: "adapter" });
          }, dialogTimeoutMs),
        );
      }
      if (event.type === "extension_widget") {
        const capability =
          typeof event.widget === "string" && event.widget !== "" ? event.widget : "unknown-widget";
        const seen = unsupportedCapabilities.get(capability);
        if (seen === undefined)
          unsupportedCapabilities.set(capability, { capability, count: 1, frame: event });
        else seen.count += 1;
      }
      if (event.type === "error") {
        // The failure mapping, classified. An error correlated by id to an
        // un-acknowledged command or turn is THAT command's typed rejection
        // — the Pi error travels verbatim, the floor frees, and nothing
        // parks; the coordinator decides what a rejected command means. A
        // `policy_denied` is a Workbench-owned denial: typed, no park. Only
        // an uncorrelated provider condition parks the session
        // awaiting-human — auth and quota are named kinds, anything else is
        // a provider failure all the same — with the provider-reported
        // usage preserved verbatim; nothing retries, re-targets, falls
        // back, or delivers queued work without an explicit human decision.
        const correlatedTurn =
          event.id !== undefined
            ? liveTurns.find((turn) => turn.requestId === event.id && !turn.accepted)
            : undefined;
        if (event.kind === "policy_denied") {
          const denial = typedError("policy_denied", "the broker denied a capability", {
            evidence: event,
          });
          if (correlatedTurn !== undefined) {
            liveTurns.splice(liveTurns.indexOf(correlatedTurn), 1);
            correlatedTurn.onAcceptRejected(denial);
            correlatedTurn.onSettleRejected(denial);
          } else {
            for (const turn of liveTurns.splice(0)) {
              turn.onAcceptRejected(denial);
              turn.onSettleRejected(denial);
            }
          }
        } else if (correlatedTurn !== undefined) {
          const rejection = typedError("rejected", "the runtime rejected the command", {
            evidence: event,
          });
          liveTurns.splice(liveTurns.indexOf(correlatedTurn), 1);
          correlatedTurn.onAcceptRejected(rejection);
          correlatedTurn.onSettleRejected(rejection);
        } else {
          const correlatedCommand = pendingCommands.findIndex(
            (command) => command.requestId === event.id,
          );
          if (correlatedCommand !== -1) {
            const [command] = pendingCommands.splice(correlatedCommand, 1);
            command.onRejected(
              typedError("rejected", "the runtime rejected the command", { evidence: event }),
            );
          } else {
            const reason = PROVIDER_FAILURE_KINDS.includes(event.kind)
              ? event.kind
              : "provider_failure";
            awaitingHuman = true;
            const failure = typedError(
              reason,
              `the provider reported ${reason} — the session is parked awaiting a human decision; nothing is retried or re-targeted`,
              {
                failure: {
                  status: "awaiting-human",
                  reason,
                  usage: event.usage ?? null,
                  evidence: event,
                },
              },
            );
            for (const turn of liveTurns.splice(0)) {
              turn.onAcceptRejected(failure);
              turn.onSettleRejected(failure);
            }
            clearQueuedWork(
              adapterError(
                "cancelled",
                "the session parked awaiting-human — queued work never delivers without an explicit human decision",
              ),
            );
            for (const command of pendingCommands.splice(0)) command.onRejected(failure);
          }
        }
      }
      for (const waiter of eventWaiters.splice(0)) waiter();
      return envelope;
    };

    // The consumption loop: the child's stdout as JSONL. A stateful decoder
    // reassembles chunks so a multi-byte code point split across chunks
    // decodes whole. Ends with EOF. Exit evidence lands before the end
    // drains, so the unknown-outcome rejections carry it.
    const decoder = new StringDecoder("utf8");
    void (async () => {
      let pendingLine = "";
      try {
        for await (const chunk of child.stdout) {
          pendingLine += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          let boundary = pendingLine.indexOf("\n");
          while (boundary !== -1) {
            const line = pendingLine.slice(0, boundary);
            pendingLine = pendingLine.slice(boundary + 1);
            if (line.trim() !== "") observeFrame(decodeLine(line));
            boundary = pendingLine.indexOf("\n");
          }
        }
        pendingLine += decoder.end();
        if (pendingLine.trim() !== "") observeFrame(decodeLine(pendingLine));
      } finally {
        exitStatus = child.exited ? await child.exited.catch(() => null) : null;
        endSession("eof");
      }
    })();

    // The handshake: the runtime's FIRST decoded frame must be the hello —
    // a runtime that streams other frames first, announces an unsupported
    // protocol, pins an unsupported revision, or ends silently, is a typed
    // denial. Every denial stops the child and releases the writer claim.
    const firstFrame = await (async () => {
      while (buffer.length === 0) {
        if (ended) {
          child.kill();
          await releaseWriterClaim();
          throw adapterError("runtime_ended", "the runtime ended before the protocol handshake");
        }
        await waitForEvent();
      }
      return buffer[0].event;
    })();
    if (firstFrame.type !== "hello") {
      child.kill();
      await releaseWriterClaim();
      throw adapterError(
        "handshake_violation",
        `the runtime's first frame was "${firstFrame.type}", not a hello`,
      );
    }
    if (!supportedProtocols.includes(firstFrame.protocol)) {
      child.kill();
      await releaseWriterClaim();
      throw adapterError(
        "unsupported_protocol",
        `the runtime speaks protocol "${firstFrame.protocol}"; this adapter speaks ${supportedProtocols.join(", ")}`,
      );
    }
    if (
      allowedRuntimeVersions !== undefined &&
      !allowedRuntimeVersions.includes(firstFrame.runtime)
    ) {
      child.kill();
      await releaseWriterClaim();
      throw adapterError(
        "unsupported_runtime",
        `the runtime is ${firstFrame.runtime ?? "unversioned"}; the reviewed runtime is ${allowedRuntimeVersions.join(", ")}`,
      );
    }

    // The end path: what each unfinished thing becomes. A turn the Developer
    // explicitly stopped is cancelled; any other unsettled turn rejects with
    // the documented Unknown outcome — the end reason and the exit evidence
    // travel with it for reconciliation. Queued work never delivered and
    // never will, so it is cancelled outright.
    const rejectUnsettled = () => {
      const unknown = () =>
        typedError(
          "runtime_ended_unsettled",
          "the runtime ended before settling the turn — the outcome is unknown until reconciliation",
          { outcome: "unknown", endReason, exit: exitStatus },
        );
      for (const turn of liveTurns.splice(0)) {
        if (turn.stopped) {
          turn.onAcceptRejected(stoppedTurnRejection());
          turn.onSettleRejected(stoppedTurnRejection());
        } else {
          turn.onAcceptRejected(unknown());
          turn.onSettleRejected(unknown());
        }
      }
      for (const entry of followUps.splice(0))
        rejectQueuedEntry(
          entry,
          adapterError("cancelled", "the session ended — the queued follow-up will never deliver"),
        );
      for (const command of pendingCommands.splice(0)) command.onRejected(unknown());
    };
    onEnd(rejectUnsettled);

    const idleTurnRejection = () => adapterError("turn_not_in_flight", "no turn is live");

    // Stops the runtime and releases the writer claim through the same
    // end path as EOF: unsettled turns reject, waiters drain. The
    // transcript stays for inspection; nothing is deleted.
    const stopRuntime = async () => {
      endSession("requested");
      child.kill();
      await releaseWriterClaim();
    };

    return {
      sessionId: id,
      sessionDirectory,
      sessionFile,
      argv,
      runtime: { protocol: firstFrame.protocol, version: firstFrame.runtime },

      // The session's own word for where it stands — never a claim about
      // processes: ended, waiting-for-input (a typed dialog is pending),
      // awaiting-human (a provider failure parked it), or ready.
      state: () => {
        if (ended) return "ended";
        if (pendingDialogs.size > 0) return "waiting-for-input";
        if (awaitingHuman) return "awaiting-human";
        return "ready";
      },

      // The child's exit status once observed; null while it lives. This is
      // evidence, not a liveness claim.
      exit: () => exitStatus,

      // Sends one user turn. The returned promises are the acceptance and
      // the settlement of THIS request id: acceptance is the runtime's ack;
      // settlement is only the runtime's settle signal for the one live
      // turn — reconciliation on the durable record remains the
      // coordinator's separate duty. A second prompt before settlement is
      // rejected: the follow-up queue is the explicit way to hold work.
      sendPrompt(text) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (liveTurns.length > 0)
          throw adapterError(
            "turn_in_flight",
            "a prompt is already awaiting settlement — steer, queue it, or stop the turn first",
          );
        if (typeof text !== "string" || text.trim() === "")
          throw adapterError("invalid_request", "a prompt needs a non-empty text");
        // A prompt is an explicit human decision to continue — it re-opens
        // a session a provider failure had parked.
        awaitingHuman = false;
        const requestId = `req_${randomUUID()}`;
        const { turn, promises } = makeTurn(requestId);
        dispatchPrompt(turn, text);
        return { requestId, ...promises };
      },

      // Steer rides the live turn — explicit guidance, never an implicit
      // interruption and never a second prompt.
      steer(text) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (liveTurns.length === 0) throw idleTurnRejection();
        if (typeof text !== "string" || text.trim() === "")
          throw adapterError("invalid_request", "a steer needs a non-empty text");
        const requestId = `req_${randomUUID()}`;
        const { accepted, onAccepted, onAcceptRejected } = makeAcceptance();
        pendingCommands.push({ requestId, onAccepted, onRejected: onAcceptRejected });
        writeFrame({ type: "steer", id: requestId, text });
        return { requestId, accepted };
      },

      // A follow-up queues behind the live turn — explicit, bounded, FIFO.
      // Its promises resolve only when it is delivered as a turn of its
      // own; acceptance and delivery remain separate.
      queueFollowUp(text) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (liveTurns.length === 0)
          throw adapterError(
            "turn_not_in_flight",
            "a follow-up queues behind the live turn — send a prompt when the floor is free",
          );
        if (typeof text !== "string" || text.trim() === "")
          throw adapterError("invalid_request", "a follow-up needs a non-empty text");
        if (followUps.length >= followUpLimit)
          throw adapterError(
            "queue_full",
            `the follow-up queue is bounded at ${followUpLimit} — clear it before queueing more`,
          );
        const requestId = `req_${randomUUID()}`;
        const { turn, promises } = makeTurn(requestId);
        followUps.push({ text, turn });
        return { requestId, ...promises };
      },

      // Drops every queued follow-up — they will never deliver — and tells
      // the runtime to clear whatever it has queued internally too.
      clearQueue() {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        const cleared = clearQueuedWork(
          adapterError(
            "cancelled",
            "the queued follow-up was explicitly cleared — it will never deliver",
          ),
        );
        return {
          cleared: cleared.map((entry) => ({ requestId: entry.turn.requestId, text: entry.text })),
        };
      },

      // Stop-turn: clear the queue FIRST, then abort the live turn. The
      // floor stays occupied until the runtime is observed to settle; that
      // settle is the turn's cancelled outcome.
      stopTurn() {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        const turn = liveTurns[0];
        if (turn === undefined) throw idleTurnRejection();
        const cleared = clearQueuedWork(
          adapterError(
            "cancelled",
            "the turn was stopped — the queued follow-up was cleared with it",
          ),
        );
        turn.stopped = true;
        const requestId = `req_${randomUUID()}`;
        writeFrame({ type: "abort", id: requestId });
        return {
          requestId,
          cleared: cleared.map((entry) => ({ requestId: entry.turn.requestId, text: entry.text })),
        };
      },

      // The typed pending questions: dialogs the runtime is waiting on.
      pendingDialogs: () =>
        [...pendingDialogs.values()].map(({ dialogId, kind, request }) => ({
          dialogId,
          kind,
          request,
        })),

      // Answers a typed dialog through the response sub-protocol.
      answerDialog({ dialogId, value }) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (value === undefined)
          throw adapterError("invalid_request", "a dialog answer carries a value");
        const dialog = pendingDialogs.get(dialogId);
        if (dialog === undefined)
          throw adapterError("dialog_not_found", `no pending dialog "${dialogId}"`);
        disarmDialogTimeout(dialogId);
        pendingDialogs.delete(dialogId);
        writeFrame({ type: "dialog_response", id: dialogId, value });
        return { dialogId, answered: true };
      },

      // Cancels a typed dialog — a typed cancellation, never a default.
      cancelDialog({ dialogId }) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (!cancelDialogInternal({ dialogId }))
          throw adapterError("dialog_not_found", `no pending dialog "${dialogId}"`);
        return { dialogId, cancelled: true };
      },

      // The unsupported-capability list: widgets this adapter cannot render,
      // each with its verbatim first frame and a count. Evidence, never a
      // silent drop.
      unsupportedCapabilities: () =>
        [...unsupportedCapabilities.values()].sort((a, b) =>
          a.capability.localeCompare(b.capability),
        ),

      // The full retained evidence with the latest cursor.
      observe() {
        return { events: [...buffer], latestCursor: cursor };
      },

      // Reattach a viewer: the retained events after `afterCursor`, or an
      // explicit gap naming the first retained cursor when that cursor has
      // fallen out of the bounded buffer.
      reconnect({ afterCursor }) {
        if (!Number.isInteger(afterCursor) || afterCursor < 0)
          throw adapterError("invalid_request", "afterCursor must be a non-negative integer");
        if (afterCursor < oldestCursor - 1)
          return {
            gap: { after: afterCursor, firstRetainedCursor: oldestCursor },
            events: [...buffer],
          };
        return { events: buffer.filter((envelope) => envelope.cursor > afterCursor) };
      },

      // The runtime-owned transcript, read only. Malformed lines are
      // preserved as evidence, never dropped silently.
      async history() {
        let raw;
        try {
          raw = await readFile(sessionFile, "utf8");
        } catch {
          return [];
        }
        return raw
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => decodeLine(line));
      },

      // Stops the runtime and releases the writer claim — the same end
      // path as EOF (see stopRuntime). The transcript stays for inspection.
      async dispose() {
        await stopRuntime();
      },

      // Terminate-runtime is destructive, so it is typed-confirmed: the
      // caller echoes the session id it is ending. Anything else is a typed
      // refusal that kills nothing.
      async terminateRuntime({ confirmation } = {}) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has already ended");
        if (confirmation !== id)
          throw adapterError(
            "termination_unconfirmed",
            `terminate-runtime ends the runtime and releases the conversation — pass { confirmation: "${id}" } to confirm`,
          );
        await stopRuntime();
      },
    };
  })();
};
