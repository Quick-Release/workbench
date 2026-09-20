import { useEffect, useState } from "react";

import {
  clarificationDraftProvenanceKinds,
  clarificationDraftVersion,
  clarificationTaskProfiles,
  noApprovalLine,
  type ClarificationDraftDocument,
  type ClarificationTaskProfile,
} from "../types";
import type { ClarificationDraftProvenance } from "../schema";
import { useClarificationDraft } from "../hooks/use-clarification-draft";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

// The Clarification draft surface (spec #221, ticket #233): the attempt's
// proposal, editable in one place — behavior, scope, exclusions, acceptance
// criteria, labeled assumptions, evidence — every claim showing its
// provenance kind, the task profile gating what the brief still needs, and
// the visible issue-body diff rendering exactly the bytes publication would
// write. The save affordance always says what it is not: saving a draft is
// not publication approval.

const emptyDraft = (): ClarificationDraftDocument => ({
  version: clarificationDraftVersion,
  profile: "unknown",
  behavior: "",
  observation: "",
  reproduction: "",
  boundary: "",
  scope: "",
  exclusions: [],
  acceptance: [],
  dependencies: "",
  performanceClaim: "",
  performanceEvidence: "",
  assumptions: [],
  evidence: [],
});

const behaviorLabelFor = (profile: ClarificationTaskProfile) =>
  profile === "bug"
    ? "Expected behavior"
    : profile === "refactor"
      ? "Behavior-preservation goal"
      : profile === "feature-request"
        ? "Intended behavior"
        : "Behavior";

type TextField = { key: keyof ClarificationDraftDocument; label: string };

// The profile gates which fields the brief needs — the same minimums the
// completeness arithmetic enforces, shown only when they apply.
const textFieldsFor = (profile: ClarificationTaskProfile): TextField[] => {
  const fields: TextField[] = [{ key: "behavior", label: behaviorLabelFor(profile) }];
  if (profile === "bug") {
    fields.push({ key: "observation", label: "Actual behavior" });
    fields.push({ key: "reproduction", label: "Reproduction or reproduction limit" });
  }
  if (profile === "feature-request") {
    fields.push({ key: "boundary", label: "User and system boundary" });
  }
  fields.push({ key: "scope", label: "Bounded scope" });
  if (profile === "feature-request") {
    fields.push({ key: "dependencies", label: "Dependencies and decisions" });
  }
  if (profile === "refactor") {
    fields.push({ key: "performanceClaim", label: "Performance claim" });
    fields.push({ key: "performanceEvidence", label: "Evidence for the performance claim" });
  }
  return fields;
};

const linesOf = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const developerProvenance = (): ClarificationDraftProvenance => ({
  kind: "developer",
  source: "Developer",
  locator: "draft panel",
});

const ProvenanceEditor = ({
  what,
  provenance,
  onChange,
}: {
  what: string;
  provenance: ClarificationDraftProvenance;
  onChange: (provenance: ClarificationDraftProvenance) => void;
}) => (
  <div className="flex flex-wrap items-center gap-1">
    <select
      aria-label={`${what} provenance kind`}
      className="rounded-md border bg-transparent px-1 py-0.5 text-xs"
      value={provenance.kind}
      onChange={(event) =>
        onChange({
          ...provenance,
          kind: event.target.value as ClarificationDraftProvenance["kind"],
        })
      }
    >
      {clarificationDraftProvenanceKinds.map((kind) => (
        <option key={kind} value={kind}>
          {kind}
        </option>
      ))}
    </select>
    <input
      aria-label={`${what} provenance source`}
      className="w-28 rounded-md border bg-transparent px-2 py-0.5 text-xs"
      placeholder="source"
      value={provenance.source}
      onChange={(event) => onChange({ ...provenance, source: event.target.value })}
    />
    <input
      aria-label={`${what} provenance locator`}
      className="w-28 rounded-md border bg-transparent px-2 py-0.5 text-xs"
      placeholder="locator"
      value={provenance.locator}
      onChange={(event) => onChange({ ...provenance, locator: event.target.value })}
    />
  </div>
);

