import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ADAPTER_VERSION, startManagedSession } from "./pi-managed.mjs";

// Contract tests for the pi-managed/v1 adapter (spec #221, tickets #227 +
// #228, ADR 0018): everything runs against a scripted fake JSONL child — the
// adapter code is real, the runtime is not. No timers: frames are pushed and
// the test drains the consumption loop deterministically.

// Deterministic drain of the adapter's async consumption loop.
const drain = async () => {
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
    pushRaw: (chunk) => {
      queue.push(chunk);
      wakeup?.();
    },
    end: (code = 0) => {
      closed = true;
      wakeup?.();
      exitResolve({ code, signal: null });
    },
  };
};

const testEnv = { PATH: "/usr/bin" };

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

const start = async (
  fake,
  {
    sessionRoot,
    sessionId,
    eventBufferLimit,
    dialogTimeoutMs,
    scheduleTimeout,
    cancelTimeout,
  } = {},
) => {
  const started = startManagedSession({
    spawn: fake.spawn,
    command: "pi",
    sessionRoot,
    env: testEnv,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(eventBufferLimit !== undefined ? { eventBufferLimit } : {}),
    ...(dialogTimeoutMs !== undefined ? { dialogTimeoutMs } : {}),
    ...(scheduleTimeout !== undefined ? { scheduleTimeout } : {}),
    ...(cancelTimeout !== undefined ? { cancelTimeout } : {}),
  });
  await drain();
  fake.push(hello());
  await drain();
  return started;
};

// Injected timer port: expiry is arithmetic the test drives, never a sleep.
const manualTimers = () => {
  const pending = new Map();
  let nextHandle = 1;
  return {
    schedule: (fn, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { fn, ms });
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
    fire: (upToMs) => {
      for (const [handle, timer] of [...pending]) {
        if (timer.ms > upToMs) continue;
        pending.delete(handle);
        timer.fn();
      }
    },
    size: () => pending.size,
  };
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
        env: testEnv,
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
      env: testEnv,
    });
    await drain();
    fake.push(hello("9"));
    await rejects(started, (error) => error.code === "unsupported_protocol");
    ok(fake.killed.length > 0, "the unsupported runtime is stopped");
    await fake.end();
  });
});

test("a denial releases the writer claim, so a corrected runtime can retry", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const started = startManagedSession({
      spawn: fake.spawn,
      command: "pi",
      sessionRoot,
      env: testEnv,
      sessionId: "conversation-1",
    });
    await drain();
    fake.push(hello("9"));
    await rejects(started, (error) => error.code === "unsupported_protocol");

    const retryFake = fakeRuntime();
    const retry = await start(retryFake, { sessionRoot, sessionId: "conversation-1" });
    strictEqual(retry.state(), "ready");
    await retry.dispose();
    await retryFake.end();
  });
});

test("a runtime whose first frame is not a hello is a typed denial", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const started = startManagedSession({
      spawn: fake.spawn,
      command: "pi",
      sessionRoot,
      env: testEnv,
    });
    await drain();
    fake.push(JSON.stringify({ type: "message", text: "chatty before hello" }));
    await rejects(started, (error) => error.code === "handshake_violation");
    ok(fake.killed.length > 0);
    await fake.end();
  });
});

test("a runtime revision outside the reviewed pin is a typed denial", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const started = startManagedSession({
      spawn: fake.spawn,
      command: "pi",
      sessionRoot,
      env: testEnv,
      allowedRuntimeVersions: ["5.2.1"],
    });
    await drain();
    fake.push(JSON.stringify({ type: "hello", protocol: "1", runtime: "9.9.9" }));
    await rejects(started, (error) => error.code === "unsupported_runtime");
    await fake.end();

    const pinnedFake = fakeRuntime();
    const pinnedStarted = startManagedSession({
      spawn: pinnedFake.spawn,
      command: "pi",
      sessionRoot,
      env: testEnv,
      allowedRuntimeVersions: ["5.2.1"],
    });
    await drain();
    pinnedFake.push(JSON.stringify({ type: "hello", protocol: "1", runtime: "5.2.1" }));
    const pinned = await pinnedStarted;
    deepStrictEqual(pinned.runtime, { protocol: "1", version: "5.2.1" });
    await pinned.dispose();
    await pinnedFake.end();
  });
});

