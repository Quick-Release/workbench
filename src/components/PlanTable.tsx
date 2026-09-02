import { StatusBadge } from "./StatusBadge";
import type { PlanRecord } from "../types";

export function PlanTable({
  plans,
  total,
}: Readonly<{
  plans: readonly PlanRecord[];
  total: number;
}>) {
  return (
    <section className="content-section" id="plans">
      <div className="section-heading">
        <div>
          <p className="section-kicker">02 / source corpus</p>
          <h2>
            The plans behind the <em>queue.</em>
          </h2>
        </div>
        <p>
          Top-level planning sources are summarized here so a ticket never loses the context, owner,
          or workstream it came from.
        </p>
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{plans.length}</strong> of {total} plan sources
        </span>
        <span className="result-hint">Counts are derived from local Markdown files.</span>
      </div>
      <div className="table-shell">
        <table className="signal-table plan-table">
          <caption className="sr-only">Local planning source documents</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Ticket load</th>
              <th scope="col">What it is about</th>
            </tr>
          </thead>
          <tbody>
            {plans.length === 0 ? (
              <tr>
                <td className="table-empty" colSpan={4}>
                  No plan sources match this lens.
                </td>
              </tr>
            ) : (
              plans.map((plan) => <PlanRow key={plan.id} plan={plan} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlanRow({ plan }: Readonly<{ plan: PlanRecord }>) {
  const progress =
    plan.ticketCount === 0 ? 0 : Math.round((plan.completeTicketCount / plan.ticketCount) * 100);
  return (
    <tr>
      <td className="plan-title-cell">
        <a className="plan-id" href={plan.sourceUrl} target="_blank" rel="noreferrer">
          {plan.id} <span aria-hidden="true">↗</span>
        </a>
        <strong>{plan.title}</strong>
        <code className="source-path">{plan.sourcePath}</code>
      </td>
      <td>
        <StatusBadge status={plan.status} label={plan.statusLabel} />
        {plan.statusDetail && plan.statusDetail !== plan.statusLabel && (
          <small className="status-detail">{plan.statusDetail}</small>
        )}
      </td>
      <td className="plan-load-cell">
        <strong>{plan.ticketCount}</strong>
        <span>
          {plan.openTicketCount} open / {plan.completeTicketCount} complete
        </span>
        <div className="progress-bar" aria-label={`${progress}% of plan tickets complete`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      </td>
      <td>
        <span className="stream-chip">{plan.stream}</span>
        <p className="plan-summary">{plan.summary}</p>
      </td>
    </tr>
  );
}
