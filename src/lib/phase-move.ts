import type { PhaseMoveTarget, WorkItemRecord } from "../types";
import { phaseMoveTargets } from "../types";
import { workItemIdNumberText } from "./work-item-id";

// The phase move's view-layer grammar (ticket #148): the columns a board card
// or the shared panel offers, and the copyable gh command static builds
// degrade to. The command mirrors the seam applier's label math (the same
// worn-label rule, computed from the record the view holds).

// Every column but the one the item sits in now — re-selecting the current
// column is not a move.
export const phaseMoveTargetsFor = (current: PhaseMoveTarget): PhaseMoveTarget[] =>
  phaseMoveTargets.filter((target) => target !== current);

// The worn `workflow:` labels a move must strip: the raw source labels when
// the record rides them (GH-136), else the one label the resolved phase
// vouches for — never the target's own.
const wornPhaseLabels = (record: WorkItemRecord, target: PhaseMoveTarget): string[] => {
  const targetLabel = target === "pre-flow" ? null : `workflow:${target}`;
  return (record.labels ?? (record.phase ? [`workflow:${record.phase}`] : [])).filter(
    (label) => label.startsWith("workflow:") && label !== targetLabel,
  );
};

// The command a Developer runs by hand when the seam is unreachable (static
// builds degrade actions to copy-the-command). Pre-flow adds no label.
export const phaseMoveCommand = (record: WorkItemRecord, target: PhaseMoveTarget): string => {
  const args = ["gh issue edit", workItemIdNumberText(record.id)];
  if (target !== "pre-flow") args.push("--add-label", `workflow:${target}`);
  for (const label of wornPhaseLabels(record, target)) args.push("--remove-label", label);
  return args.join(" ");
};
