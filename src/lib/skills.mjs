// Plain ESM so the installed CLI's raw-Node sync can import it from
// node_modules, where Node refuses to type-strip TypeScript (GH-195); types
// live in the sibling .d.mts.
export const mattPocockSkillSource = {
  id: "matt-pocock",
  name: "Matt Pocock Skills",
  repository: "mattpocock/skills",
  repositoryUrl: "https://github.com/mattpocock/skills",
  installCommand: "npx skills@latest add mattpocock/skills --all",
};

// Mirrors the seam's per-skill install (scripts/seam/routes/skills-api.mjs) for the
// static-build copy-the-command degradation.
export const perSkillInstallCommand = (id) =>
  `npx skills@latest add ${mattPocockSkillSource.repository} --skill ${id}`;

// The favorites lens over the flow graph — a filter, not a second home.
export const favoriteSkillIds = [
  "grill-with-docs",
  "implement",
  "code-review",
  "tdd",
  "diagnosing-bugs",
  "codebase-design",
  "improve-codebase-architecture",
  "research",
  "to-spec",
  "to-tickets",
  "triage",
  "setup-matt-pocock-skills",
];
