// Typed surface of scripts/tracker/index.mjs for the dashboard's TypeScript
// side (spec #221's clarification collectors reuse the tracker reads, and the
// read-completeness tests drive the real collector). The full record shapes
// live in src/schema.ts — the collector's output crosses that schema at sync,
// so this declaration carries only the loosest honest shape.
export declare const collectTrackerState: (input: {
  repo: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  ghToken?: () => Promise<string>;
  apiBaseUrl?: string;
  tokenEnv?: string;
  maxPages?: number;
  vocabulary?: unknown;
  vocabularyPath?: string;
  phaseClocks?: Map<string, unknown>;
}) => Promise<{
  workItems: Record<string, unknown>[];
  maps: Record<string, unknown>[];
  blockerEdges: Record<string, unknown>[];
  decisions: unknown[];
  warnings: string[];
  [key: string]: unknown;
}>;
