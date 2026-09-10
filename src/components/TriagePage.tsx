import { useState } from "react";
import { Eye, Inbox, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import type { DisplayCaveat } from "@/lib/display-state";
import { deriveDisplayState } from "@/lib/display-state";
import { indexWorkItems, openBlockers } from "@/lib/frontier";
import { staticMoveCommand, targetStatesFor, triageLanes } from "@/lib/triage";
import type { BlockerEdgeRecord, TriageState, TrackerMapRecord, WorkItemRecord } from "@/types";

export type TriageLens = "none" | "wontfix";

type TriageMode = "live" | "static";

type TriageRowProps = {
  record: WorkItemRecord;
  caveats?: readonly DisplayCaveat[];
  mode: TriageMode;
  lens: boolean;
  confirming: boolean;
  pending: boolean;
  onMove: (target: TriageState) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onOpenIssue: () => void;
};

// One triage row: the work item beside its move affordance — a native select
// that fires inline in live mode, the copyable gh command when the seam is
// unreachable, and the two-step refusal when wontfix is on the table.
export function TriageRow({
  record,
  caveats = [],
  mode,
  lens,
  confirming,
  pending,
  onMove,
  onConfirm,
  onCancel,
  onOpenIssue,
}: TriageRowProps) {
  const command = staticMoveCommand(record);
  return (
    <li
      data-slot="triage-row"
      data-pending={pending || undefined}
      className="flex flex-col gap-3 border-b py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <button
            type="button"
            data-slot="issue-link"
            onClick={onOpenIssue}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {record.id}
          </button>
          <span className="truncate">{record.title}</span>
          {record.phase && <Badge variant="outline">{record.phase}</Badge>}
          {record.triageState !== "unlabeled" && (
            <Badge variant="outline">{record.triageState}</Badge>
          )}
          {record.deferred && <Badge variant="outline">deferred</Badge>}
        </p>
        {record.summary && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{record.summary}</p>
        )}
        {caveats.map((caveat) => (
          <p key={caveat.kind} className="mt-1 text-xs text-muted-foreground italic">
            {caveat.message}
          </p>
        ))}
      </div>
      <div className="shrink-0">
        {mode === "static" ? (
          command ? (
            <code className="rounded bg-muted px-2 py-1 text-xs">{command}</code>
          ) : (
            <p className="max-w-48 text-xs text-muted-foreground">
              Refusal is terminal — reopen it on GitHub if this was an accident.
            </p>
          )
        ) : confirming ? (
          <div className="flex items-center gap-2 text-xs">
            <span>Refuse {record.id}?</span>
            <Button
              size="xs"
              variant="destructive"
              disabled={pending}
              onClick={() => onMove("wontfix")}
            >
              Confirm refuse
            </Button>
            <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
              Keep evaluating
            </Button>
          </div>
        ) : pending ? (
          <p className="text-xs text-muted-foreground">Moving…</p>
        ) : (
          <NativeSelect
            aria-label={`Move ${record.id}`}
            className="w-44 text-xs"
            value=""
            onChange={(event) => {
              const target = event.target.value as TriageState;
              if (!target) return;
              if (target === "wontfix") onConfirm();
              else onMove(target);
            }}
          >
            <option value="">Move to…</option>
            {targetStatesFor(record.triageState, lens).map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
    </li>
  );
}

type TriagePageProps = {
  workItems: readonly WorkItemRecord[];
  maps: readonly TrackerMapRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  mode: TriageMode;
  lens: TriageLens;
  onLensChange: (lens: TriageLens) => void;
  onMove: (issueId: string, triageState: TriageState) => void;
  onOpenIssue: (issueId: string) => void;
  onNewIssue: () => void;
  pendingId: string | null;
  message: string | null;
};

const WAITING_GROUPS = [
  { key: "reporter", label: "Reporter's move" },
  { key: "human", label: "Human's move" },
  { key: "parked", label: "Parked" },
] as const;

// The triage skill's surface (spec #54, views and IA): an Intake lane of
// fresh work — map children excluded — and a Waiting lane grouped by whose
// move it is. Quick triage-state moves fire inline through the execution
// seam and degrade to copy-the-command when it is unreachable.
export function TriagePage({
  workItems,
  maps,
  blockerEdges,
  mode,
  lens,
  onLensChange,
  onMove,
  onOpenIssue,
  onNewIssue,
  pendingId,
  message,
}: TriagePageProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const lanes = triageLanes(workItems, maps);
  const frontierItems = indexWorkItems(workItems);

  const rowProps = (record: WorkItemRecord) => {
    const blocked = openBlockers(record.id, blockerEdges, frontierItems).open.length > 0;
    const { caveats } = deriveDisplayState(record, blocked);
    return {
      record,
      caveats,
      mode,
      lens: lens === "wontfix",
      confirming: confirmingId === record.id,
      pending: pendingId === record.id,
      onMove: (target: TriageState) => {
        setConfirmingId(null);
        onMove(record.id, target);
      },
      onConfirm: () => setConfirmingId(record.id),
      onCancel: () => setConfirmingId(null),
      onOpenIssue: () => onOpenIssue(record.id),
    };
  };

  const rows = (group: readonly WorkItemRecord[]) => (
    <ul>
      {group.map((record) => (
        <TriageRow key={record.id} {...rowProps(record)} />
      ))}
    </ul>
  );

  const waitingCount =
    lanes.waiting.reporter.length + lanes.waiting.human.length + lanes.waiting.parked.length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Triage</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onNewIssue}>
            <Plus />
            New issue
          </Button>
          <Button
            size="sm"
            variant={lens === "wontfix" ? "secondary" : "outline"}
            aria-pressed={lens === "wontfix"}
            onClick={() => onLensChange(lens === "wontfix" ? "none" : "wontfix")}
          >
            <Eye />
            Refused
          </Button>
        </div>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Fresh work in, parked work out — the triage skill's surface. Inline moves write the tracker
        label directly; GitHub's history is the audit log.
      </p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Intake</CardTitle>
            <CardDescription>
              <strong>{lanes.intake.length}</strong> awaiting evaluation
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lanes.intake.length > 0 ? (
              rows(lanes.intake)
            ) : (
              <p className="text-sm text-muted-foreground">No work waiting for evaluation.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Waiting</CardTitle>
            <CardDescription>
              <strong>{waitingCount}</strong> waiting on someone
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {WAITING_GROUPS.map(({ key, label }) =>
              lanes.waiting[key].length > 0 ? (
                <section key={key}>
                  <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {label}
                  </p>
                  {rows(lanes.waiting[key])}
                </section>
              ) : null,
            )}
            {waitingCount === 0 && (
              <p className="text-sm text-muted-foreground">Nobody is waiting on a person.</p>
            )}
          </CardContent>
        </Card>
      </div>
      {lens === "wontfix" && lanes.refused.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Refused</CardTitle>
            <CardDescription>
              <strong>{lanes.refused.length}</strong> refused — visible only behind this lens
            </CardDescription>
          </CardHeader>
          <CardContent>{rows(lanes.refused)}</CardContent>
        </Card>
      )}
    </div>
  );
}