test("a burst beyond the buffer keeps ordering, cursors, and gap accounting", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot, eventBufferLimit: 10 });

    for (let i = 1; i <= 50; i += 1) {
      fake.push(JSON.stringify({ type: "message", text: `m${i}` }));
    }
    await drain();

    const observed = session.observe();
    strictEqual(observed.latestCursor, 51);
    strictEqual(observed.events.length, 10);
    deepStrictEqual(
      observed.events.map((envelope) => envelope.cursor),
      [42, 43, 44, 45, 46, 47, 48, 49, 50, 51],
    );
    deepStrictEqual(observed.events[0].event.text, "m41");
    deepStrictEqual(observed.events[9].event.text, "m50");

    const afterGap = session.reconnect({ afterCursor: 20 });
    strictEqual(afterGap.gap.firstRetainedCursor, 42);
    strictEqual(afterGap.events.length, 10);
    await session.dispose();
  });
});

test("a multi-byte code point split across chunks decodes whole", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const frame = Buffer.from(
      `${JSON.stringify({ type: "message", text: "clarified \u2713 done" })}\n`,
      "utf8",
    );
    const split = 10;
    fake.pushRaw(frame.subarray(0, split));
    await drain();
    fake.pushRaw(frame.subarray(split));
    await drain();

    const events = session.observe().events.filter((envelope) => envelope.event.type === "message");
    strictEqual(events.length, 1);
    strictEqual(events[0].event.text, "clarified \u2713 done");
    await session.dispose();
  });
});

test("dispose rejects the unsettled live turn through the same end path as EOF", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("Will dispose settle me?");
    const rejected = Promise.all([
      rejects(turn.accepted, (error) => error.code === "runtime_ended_unsettled"),
      rejects(turn.settled, (error) => error.code === "runtime_ended_unsettled"),
    ]);
    await session.dispose();
    await rejected;
    strictEqual(session.state(), "ended");
  });
});

test("a second prompt before settlement is a typed rejection, not a silent queue", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    session.sendPrompt("the live turn");
    throws(
      () => session.sendPrompt("a queued follow-up is ticket 07's concern"),
      (error) => error.code === "turn_in_flight",
    );
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    const next = session.sendPrompt("now the floor is free");
    strictEqual(next.requestId.startsWith("req_"), true);
    const floorRejection = Promise.all([
      rejects(next.accepted, (error) => error.code === "runtime_ended_unsettled"),
      rejects(next.settled, (error) => error.code === "runtime_ended_unsettled"),
    ]);
    await session.dispose();
    await floorRejection;
  });
});

test("acceptance and settlement are distinct; assistant text settles nothing", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const turn = session.sendPrompt("What does this issue mean?");
    const settledRace = Promise.race([
      turn.settled.then(() => "settled"),
      drain().then(() => "pending"),
    ]);

    // The request travels as a typed frame; the runtime acks it.
    deepStrictEqual(JSON.parse(fake.stdinFrames[0]), {
      type: "prompt",
      id: turn.requestId,
      text: "What does this issue mean?",
    });
    fake.push(JSON.stringify({ type: "accepted", id: turn.requestId }));
    fake.push(JSON.stringify({ type: "message", text: "partial answer" }));
    await drain();
    strictEqual(await turn.accepted.then(() => "accepted"), "accepted");
    strictEqual(await settledRace, "pending", "assistant text is not settlement");

    // Only the runtime's settle signal settles the turn.
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await turn.settled, { requestId: turn.requestId });
    await session.dispose();
  });
});

test("a runtime that ends before settling never reports a settled turn", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("Will you settle?");
    const endedUnsettled = Promise.all([
      rejects(turn.accepted, (error) => error.code === "runtime_ended_unsettled"),
      rejects(turn.settled, (error) => error.code === "runtime_ended_unsettled"),
    ]);

    fake.end();
    await endedUnsettled;
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
    await drain();

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
    await drain();

    const observed = session.observe();
    strictEqual(observed.latestCursor, 6);
    deepStrictEqual(
      observed.events.map((envelope) => envelope.event.text),
      ["three", "four", "five"],
    );

    const afterGap = session.reconnect({ afterCursor: 0 });
    ok(afterGap.gap, "an expired cursor is an explicit gap");
    strictEqual(afterGap.gap.after, 0);
    strictEqual(afterGap.gap.firstRetainedCursor, 4);
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
    await drain();

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
    deepStrictEqual(entries[1], {
      type: "malformed",
      raw: "not json either",
      origin: "adapter",
    });
    ok(
      fake.stdinFrames.every((frame) => !frame.includes("from the transcript")),
      "the adapter never writes the transcript",
    );
    await session.dispose();
  });
});

