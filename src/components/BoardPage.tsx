import { Columns3, Eye } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhaseMoveSelect } from "@/components/PhaseMoveSelect";
import type { BoardCard, BoardColumnView } from "@/lib/board";
import type { PhaseMoveTarget } from "@/types";

// The flow board's surface (ticket #146, the read-only board; ticket #148,
// the moves): one column per pre-flow phase slot, cards placed by the board
// derivation. Every card carries the phase-move select and opens the shared
// issue detail panel through the route's `?issue` param, exactly like triage.

type BoardCardProps = {
  card: BoardCard;
  mode: "live" | "static";
  pending: boolean;
  onMovePhase: (issueId: string, phase: PhaseMoveTarget) => void;
  onOpenIssue: (issueId: string) => void;
};

function BoardCardView({ card, mode, pending, onMovePhase, onOpenIssue }: BoardCardProps) {
  const { record, column, chips, caveats, clock, warnings } = card;
  return (
    <article
      data-slot="board-card"
      data-parked={chips.parked || undefined}
      className={`flex flex-col gap-1.5 rounded-md border p-2.5 ${chips.parked ? "opacity-60" : ""}`}
    >
      <p className="flex items-baseline gap-2 text-sm leading-snug">
        <button
          type="button"
          data-slot="issue-link"
          onClick={() => onOpenIssue(record.id)}
          className="shrink-0 font-mono text-xs underline-offset-4 hover:underline"
        >
          {record.id}
        </button>
        <span className="font-medium">{record.title}</span>
      </p>
      <p className="flex flex-wrap gap-1.5">
        {record.kind !== null && record.kind !== "map" && (
          <Badge variant="outline" tone="muted" data-slot="board-kind">
            {record.kind}
          </Badge>
        )}
        {chips.grabbable && (
          <Badge variant="outline" tone="good">
            grabbable
          </Badge>
        )}
        {chips.blocked && (
          <Badge variant="outline" tone="warn">
            blocked
          </Badge>
        )}
        {chips.claimed && (
          <Badge variant="outline" tone="info">
            claimed
          </Badge>
        )}
        {chips.parked && (
          <Badge variant="outline" tone="muted">
            parked
          </Badge>
        )}
        {chips.decided && (
          <Badge variant="outline" tone="good">
            decided
          </Badge>
        )}
        {chips.ruledOut && (
          <Badge variant="outline" tone="hot">
            ruled out
          </Badge>
        )}
      </p>
      {caveats.map((caveat) => (
        <p key={caveat.kind} className="text-xs text-muted-foreground italic">
          {caveat.message}
        </p>
      ))}
      {clock && (
        <p data-slot="board-clock" className="font-mono text-xs text-muted-foreground">
          {clock.text}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} data-slot="board-card-warning" className="text-xs text-amber">
          {warning}
        </p>
      ))}
      <PhaseMoveSelect
        record={record}
        current={column}
        mode={mode}
        pending={pending}
        onMove={(phase) => onMovePhase(record.id, phase)}
      />
    </article>
  );
}

type BoardColumnProps = {
  column: BoardColumnView;
  mode: "live" | "static";
  pendingId: string | null;
  onMovePhase: (issueId: string, phase: PhaseMoveTarget) => void;
  onOpenIssue: (issueId: string) => void;
};

function BoardColumnView({ column, mode, pendingId, onMovePhase, onOpenIssue }: BoardColumnProps) {
  return (
    <section
      data-slot="board-column"
      data-column={column.key}
      className="flex w-64 shrink-0 flex-col gap-2"
    >
      <header className="flex items-baseline justify-between border-b pb-1.5">
        <h2 className="text-xs font-semibold tracking-wide uppercase">{column.key}</h2>
        <span className="font-mono text-xs text-muted-foreground">{column.cards.length}</span>
      </header>
      {column.cards.length > 0 ? (
        column.cards.map((card) => (
          <BoardCardView
            key={card.record.id}
            card={card}
            mode={mode}
            pending={pendingId === card.record.id}
            onMovePhase={onMovePhase}
            onOpenIssue={onOpenIssue}
          />
        ))
      ) : (
        <p data-slot="board-empty" className="text-xs text-muted-foreground">
          No work here.
        </p>
      )}
    </section>
  );
}

export type BoardPageProps = {
  columns: readonly BoardColumnView[];
  deferredLens: boolean;
  mode: "live" | "static";
  pendingId: string | null;
  message: string | null;
  onLensChange: (deferred: boolean) => void;
  onOpenIssue: (issueId: string) => void;
  onMovePhase: (issueId: string, phase: PhaseMoveTarget) => void;
};

export function BoardPage({
  columns,
  deferredLens,
  mode,
  pendingId,
  message,
  onLensChange,
  onOpenIssue,
  onMovePhase,
}: BoardPageProps) {
  const cardCount = columns.reduce((count, column) => count + column.cards.length, 0);
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Columns3 className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Board</h1>
        </div>
        <Button
          size="sm"
          variant={deferredLens ? "secondary" : "outline"}
          aria-pressed={deferredLens}
          onClick={() => onLensChange(!deferredLens)}
        >
          <Eye />
          Deferred
        </Button>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Where work sits on the skill flow: every item places by its resolved phase, decision tickets
        by the parsed placement table. A move fires directly and wears exactly the target phase —
        GitHub history is the audit log.
      </p>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {cardCount === 0 && <p className="text-sm text-muted-foreground">Nothing on the board.</p>}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => (
          <BoardColumnView
            key={column.key}
            column={column}
            mode={mode}
            pendingId={pendingId}
            onMovePhase={onMovePhase}
            onOpenIssue={onOpenIssue}
          />
        ))}
      </div>
    </div>
  );
}
