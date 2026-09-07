// Server-side prompt assembly for the draft endpoint: the PR record plus the
// host repo's recent commit subjects (local git history only — no additional
// GitHub calls). The prompt names the two fields the structured-output schema
// expects, so a draft can lift straight into the PR form.

export const buildDraftPrompt = ({ pr, commitSubjects }) => {
  const style = commitSubjects.length
    ? commitSubjects.map((subject) => `- ${subject}`).join("\n")
    : "- (none)";
  return [
    "You draft pull-request descriptions for a software repository.",
    "",
    `Pull request #${pr.number} by ${pr.author}, ${pr.isDraft ? "draft" : "ready"}, branch ${pr.head} into ${pr.base}.`,
    `Title: ${pr.title}`,
    `Body: ${pr.body?.trim() || "(none)"}`,
    "",
    "Recent commit subjects from this repository, as a style reference:",
    style,
    "",
    "Write a pull-request description for this pull request: a one-line `title` in the repo's commit-subject style, and a `body` that explains what the change does and why. Reply with only the title and body.",
  ].join("\n");
};