// --- Ticket 07: the control surface and the failure mapping. ---

const frames = (fake) => fake.stdinFrames.map((frame) => JSON.parse(frame));
const lastFrame = (fake) => frames(fake)[fake.stdinFrames.length - 1];

test("the child environment is exactly the sanitized env passed; nothing is inherited and retries are pinned off", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const sanitized = testEnv;

    // Fail closed: no environment, no runtime. The host environment is
    // never inherited by default — that is where credentials live.
    const refused = fakeRuntime();
    throws(
      () => startManagedSession({ spawn: refused.spawn, command: "pi", sessionRoot }),
      (error) => error.code === "invalid_adapter",
    );
    throws(
      () =>
        startManagedSession({
          spawn: refused.spawn,
          command: "pi",
          sessionRoot,
          env: "PATH=/usr/bin",
        }),
      (error) => error.code === "invalid_adapter",
    );
    strictEqual(refused.calls.length, 0, "no child is spawned without a sanitized environment");

    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const call = fake.calls[0];
    deepStrictEqual(call.env, sanitized, "the child gets exactly the env the caller passed");
    ok(
      call.args.includes("--no-retry"),
      "pi automatic retries are pinned off — provider activity cannot escape accounting",
    );
    await session.dispose();
  });
});

test("steer rides the live turn explicitly; idle steering is a typed rejection", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    throws(
      () => session.steer("no one is running"),
      (error) => error.code === "turn_not_in_flight",
    );
    strictEqual(fake.stdinFrames.length, 0, "an idle steer writes nothing");

    const turn = session.sendPrompt("the live turn");
    const steer = session.steer("focus on the acceptance criteria");
    ok(steer.requestId.startsWith("req_"));
    deepStrictEqual(lastFrame(fake), {
      type: "steer",
      id: steer.requestId,
      text: "focus on the acceptance criteria",
    });

    fake.push(JSON.stringify({ type: "accepted", id: steer.requestId }));
    await drain();
    strictEqual(await steer.accepted.then(() => "accepted"), "accepted");
    // Steering is not interruption: the live turn is still the live turn.
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await turn.settled, { requestId: turn.requestId });
    await session.dispose();
  });
});

test("follow-ups queue explicitly behind the live turn and deliver in order as fresh turns", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    throws(
      () => session.queueFollowUp("nothing is running"),
      (error) => error.code === "turn_not_in_flight",
    );

    const live = session.sendPrompt("the live turn");
    const first = session.queueFollowUp("first follow-up");
    const second = session.queueFollowUp("second follow-up");

    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await live.settled, { requestId: live.requestId });
    // The first follow-up is delivered as its own prompt — acceptance and
    // delivery remain separate, and it settles on its own settle signal.
    deepStrictEqual(lastFrame(fake), {
      type: "prompt",
      id: first.requestId,
      text: "first follow-up",
    });
    fake.push(JSON.stringify({ type: "accepted", id: first.requestId }));
    await drain();
    strictEqual(await first.accepted.then(() => "accepted"), "accepted");

    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await first.settled, { requestId: first.requestId });
    deepStrictEqual(lastFrame(fake), {
      type: "prompt",
      id: second.requestId,
      text: "second follow-up",
    });

    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await second.settled, { requestId: second.requestId });
    const prompts = frames(fake).filter((frame) => frame.type === "prompt");
    deepStrictEqual(
      prompts.map((frame) => frame.text),
      ["the live turn", "first follow-up", "second follow-up"],
      "delivery is FIFO and nothing jumps the queue",
    );
    await session.dispose();
  });
});

test("clear-queue drops queued work explicitly and tells the runtime", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const live = session.sendPrompt("the live turn");
    const first = session.queueFollowUp("doomed follow-up");
    const second = session.queueFollowUp("also doomed");
    // The handlers attach before the clear: a rejection is never handled
    // late, and a cleared follow-up rejects both of its promises.
    const clearedRejections = Promise.all([
      rejects(first.accepted, (error) => error.code === "cancelled"),
      rejects(first.settled, (error) => error.code === "cancelled"),
      rejects(second.accepted, (error) => error.code === "cancelled"),
      rejects(second.settled, (error) => error.code === "cancelled"),
    ]);

    const { cleared } = session.clearQueue();
    deepStrictEqual(
      cleared.map((entry) => entry.requestId),
      [first.requestId, second.requestId],
    );
    deepStrictEqual(lastFrame(fake).type, "clear_queue", "the runtime's own queue is cleared too");
    await clearedRejections;

    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await live.settled, { requestId: live.requestId });
    const prompts = frames(fake).filter((frame) => frame.type === "prompt");
    strictEqual(prompts.length, 1, "cleared work never delivers");
    await session.dispose();
  });
});

