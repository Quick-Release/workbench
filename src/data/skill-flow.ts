// The curated typed module ADR 0006 specifies: classification (flow role,
// blurbs) and the skill flow edges shadow the ask-matt map's prose, edge by
// edge. The Catalog itself (which skills exist, id + category) is fetched from
// mattpocock/skills at sync time; this module only classifies. The offline
// fallback catalog below is the last resort when the upstream fetch and the
// last-good generated data are both unavailable.
//
// Draft transcribed from .agents/skills/ask-matt/SKILL.md and the approved
// flow-graph prototype (decision ticket #50), which is the landing design.

import type { SkillClassification, SkillFlowEdge } from "../types";

export const skillFlowClassification = {
  "grill-with-docs": {
    role: "main-flow",
    blurb:
      "Sharpens an idea by relentless interview, retaining what it learns in CONTEXT.md and ADRs.",
    when: "Start here for any idea, while working in a working directory.",
  },
  "to-spec": {
    role: "main-flow",
    blurb: "Turns the conversation into a specification for the issue tracker.",
    when: "The grilling settled every question; the build is a multi-session effort.",
  },
  "to-tickets": {
    role: "main-flow",
    blurb: "Splits the spec into small tracer-bullet tickets with blocking edges.",
    when: "A spec exists; work must be split so each implement starts fresh.",
  },
  implement: {
    role: "main-flow",
    blurb: "Builds one ticket by driving TDD internally, closing with a two-axis code review.",
    when: "A frontier ticket is picked; one unbroken session per ticket.",
  },
  handoff: {
    role: "main-flow",
    blurb: "Writes a portable markdown handoff file to bridge a context boundary.",
    when: "New harness, new directory, colleague, or a side task forked mid-phase — here, bridging out to a prototype and back.",
  },
  prototype: {
    role: "main-flow",
    blurb: "A throwaway program that answers one design question a conversation cannot.",
    when: "A question needs a runnable answer — state, business logic, a UI you have to see.",
  },
  triage: {
    role: "on-ramp",
    blurb: "Moves incoming issues through triage roles and produces agent-ready briefs.",
    when: "Bugs and requests you didn't create are piling up. Its output merges at implement.",
  },
  "diagnosing-bugs": {
    role: "on-ramp",
    blurb:
      "Turns a hard bug into a reproducible, instrumented diagnosis loop, then fixes it with a regression test.",
    when: "The bug resists a first glance. Post-mortem hands off to improve-codebase-architecture.",
  },
  wayfinder: {
    role: "on-ramp",
    blurb: "Charts a foggy effort as a map of decision tickets and resolves them one at a time.",
    when: "The effort is too big for one session. Merges at to-spec when the map clears — it hands off, it doesn't build.",
  },
  grilling: {
    role: "primitive",
    blurb:
      "The interview primitive itself: rounds, the frontier, facts are the agent's job and decisions are yours.",
    when: "Directly, only when you want the interview with no wrapper around it.",
  },
  "domain-modeling": {
    role: "vocabulary",
    blurb: "Sharpens the domain language: challenge terms, resolve overloads, record ADRs.",
    when: "The words, not the process, are the problem.",
  },
  "codebase-design": {
    role: "vocabulary",
    blurb:
      "The deep-module vocabulary for designing a module's shape: behaviour behind a small interface at a clean seam.",
    when: "Designing the chosen deepening opportunity; spoken by tdd and improve-codebase-architecture.",
  },
  tdd: {
    role: "standalone",
    blurb: "Keeps implementation feedback tight with a red-green-refactor loop.",
    when: "You want one concrete behaviour built test-first, no spec needed. Also what implement drives internally.",
  },
  "code-review": {
    role: "standalone",
    blurb: "Two-axis review (Standards + Spec) of a diff against a fixed point.",
    when: "Any branch or PR to review. Also how implement closes out.",
  },
  "improve-codebase-architecture": {
    role: "standalone",
    blurb: "Surveys the codebase for high-value deepening opportunities.",
    when: "Spare moments. Picking one generates an idea that enters the main flow at grill-with-docs.",
  },
  research: {
    role: "standalone",
    blurb: "Delegates reading legwork to a background agent; leaves a cited findings file.",
    when: "The answer is in primary sources, not your head. Feed the file into grill-with-docs.",
  },
  "to-questionnaire": {
    role: "standalone",
    blurb: "Writes a questionnaire aimed at the gap in someone else's head.",
    when: "The blocker is knowledge you don't have and can't reach yourself.",
  },
  "grill-me": {
    role: "standalone",
    blurb:
      "The same relentless interview as grill-with-docs, but stateless — it saves nothing locally.",
    when: "Sharpening a plan or a piece of writing with no repo under it.",
  },
  "ask-matt": {
    role: "standalone",
    blurb: "The router over this whole graph: asks which skill or flow fits your situation.",
    when: "You don't remember every skill, so ask.",
  },
  "resolving-merge-conflicts": {
    role: "standalone",
    blurb:
      "Works a merge or rebase conflict hunk by hunk, resolving by intent traced to each side's primary source.",
    when: "You are already mid-conflict. Never runs --abort.",
  },
  "setup-matt-pocock-skills": {
    role: "standalone",
    blurb: "Configures the issue tracker, triage labels, and doc layout the other skills assume.",
    when: "Once, before your first engineering flow in a repo.",
  },
  wizard: {
    role: "standalone",
    blurb: "Generates an interactive bash script for the steps only a human can take.",
    when: "Provisioning, credentials, CI secrets, third-party dashboards, one-off cutovers.",
  },
  "wait-what": {
    role: "standalone",
    blurb: "The corrective for a message that didn't land: re-pitches it with the missing context.",
    when: "Mid-conversation, inside any other skill, right after the confusion.",
  },
  teach: {
    role: "standalone",
    blurb:
      "Learn a concept over multiple sessions, using the current directory as a stateful workspace.",
    when: "Understanding, not shipping, is the goal.",
  },
  "writing-for-agents": {
    role: "standalone",
    blurb:
      "The reference for writing documents agents consume: skills, AGENTS.md, pointed-at docs.",
    when: "Any document whose reader is an agent.",
  },
  "git-guardrails-claude-code": {
    role: "standalone",
    blurb: "Guardrail configuration so git operations stay inside their guardrails.",
    when: "Set up once per harness; off every flow.",
  },
  "migrate-to-shoehorn": {
    role: "standalone",
    blurb: "Migrates a repo onto the shoehorn layout.",
    when: "One-off migration; off every flow.",
  },
  "scaffold-exercises": {
    role: "standalone",
    blurb: "Scaffolds exercise material.",
    when: "Course-style repos; off every flow.",
  },
  "setup-pre-commit": {
    role: "standalone",
    blurb: "Sets up pre-commit hooks for the repo.",
    when: "One-off setup; off every flow.",
  },
  "claude-handoff": {
    role: null,
    blurb: "Handoff variant for Claude Code. Upstream work in progress.",
    when: "",
  },
  "implement-spec": {
    role: null,
    blurb: "Implement from an OpenSpec-style change. Upstream work in progress.",
    when: "",
  },
  "loop-me": {
    role: null,
    blurb: "Loop a prompt on a schedule. Upstream work in progress.",
    when: "",
  },
  retro: {
    role: null,
    blurb: "Run a retrospective. Upstream work in progress.",
    when: "",
  },
  "setup-ts-deep-modules": {
    role: null,
    blurb: "Set up the TypeScript deep-modules scaffold. Upstream work in progress.",
    when: "",
  },
  "writing-beats": {
    role: null,
    blurb: "Writing beats reference. Upstream work in progress.",
    when: "",
  },
  "writing-fragments": {
    role: null,
    blurb: "Writing fragments reference. Upstream work in progress.",
    when: "",
  },
  "writing-shape": {
    role: null,
    blurb: "Writing shape reference. Upstream work in progress.",
    when: "",
  },
} satisfies Record<string, SkillClassification>;

