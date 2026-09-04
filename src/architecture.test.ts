import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

// ADR 0005 — the browser talks only to the localhost execution seam:
// no fetch outside /api/-relative URLs, and no Node builtins or tracker
// clients imported into browser code. This file is excluded from its own scan.

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

const BANNED_IMPORTS = ["node:", "child_process", "octokit", "@octokit/", "undici"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(SOURCE_ROOT);

describe("ADR 0005 execution-seam invariant", () => {
  it("never fetches anything but /api/-relative URLs", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/fetch\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')?/g)) {
        const arg = match[1];
        if (!arg || !arg.slice(1).startsWith("/api/")) {
          violations.push(`${file}: fetch(${arg ?? "<non-literal argument>"})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("imports no Node builtins or tracker clients into browser code", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/(?:from\s*|import\s+|require\()\s*["']([^"']+)["']/g)) {
        const source = match[1];
        if (BANNED_IMPORTS.some((banned) => source === banned || source.startsWith(banned))) {
          violations.push(`${file}: imports "${source}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
