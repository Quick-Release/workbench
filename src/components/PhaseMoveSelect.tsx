import { useState } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import { phaseMoveCommand, phaseMoveTargetsFor } from "@/lib/phase-move";
import type { PhaseMoveTarget, WorkItemRecord } from "@/types";

const commandClass = "block rounded bg-muted px-2 py-1 text-xs break-all";

type PhaseMoveSelectProps = {
  record: WorkItemRecord;
  // The column the item sits in now — the offered targets are every other
  // column. A board card knows its column; the panel derives it from the
  // record's resolved phase (pre-flow when unlabeled).
  current: PhaseMoveTarget;
  mode: "live" | "static";
  pending: boolean;
  onMove: (phase: PhaseMoveTarget) => void;
};

// The move affordance the board card and the shared panel render (ticket
// #148): a native select that fires directly in live mode — no confirmation
// beat, GitHub history is the audit log (ADR 0005) — and in static mode
// composes the copyable gh command for the picked column instead of starting
// an action.
export function PhaseMoveSelect({ record, current, mode, pending, onMove }: PhaseMoveSelectProps) {
  const [staticTarget, setStaticTarget] = useState<PhaseMoveTarget | null>(null);

  const options = (
    <>
      <option value="">Move to…</option>
      {phaseMoveTargetsFor(current).map((target) => (
        <option key={target} value={target}>
          {target}
        </option>
      ))}
    </>
  );

  if (mode === "static")
    return (
      <div data-slot="phase-move-static" className="flex flex-col gap-1.5">
        <NativeSelect
          aria-label={`Compose a move command for ${record.id}`}
          className="w-44 text-xs"
          value={staticTarget ?? ""}
          onChange={(event) =>
            setStaticTarget((event.target.value || null) as PhaseMoveTarget | null)
          }
        >
          {options}
        </NativeSelect>
        {staticTarget && (
          <code data-slot="phase-move-command" className={commandClass}>
            {phaseMoveCommand(record, staticTarget)}
          </code>
        )}
      </div>
    );

  if (pending) return <p className="text-xs text-muted-foreground">Moving…</p>;

  return (
    <div data-slot="phase-move">
      <NativeSelect
        aria-label={`Move ${record.id}`}
        className="w-44 text-xs"
        value=""
        onChange={(event) => {
          const target = event.target.value as PhaseMoveTarget;
          if (target) onMove(target);
        }}
      >
        {options}
      </NativeSelect>
    </div>
  );
}
