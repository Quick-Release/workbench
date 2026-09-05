import { ExternalLink } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  flowCanvasSize,
  flowEdgePath,
  flowRegionFor,
  flowRegionLabels,
  layoutFlowGraph,
} from "@/lib/flow-layout";
import { GraphView, type GraphNodeDatum } from "@/components/GraphView";
import { skillClassification, skillFlowEdges } from "@/data/skill-flow";
import { favoriteSkillIds, mattPocockSkillSource, perSkillInstallCommand } from "@/lib/skills";
import type { OverviewData, SkillRecord, SkillsStatus } from "@/types";

const ROLE_TAG = {
  "main-flow": "main-flow step",
  "on-ramp": "on-ramp",
  standalone: "standalone",
  vocabulary: "vocabulary layer",
  primitive: "primitive",
  none: "unclassified",
} as const;

const KIND_LABEL = {
  "next-step": "next step",
  "hands-off-to": "hands off to",
  "merges-onto": "merges onto",
  "runs-internally": "runs",
  "pairs-with": "pairs with",
  "delegates-to": "delegates to",
} as const;

const ROLE_ACCENT: Record<string, string> = {
  "main-flow": "var(--acid)",
  "on-ramp": "var(--blue)",
  vocabulary: "var(--amber)",
  primitive: "var(--coral)",
  none: "var(--line-strong)",
};

type FlowPageProps = {
  data: OverviewData;
  status: SkillsStatus | null;
  pending: boolean;
  favorites: boolean;
  selected: string | null;
  onFavoritesChange: (value: boolean) => void;
  onSelect: (id: string | null) => void;
  onInstall: (id: string) => void;
  onInstallAll: () => void;
};

const roleTag = (id: string) => ROLE_TAG[skillClassification(id)?.role ?? "none"];

const humanize = (value: string) =>
  value
    .split(/[-_]/)
    .map((part) => part.replace(/\b\w/g, (character) => character.toLocaleUpperCase()))
    .join(" ");

