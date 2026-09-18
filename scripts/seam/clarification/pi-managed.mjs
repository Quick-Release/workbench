import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

// The pi-managed/v1 adapter core (spec #221, ticket #227, ADR 0018): the
// Workbench side of one managed Pi session. One clarification attempt gets
// one dedicated Pi conversation, one managed runtime spawned in RPC mode,
// and one session-file writer, in dedicated storage that never touches the
// Developer's personal Pi sessions.
//
// Ownership: Workbench owns the session's lifecycle, its writer lock, the
// versioned event envelope, and the session event cursor. Pi owns the
// conversation and its native transcript file — the adapter reads that file
// for history and never writes it. The runtime's own protocol details are
// the child's business; this adapter pins the handshake protocol version,
// wraps every observed frame in the versioned envelope with a monotonic
// cursor, and preserves unknown or malformed frames verbatim as evidence.
//
// Acceptance versus settlement: a runtime ack is acceptance; only the
// runtime's settle signal settles a turn. Assistant text settles nothing,
// and a runtime that ends before settling rejects the turn — reconciliation
// over the durable run record is the coordinator's separate duty; this
// adapter never reports success on its own.
//
// Reconnect: every observed frame keeps its cursor in a bounded buffer. A
// viewer reattaches with `reconnect({ afterCursor })` and receives the
// retained events after that cursor; a cursor that has fallen out of the
// buffer reconnects with an explicit gap and the resume point — history is
// never invented.

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
      return { type: "malformed", raw: line };
    return event;
  } catch {
    return { type: "malformed", raw: line };
  }
};

// Starts one managed session and resolves it once the runtime has completed
// the protocol handshake. Rejects with typed errors when the writer lock is
// contested or the runtime announces an unsupported protocol.
export const startManagedSession = ({
  spawn,
  command = "pi",
  baseArgs = [],
  sessionRoot,
  sessionId,
  supportedProtocols = SUPPORTED_PROTOCOLS,
  eventBufferLimit = 1000,
}) => {
  if (typeof spawn !== "function")
    throw adapterError("invalid_adapter", "the adapter needs a spawn port");
  if (!sessionRoot || typeof sessionRoot !== "string")
    throw adapterError("invalid_adapter", "the adapter needs a dedicated session root");

  const id = sanitizeSessionId(sessionId);
  const sessionDirectory = join(sessionRoot, id);
  const sessionFile = join(sessionDirectory, "session.jsonl");
  const writerLockPath = `${sessionFile}.writer`;
  const argv = [...baseArgs, "--mode", "rpc", "--session", sessionFile];

  return (async () => {
    // The single-writer claim: an exclusive create, so a second coordinator
    // over the same conversation is a typed refusal before any child is
    // spawned. The lock is released when the runtime is disposed.
    await mkdir(sessionDirectory, { recursive: true });
    let writerLock;
    try {
      writerLock = await openFile(writerLockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw adapterError(
        "session_writer_exists",
        `the session file "${sessionFile}" already has a writer — one runtime owns one conversation`,
      );
    }
    await writerLock.writeFile(`${ADAPTER_VERSION}\n`);
    await writerLock.close();

    const child = spawn({ command, args: argv });
    let ended = false;
    let cursor = 0;
    let oldestCursor = 1;
    const buffer = [];
    const pendingTurns = [];
    const eventWaiters = [];
    const endWaiters = [];

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
    // its cursor, and turns the runtime's acks and settle signal into the
    // pending turns' acceptance and settlement.
    const observeFrame = (event) => {
      cursor += 1;
      const envelope = { cursor, envelope: ADAPTER_VERSION, event };
      buffer.push(envelope);
      if (buffer.length > eventBufferLimit) {
        buffer.shift();
        oldestCursor = buffer[0].cursor;
      }
      if (event.type === "accepted") {
        for (const turn of pendingTurns) {
          if (event.id === turn.requestId) turn.onAccepted();
        }
      }
      if (event.type === "agent_settled") {
        for (const turn of pendingTurns.splice(0)) turn.onSettled();
      }
      for (const waiter of eventWaiters.splice(0)) waiter();
      return envelope;
    };

    // The consumption loop: the child's stdout as JSONL. Ends with EOF.
    void (async () => {
      let pendingLine = "";
      try {
        for await (const chunk of child.stdout) {
          pendingLine += typeof chunk === "string" ? chunk : String(chunk);
          let boundary = pendingLine.indexOf("\n");
          while (boundary !== -1) {
            const line = pendingLine.slice(0, boundary);
            pendingLine = pendingLine.slice(boundary + 1);
            if (line.trim() !== "") observeFrame(decodeLine(line));
            boundary = pendingLine.indexOf("\n");
          }
        }
        if (pendingLine.trim() !== "") observeFrame(decodeLine(pendingLine));
      } finally {
        ended = true;
        for (const handler of endWaiters.splice(0)) handler();
        for (const waiter of eventWaiters.splice(0)) waiter();
      }
    })();

    // The handshake: the runtime's first decoded frame must be a hello
    // announcing a supported protocol; anything else (including an early
    // end) is a typed denial.
    const handshakeFrame = await (async () => {
      while (true) {
        const hello = buffer.map((entry) => entry.event).find((event) => event.type === "hello");
        if (hello !== undefined) {
          if (!supportedProtocols.includes(hello.protocol)) {
            child.kill();
            throw adapterError(
              "unsupported_protocol",
              `the runtime speaks protocol "${hello.protocol}"; this adapter speaks ${supportedProtocols.join(", ")}`,
            );
          }
          return hello;
        }
        if (ended)
          throw adapterError("runtime_ended", "the runtime ended before the protocol handshake");
        await waitForEvent();
      }
    })();
    void handshakeFrame;

    const rejectUnsettledTurns = () => {
      for (const turn of pendingTurns.splice(0))
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

      state: () => (ended ? "ended" : "ready"),

      // Sends one user turn. The returned promises are the acceptance and
      // the settlement of THIS request id: acceptance is the runtime's ack;
      // settlement is only the runtime's settle signal — reconciliation on
      // the durable record remains the coordinator's separate duty.
      // Assistant text is evidence, never settlement.
      sendPrompt(text) {
        if (ended) throw adapterError("runtime_ended", "the managed runtime has ended");
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
        pendingTurns.push(turn);
        child.stdin.write(`${JSON.stringify({ type: "prompt", id: requestId, text })}\n`);
        return { requestId, accepted, settled };
      },

      // The full retained evidence with the latest cursor.
      observe() {
        return { events: [...buffer], latestCursor: cursor };
      },

      // Reattach a viewer: the retained events after `afterCursor`, or an
      // explicit gap naming the resume point when that cursor has fallen
      // out of the bounded buffer.
      reconnect({ afterCursor }) {
        if (afterCursor < oldestCursor - 1)
          return {
            gap: { after: afterCursor, resumeFrom: oldestCursor },
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

      // Stops the runtime and releases the writer claim. The transcript
      // stays for inspection; nothing is deleted.
      async dispose() {
        ended = true;
        child.kill();
        await rm(writerLockPath, { force: true });
      },
    };
  })();
};