test("stop-turn clears the queue first, then aborts; the settle after abort is a cancelled outcome", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    throws(
      () => session.stopTurn(),
      (error) => error.code === "turn_not_in_flight",
    );

    const live = session.sendPrompt("the live turn");
    const liveCancelled = rejects(live.settled, (error) => error.code === "cancelled");
    const doomed = session.queueFollowUp("never delivers");
    const doomedRejected = Promise.all([
      rejects(doomed.accepted, (error) => error.code === "cancelled"),
      rejects(doomed.settled, (error) => error.code === "cancelled"),
    ]);
    const stopped = session.stopTurn();

    deepStrictEqual(
      stopped.cleared.map((entry) => entry.requestId),
      [doomed.requestId],
      "stop-turn clears the queue first",
    );
    const tail = frames(fake).slice(-2);
    deepStrictEqual(
      tail.map((frame) => frame.type),
      ["clear_queue", "abort"],
      "the abort follows the queue clear, in that order, on the wire",
    );
    await doomedRejected;

    // The floor stays occupied until the runtime is observed to settle.
    throws(
      () => session.sendPrompt("too soon"),
      (error) => error.code === "turn_in_flight",
    );
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    await liveCancelled;

    const next = session.sendPrompt("the floor is free after the observed settle");
    fake.push(JSON.stringify({ type: "accepted", id: next.requestId }));
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await next.settled, { requestId: next.requestId });
    await session.dispose();
  });
});

test("a runtime end after an explicit stop is cancelled, not unknown", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const live = session.sendPrompt("stopped then the runtime dies");
    const cancelled = Promise.all([
      rejects(live.accepted, (error) => error.code === "cancelled"),
      rejects(live.settled, (error) => error.code === "cancelled"),
    ]);
    session.stopTurn();
    fake.end();
    await cancelled;
    await session.dispose();
  });
});

test("extension dialogs arrive as typed questions, answered or cancelled through the sub-protocol", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    fake.push(
      JSON.stringify({
        type: "select",
        id: "d1",
        title: "Pick a source",
        options: ["docs", "issue"],
      }),
    );
    await drain();
    deepStrictEqual(session.pendingDialogs(), [
      {
        dialogId: "d1",
        kind: "select",
        request: { type: "select", id: "d1", title: "Pick a source", options: ["docs", "issue"] },
      },
    ]);
    strictEqual(session.state(), "waiting-for-input");

    session.answerDialog({ dialogId: "d1", value: "docs" });
    deepStrictEqual(lastFrame(fake), { type: "dialog_response", id: "d1", value: "docs" });
    deepStrictEqual(session.pendingDialogs(), []);
    strictEqual(session.state(), "ready");

    fake.push(JSON.stringify({ type: "confirm", id: "d2", title: "Proceed?" }));
    await drain();
    session.cancelDialog({ dialogId: "d2" });
    deepStrictEqual(lastFrame(fake), { type: "dialog_response", id: "d2", cancelled: true });
    deepStrictEqual(session.pendingDialogs(), []);

    throws(
      () => session.answerDialog({ dialogId: "missing", value: "x" }),
      (error) => error.code === "dialog_not_found",
    );
    throws(
      () => session.answerDialog({ dialogId: "d2" }),
      (error) => error.code === "invalid_request",
    );
    await session.dispose();
  });
});

test("unsupported widgets surface as a capability list and are preserved verbatim as evidence", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const widget = { type: "extension_widget", widget: "custom-tui", payload: { custom: true } };
    fake.push(JSON.stringify(widget));
    fake.push(
      JSON.stringify({ type: "extension_widget", widget: "custom-tui", payload: { v2: true } }),
    );
    fake.push(JSON.stringify({ type: "extension_widget", widget: "tree-view" }));
    await drain();

    deepStrictEqual(
      session.unsupportedCapabilities().map((entry) => [entry.capability, entry.count]),
      [
        ["custom-tui", 2],
        ["tree-view", 1],
      ],
    );
    strictEqual(
      session.unsupportedCapabilities()[0].frame.payload.custom,
      true,
      "the first frame verbatim",
    );

    const seen = session
      .observe()
      .events.filter((envelope) => envelope.event.type === "extension_widget");
    strictEqual(seen.length, 3, "nothing is dropped silently from the stream either");
    await session.dispose();
  });
});

