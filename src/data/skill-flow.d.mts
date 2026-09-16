// Types for skill-flow.mjs (GH-195): the implementation is plain ESM so the
// installed CLI's raw-Node sync can import it from node_modules. The
// declarations carry the type-checking the .mjs's dropped `satisfies`
// clauses used to provide.
import type { SkillClassification, SkillFlowEdge } from "../types";

export declare const skillFlowClassification: Record<string, SkillClassification>;
export declare const skillFlowEdges: readonly SkillFlowEdge[];
export declare const offlineFallbackCatalog: Array<{ id: string; category: string }>;
export declare const curatedShelfOrder: string[];
export declare const curatedPenOrder: string[];
export declare const skillClassification: (id: string) => SkillClassification | undefined;
