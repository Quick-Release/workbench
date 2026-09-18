import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ADAPTER_VERSION, startManagedSession } from "./pi-managed.mjs";

// Contract tests for the pi-managed/v1 adapter core (spec #221, ticket #227,
// ADR 0018): everything runs against a scripted fake JSONL child — the
// adapter code is real, the runtime is not. No timers: frames are pushed and
// the test drains the consumption loop deterministically.

// Deterministic drain of the adapter's async consumption loop.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// The scripted runtime: a spawn port returning one controllable child whose
// stdout is a pushable line queue. Records every spawn call, stdin frame,
// and kill signal; `end` is the child's EOF.
const fakeRuntime = () => {
  const calls = [];
  const stdinFrames = [];
  const killed = [];
  const queue = [];
  let wakeup = null;
  let closed = false;
  let exitResolve;
  const exited = new Promise((resolve) => (exitResolve = resolve));
  const child = {
    stdin: { write: (frame) => stdinFrames.push(frame) },
    stdout: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (queue.length > 0) yield queue.shift();
          if (closed) return;
          await new Promise((resolve) => (wakeup = resolve));
        }
      },
    },
    exited,
    kill: (signal) => {
      killed.push(signal ?? "SIGTERM");
      exitResolve({ code: null, signal: signal ?? "SIGTERM" });
    },
  };
  return {
    spawn: (options) => {
      calls.push(options);
      return child;
    },
    calls,
    stdinFrames,
    killed,
    // The runtime writes newline-delimited frames; every pushed line rides
    // out with its newline like real JSONL stdout would, and a suspended
    // reader is woken.
    push: (line) => {
      queue.push(`${line}\n`);
      wakeup?.();
    },
    end: (code = 0) => {
      closed = true;
      wakeup?.();
      exitResolve({ code, signal: null });
    },
  };
};

const hello = (protocol = "1") => JSON.stringify({ type: "hello", protocol });

const withSessionRoot = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-pi-managed-"));
  const sessionRoot = join(directory, "clarification-sessions");
  try {
    return await fn({ sessionRoot, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const start = async (fake, { sessionRoot, sessionId, eventBufferLimit } = {}) => {
  const started = startManagedSession({
    spawn: fake.spawn,
    command: "pi",
    sessionRoot,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(eventBufferLimit !== undefined ? { eventBufferLimit } : {}),
  });
  await settle();
  fake.push(hello());
  await settle();
  return started;
};

test("spawns the runtime in RPC mode over a fresh dedicated session file", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    strictEqual(fake.calls.length, 1);
    const call = fake.calls[0];
    strictEqual(call.command, "pi");
    ok(call.args.includes("--mode"), "the runtime runs in RPC mode");
    ok(call.args.includes("rpc"));
    const sessionFlag = call.args[call.args.indexOf("--session") + 1];
    ok(sessionFlag.startsWith(sessionRoot), "the session file lives in dedicated storage");
    ok(!existsSync(join(sessionRoot, "..", ".pi")), "nothing touches personal session storage");

    strictEqual(session.sessionFile, sessionFlag);
    ok(existsSync(`${session.sessionFile}.writer`), "the single writer lock is claimed");
    strictEqual(session.state(), "ready");
    await session.dispose();
  });
});

test("a second writer over the same session file is a typed refusal", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const firstFake = fakeRuntime();
    const first = await start(firstFake, { sessionRoot, sessionId: "conversation-1" });
    const lockPath = `${first.sessionFile}.writer`;
    ok(existsSync(lockPath));

    // Another coordinator claims the same conversation while the writer
    // lock is held — the runtime is already owned. The rejection handler
    // attaches from birth, before the helper's settle drains.
    const secondFake = fakeRuntime();
    const secondRefusal = rejects(
      startManagedSession({
        spawn: secondFake.spawn,
        command: "pi",
        sessionRoot,
        sessionId: "conversation-1",
      }),
      (error) => error.code === "session_writer_exists",
    );
    await secondRefusal;
    strictEqual(secondFake.calls.length, 0, "no child is spawned over a claimed session");

    // Dispose releases the claim with the runtime.
    await first.dispose();
    ok(!existsSync(lockPath), "the writer lock is released with the runtime");
    await firstFake.end();
  });
});

test("an unsupported runtime protocol fails with a typed denial and no session", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const started = startManagedSession({
      spawn: fake.spawn,
      command: "pi",
      sessionRoot,
    });
    await settle();
    fake.push(hello("9"));
    await rejects(started, (error) => error.code === "unsupported_protocol");
    ok(fake.killed.length > 0, "the unsupported runtime is stopped");
    await fake.end();
  });
});