export function FlowPage({
  data,
  status,
  pending,
  favorites,
  selected,
  onFavoritesChange,
  onSelect,
  onInstall,
  onInstallAll,
}: FlowPageProps) {
  const liveById = useMemo(
    () => new Map((status?.skills ?? []).map((entry) => [entry.id, entry])),
    [status],
  );
  const snapshotInstalls = useMemo(() => new Set(data.skillInstalls), [data.skillInstalls]);
  // Installed state is never stored as truth: the live seam payload wins per
  // id; without a dev server the sync-time snapshot degrades gracefully.
  const isInstalled = (id: string) =>
    liveById.has(id) ? Boolean(liveById.get(id)?.installed) : snapshotInstalls.has(id);
  // Descriptions resolve installed frontmatter → curated blurb → name.
  const descriptionFor = (id: string) =>
    liveById.get(id)?.description ?? skillClassification(id)?.blurb ?? humanize(id);

  const visible: SkillRecord[] = favorites
    ? data.skills.filter((skill) => (favoriteSkillIds as readonly string[]).includes(skill.id))
    : [...data.skills];

  const boxes = useMemo(() => layoutFlowGraph(visible), [visible]);
  const nodes: GraphNodeDatum[] = visible.map((skill) => ({
    id: skill.id,
    box: boxes[skill.id],
    label: skill.id,
    sublabel: flowRegionFor(skill) === "pen" ? "in progress" : roleTag(skill.id),
    accent: ROLE_ACCENT[skillClassification(skill.id)?.role ?? "none"],
    region: flowRegionFor(skill),
    marked: isInstalled(skill.id),
    dimmed: !isInstalled(skill.id),
    selected: selected === skill.id,
    title: `/${skill.id} — ${descriptionFor(skill.id)}`,
    onSelect: () => onSelect(skill.id),
  }));
  const edges = skillFlowEdges
    .filter((edge) => boxes[edge.from] && boxes[edge.to])
    .map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      d: flowEdgePath(boxes[edge.from], boxes[edge.to]),
      variant: edge.kind === "runs-internally" ? ("internal" as const) : ("progression" as const),
      title: `${edge.from} —${edge.kind}→ ${edge.to}`,
    }));

  const liveSource = status?.sources.find((source) => source.id === mattPocockSkillSource.id);
  const staticInstalledCount = data.skills.filter((skill) => snapshotInstalls.has(skill.id)).length;
  const installedCount = liveSource?.installedSkillCount ?? staticInstalledCount;
  const totalCount = liveSource?.totalSkillCount ?? data.skills.length;
  const staticMode = status === null;

  const selectedEdges = selected
    ? {
        out: skillFlowEdges.filter((edge) => edge.from === selected),
        in: skillFlowEdges.filter((edge) => edge.to === selected),
      }
    : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Skill flow</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            The full Catalog as one flow graph: the main flow from idea to ship, the on-ramps that
            merge onto it, the vocabulary running underneath, and the standalone shelf. Uninstalled
            entries render dimmed — click one for detail and install.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={favorites ? "secondary" : "outline"}
            size="sm"
            aria-pressed={favorites}
            onClick={() => onFavoritesChange(!favorites)}
          >
            Favorites
          </Button>
          {selected ? (
            <Button variant="outline" size="sm" onClick={() => onSelect(null)}>
              Close detail
            </Button>
          ) : null}
        </div>
      </header>

      {staticMode && (
        <p className="text-sm text-muted-foreground" role="status">
          Static snapshot — no dev server is answering, so actions degrade to copy the command.
        </p>
      )}

      <Card className="max-w-5xl" data-slot="flow-source">
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-lg">{mattPocockSkillSource.name}</CardTitle>
              <CardDescription>
                The skills ecosystem this dashboard renders, served from{" "}
                {mattPocockSkillSource.repository}.
              </CardDescription>
            </div>
            <Badge variant={installedCount > 0 ? "secondary" : "outline"}>
              {installedCount} of {totalCount} installed
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {staticMode ? (
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <code>{mattPocockSkillSource.installCommand}</code>
            </pre>
          ) : (
            <Button size="sm" disabled={pending} onClick={onInstallAll} data-slot="install-all">
              {pending ? "Installing…" : "Install all skills"}
            </Button>
          )}
          <a
            href={mattPocockSkillSource.repositoryUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
          >
            View source <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </CardContent>
      </Card>

      <figure className="min-w-0">
        <GraphView
          width={flowCanvasSize.width}
          height={flowCanvasSize.height}
          ariaLabel="Skill flow graph"
          labels={flowRegionLabels()}
          edges={edges}
          nodes={nodes}
        />
      </figure>

      {selected && selectedEdges ? (
        <aside
          data-slot="flow-detail"
          className="max-w-md space-y-3 rounded-lg border border-border bg-card p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-mono text-base font-semibold">/{selected}</h2>
            <Button variant="ghost" size="sm" onClick={() => onSelect(null)} aria-label="Close">
              ✕
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span className="rounded-full border border-border px-2 py-0.5">
              {roleTag(selected)}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5">
              {humanize(data.skills.find((skill) => skill.id === selected)?.category ?? "") || "—"}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5">
              {isInstalled(selected) ? "installed" : "not installed"}
            </span>
          </div>
          <p className="text-sm leading-6">{descriptionFor(selected)}</p>
          {skillClassification(selected)?.when ? (
            <p className="text-sm leading-6 text-muted-foreground">
              When: {skillClassification(selected)?.when}
            </p>
          ) : null}
          {(
            [
              ["Feeds into", selectedEdges.out.filter((edge) => edge.kind !== "runs-internally")],
              [
                "Runs internally",
                selectedEdges.out.filter((edge) => edge.kind === "runs-internally"),
              ],
              ["Run by", selectedEdges.in],
            ] as const
          ).map(([label, list]) => (
            <div key={label} className="border-t border-border pt-2 text-sm">
              <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                {label}
              </p>
              {list.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                list.map((edge) => {
                  const other = edge.from === selected ? edge.to : edge.from;
                  const suffix =
                    edge.from === selected && edge.kind !== "runs-internally"
                      ? ` (${KIND_LABEL[edge.kind]})`
                      : edge.from !== selected
                        ? ` (${KIND_LABEL[edge.kind]})`
                        : "";
                  return (
                    <button
                      key={`${label}-${other}`}
                      className="block font-mono text-sm underline-offset-4 hover:underline"
                      onClick={() => onSelect(other)}
                    >
                      {other}
                      {suffix}
                    </button>
                  );
                })
              )}
            </div>
          ))}
          {isInstalled(selected) ? null : staticMode ? (
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <code>{perSkillInstallCommand(selected)}</code>
            </pre>
          ) : (
            <Button
              className="w-full"
              size="sm"
              disabled={pending}
              onClick={() => onInstall(selected)}
              data-slot="install-skill"
            >
              {pending ? "Installing…" : `Install /${selected}`}
            </Button>
          )}
        </aside>
      ) : null}
    </div>
  );
}
