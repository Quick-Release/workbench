import { describe, expect, it } from "vite-plus/test";

import { redactTranscript } from "./redact";

// Render-time redaction (ticket #35): local paths and credential-bearing
// URLs become stable tokens with a ledger; the ledger itself carries no
// original values, so the redacted transcript plus its ledger can be read
// or shared without leaking machine details.

describe("redactTranscript", () => {
  it("rewrites local paths into stable tokens", () => {
    const { messages, ledger } = redactTranscript([
      { role: "user", content: "read /Users/ada/workbench/src/app.ts and /var/log/agent.log" },
    ]);
    expect(messages[0].content).toBe("read [REDACTED-PATH-1] and [REDACTED-PATH-2]");
    expect(ledger).toEqual([
      { token: "[REDACTED-PATH-1]", kind: "path", count: 1 },
      { token: "[REDACTED-PATH-2]", kind: "path", count: 1 },
    ]);
  });

  it("uses the same token for the same path and counts repeats", () => {
    const { messages, ledger } = redactTranscript([
      { role: "user", content: "open /home/ada/notes.txt" },
      { role: "assistant", content: "read /home/ada/notes.txt twice? /home/ada/notes.txt" },
    ]);
    expect(messages[0].content).toContain("[REDACTED-PATH-1]");
    expect(messages[1].content).toContain("[REDACTED-PATH-1]");
    expect(ledger).toEqual([{ token: "[REDACTED-PATH-1]", kind: "path", count: 3 }]);
  });

  it("rewrites credential-bearing URLs into their own tokens", () => {
    const { messages, ledger } = redactTranscript([
      { role: "user", content: "clone https://token123@github.com/acme/widgets.git" },
    ]);
    expect(messages[0].content).toBe("clone [REDACTED-CREDENTIAL-URL-1]");
    expect(ledger).toEqual([
      { token: "[REDACTED-CREDENTIAL-URL-1]", kind: "credential-url", count: 1 },
    ]);
  });

  it("redacts text blocks and leaves other content untouched", () => {
    const { messages, ledger } = redactTranscript([
      {
        role: "assistant",
        content: [
          { type: "text", text: "edited /opt/app/index.ts" },
          { type: "tool_use", id: "tool_1", name: "edit", input: { path: "/opt/app/index.ts" } },
        ],
      },
    ]);
    const content = messages[0].content as Array<{ type: string; text?: string; input?: unknown }>;
    expect(content[0].text).toBe("edited [REDACTED-PATH-1]");
    expect(content[1]).toEqual({
      type: "tool_use",
      id: "tool_1",
      name: "edit",
      input: { path: "/opt/app/index.ts" },
    });
    expect(ledger).toHaveLength(1);
  });

  it("does not redact URL path segments that merely look like directories", () => {
    const { messages, ledger } = redactTranscript([
      {
        role: "user",
        content: "see https://example.com/data/sheets and https://github.com/etc/repo",
      },
    ]);
    expect(messages[0].content).toContain("https://example.com/data/sheets");
    expect(messages[0].content).toContain("https://github.com/etc/repo");
    expect(ledger).toEqual([]);
  });

  it("passes clean text through with an empty ledger", () => {
    const { messages, ledger } = redactTranscript([{ role: "user", content: "hello world" }]);
    expect(messages[0].content).toBe("hello world");
    expect(ledger).toEqual([]);
  });

  it("never leaks the original values through the ledger", () => {
    const secret = "https://token123@github.com/acme/widgets.git";
    const { ledger } = redactTranscript([{ role: "user", content: `clone ${secret}` }]);
    expect(JSON.stringify(ledger)).not.toContain(secret);
    expect(JSON.stringify(ledger)).not.toContain("token123");
  });
});
