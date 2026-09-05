import type { ArtifactRecord, DecisionRecord } from "../types";

// The decisions view's index (ticket #63): records regrouped by work item —
// ADR, resolution, and spec records stay distinct but side by side, research
// notes ride with their work item, and everything without linkage lands in
// one explicit group placed last. Map gists are never consulted; the index
// is rebuilt purely from the synced records.

export type DecisionGroup = {
  workItemId: string | null;
  decisions: readonly DecisionRecord[];
  artifacts: readonly ArtifactRecord[];
};

// The unlinked group is the view's warning surface: linkage is declared (the
// ADR/artifact `Work item:` line), so records without it are a data-quality
// gap, not a quiet bucket. The count keeps the size honest.
export const unlinkedWarning = (count: number) =>
  `${count} ${count === 1 ? "record carries" : "records carry"} no Work item linkage; grouped here so the gap stays visible`;

// The snapshot's stable id order (scripts/tracker/decisions.mjs): namespace
// first, numerically within it, then source — so ADR records sort beside
// their resolution rather than after every GH id.
const namespace = (id: string) => id.slice(0, id.lastIndexOf("-"));

const numberSuffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

const compareIds = (left: string, right: string) =>
  namespace(left).localeCompare(namespace(right)) || numberSuffix(left) - numberSuffix(right);

const byRecordId = (left: { id: string; source: string }, right: { id: string; source: string }) =>
  compareIds(left.id, right.id) || left.source.localeCompare(right.source);

type MutableGroup = {
  workItemId: string | null;
  decisions: DecisionRecord[];
  artifacts: ArtifactRecord[];
};

export const decisionGroups = (
  decisions: readonly DecisionRecord[],
  artifacts: readonly ArtifactRecord[],
): readonly DecisionGroup[] => {
  const linked = new Map<string, MutableGroup>();
  const unlinked: MutableGroup = { workItemId: null, decisions: [], artifacts: [] };

  const groupFor = (workItemId: string | null): MutableGroup => {
    if (workItemId === null) return unlinked;
    let group = linked.get(workItemId);
    if (!group) {
      group = { workItemId, decisions: [], artifacts: [] };
      linked.set(workItemId, group);
    }
    return group;
  };

  for (const record of decisions) groupFor(record.workItemId).decisions.push(record);
  for (const record of artifacts) groupFor(record.workItemId).artifacts.push(record);

  for (const group of linked.values()) group.decisions.sort(byRecordId);
  unlinked.decisions.sort(byRecordId);
  unlinked.artifacts.sort((left, right) => left.id.localeCompare(right.id));

  const sorted: readonly DecisionGroup[] = [
    ...[...linked.values()].sort((left, right) =>
      compareIds(left.workItemId ?? "", right.workItemId ?? ""),
    ),
  ];
  const hasUnlinked = unlinked.decisions.length + unlinked.artifacts.length > 0;
  return hasUnlinked ? [...sorted, unlinked] : sorted;
};
