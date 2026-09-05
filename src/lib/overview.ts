import type {
  OverviewData,
  PlanRecord,
  SpecChangeRecord,
  TicketRecord,
  TicketStatus,
  OverviewView,
} from "../types";

export const statusLabels = {
  complete: "complete",
  "in-progress": "in-progress",
  ready: "ready-for-agent",
  "needs-development": "needs-development",
  gated: "ready-for-human",
  blocked: "blocked",
  planned: "needs-triage",
  deferred: "deferred",
} satisfies Record<TicketStatus, string>;

export const overviewViewLabels = {
  all: "All work",
  grilling: "Ready for grilling",
  spec: "Ready for spec",
  tickets: "Ready for tickets",
  implementation: "Ready for implementation",
} satisfies Record<OverviewView, string>;

export const recordsForView = (data: OverviewData, view: OverviewView) => {
  switch (view) {
    case "grilling":
      return {
        tickets: data.tickets.filter(
          (ticket) => ticket.kind === "external" && ticket.status === "planned",
        ),
        plans: [],
        changes: [],
      };
    case "spec":
      return { tickets: [], plans: data.plans, changes: [] };
    case "tickets":
      return {
        tickets: [],
        plans: [],
        changes: data.changes.filter((change) => change.status !== "complete"),
      };
    case "implementation":
      return {
        tickets: data.tickets.filter((ticket) => ticket.status === "ready"),
        plans: [],
        changes: [],
      };
    case "all":
      return { tickets: data.tickets, plans: data.plans, changes: data.changes };
  }
};

export const viewCounts = (data: OverviewData) => {
  const all = recordsForView(data, "all");
  const grilling = recordsForView(data, "grilling");
  const spec = recordsForView(data, "spec");
  const tickets = recordsForView(data, "tickets");
  const implementation = recordsForView(data, "implementation");

  return {
    all: all.tickets.length + all.plans.length + all.changes.length,
    grilling: grilling.tickets.length,
    spec: spec.plans.length,
    tickets: tickets.changes.length,
    implementation: implementation.tickets.length,
  };
};

export const statusTone = (status: TicketStatus) =>
  status === "complete"
    ? "good"
    : status === "ready"
      ? "ready"
      : status === "gated" || status === "needs-development"
        ? "warn"
        : status === "blocked"
          ? "hot"
          : status === "in-progress"
            ? "info"
            : "muted";

export const ticketCounts = (tickets: readonly TicketRecord[]) =>
  tickets.reduce(
    (counts, ticket) => {
      counts[ticket.status] += 1;
      return counts;
    },
    {
      complete: 0,
      "in-progress": 0,
      ready: 0,
      "needs-development": 0,
      gated: 0,
      blocked: 0,
      planned: 0,
      deferred: 0,
    },
  );

const searchable = (value: string) => value.toLocaleLowerCase();

export const filterTickets = (
  tickets: readonly TicketRecord[],
  query: string,
  status: TicketStatus | "all",
  stream: string,
) => {
  const needle = query.trim().toLocaleLowerCase();
  return tickets.filter((ticket) => {
    const matchesStatus = status === "all" || ticket.status === status;
    const matchesStream = stream === "all" || ticket.group === stream;
    const matchesQuery =
      needle.length === 0 ||
      [
        ticket.id,
        ticket.title,
        ticket.statusLabel,
        ticket.group,
        ticket.lane,
        ticket.summary,
        ticket.sourcePath,
        ticket.externalSource || "",
      ]
        .map(searchable)
        .some((value) => value.includes(needle));
    return matchesStatus && matchesStream && matchesQuery;
  });
};

export const filterPlans = (
  plans: readonly PlanRecord[],
  query: string,
  status: TicketStatus | "all",
  stream: string,
) => {
  const needle = query.trim().toLocaleLowerCase();
  return plans.filter((plan) => {
    const matchesStatus = status === "all" || plan.status === status;
    const matchesStream = stream === "all" || plan.stream === stream;
    const matchesQuery =
      needle.length === 0 ||
      [plan.id, plan.title, plan.statusLabel, plan.stream, plan.summary, plan.sourcePath]
        .map(searchable)
        .some((value) => value.includes(needle));
    return matchesStatus && matchesStream && matchesQuery;
  });
};

export const filterChanges = (
  changes: readonly SpecChangeRecord[],
  query: string,
  status: TicketStatus | "all",
) => {
  const needle = query.trim().toLocaleLowerCase();
  return changes.filter((change) => {
    const matchesStatus = status === "all" || change.status === status;
    const matchesQuery =
      needle.length === 0 ||
      [change.id, change.title, change.summary, change.sourcePath]
        .map(searchable)
        .some((value) => value.includes(needle));
    return matchesStatus && matchesQuery;
  });
};

export const uniqueGroups = (tickets: readonly TicketRecord[]) =>
  [...new Set(tickets.map((ticket) => ticket.group))].sort((a, b) => a.localeCompare(b));

export const summaryFor = (data: OverviewData) => {
  const counts = ticketCounts(data.tickets);
  return {
    ...counts,
    open: data.tickets.length - counts.complete - counts.deferred,
    attention: counts["needs-development"] + counts.gated + counts.blocked,
  };
};
