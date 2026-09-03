import { Badge } from "@/components/ui/badge";

import { statusLabels, statusTone } from "../lib/overview";
import type { TicketStatus } from "../types";

export function StatusBadge({
  status,
  label = statusLabels[status],
}: Readonly<{ status: TicketStatus; label?: string }>) {
  return (
    <Badge tone={statusTone(status)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
