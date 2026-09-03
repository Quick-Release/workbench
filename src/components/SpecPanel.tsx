import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

import { StatusBadge } from "./StatusBadge";
import type { SpecChangeRecord } from "../types";

export function SpecPanel({
  changes,
  total,
}: Readonly<{
  changes: readonly SpecChangeRecord[];
  total: number;
}>) {
  return (
    <section className="content-section" id="specs">
      <div className="section-heading">
        <div>
          <p className="section-kicker">03 / change proposals</p>
          <h2>
            Specs waiting for a <em>runway.</em>
          </h2>
        </div>
        <p>
          OpenSpec changes are deliberately separate from implementation tickets: they describe a
          proposed shape before it becomes work.
        </p>
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{changes.length}</strong> of {total} active change proposals
        </span>
        <span className="result-hint">Task counts are read from each change&apos;s task file.</span>
      </div>
      <div className="spec-grid">
        {changes.length === 0 ? (
          <Card className="min-h-[230px] items-center justify-center rounded-none border-line bg-panel/90 p-[35px] text-center text-muted-foreground shadow-none">
            No change proposals match this lens.
          </Card>
        ) : (
          changes.map((change) => <SpecCard key={change.id} change={change} />)
        )}
      </div>
    </section>
  );
}

function SpecCard({ change }: Readonly<{ change: SpecChangeRecord }>) {
  const progress =
    change.taskCount === 0 ? 0 : Math.round((change.completeTaskCount / change.taskCount) * 100);
  return (
    <Card className="min-h-[230px] gap-0 rounded-none border-line border-t-[3px] border-t-info bg-panel/90 p-[19px] shadow-none">
      <div className="flex items-start justify-between gap-5">
        <code className="font-mono text-[0.7rem] text-info">{change.id}</code>
        <StatusBadge status={change.status} label={change.statusLabel} />
      </div>
      <h3 className="mt-6 mb-2 text-[1.05rem] font-bold leading-[1.2]">{change.title}</h3>
      <p className="max-w-[630px] text-[0.82rem] leading-[1.52] text-muted-foreground">
        {change.summary}
      </p>
      <div className="mt-auto flex items-end justify-between gap-5 pt-[22px]">
        <div className="min-w-[130px]">
          <Progress value={progress} className="mb-[7px] h-[5px] rounded-none bg-panel-hi" />
          <small className="text-[0.67rem] text-faint">
            {change.completeTaskCount}/{change.taskCount} tasks checked
          </small>
        </div>
        <a
          href={change.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-[0.74rem]"
        >
          Read proposal ↗
        </a>
      </div>
    </Card>
  );
}
