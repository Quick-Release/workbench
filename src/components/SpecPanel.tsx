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
          <div className="empty-card">No change proposals match this lens.</div>
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
    <article className="spec-card">
      <div className="spec-card-topline">
        <code>{change.id}</code>
        <StatusBadge status={change.status} label={change.statusLabel} />
      </div>
      <h3>{change.title}</h3>
      <p>{change.summary}</p>
      <div className="spec-card-footer">
        <div>
          <div className="progress-bar" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
          <small>
            {change.completeTaskCount}/{change.taskCount} tasks checked
          </small>
        </div>
        <a href={change.sourceUrl} target="_blank" rel="noreferrer">
          Read proposal ↗
        </a>
      </div>
    </article>
  );
}
