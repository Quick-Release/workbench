import { useState } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DraftState } from "@/lib/draft-state";

// The draft panel (ticket #38) is deliberately presentational: its whole
// state arrives as one data prop, so the server-render tests can place it
// in any state and the container owns only the fetch wiring. The host
// repo's content appears here solely on the Developer's explicit click —
// the panel never sends anything itself.

export function DraftPanel({ state }: { state: DraftState }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (state.phase !== "done") return;
    void navigator.clipboard
      .writeText(`${state.title}\n\n${state.body}`)
      .then(() => setCopied(true));
  };

  return (
    <div
      data-slot="draft-panel"
      data-draft-state={state.phase}
      aria-busy={state.phase === "drafting"}
      className="mt-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      {state.phase === "idle" && null}

      {state.phase === "drafting" && (
        <p data-slot="draft-pending" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Drafting description…
        </p>
      )}

      {state.phase === "done" && (
        <div data-slot="draft-result" className="space-y-2">
          <p className="font-medium">{state.title}</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{state.body}</p>
          <Button type="button" variant="outline" size="xs" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy draft"}
          </Button>
        </div>
      )}

      {state.phase === "error" && (
        <p data-slot="draft-error" className="text-destructive">
          {state.message}
        </p>
      )}

      {state.phase === "unconfigured" && (
        <p data-slot="draft-hint" className="text-muted-foreground">
          No model provider key is configured — set <code>ANTHROPIC_API_KEY</code> in{" "}
          <code>.env</code> and restart <code>pnpm dev</code> to enable drafting.
        </p>
      )}
    </div>
  );
}
