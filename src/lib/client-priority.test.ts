import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import {
  classifyClientTicket,
  clientAttention,
  clientKindFor,
  clientTierFor,
  compareByClientTier,
  evaluateClientGate,
  openClientBugs,
} from "./client-priority";

const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/example/project/issues/${number}`,
  state: "open",
  assignees: [],
  phase: null,
  triageState: "unlabeled",
  deferred: false,
  category: null,
  kind: null,
  summary: "",
  ...overrides,
});

const clientBug = {
  id: "GH-12",
  title: "Checkout charges twice",
  url: "https://github.com/example/project/issues/12",
};

describe("classifyClientTicket", () => {
  it("classifies the exact canonical names", () => {
    expect(classifyClientTicket(["client-bug"])).toBe("client-bug");
    expect(classifyClientTicket(["client-feedback"])).toBe("client-feedback");
    expect(classifyClientTicket(["bug", "enhancement"])).toBeNull();
  });

  it("normalizes case, padding, and separators — never substrings", () => {
    expect(classifyClientTicket(["Client Bug"])).toBe("client-bug");
    expect(classifyClientTicket(["  CLIENT_FEEDBACK "])).toBe("client-feedback");
    expect(classifyClientTicket(["client-bugs"])).toBeNull();
    expect(classifyClientTicket(["verify-client-bug"])).toBeNull();
    expect(classifyClientTicket(["client bug triage"])).toBeNull();
    expect(classifyClientTicket(["clientbug"])).toBeNull();
  });

  it("treats absent labels as unknown, not internal", () => {
    expect(classifyClientTicket(undefined)).toBeNull();
    expect(classifyClientTicket([])).toBeNull();
  });

  it("counts an issue wearing both labels once, bug tier winning", () => {
    expect(classifyClientTicket(["client-feedback", "client-bug"])).toBe("client-bug");
  });
});

describe("clientKindFor", () => {
  it("upgrades feedback categorized bug to the bug tier", () => {
    expect(clientKindFor({ labels: ["client-feedback"], category: "bug" })).toBe("client-bug");
    expect(clientKindFor({ labels: ["client-feedback"], category: "enhancement" })).toBe(
      "client-feedback",
    );
    expect(clientKindFor({ labels: ["client-feedback"], category: null })).toBe("client-feedback");
  });

  it("never invents client origin from the category alone", () => {
    expect(clientKindFor({ labels: ["bug"], category: "bug" })).toBeNull();
    expect(clientKindFor({ labels: undefined, category: "bug" })).toBeNull();
  });
});

describe("tier ordering", () => {
  it("orders client bugs before client feedback before internal work", () => {
    const internal = item(1);
    const feedback = item(2, { labels: ["client-feedback"] });
    const bug = item(3, { labels: ["client-bug"] });
    expect(clientTierFor(bug)).toBe(0);
    expect(clientTierFor(feedback)).toBe(1);
    expect(clientTierFor(internal)).toBe(2);
    expect(compareByClientTier(bug, feedback)).toBeLessThan(0);
    expect(compareByClientTier(feedback, internal)).toBeLessThan(0);
    expect(compareByClientTier(internal, bug)).toBeGreaterThan(0);
  });

  it("falls back to the issue number inside a tier, deterministically", () => {
    const first = item(7, { labels: ["client-bug"] });
    const second = item(11, { labels: ["client-bug"] });
    expect(compareByClientTier(first, second)).toBeLessThan(0);
    expect(compareByClientTier(second, first)).toBeGreaterThan(0);
    expect(compareByClientTier(first, first)).toBe(0);
  });
});

describe("clientAttention", () => {
  it("lists every open client ticket regardless of triage state or deferral", () => {
    const attention = clientAttention([
      item(1),
      item(2, { labels: ["client-bug"], triageState: "needs-info" }),
      item(3, { labels: ["client-bug"], deferred: true }),
      item(4, { labels: ["client-bug"], state: "closed" }),
      item(5, { labels: ["client-feedback"], triageState: "wontfix" }),
    ]);
    expect(attention.bugs.map((record) => record.id)).toEqual(["GH-2", "GH-3"]);
    expect(attention.feedback.map((record) => record.id)).toEqual(["GH-5"]);
  });

  it("moves feedback categorized bug into the bugs list", () => {
    const attention = clientAttention([
      item(9, { labels: ["client-feedback"], category: "bug" }),
      item(8, { labels: ["client-feedback"] }),
    ]);
    expect(attention.bugs.map((record) => record.id)).toEqual(["GH-9"]);
    expect(attention.feedback.map((record) => record.id)).toEqual(["GH-8"]);
  });
});

describe("openClientBugs", () => {
  it("maps open bugs to blocking references in issue-number order", () => {
    const bugs = openClientBugs([
      item(20, { labels: ["client-bug"] }),
      item(4, { labels: ["client-bug"], state: "closed" }),
      item(15, { labels: ["client-feedback"] }),
      item(7, { labels: ["client-feedback"], category: "bug" }),
    ]);
    expect(bugs.map((bug) => bug.id)).toEqual(["GH-7", "GH-20"]);
    expect(bugs[0]).toMatchObject({ id: "GH-7", title: "Issue 7" });
  });
});

describe("evaluateClientGate", () => {
  const enhancement = item(80, { labels: ["enhancement"], category: "enhancement" });
  const unclassified = item(81, { labels: ["needs-triage"] });
  const decisionTicket = item(82, { labels: ["wayfinder:research"], kind: "research" });
  const internalBug = item(83, { labels: ["bug"], category: "bug" });
  const clientBugItem = item(12, { labels: ["client-bug"] });

  it("denies a feature start while a client bug is open, naming the blockers", () => {
    const verdict = evaluateClientGate({
      target: enhancement,
      coverageComplete: true,
      openClientBugs: [clientBug],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("client_bugs_open");
    expect(verdict.blockingBugs).toEqual([clientBug]);
    expect(verdict.explanation).toContain("GH-12");
    expect(verdict.explanation).toContain("Checkout charges twice");
  });

  it("allows feature starts once every client bug is confirmed closed", () => {
    const verdict = evaluateClientGate({
      target: enhancement,
      coverageComplete: true,
      openClientBugs: [],
    });
    expect(verdict.allowed).toBe(true);
  });

  it("never grants an all-clear from incomplete coverage", () => {
    for (const target of [enhancement, unclassified]) {
      const verdict = evaluateClientGate({
        target,
        coverageComplete: false,
        openClientBugs: [],
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("client_priority_unverified");
    }
  });

  it("fails closed on unknown, closed, and unclassifiable targets", () => {
    for (const target of [null, { ...enhancement, state: "closed" as const }, unclassified]) {
      const verdict = evaluateClientGate({
        target,
        coverageComplete: true,
        openClientBugs: [clientBug],
      });
      expect(verdict.allowed).toBe(false);
      expect(["target_not_open", "client_bugs_open"]).toContain(verdict.reason);
    }
    const missingLabels = evaluateClientGate({
      target: { state: "open", labels: undefined, category: null, kind: null },
      coverageComplete: true,
      openClientBugs: [clientBug],
    });
    expect(missingLabels.reason).toBe("client_bugs_open");
  });

  it("keeps client remediation, planning, internal fixes, and validated prerequisites available", () => {
    for (const target of [
      clientBugItem,
      item(12, { labels: ["client-feedback"], triageState: "needs-info" }),
      decisionTicket,
      internalBug,
    ]) {
      const verdict = evaluateClientGate({
        target,
        coverageComplete: true,
        openClientBugs: [clientBug],
      });
      expect(verdict.allowed).toBe(true);
    }
    const prerequisite = evaluateClientGate({
      target: enhancement,
      coverageComplete: true,
      openClientBugs: [clientBug],
      prerequisiteOfOpenClientBugs: ["GH-12"],
    });
    expect(prerequisite.allowed).toBe(true);
  });

  it("allows internal fixes and planning even when coverage is unverified", () => {
    for (const target of [decisionTicket, internalBug, clientBugItem]) {
      const verdict = evaluateClientGate({ target, coverageComplete: false });
      expect(verdict.allowed).toBe(true);
    }
  });

  it("keeps wontfix, deferred, and waiting client bugs gating", () => {
    const parked = item(12, { labels: ["client-bug"], triageState: "wontfix", deferred: true });
    const verdict = evaluateClientGate({
      target: enhancement,
      coverageComplete: true,
      openClientBugs: openClientBugs([parked]),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("client_bugs_open");
  });
});