export const skillFlowEdges = [
  // spine progression
  { from: "grill-with-docs", to: "to-spec", kind: "next-step" },
  { from: "to-spec", to: "to-tickets", kind: "next-step" },
  { from: "to-tickets", to: "implement", kind: "next-step" },
  // prototype detour, bridged by handoff both ways
  { from: "grill-with-docs", to: "handoff", kind: "hands-off-to" },
  { from: "handoff", to: "prototype", kind: "next-step" },
  { from: "prototype", to: "handoff", kind: "next-step" },
  { from: "handoff", to: "to-spec", kind: "next-step" },
  // on-ramps merging on
  { from: "wayfinder", to: "to-spec", kind: "merges-onto" },
  { from: "triage", to: "implement", kind: "merges-onto" },
  { from: "diagnosing-bugs", to: "implement", kind: "merges-onto" },
  // feeds into the flow
  { from: "improve-codebase-architecture", to: "grill-with-docs", kind: "hands-off-to" },
  { from: "diagnosing-bugs", to: "improve-codebase-architecture", kind: "hands-off-to" },
  { from: "research", to: "grill-with-docs", kind: "hands-off-to" },
  { from: "to-questionnaire", to: "grill-with-docs", kind: "hands-off-to" },
  // runs internally
  { from: "grill-with-docs", to: "grilling", kind: "runs-internally" },
  { from: "grill-me", to: "grilling", kind: "runs-internally" },
  { from: "grill-with-docs", to: "domain-modeling", kind: "runs-internally" },
  { from: "implement", to: "tdd", kind: "runs-internally" },
  { from: "implement", to: "code-review", kind: "runs-internally" },
  { from: "tdd", to: "codebase-design", kind: "runs-internally" },
  { from: "improve-codebase-architecture", to: "codebase-design", kind: "runs-internally" },
] satisfies readonly SkillFlowEdge[];

