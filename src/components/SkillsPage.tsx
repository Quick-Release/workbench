import { useCallback, useEffect, useState } from "react";
import { Check, Download, ExternalLink, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { favoriteSkills, mattPocockSkillSource } from "@/lib/skills";

type SkillSourceStatus = {
  id: string;
  source: string;
  installed: boolean;
  installedSkillCount: number;
  totalSkillCount: number;
};

type SkillsResponse = {
  skills: SkillSourceStatus[];
  message?: string;
};

const SkillsPage = () => {
  const [sourceStatus, setSourceStatus] = useState<SkillSourceStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as SkillsResponse;
      const mattPocockStatus = body.skills.find((skill) => skill.id === mattPocockSkillSource.id);
      if (!mattPocockStatus) throw new Error("Matt Pocock Skills status is missing");
      setSourceStatus(mattPocockStatus);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async () => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/skills/${mattPocockSkillSource.id}/setup`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as SkillsResponse;
      const nextStatus = body.skills?.find((skill) => skill.id === mattPocockSkillSource.id);
      if (nextStatus) setSourceStatus(nextStatus);
      if (!response.ok) throw new Error(body.message ?? "Skill installation failed.");
      setMessage(body.message ?? "Matt Pocock Skills installed.");
      setUnavailable(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Skill installation failed.");
    } finally {
      setPending(false);
    }
  };

  const statusLabel = unavailable
    ? "Unavailable"
    : sourceStatus === null
      ? "Checking…"
      : sourceStatus.installedSkillCount === 0
        ? "Not installed"
        : sourceStatus.installedSkillCount < sourceStatus.totalSkillCount
          ? `${sourceStatus.installedSkillCount}/${sourceStatus.totalSkillCount} installed`
          : `Installed · ${sourceStatus.totalSkillCount}`;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" aria-hidden="true" />
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Favorite skills
          </p>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          A small shelf of agent skills we recommend for work on this repository. Installations run
          locally against the repository Workbench is serving.
        </p>
      </header>

      {unavailable && (
        <p className="text-sm text-muted-foreground" role="status">
          Skill status is unavailable. The skills API is available when Workbench runs through its
          dev server.
        </p>
      )}
      {message && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <Card className="max-w-5xl">
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <CardTitle className="text-xl">{mattPocockSkillSource.name}</CardTitle>
              <CardDescription>
                Skills for real engineers: small, composable workflows for planning, building, and
                reviewing software.
              </CardDescription>
            </div>
            <Badge variant={sourceStatus?.installed ? "secondary" : "outline"}>{statusLabel}</Badge>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            The full collection is installed with the open <code>skills</code> CLI. It uses project
            scope, so the skills and lockfile stay with the host repository and can be reviewed by
            the team.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Our favorites</h2>
            <span className="text-xs text-muted-foreground">
              {favoriteSkills.length} featured from the collection
            </span>
          </div>
          <ul className="grid gap-3 md:grid-cols-2">
            {favoriteSkills.map((skill) => (
              <li key={skill.id} className="rounded-lg border border-border/70 p-4">
                <div className="flex items-start gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <a
                        href={`${mattPocockSkillSource.repositoryUrl}/tree/main/${skill.path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {skill.name}
                      </a>
                      <span className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">
                        {skill.category}
                      </span>
                    </div>
                    <p className="text-sm leading-5 text-muted-foreground">{skill.description}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>

        <CardFooter className="flex-wrap gap-3 border-t">
          <Button disabled={unavailable || pending} onClick={() => void install()}>
            <Download />
            {pending ? "Installing…" : sourceStatus?.installed ? "Update skills" : "Install skills"}
          </Button>
          <a
            href={mattPocockSkillSource.repositoryUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
          >
            View source <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </CardFooter>
      </Card>

      <div className="max-w-5xl space-y-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Install manually
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-sm">
          <code>{mattPocockSkillSource.installCommand}</code>
        </pre>
        <p className="text-xs leading-5 text-muted-foreground">
          The one-click action runs this command with confirmation prompts disabled. Review the
          installed skill files before using them, since agents execute skill instructions with
          their normal repository permissions.
        </p>
      </div>
    </div>
  );
};

export { SkillsPage };