test("acceptance and settlement are distinct; assistant text settles nothing", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const turn = session.sendPrompt("What does this issue mean?");
    const settledRace = Promise.race([
      turn.settled.then(() => "settled"),
      settle().then(() => "pending"),
    ]);

    // The request travels as a typed frame; the runtime acks it.
    deepStrictEqual(JSON.parse(fake.stdinFrames[0]), {
      type: "prompt",
      id: turn.requestId,
      text: "What does this issue mean?",
    });
    fake.push(JSON.stringify({ type: "accepted", id: turn.requestId }));
    fake.push(JSON.stringify({ type: "message", text: "partial answer" }));
    await settle();
    strictEqual(await turn.accepted.then(() => "accepted"), "accepted");
    strictEqual(await settledRace, "pending", "assistant text is not settlement");

    // Only the runtime's settle signal settles the turn.
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await settle();
    deepStrictEqual(await turn.settled, { requestId: turn.requestId });
    await session.dispose();
  });
});

test("a runtime that ends before settling never reports a settled turn", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("Will you settle?");

    fake.end();
    await rejects(turn.settled, (error) => error.code === "runtime_ended_unsettled");
    throws(
      () => session.sendPrompt("after the end"),
      (error) => error.code === "runtime_ended",
    );
    strictEqual(session.state(), "ended");
  });
});

test("events carry the versioned envelope and cursor; reconnect replays after the cursor", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    fake.push(JSON.stringify({ type: "message", text: "one" }));
    fake.push(JSON.stringify({ type: "message", text: "two" }));
    fake.push(JSON.stringify({ type: "message", text: "three" }));
    await settle();

    // The handshake's hello is evidence too — it pins the protocol version —
    // so the messages ride cursors 2..4 behind it.
    const observed = session.observe();
    strictEqual(observed.latestCursor, 4);
    deepStrictEqual(
      observed.events.map((envelope) => envelope.cursor),
      [1, 2, 3, 4],
    );
    ok(observed.events.every((envelope) => envelope.envelope === ADAPTER_VERSION));
    deepStrictEqual(observed.events[0].event, { type: "hello", protocol: "1" });
    const messageTexts = (events) =>
      events
        .filter((envelope) => envelope.event.type === "message")
        .map((envelope) => envelope.event.text);

    const tail = session.reconnect({ afterCursor: 1 });
    strictEqual(tail.gap, undefined);
    deepStrictEqual(messageTexts(tail.events), ["one", "two", "three"]);

    const fresh = session.reconnect({ afterCursor: 0 });
    deepStrictEqual(messageTexts(fresh.events), ["one", "two", "three"]);
    await session.dispose();
  });
});

test("an expired cursor reconnects with an explicit gap, never invented history", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot, eventBufferLimit: 3 });

    for (const text of ["one", "two", "three", "four", "five"]) {
      fake.push(JSON.stringify({ type: "message", text }));
    }
    await settle();

    const observed = session.observe();
    strictEqual(observed.latestCursor, 6);
    deepStrictEqual(
      observed.events.map((envelope) => envelope.event.text),
      ["three", "four", "five"],
    );

    const afterGap = session.reconnect({ afterCursor: 0 });
    ok(afterGap.gap, "an expired cursor is an explicit gap");
    strictEqual(afterGap.gap.after, 0);
    strictEqual(afterGap.gap.resumeFrom, 4);
    deepStrictEqual(
      afterGap.events.map((envelope) => envelope.event.text),
      ["three", "four", "five"],
    );
    await session.dispose();
  });
});

test("malformed and unknown events are preserved as evidence and never stop the stream", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    fake.push("this is not json");
    fake.push(JSON.stringify({ type: "extension_widget", payload: { custom: true } }));
    fake.push(JSON.stringify({ type: "message", text: "still alive" }));
    await settle();

    const events = session.observe().events;
    strictEqual(events.length, 4);
    deepStrictEqual(events[0].event, { type: "hello", protocol: "1" });
    strictEqual(events[1].event.type, "malformed");
    strictEqual(events[1].event.raw, "this is not json");
    deepStrictEqual(events[2].event, {
      type: "extension_widget",
      payload: { custom: true },
    });
    deepStrictEqual(events[3].event, { type: "message", text: "still alive" });
    await session.dispose();
  });
});

test("history reads the runtime-owned transcript, malformed lines included", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    // The runtime owns its transcript file; the fake appends to it the way
    // pi natively would. The adapter only ever reads it.
    await appendFile(
      session.sessionFile,
      `${JSON.stringify({ type: "message", text: "from the transcript" })}\nnot json either\n`,
    );

    const entries = await session.history();
    strictEqual(entries.length, 2);
    deepStrictEqual(entries[0], { type: "message", text: "from the transcript" });
    deepStrictEqual(entries[1], { type: "malformed", raw: "not json either" });
    ok(
      fake.stdinFrames.every((frame) => !frame.includes("from the transcript")),
      "the adapter never writes the transcript",
    );
    await session.dispose();
  });
});
