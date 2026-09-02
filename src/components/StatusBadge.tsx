import { statusLabels, statusTone } from "../lib/overview";
import type { TicketStatus } from "../types";

export function StatusBadge({
  status,
  label = statusLabels[status],
}: Readonly<{ status: TicketStatus; label?: string }>) {
  return (
    <span className={`status-badge status-${statusTone(status)}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