export const ClarificationDraftPanel = ({ issueNumber }: { issueNumber: number }) => {
  const { view, absent, failure, save } = useClarificationDraft(issueNumber);
  const [doc, setDoc] = useState<ClarificationDraftDocument>(emptyDraft);
  const [exclusionLines, setExclusionLines] = useState("");
  const [acceptanceLines, setAcceptanceLines] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The served draft becomes the editing base once per attempt: edits are
  // local until the explicit save, and persistence across reloads is the
  // seam's business, not this component's.
  useEffect(() => {
    if (!view || loadedFor === view.attemptId) return;
    setLoadedFor(view.attemptId);
    if (view.draft) {
      setDoc(view.draft);
      setExclusionLines(view.draft.exclusions.join("\n"));
      setAcceptanceLines(view.draft.acceptance.join("\n"));
    } else {
      setDoc(emptyDraft());
      setExclusionLines("");
      setAcceptanceLines("");
    }
  }, [view, loadedFor]);

  if (absent) return null;
  if (!view)
    return (
      <p className="text-xs text-muted-foreground">
        {failure ?? "looking for this issue's clarification draft…"}
      </p>
    );

  const fields = textFieldsFor(doc.profile);
  const compose = (): ClarificationDraftDocument => ({
    ...doc,
    exclusions: linesOf(exclusionLines),
    acceptance: linesOf(acceptanceLines),
  });
  const onSave = async () => {
    setSaving(true);
    const result = await save(compose());
    setSaving(false);
    setSaveError("error" in result ? result.message : null);
  };

  return (
    <div data-slot="clarification-draft" className="flex flex-col gap-2 border-t pt-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Draft</p>

      <div data-slot="clarification-draft-gaps" className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{view.briefCompleteness}</Badge>
          <span className="text-xs text-muted-foreground">brief completeness</span>
        </div>
        {view.gaps.map((gap) => (
          <p key={gap} className="text-xs text-amber-600">
            {gap}
          </p>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="draft-profile">
          task profile
        </label>
        <select
          id="draft-profile"
          aria-label="draft task profile"
          className="rounded-md border bg-transparent px-1 py-0.5 text-xs"
          value={doc.profile}
          onChange={(event) =>
            setDoc({ ...doc, profile: event.target.value as ClarificationTaskProfile })
          }
        >
          {clarificationTaskProfiles.map((profile) => (
            <option key={profile} value={profile}>
              {profile}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground italic">you classify the work</span>
      </div>

      {fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor={`draft-${field.key}`}>
            {field.label}
          </label>
          <textarea
            id={`draft-${field.key}`}
            aria-label={`draft ${field.key}`}
            className="min-h-16 w-full rounded-md border bg-transparent px-2 py-1 text-sm"
            value={doc[field.key] as string}
            onChange={(event) => setDoc({ ...doc, [field.key]: event.target.value })}
          />
        </div>
      ))}

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="draft-exclusions">
          Exclusions — one per line
        </label>
        <textarea
          id="draft-exclusions"
          aria-label="draft exclusions"
          className="min-h-12 w-full rounded-md border bg-transparent px-2 py-1 text-sm"
          value={exclusionLines}
          onChange={(event) => setExclusionLines(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="draft-acceptance">
          Acceptance criteria — one per line
        </label>
        <textarea
          id="draft-acceptance"
          aria-label="draft acceptance"
          className="min-h-12 w-full rounded-md border bg-transparent px-2 py-1 text-sm"
          value={acceptanceLines}
          onChange={(event) => setAcceptanceLines(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">
          Assumptions — labeled, material ones block
        </p>
        {doc.assumptions.map((assumption, index) => (
          <div key={index} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex gap-1">
              <input
                aria-label={`assumption ${index + 1} label`}
                className="w-28 rounded-md border bg-transparent px-2 py-0.5 text-xs"
                placeholder="label"
                value={assumption.label}
                onChange={(event) =>
                  setDoc({
                    ...doc,
                    assumptions: doc.assumptions.map((entry, at) =>
                      at === index ? { ...entry, label: event.target.value } : entry,
                    ),
                  })
                }
              />
              <input
                aria-label={`assumption ${index + 1} text`}
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-0.5 text-xs"
                placeholder="the assumption"
                value={assumption.text}
                onChange={(event) =>
                  setDoc({
                    ...doc,
                    assumptions: doc.assumptions.map((entry, at) =>
                      at === index ? { ...entry, text: event.target.value } : entry,
                    ),
                  })
                }
              />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  aria-label={`assumption ${index + 1} material`}
                  type="checkbox"
                  checked={assumption.material}
                  onChange={(event) =>
                    setDoc({
                      ...doc,
                      assumptions: doc.assumptions.map((entry, at) =>
                        at === index ? { ...entry, material: event.target.checked } : entry,
                      ),
                    })
                  }
                />
                material
              </label>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`remove assumption ${index + 1}`}
                onClick={() =>
                  setDoc({
                    ...doc,
                    assumptions: doc.assumptions.filter((_, at) => at !== index),
                  })
                }
              >
                remove
              </Button>
            </div>
            <ProvenanceEditor
              what={`assumption ${index + 1}`}
              provenance={assumption.provenance}
              onChange={(provenance) =>
                setDoc({
                  ...doc,
                  assumptions: doc.assumptions.map((entry, at) =>
                    at === index ? { ...entry, provenance } : entry,
                  ),
                })
              }
            />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          aria-label="add assumption"
          onClick={() =>
            setDoc({
              ...doc,
              assumptions: [
                ...doc.assumptions,
                { label: "", text: "", material: false, provenance: developerProvenance() },
              ],
            })
          }
        >
          add assumption
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">
          Evidence — every claim shows where it came from
        </p>
        {doc.evidence.map((item, index) => (
          <div key={index} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex gap-1">
              <input
                aria-label={`evidence ${index + 1} claim`}
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-0.5 text-xs"
                placeholder="the claim"
                value={item.claim}
                onChange={(event) =>
                  setDoc({
                    ...doc,
                    evidence: doc.evidence.map((entry, at) =>
                      at === index ? { ...entry, claim: event.target.value } : entry,
                    ),
                  })
                }
              />
              <Button
                size="xs"
                variant="ghost"
                aria-label={`remove evidence ${index + 1}`}
                onClick={() =>
                  setDoc({
                    ...doc,
                    evidence: doc.evidence.filter((_, at) => at !== index),
                  })
                }
              >
                remove
              </Button>
            </div>
            <ProvenanceEditor
              what={`evidence ${index + 1}`}
              provenance={item.provenance}
              onChange={(provenance) =>
                setDoc({
                  ...doc,
                  evidence: doc.evidence.map((entry, at) =>
                    at === index ? { ...entry, provenance } : entry,
                  ),
                })
              }
            />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          aria-label="add evidence"
          onClick={() =>
            setDoc({
              ...doc,
              evidence: [...doc.evidence, { claim: "", provenance: developerProvenance() }],
            })
          }
        >
          add evidence
        </Button>
        <p className="text-xs text-muted-foreground italic">
          tracker · read from the issue — research · documentation — model · the runtime&apos;s
          proposal, never authority — developer · you
        </p>
      </div>

      {view.diff ? (
        <div data-slot="clarification-draft-diff" className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            Issue body diff{" "}
            {view.diff.unchanged ? "— unchanged" : `+${view.diff.added} −${view.diff.removed}`}
            {" — exactly what publication would write"}
          </p>
          <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-1 font-mono text-xs">
            {view.diff.lines.map((line, index) => (
              <p
                key={index}
                data-diff-kind={line.kind}
                className={
                  line.kind === "added"
                    ? "text-green-700 dark:text-green-400"
                    : line.kind === "removed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
                }
              >
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                {line.text}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {view.warnings.length > 0 && (
        <div data-slot="clarification-draft-warnings" className="flex flex-col gap-1">
          {view.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-600">
              {warning}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-label="save draft" disabled={saving} onClick={() => void onSave()}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
        <span className="text-xs italic text-muted-foreground">{noApprovalLine}</span>
        {saveError && <span className="text-xs text-red-600">{saveError}</span>}
      </div>
      {view.savedAt && <p className="text-xs text-muted-foreground">saved · {view.savedAt}</p>}
    </div>
  );
};