test("auth and quota failures park the session awaiting-human with the budget preserved and no fallback", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const quota = session.sendPrompt("will hit the quota");
    // Outcome handlers attach at birth: a rejection is never handled late,
    // and a pre-acceptance failure rejects both of the turn's promises.
    const quotaOutcome = Promise.all([
      quota.accepted.then(
        () => "accepted",
        (error) => error,
      ),
      quota.settled.then(
        () => "settled",
        (error) => error,
      ),
    ]);
    const usage = { tokens: 42, source: "provider-reported" };
    fake.push(JSON.stringify({ type: "error", kind: "quota", usage, detail: "rate limited" }));
    await drain();
    const [quotaAccepted, quotaSettled] = await quotaOutcome;
    strictEqual(quotaAccepted.code, "quota");
    strictEqual(quotaSettled.code, "quota");
    deepStrictEqual(quotaSettled.failure, {
      status: "awaiting-human",
      reason: "quota",
      usage,
      evidence: { type: "error", kind: "quota", usage, detail: "rate limited" },
    });
    strictEqual(session.state(), "awaiting-human");
    const promptsAfterQuota = frames(fake).filter((frame) => frame.type === "prompt").length;
    strictEqual(promptsAfterQuota, 1, "no silent retry, no provider fallback");

    const auth = session.sendPrompt("human decided to continue; now auth fails");
    const authOutcome = auth.settled.then(
      () => "settled",
      (error) => error,
    );
    fake.push(JSON.stringify({ type: "accepted", id: auth.requestId }));
    fake.push(JSON.stringify({ type: "error", kind: "auth_required" }));
    await drain();
    const authFailure = await authOutcome;
    strictEqual(authFailure.code, "auth_required");
    strictEqual(authFailure.failure.status, "awaiting-human");
    strictEqual(authFailure.failure.usage, null, "no usage is invented when none is reported");

    const generic = session.sendPrompt("and an unclassified provider error");
    const genericOutcome = generic.settled.then(
      () => "settled",
      (error) => error,
    );
    fake.push(JSON.stringify({ type: "accepted", id: generic.requestId }));
    fake.push(JSON.stringify({ type: "error", detail: "weird" }));
    await drain();
    const genericFailure = await genericOutcome;
    strictEqual(genericFailure.code, "provider_failure");
    await session.dispose();
  });
});

test("process death is the evidence unknown-outcome reconciliation needs; nothing restarts or replays", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("will the runtime survive?");
    const unsettled = Promise.all([
      rejects(turn.accepted, (error) => error.code === "runtime_ended_unsettled"),
      rejects(turn.settled, (error) => error.code === "runtime_ended_unsettled"),
    ]);

    const framesBefore = fake.stdinFrames.length;
    const spawnCallsBefore = fake.calls.length;
    fake.end(1);
    await unsettled;
    deepStrictEqual(session.exit(), { code: 1, signal: null });
    deepStrictEqual(session.exit(), { code: 1, signal: null });
    strictEqual(session.state(), "ended");
    strictEqual(fake.calls.length, spawnCallsBefore, "no automatic restart");
    strictEqual(fake.stdinFrames.length, framesBefore, "no automatic prompt replay");
  });
});

test("terminate-runtime is a confirmed operation", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const lockPath = `${session.sessionFile}.writer`;

    await rejects(
      session.terminateRuntime({ confirmation: "the wrong value" }),
      (error) => error.code === "termination_unconfirmed",
    );
    await rejects(session.terminateRuntime(), (error) => error.code === "termination_unconfirmed");
    strictEqual(fake.killed.length, 0, "an unconfirmed termination kills nothing");
    ok(existsSync(lockPath));

    await session.terminateRuntime({ confirmation: session.sessionId });
    strictEqual(fake.killed.length, 1);
    ok(!existsSync(lockPath), "the writer claim is released with the runtime");
    strictEqual(session.state(), "ended");
    await rejects(
      session.terminateRuntime({ confirmation: session.sessionId }),
      (error) => error.code === "runtime_ended",
    );
    await fake.end();
  });
});