// The offline floor for the catalog collector: used only when the upstream
// trees fetch and the last-good generated data are both unavailable.
export const offlineFallbackCatalog: Array<{ id: string; category: string }> = [
  { id: "ask-matt", category: "engineering" },
  { id: "claude-handoff", category: "in-progress" },
  { id: "code-review", category: "engineering" },
  { id: "codebase-design", category: "engineering" },
  { id: "diagnosing-bugs", category: "engineering" },
  { id: "domain-modeling", category: "engineering" },
  { id: "git-guardrails-claude-code", category: "misc" },
  { id: "grill-me", category: "productivity" },
  { id: "grill-with-docs", category: "engineering" },
  { id: "grilling", category: "productivity" },
  { id: "handoff", category: "productivity" },
  { id: "implement", category: "engineering" },
  { id: "implement-spec", category: "in-progress" },
  { id: "improve-codebase-architecture", category: "engineering" },
  { id: "loop-me", category: "in-progress" },
  { id: "migrate-to-shoehorn", category: "misc" },
  { id: "prototype", category: "engineering" },
  { id: "research", category: "engineering" },
  { id: "resolving-merge-conflicts", category: "engineering" },
  { id: "retro", category: "in-progress" },
  { id: "scaffold-exercises", category: "misc" },
  { id: "setup-matt-pocock-skills", category: "engineering" },
  { id: "setup-pre-commit", category: "misc" },
  { id: "setup-ts-deep-modules", category: "in-progress" },
  { id: "tdd", category: "engineering" },
  { id: "teach", category: "productivity" },
  { id: "to-questionnaire", category: "productivity" },
  { id: "to-spec", category: "engineering" },
  { id: "to-tickets", category: "engineering" },
  { id: "triage", category: "engineering" },
  { id: "wait-what", category: "productivity" },
  { id: "wayfinder", category: "engineering" },
  { id: "wizard", category: "engineering" },
  { id: "writing-beats", category: "in-progress" },
  { id: "writing-for-agents", category: "productivity" },
  { id: "writing-fragments", category: "in-progress" },
  { id: "writing-shape", category: "in-progress" },
];

// Presentation order for the stacked lanes; the layout module appends any
// unclassified ids alphabetically after these.
export const curatedShelfOrder = [
  "tdd",
  "code-review",
  "improve-codebase-architecture",
  "research",
  "to-questionnaire",
  "grill-me",
  "ask-matt",
  "resolving-merge-conflicts",
  "setup-matt-pocock-skills",
  "wizard",
  "wait-what",
  "teach",
  "writing-for-agents",
  "git-guardrails-claude-code",
  "migrate-to-shoehorn",
  "scaffold-exercises",
  "setup-pre-commit",
];

export const curatedPenOrder = [
  "claude-handoff",
  "implement-spec",
  "loop-me",
  "retro",
  "setup-ts-deep-modules",
  "writing-beats",
  "writing-fragments",
  "writing-shape",
];

export const skillClassification = (id: string): SkillClassification | undefined =>
  (skillFlowClassification as Record<string, SkillClassification>)[id];
