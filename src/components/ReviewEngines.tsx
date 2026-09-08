import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReviewEngine, ReviewEngineHealth } from "@/types";

// The review-engines health panel (epic #20, ticket #24): what the PR page
// renders from the review runner's health probe. The probe result travels in
// as data — the route fetches it on load — so this component only renders
// states and enforces ticket #24's invariant: an engine that is not ready is
// shown with its one-step remediation command instead of a start affordance,
// never a button that would fail opaquely mid-run.

const stateLabels: Record<ReviewEngineHealth["state"], string> = {
  ready: "Ready",
  binary_missing: "Not installed",
  auth_missing: "Not authenticated",
  provider_missing: "No model provider",
  probe_error: "Probe failed",
};

function EngineRow({
  health,
  onStart,
}: {
  health: ReviewEngineHealth;
  onStart?: (engine: ReviewEngine) => void;
}) {
  return (
    <li
      data-engine={health.engine}
      data-engine-state={health.state}
      className="py-2 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{health.engine}</span>
        <Badge variant={health.state === "ready" ? "default" : "outline"}>
          {stateLabels[health.state]}
        </Badge>
        {"version" in health && health.version && (
          <span className="font-mono text-xs text-muted-foreground">{health.version}</span>
        )}
        {health.state === "ready" && onStart && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => onStart(health.engine)}
          >
            Run review
          </Button>
        )}
      </div>
      {health.state === "probe_error" ? (
        <p className="mt-1 text-xs text-muted-foreground">{health.message}</p>
      ) : (
        health.state !== "ready" && (
          <p className="mt-1 text-xs text-muted-foreground">{health.remediation}</p>
        )
      )}
    </li>
  );
}

export function ReviewEngines({
  health,
  onStart,
}: {
  health: readonly ReviewEngineHealth[] | null;
  onStart?: (engine: ReviewEngine) => void;
}) {
  return (
    <Card data-slot="review-engines">
      <CardHeader>
        <CardTitle>Review engines</CardTitle>
      </CardHeader>
      <CardContent>
        {health === null ? (
          <p data-slot="review-engines-unknown" className="text-sm text-muted-foreground">
            Probing the review engines…
          </p>
        ) : (
          <ul className="flex flex-col">
            {health.map((engineHealth) => (
              <EngineRow key={engineHealth.engine} health={engineHealth} onStart={onStart} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