test("agent_end, compaction, and retry observations are evidence, never settlement", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("long-running turn");

    fake.push(JSON.stringify({ type: "agent_end" }));
    fake.push(JSON.stringify({ type: "compaction", detail: "context compacted" }));
    fake.push(JSON.stringify({ type: "provider_retry", attempt: 2 }));
    await drain();
    const stillRunning = await Promise.race([
      turn.settled.then(() => "settled"),
      drain().then(() => "pending"),
    ]);
    strictEqual(stillRunning, "pending", "low-level boundaries settle nothing");

    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    deepStrictEqual(await turn.settled, { requestId: turn.requestId });
    await session.dispose();
  });
});

test("a pending dialog is bounded: the timeout cancels it typed, never answers it", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const timers = manualTimers();
    const fake = fakeRuntime();
    const session = await start(fake, {
      sessionRoot,
      dialogTimeoutMs: 5000,
      scheduleTimeout: timers.schedule,
      cancelTimeout: timers.cancel,
    });

    fake.push(JSON.stringify({ type: "input", id: "d1", title: "Clarify scope" }));
    await drain();
    strictEqual(session.pendingDialogs().length, 1);
    strictEqual(timers.size(), 1, "the dialog is armed with its bounded timeout");

    // An answer disarms the timeout.
    session.answerDialog({ dialogId: "d1", value: "behavior + acceptance criteria" });
    strictEqual(timers.size(), 0, "an answered dialog is no longer timed");
    deepStrictEqual(session.pendingDialogs(), []);

    fake.push(JSON.stringify({ type: "editor", id: "d2", title: "Edit the brief" }));
    await drain();
    strictEqual(timers.size(), 1);
    timers.fire(5000);
    await drain();
    deepStrictEqual(session.pendingDialogs(), [], "the timed-out dialog is no longer pending");
    deepStrictEqual(lastFrame(fake), { type: "dialog_response", id: "d2", cancelled: true });
    const timeoutEvidence = session
      .observe()
      .events.find((envelope) => envelope.event.type === "dialog_timeout");
    ok(timeoutEvidence, "the timeout itself is typed evidence");
    deepStrictEqual(timeoutEvidence.event.dialogId, "d2");
    strictEqual(session.state(), "ready");
    await session.dispose();
  });
});

test("a provider failure before acceptance rejects the acceptance and holds the queue", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });

    const turn = session.sendPrompt("never accepted");
    const followUp = session.queueFollowUp("parked with it");
    const outcomes = Promise.all([
      turn.accepted.then(
        () => "accepted",
        (error) => error,
      ),
      turn.settled.then(
        () => "settled",
        (error) => error,
      ),
      rejects(followUp.accepted, (error) => error.code === "cancelled"),
      rejects(followUp.settled, (error) => error.code === "cancelled"),
    ]);
    const promptsBefore = frames(fake).filter((frame) => frame.type === "prompt").length;

    fake.push(JSON.stringify({ type: "error", kind: "quota" }));
    await drain();
    const [accepted, settled] = await outcomes;
    strictEqual(accepted.code, "quota", "the acceptance carries the typed failure");
    strictEqual(settled.code, "quota");
    strictEqual(session.state(), "awaiting-human");

    // The park holds: even a settle delivers nothing new.
    fake.push(JSON.stringify({ type: "agent_settled" }));
    await drain();
    const promptsAfter = frames(fake).filter((frame) => frame.type === "prompt");
    strictEqual(
      promptsAfter.length,
      promptsBefore,
      "queued work never delivers without an explicit human decision",
    );
    await session.dispose();
  });
});

test("a turn's acceptance rejects when the runtime dies before acknowledging", async () => {
  await withSessionRoot(async ({ sessionRoot }) => {
    const fake = fakeRuntime();
    const session = await start(fake, { sessionRoot });
    const turn = session.sendPrompt("never acked");
    const accepted = turn.accepted.then(
      () => "accepted",
      (error) => error,
    );
    const settledRejected = rejects(
      turn.settled,
      (error) => error.code === "runtime_ended_unsettled",
    );
    fake.end();
    const failure = await accepted;
    strictEqual(failure.code, "runtime_ended_unsettled");
    strictEqual(failure.outcome, "unknown");
    deepStrictEqual(failure.exit, { code: 0, signal: null });
    await settledRejected;
    await session.dispose();
  });
});
