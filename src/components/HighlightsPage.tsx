import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CommitCandidate } from "../types";
import type { SubmissionOutcome } from "../lib/submissions";

// The Highlights page (tickets #17 and #12): commit-message candidates
// gathered at sync for marketing write-ups. The consent posture sits in
// the explainer card — nothing leaves the machine until a Developer
// Submits one candidate, which is the page's single action. The Submit
// handler arrives as a prop; the page tracks per-candidate outcomes so a
// submitted commit never offers its button again.

interface HighlightsPageProps {
  highlights: readonly CommitCandidate[];
  onSubmit?: (candidate: CommitCandidate) => Promise<SubmissionOutcome>;
  outcomes?: ReadonlyMap<string, SubmissionOutcome>;
}

export function HighlightsPage({ highlights, onSubmit, outcomes }: HighlightsPageProps) {
  const pageOutcomes = outcomes ?? new Map<string, SubmissionOutcome>();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold">Highlights</h1>
        <p className="text-sm text-muted-foreground">
          Commit-message candidates from this repository's recent history, gathered at sync for
          marketing write-ups.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Consent posture</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Nothing leaves your machine until you make an explicit Submission. Browsing these
          candidates records nothing and sends nothing; a Submission is a separate, deliberate act
          that picks exactly one commit message, with attribution, for marketing use.
        </CardContent>
      </Card>

      {highlights.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No commit-message candidates yet — candidates need a body beyond the subject and a ticket
          or issue reference.
        </p>
      ) : (
        <ul className="space-y-3">
          {highlights.map((candidate) => (
            <li key={candidate.sha}>
              <Card>
                <CardContent className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{candidate.subject}</p>
                    <Badge variant="outline">{candidate.ticketRef}</Badge>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {candidate.body}
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {candidate.author} ·{" "}
                      <time dateTime={candidate.date}>{candidate.date.slice(0, 10)}</time>
                    </p>
                    {pageOutcomes.get(candidate.sha)?.status === "submitted" ? (
                      <Badge variant="outline">Submitted</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!onSubmit}
                        onClick={() => void onSubmit?.(candidate)}
                        data-sha={candidate.sha}
                      >
                        Submit
                      </Button>
                    )}
                  </div>
                  {pageOutcomes.get(candidate.sha) &&
                    pageOutcomes.get(candidate.sha)?.status !== "submitted" && (
                      <p className="text-xs text-muted-foreground">
                        {pageOutcomes.get(candidate.sha)?.message}
                      </p>
                    )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
