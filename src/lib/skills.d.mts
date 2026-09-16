// Types for skills.mjs (GH-195): the implementation is plain ESM so the
// installed CLI's raw-Node sync can import it from node_modules.
export declare const mattPocockSkillSource: {
  readonly id: "matt-pocock";
  readonly name: "Matt Pocock Skills";
  readonly repository: "mattpocock/skills";
  readonly repositoryUrl: "https://github.com/mattpocock/skills";
  readonly installCommand: "npx skills@latest add mattpocock/skills --all";
};

export declare const perSkillInstallCommand: (id: string) => string;

export declare const favoriteSkillIds: readonly [
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
