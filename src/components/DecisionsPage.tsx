import { ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { decisionGroups, unlinkedWarning } from "@/lib/decisions";
import type { ArtifactRecord, DecisionRecord, DecisionSource } from "@/types";

const SOURCE_LABEL: Record<DecisionSource, string> = {
  adr: "ADR",
  resolution: "Resolution",
  spec: "Spec bundle",
};

// ADRs and research notes live as files in the host repo; a browser can only
// open them at a web url, so repo-relative refs resolve to their path on the
// host repository (the dashboard already treats GitHub as the tracker home).
// Full urls (issue and comment refs) pass through untouched.
const noteHref = (repositoryUrl: string, ref: string) =>
  /^[a-z]+:\/\//i.test(ref) || !repositoryUrl ? ref : `${repositoryUrl}/blob/HEAD/${ref}`;

// The one shared record row: the source form stays visible — a conclusion
// that exists as both a resolution and an ADR renders twice, side by side,
// never merged. Statements carry the full closing comment, uncapped.
function DecisionRow({ record, repositoryUrl }: { record: DecisionRecord; repositoryUrl: string }) {
  return (
    <li
      data-slot="decision-row"
      data-source={record.source}
      className="border-b py-3 last:border-b-0"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <a
          href={noteHref(repositoryUrl, record.sourceRef)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline-offset-4 hover:underline"
        >
          {record.id}
        </a>
        <Badge variant="outline">{SOURCE_LABEL[record.source]}</Badge>
        <span>{record.title}</span>
        {record.status && (
          <Badge variant="outline" data-status={record.status}>
            {record.status}
          </Badge>
        )}
        {record.decidedAt && (
          <span className="font-mono text-xs text-muted-foreground">
            {record.decidedAt.slice(0, 10)}
          </span>
        )}
      </p>
      {record.supersedes && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {`supersedes ${record.supersedes}`}
        </p>
      )}
      {record.statement && (
        <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{record.statement}</p>
      )}
    </li>
  );
}

function ArtifactRow({ record, repositoryUrl }: { record: ArtifactRecord; repositoryUrl: string }) {
  return (
    <li data-slot="artifact-row" className="border-b py-3 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <a
          href={noteHref(repositoryUrl, record.path)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs underline-offset-4 hover:underline"
        >
          {record.id}
        </a>
        <Badge variant="outline">Research note</Badge>
        <span>{record.title}</span>
      </p>
      <p className="mt-1 font-mono text-xs text-muted-foreground">{record.path}</p>
    </li>
  );
}

// The decisions view (ticket #63): Decision and Artifact records regrouped by
// work item — the index is rebuilt purely from the synced records, map gists
// are never consulted. Records without work-item linkage land in one explicit
// group whose warning surfaces. `repositoryUrl` is the host repository's web
// home, from the bundled snapshot's meta.
export function DecisionsPage({
  decisions,
  artifacts,
  repositoryUrl,
}: {
  decisions: readonly DecisionRecord[];
  artifacts: readonly ArtifactRecord[];
  repositoryUrl: string;
}) {
  const groups = decisionGroups(decisions, artifacts);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <ScrollText className="size-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Decisions</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        What the planning work decided — ADRs, resolutions, and spec bundles grouped by work item,
        with the research notes that supported them. A conclusion living as both a resolution and an
        ADR stays two records, side by side.
      </p>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No decisions collected yet — run <code>pnpm sync</code> to collect ADRs, resolutions, and
          spec bundles.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => {
            const unlinked = group.workItemId === null;
            const recordCount = group.decisions.length + group.artifacts.length;
            return (
              <Card
                key={group.workItemId ?? "unlinked"}
                data-slot="decision-group"
                data-work-item={group.workItemId ?? undefined}
                data-unlinked={unlinked || undefined}
              >
                <CardHeader>
                  <CardTitle
                    className={
                      unlinked ? "font-mono text-sm" : "font-mono text-sm text-muted-foreground"
                    }
                  >
                    {unlinked ? "Unlinked" : group.workItemId}
                  </CardTitle>
                  <CardDescription>
                    <strong>{recordCount}</strong> {recordCount === 1 ? "record" : "records"}
                    {unlinked && ` — ${unlinkedWarning(recordCount)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul>
                    {group.decisions.map((record) => (
                      <DecisionRow
                        key={`${record.id}:${record.source}`}
                        record={record}
                        repositoryUrl={repositoryUrl}
                      />
                    ))}
                    {group.artifacts.map((record) => (
                      <ArtifactRow key={record.id} record={record} repositoryUrl={repositoryUrl} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
