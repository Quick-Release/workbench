import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

// The pi-managed/v1 adapter core (spec #221, ticket #227, ADR 0018): the
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
// runtime's settle signal settles the one live turn. Assistant text settles
// nothing, a second prompt before settlement is a typed rejection (the
// follow-up queue is the control surface's concern), and a runtime that
// ends or is disposed before settling rejects the turn — reconciliation
// over the durable run record is the coordinator's separate duty; this
// adapter never reports success on its own.
//
// Reconnect: every observed frame keeps its cursor in a bounded buffer. A
// viewer reattaches with `reconnect({ afterCursor })` and receives the
// retained events after that cursor; a cursor that has fallen out of the
// buffer reconnects with an explicit gap and the first retained cursor —
// history is never invented.

export const ADAPTER_VERSION = "pi-managed/v1";

// The handshake protocol versions this adapter speaks. A runtime announcing
// anything else is stopped and the start is a typed denial.
export const SUPPORTED_PROTOCOLS = ["1"];

const adapterError = (code, message) => Object.assign(new Error(message), { code });

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
  supportedProtocols = SUPPORTED_PROTOCOLS,
  allowedRuntimeVersions,
  eventBufferLimit = 1000,
}) => {
  if (typeof spawn !== "function")
    throw adapterError("invalid_adapter", "the adapter needs a spawn port");
  if (!sessionRoot || typeof sessionRoot !== "string")
    throw adapterError("invalid_adapter", "the adapter needs a dedicated session root");
  if (!Number.isInteger(eventBufferLimit) || eventBufferLimit < 1)
    throw adapterError(
      "invalid_adapter",
      "the event buffer limit must be an integer of at least 1",
    );

  const id = sanitizeSessionId(sessionId);
  const sessionDirectory = join(sessionRoot, id);
  const sessionFile = join(sessionDirectory, "session.jsonl");
  const writerClaimPath = `${sessionFile}.writer`;
  const argv = [...baseArgs, "--mode", "rpc", "--session", sessionFile];

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

    const child = spawn({ command, args: argv });
    let ended = false;
    let cursor = 0;
    let oldestCursor = 1;
    const buffer = [];
    const liveTurns = [];
    const eventWaiters = [];
    const endWaiters = [];

    const endSession = () => {
      if (ended) return;
      ended = true;
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

    // Every observed frame becomes evidence — a decoded event or a
    // malformed line preserved verbatim — under the versioned envelope with
    // its cursor, and turns the runtime's ack and settle signal into the
    // live turn's acceptance and settlement.
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
      }
      if (event.type === "agent_settled") {
        for (const turn of liveTurns.splice(0)) turn.onSettled();
      }
      for (const waiter of eventWaiters.splice(0)) waiter();
      return envelope;
    };

    // The consumption loop: the child's stdout as JSONL. A stateful decoder
    // reassembles chunks so a multi-byte code point split across chunks
    // decodes whole. Ends with EOF.
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
        endSession();
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

    const rejectUnsettledTurns = () => {
      for (const turn of liveTurns.splice(0))
        turn.onSettleRejected(
          adapterError(
            "runtime_ended_unsettled",
            "the runtime ended before settling the turn — the outcome is unknown until reconciliation",
          ),
        );
    };
    onEnd(rejectUnsettledTurns);

    return {
      sessionId: id,
      sessionDirectory,
      sessionFile,
      argv,
      runtime: { protocol: firstFrame.protocol, version: firstFrame.runtime },

      state: () => (ended ? "ended" : "ready"),

      // Sends one user turn. The returned promises are the acceptance and
      // the settlement of THIS request id: acceptance is the runtime's ack;
      // settlement is only the runtime's settle signal for the one live
      // turn — reconciliation on the durable record remains the
      // coordinator's separate duty. A second prompt before settlement is
      // rejected: the follow-up queue is the control surface's concern.
      sendPrompt(text) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
        if (liveTurns.length > 0)
          throw adapterError(
            "turn_in_flight",
            "a prompt is already awaiting settlement — steer, queue it, or stop the turn first",
          );
        if (typeof text !== "string" || text.trim() === "")
          throw adapterError("invalid_request", "a prompt needs a non-empty text");
        const requestId = `req_${randomUUID()}`;
        let acceptResolve;
        let settleResolve;
        let settleReject;
        const accepted = new Promise((resolve) => {
          acceptResolve = resolve;
        });
        const settled = new Promise((resolve, reject) => {
          settleResolve = resolve;
          settleReject = reject;
        });
        const turn = {
          requestId,
          onAccepted: () => acceptResolve(),
          onSettled: () => settleResolve({ requestId }),
          onSettleRejected: settleReject,
        };
        liveTurns.push(turn);
        child.stdin.write(`${JSON.stringify({ type: "prompt", id: requestId, text })}\n`);
        return { requestId, accepted, settled };
      },

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

      // Stops the runtime and releases the writer claim through the same
      // end path as EOF: unsettled turns reject, waiters drain. The
      // transcript stays for inspection; nothing is deleted.
      async dispose() {
        endSession();
        child.kill();
        await releaseWriterClaim();
      },
    };
  })();
};
