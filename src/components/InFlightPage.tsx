import { Rocket } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DisplayCaveat } from "@/lib/display-state";
import { deriveDisplayState } from "@/lib/display-state";
import { inFlightBuckets } from "@/lib/in-flight";
import type { WorkItemRecord } from "@/types";

type InFlightBucketKey = "reviewing" | "implementing" | "notStarted";

type InFlightRowProps = {
  record: WorkItemRecord;
  bucket: InFlightBucketKey;
  caveats: readonly DisplayCaveat[];
};

// One in-flight row: the claimed work item, informational only. The issue
// id links out to GitHub as the secondary link; the view itself offers no
// actions — claimed-but-not-started rows wear the informational marking
// until session spawning lands (ticket #62).
export function InFlightRow({ record, bucket, caveats }: InFlightRowProps) {
  return (
    <li
      data-slot="in-flight-row"
      data-bucket={bucket}
      data-informational={bucket === "notStarted" || undefined}
      className="border-b py-3 last:border-b-0"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <a
          href={record.url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline-offset-4 hover:underline"
        >
          {record.id}
        </a>
        <span className="truncate">{record.title}</span>
        {record.phase && <Badge variant="outline">{record.phase}</Badge>}
        {record.triageState !== "unlabeled" && (
          <Badge variant="outline">{record.triageState}</Badge>
        )}
        {bucket === "notStarted" && <Badge variant="outline">informational</Badge>}
        {record.assignees.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground">
            {record.assignees.map((assignee) => `@${assignee}`).join(" ")}
          </span>
        )}
      </p>
      {record.summary && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{record.summary}</p>
      )}
      {caveats.map((caveat) => (
        <p key={caveat.kind} className="mt-1 text-xs text-muted-foreground italic">
          {caveat.message}
        </p>
      ))}
    </li>
  );
}

const BUCKETS: readonly { key: InFlightBucketKey; label: string; blurb: string }[] = [
  { key: "reviewing", label: "Reviewing", blurb: "in review — reviews outrank new starts" },
  { key: "implementing", label: "Implementing", blurb: "claimed and mid-implementation" },
  {
    key: "notStarted",
    label: "Claimed — not started",
    blurb: "informational until session spawning lands",
  },
];

// The in-flight view (ticket #62): ADR 0010's in-flight bucket in priority
// order, straight from the display-state derivation through the workflow
// read endpoint. Informational only — nothing here recommends or acts.
export function InFlightPage({ workItems }: { workItems: readonly WorkItemRecord[] }) {
  const buckets = inFlightBuckets(workItems);
  const total = buckets.reviewing.length + buckets.implementing.length + buckets.notStarted.length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <Rocket className="size-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">In flight</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Claimed work in priority order — reviewing, then implementing, then claimed-but-not-started.
        Resume before grabbing; nothing on this view recommends or acts.
      </p>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is in flight right now.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {BUCKETS.map(({ key, label, blurb }) => (
            <Card key={key}>
              <CardHeader>
                <CardTitle>{label}</CardTitle>
                <CardDescription>
                  <strong>{buckets[key].length}</strong> {blurb}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {buckets[key].length > 0 ? (
                  <ul>
                    {buckets[key].map((record) => (
                      <InFlightRow
                        key={record.id}
                        record={record}
                        bucket={key}
                        caveats={deriveDisplayState(record, false).caveats}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing here.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
