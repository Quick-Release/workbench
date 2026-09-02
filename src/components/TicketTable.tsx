import { StatusBadge } from "./StatusBadge";
import type { TicketRecord } from "../types";

export function TicketTable({
  tickets,
  total,
}: Readonly<{
  tickets: readonly TicketRecord[];
  total: number;
}>) {
  return (
    <section className="content-section" id="tickets">
      <div className="section-heading">
        <div>
          <p className="section-kicker">01 / ticket ledger</p>
          <h2>
            Work that still needs a <em>decision.</em>
          </h2>
        </div>
        <p>
          Every local implementation record in the planning corpus, with a canonical status ledger
          kept distinct from plan-file status.
        </p>
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{tickets.length}</strong> of {total} ticket records
        </span>
        <span className="result-hint">Select a status or stream above to narrow the view.</span>
      </div>
      <div className="table-shell">
        <table className="signal-table ticket-table">
          <caption className="sr-only">Local implementation tickets</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Status</th>
              <th scope="col">Stream / lane</th>
              <th scope="col">Dependencies</th>
              <th scope="col">Progress</th>
            </tr>
          </thead>
          <tbody>
            {tickets.length === 0 ? (
              <tr>
                <td className="table-empty" colSpan={5}>
                  No tickets match this lens. Clear the filters to restore the full ledger.
                </td>
              </tr>
            ) : (
              tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TicketRow({ ticket }: Readonly<{ ticket: TicketRecord }>) {
  return (
    <tr>
      <td className="ticket-title-cell">
        <div className="ticket-meta">
          <a className="ticket-id" href={ticket.sourceUrl} target="_blank" rel="noreferrer">
            {ticket.id} <span aria-hidden="true">↗</span>
          </a>
          <span className="kind-label">
            {ticket.kind === "ledger" ? "canonical ledger" : "plan ticket"}
          </span>
        </div>
        <strong>{ticket.title}</strong>
        <p>{ticket.summary}</p>
        <code className="source-path">{ticket.sourcePath}</code>
      </td>
      <td>
        <StatusBadge status={ticket.status} label={ticket.statusLabel} />
        {ticket.statusDetail && ticket.statusDetail !== ticket.statusLabel && (
          <small className="status-detail">{ticket.statusDetail}</small>
        )}
      </td>
      <td>
        <strong className="stream-name">{ticket.group}</strong>
        <small>{ticket.lane}</small>
      </td>
      <td>
        <span className="dependency-text">{ticket.dependencies}</span>
      </td>
      <td>
        {ticket.progress.total > 0 ? (
          <div className="progress-cell">
            <div className="progress-bar" aria-hidden="true">
              <span
                style={{
                  width: `${Math.round((ticket.progress.done / ticket.progress.total) * 100)}%`,
                }}
              />
            </div>
            <small>
              {ticket.progress.done}/{ticket.progress.total} checked
            </small>
          </div>
        ) : (
          <small className="muted-copy">No checklist</small>
        )}
      </td>
    </tr>
  );
}
