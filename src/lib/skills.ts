export const mattPocockSkillSource = {
  id: "matt-pocock",
  name: "Matt Pocock Skills",
  repository: "mattpocock/skills",
  repositoryUrl: "https://github.com/mattpocock/skills",
  installCommand: "npx skills@latest add mattpocock/skills --all",
} as const;

export const favoriteSkills = [
  {
    id: "grill-with-docs",
    name: "Grill with docs",
    category: "Engineering",
    description: "Clarify a change while building the shared domain language and decision records.",
    path: "skills/engineering/grill-with-docs",
  },
  {
    id: "implement",
    name: "Implement",
    category: "Engineering",
    description: "Build work from a specification or tickets with tests and a final code review.",
    path: "skills/engineering/implement",
  },
  {
    id: "code-review",
    name: "Code review",
    category: "Engineering",
    description: "Review a change against both the repository standards and its originating spec.",
    path: "skills/engineering/code-review",
  },
  {
    id: "tdd",
    name: "TDD",
    category: "Engineering",
    description: "Keep implementation feedback tight with a red-green-refactor loop.",
    path: "skills/engineering/tdd",
  },
  {
    id: "diagnosing-bugs",
    name: "Diagnosing bugs",
    category: "Engineering",
    description:
      "Turn a difficult bug or regression into a reproducible, instrumented diagnosis loop.",
    path: "skills/engineering/diagnosing-bugs",
  },
  {
    id: "codebase-design",
    name: "Codebase design",
    category: "Engineering",
    description: "Design deep modules with simple interfaces and clean, testable seams.",
    path: "skills/engineering/codebase-design",
  },
  {
    id: "improve-codebase-architecture",
    name: "Improve codebase architecture",
    category: "Engineering",
    description: "Survey a codebase for high-value opportunities to simplify its architecture.",
    path: "skills/engineering/improve-codebase-architecture",
  },
  {
    id: "research",
    name: "Research",
    category: "Engineering",
    description: "Investigate a question against high-trust sources and record cited findings.",
    path: "skills/engineering/research",
  },
  {
    id: "to-spec",
    name: "To spec",
    category: "Engineering",
    description:
      "Turn the current conversation into a specification for the project issue tracker.",
    path: "skills/engineering/to-spec",
  },
  {
    id: "to-tickets",
    name: "To tickets",
    category: "Engineering",
    description: "Break a plan or specification into small tickets with their blocking edges.",
    path: "skills/engineering/to-tickets",
  },
  {
    id: "triage",
    name: "Triage",
    category: "Engineering",
    description: "Move issues through a deliberate state machine and produce agent-ready briefs.",
    path: "skills/engineering/triage",
  },
  {
    id: "setup-matt-pocock-skills",
    name: "Setup Matt Pocock Skills",
    category: "Engineering",
    description: "Configure a repository's issue tracker, triage labels, and domain documentation.",
    path: "skills/engineering/setup-matt-pocock-skills",
  },
] as const;
