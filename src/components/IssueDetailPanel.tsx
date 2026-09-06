import { useState } from "react";
import { ExternalLink, Network, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveDisplayState } from "@/lib/display-state";
import { effortFor, frontierItemFromWorkItem, itemsById, openBlockers } from "@/lib/frontier";
import { cn } from "@/lib/utils";
import type { WorkflowStatePayload } from "../types";

export type IssuePanelAction =
  | { kind: "create"; title: string; body: string }
  | { kind: "edit"; issueId: string; title: string; body: string; confirm: boolean }
  | { kind: "comment"; issueId: string; body: string }
  | { kind: "edge-add"; blockedId: string; blockerId: string }
  | { kind: "edge-remove"; blockedId: string; blockerId: string; confirm: boolean };

type IssueDetailPanelProps = {
  issueId: string | null;
  state: WorkflowStatePayload;
  mode: "live" | "static";
  pending: IssuePanelAction["kind"] | null;
  message: string | null;
  onOpenChange: (open: boolean) => void;
  onAction: (action: IssuePanelAction) => void;
};

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const commandClass = "block rounded bg-muted px-2 py-1 text-xs break-all";

// Copied commands must survive draft text that carries double quotes.
const shellQuote = (text: string) => text.replace(/"/g, '\\"');

const githubUrl = (issueId: string, repo: string) =>
  `https://github.com/${repo}/issues/${issueId.slice(3)}`;

const secondaryLink =
  "inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline";

// The one detail grammar for every view (ticket #60): a shared panel opened
// by the `?issue` search param — deep-linkable, browser-back closes it —
// carrying the work item's state, its caveat lines, and ADR 0005's phase-1
// issue actions, degraded to copy-the-command when the seam is unreachable.
export function IssueDetailPanel(props: IssueDetailPanelProps) {
  if (!props.issueId) return null;
  return <OpenedIssueDetailPanel {...props} issueId={props.issueId} />;
}

function OpenedIssueDetailPanel({
  issueId,
  state,
  mode,
  pending,
  message,
  onOpenChange,
  onAction,
}: Omit<IssueDetailPanelProps, "issueId"> & { issueId: string }) {
  const record = state.workItems.find((item) => item.id === issueId) ?? null;
  return (
    <aside
      data-slot="issue-detail-panel"
      aria-label={record ? `Details for ${record.id}` : "Issue panel"}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          {record ? (
            <>
              <p className="font-mono text-xs text-muted-foreground">{record.id}</p>
              <h2 className="mt-0.5 text-base leading-snug font-semibold">{record.title}</h2>
            </>
          ) : (
            <h2 className="text-base font-semibold">
              {issueId === "new" ? "File a new issue" : issueId}
            </h2>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close panel"
          onClick={() => onOpenChange(false)}
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-5 p-4 text-sm">
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {issueId === "new" ? (
          <CreateIssueSection
            mode={mode}
            pending={pending}
            onAction={onAction}
            repo={state.meta.repo}
          />
        ) : record ? (
          <IssueRecordSections
            key={record.id}
            issueId={issueId}
            record={record}
            state={state}
            mode={mode}
            pending={pending}
            onAction={onAction}
          />
        ) : (
          <UnknownIssueSection issueId={issueId} repo={state.meta.repo} />
        )}
      </div>
    </aside>
  );
}

type SectionProps = {
  issueId: string;
  mode: "live" | "static";
  pending: IssuePanelAction["kind"] | null;
  onAction: (action: IssuePanelAction) => void;
};

function IssueRecordSections({
  record,
  state,
  mode,
  pending,
  onAction,
}: SectionProps & { record: (typeof state)["workItems"][number]; state: WorkflowStatePayload }) {
  const [commentDraft, setCommentDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState(record.title);
  const [bodyDraft, setBodyDraft] = useState("");
  const [confirmingEdit, setConfirmingEdit] = useState(false);

  const blockers = openBlockers(
    record.id,
    state.blockerEdges,
    itemsById(state.workItems.map(frontierItemFromWorkItem)),
  );
  const blocked = blockers.open.length > 0 || blockers.dangling.length > 0;
  const display = deriveDisplayState(record, blocked);
  const effort = effortFor(record.id, state.maps);
  const number = record.id.slice(3);
  const repo = state.meta.repo;

  const blockedLine =
    blockers.open.length > 0
      ? `Blocked by ${blockers.open.join(", ")}.`
      : blockers.dangling.length > 0
        ? `Blocked by missing work: ${blockers.dangling.join(", ")} — fix the dangling reference.`
        : "No open blockers.";

  // The degraded edit command carries only the fields the Developer fills
  // in — prefilled with the current title it would be a no-op to copy.
  const editCommand = `gh issue edit ${number} --repo ${repo}${
    titleDraft ? ` --title "${shellQuote(titleDraft)}"` : ""
  }${bodyDraft ? ` --body "${shellQuote(bodyDraft)}"` : ""}`;

  return (
    <>
      <section data-slot="issue-detail-state" className="flex flex-col gap-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">State</dt>
          <dd>{display.state}</dd>
          <dt className="text-muted-foreground">Phase</dt>
          <dd>{display.phase ?? "not on the flow yet"}</dd>
          <dt className="text-muted-foreground">Triage state</dt>
          <dd>{display.triageState}</dd>
          <dt className="text-muted-foreground">Claim</dt>
          <dd>{display.claimed ? `Claimed by ${record.assignees.join(", ")}` : "Unclaimed"}</dd>
          <dt className="text-muted-foreground">Blockers</dt>
          <dd>{blockedLine}</dd>
        </dl>
        {display.deferred && (
          <Badge variant="outline" className="w-fit">
            deferred
          </Badge>
        )}
        {display.caveats.map((caveat) => (
          <p key={caveat.kind} className="text-xs text-muted-foreground italic">
            {caveat.message}
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {effort && (
            <a className={secondaryLink} href={`/blockers?effort=${effort}&focus=${number}`}>
              <Network className="size-3.5" />
              Show in graph
            </a>
          )}
          <a className={secondaryLink} href={record.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" />
            open on GitHub
          </a>
        </div>
      </section>

      <BlockerEdgesSection
        record={record}
        state={state}
        mode={mode}
        pending={pending}
        onAction={onAction}
      />

      <section className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Comment</p>
        {mode === "static" ? (
          <code className={commandClass}>
            {`gh issue comment ${number} --repo ${repo} --body "${shellQuote(commentDraft)}"`}
          </code>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={`Comment on ${record.id}`}
              className={textareaClass}
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={pending === "comment" || !commentDraft.trim()}
                onClick={() =>
                  onAction({ kind: "comment", issueId: record.id, body: commentDraft })
                }
              >
                Comment
              </Button>
              {pending === "comment" && (
                <span className="text-xs text-muted-foreground">Commenting…</span>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Edit</p>
        {mode === "static" ? (
          <code className={commandClass}>{editCommand}</code>
        ) : confirmingEdit ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>Overwrite {record.id} on the tracker?</span>
            <Button
              size="xs"
              variant="destructive"
              disabled={pending === "edit"}
              onClick={() =>
                onAction({
                  kind: "edit",
                  issueId: record.id,
                  title: titleDraft,
                  body: bodyDraft,
                  confirm: true,
                })
              }
            >
              Confirm overwrite
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmingEdit(false)}>
              Keep drafting
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              aria-label={`Edit ${record.id} title`}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
            <textarea
              aria-label={`Edit ${record.id} body`}
              className={cn(textareaClass, "min-h-32")}
              value={bodyDraft}
              onChange={(event) => setBodyDraft(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending === "edit" || (!titleDraft.trim() && !bodyDraft.trim())}
                onClick={() => setConfirmingEdit(true)}
              >
                Save changes
              </Button>
              {pending === "edit" && <span className="text-xs text-muted-foreground">Saving…</span>}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function CreateIssueSection({
  mode,
  pending,
  onAction,
  repo,
}: Omit<SectionProps, "issueId"> & { repo: string }) {
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");

  if (mode === "static")
    return (
      <section className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          New issue
        </p>
        <code className={commandClass}>
          {`gh issue create --repo ${repo} --title "${shellQuote(titleDraft)}" --body "${shellQuote(bodyDraft)}"`}
        </code>
      </section>
    );

  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">New issue</p>
      <Input
        aria-label="New issue title"
        placeholder="What needs doing?"
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.target.value)}
      />
      <textarea
        aria-label="New issue body"
        className={textareaClass}
        value={bodyDraft}
        onChange={(event) => setBodyDraft(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending === "create" || !titleDraft.trim()}
          onClick={() => onAction({ kind: "create", title: titleDraft, body: bodyDraft })}
        >
          File issue
        </Button>
        {pending === "create" && <span className="text-xs text-muted-foreground">Filing…</span>}
      </div>
    </section>
  );
}

// ADR 0005 phase-1 blocker-edge actions (ticket #61): adding declares a gate
// with a qualified id; removal tears a gate off the tracker, so it takes the
// same deliberate two-step confirm as the edit. Static builds carry the two
// gh api commands a Developer would run by hand — the database id the
// native endpoint speaks resolves through the same `--jq .id` lookup.
function BlockerEdgesSection({
  record,
  state,
  mode,
  pending,
  onAction,
}: Omit<SectionProps, "issueId"> & {
  record: (typeof state)["workItems"][number];
  state: WorkflowStatePayload;
}) {
  const [blockerDraft, setBlockerDraft] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const declared = state.blockerEdges.filter((edge) => edge.blockedId === record.id);
  const number = record.id.slice(3);
  const repo = state.meta.repo;
  const databaseId = (blockerId: string) =>
    `$(gh api repos/${repo}/issues/${blockerId.slice(3)} --jq .id)`;
  const addCommand = `gh api --method POST repos/${repo}/issues/${number}/dependencies/blocked_by -F issue_id=${databaseId(blockerDraft || "GH-")}`;
  const removeCommand = (blockerId: string) =>
    `gh api --method DELETE repos/${repo}/issues/${number}/dependencies/blocked_by/${databaseId(blockerId)}`;

  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Blocker edges
      </p>
      {declared.length === 0 ? (
        <p className="text-xs text-muted-foreground">no gates declared from this issue</p>
      ) : (
        mode === "static" && (
          <div className="flex flex-col gap-1">
            {declared.map((edge) => (
              <code key={`${edge.blockerId}`} className={commandClass}>
                {removeCommand(edge.blockerId)}
              </code>
            ))}
          </div>
        )
      )}
      {mode === "static" ? (
        <code className={commandClass}>{addCommand}</code>
      ) : (
        <div className="flex flex-col gap-2">
          {declared.map((edge) =>
            confirmingRemoval === edge.blockerId ? (
              <div key={edge.blockerId} className="flex flex-wrap items-center gap-2 text-xs">
                <span>
                  Tear {edge.blockerId}&apos;s gate off {record.id}?
                </span>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={pending === "edge-remove"}
                  onClick={() =>
                    onAction({
                      kind: "edge-remove",
                      blockedId: record.id,
                      blockerId: edge.blockerId,
                      confirm: true,
                    })
                  }
                >
                  Confirm removal
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmingRemoval(null)}>
                  Keep the gate
                </Button>
              </div>
            ) : (
              <div
                key={edge.blockerId}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="font-mono">{edge.blockerId}</span>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Remove the gate from ${edge.blockerId}`}
                  onClick={() => setConfirmingRemoval(edge.blockerId)}
                >
                  Remove gate
                </Button>
              </div>
            ),
          )}
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Add a blocker gate to ${record.id}`}
              placeholder="GH-64 — the id that gates this issue"
              value={blockerDraft}
              onChange={(event) => setBlockerDraft(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending === "edge-add" || !/^GH-\d+$/.test(blockerDraft.trim())}
              onClick={() => {
                onAction({
                  kind: "edge-add",
                  blockedId: record.id,
                  blockerId: blockerDraft.trim(),
                });
                setBlockerDraft("");
              }}
            >
              Add gate
            </Button>
          </div>
          {pending === "edge-add" && <span className="text-xs text-muted-foreground">Adding…</span>}
          {pending === "edge-remove" && (
            <span className="text-xs text-muted-foreground">Removing…</span>
          )}
        </div>
      )}
    </section>
  );
}

function UnknownIssueSection({ issueId, repo }: { issueId: string; repo: string }) {
  return (
    <section className="flex flex-col gap-2">
      <p>
        {issueId} is not in the snapshot — it may have closed before the last sync, or the link is
        stale.
      </p>
      <p className="text-xs text-muted-foreground">
        Run pnpm sync to refresh, or read it on GitHub.
      </p>
      <a className={secondaryLink} href={githubUrl(issueId, repo)} target="_blank" rel="noreferrer">
        <ExternalLink className="size-3.5" />
        open on GitHub
      </a>
    </section>
  );
}
