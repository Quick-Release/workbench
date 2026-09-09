import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReviewEngineHealth } from "@/types";

// The review-engines health panel (epic #20, ticket #24): what the PR page
// renders from the review runner's health probe. The probe result travels in
// as data — the route fetches it on load — so this component only renders
// states. No start affordance exists anywhere by design until the run-review
// slice of epic #20 lands; a not-ready engine shows its one-step remediation
// command, and a probe_error engine shows the probe's own message.

const stateLabels: Record<ReviewEngineHealth["state"], string> = {
  ready: "Ready",
  binary_missing: "Not installed",
  auth_missing: "Not authenticated",
  provider_missing: "No model provider",
  ollama_unreachable: "Ollama unreachable",
  model_missing: "Model not pulled",
  probe_error: "Probe failed",
};

function EngineRow({ health }: { health: ReviewEngineHealth }) {
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
      </div>
      {health.state === "probe_error" ? (
        <p className="mt-1 text-xs text-muted-foreground">{health.message}</p>
      ) : (
        health.state !== "ready" && (
          <p className="mt-1 text-xs text-muted-foreground">{health.remediation}</p>
        )
      )}
      {health.state === "ready" && "models" in health && health.models.length > 0 && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">{health.models.join(" · ")}</p>
      )}
      {health.state === "ready" && "warning" in health && health.warning && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{health.warning}</p>
      )}
    </li>
  );
}

export function ReviewEngines({ health }: { health: readonly ReviewEngineHealth[] | null }) {
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
              <EngineRow key={engineHealth.engine} health={engineHealth} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
