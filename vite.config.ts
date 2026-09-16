import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { skillsApiPlugin } from "./scripts/seam/routes/skills-api.mjs";
import { toolsApiPlugin } from "./scripts/seam/routes/tools-api.mjs";
import { workflowApiPlugin } from "./scripts/seam/routes/workflow-api.mjs";
import { aiApiPlugin } from "./scripts/seam/routes/ai-api.mjs";
import { llmApiPlugin } from "./scripts/seam/routes/llm-api.mjs";
import { submissionsApiPlugin } from "./scripts/seam/routes/submissions-api.mjs";
import { reviewApiPlugin } from "./scripts/seam/routes/review-api.mjs";
import { reviewCommentApiPlugin } from "./scripts/seam/routes/review-comment-api.mjs";

// This config ships in the npm package and loads on every installed-CLI
// startup (`bin.mjs` runs `vp dev` from the package directory), so it may
// import only runtime dependencies and touch only packaged resources. The
// Workers test project lives in vite.worker.config.ts — test-only, never
// shipped (ticket #113).
//
// Shared by the dev/build pipeline and the dashboard test project: vitest
// projects don't inherit the root config's plugins or resolve (ticket #29).
const dashboardPlugins = [
  // Route tests live beside their routes; the router must not treat them as
  // route files when it generates the route tree.
  tanstackRouter({ target: "react", routeFileIgnorePattern: "\\.test\\.(ts|tsx)$" }),
  react(),
  tailwindcss(),
  toolsApiPlugin(),
  skillsApiPlugin(),
  workflowApiPlugin(),
  aiApiPlugin(),
  llmApiPlugin(),
  submissionsApiPlugin(),
  reviewApiPlugin(),
  reviewCommentApiPlugin(),
];
const dashboardAlias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  fmt: {
    ignorePatterns: ["src/routeTree.gen.ts", ".zcode", ".firecrawl"],
  },
  lint: {
    ignorePatterns: ["src/routeTree.gen.ts", ".zcode", ".firecrawl"],
  },
  test: {
    projects: [
      // The dashboard suite: browser-side components and libs, default pool.
      {
        plugins: dashboardPlugins,
        resolve: { alias: dashboardAlias },
        test: {
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
  plugins: dashboardPlugins,
  resolve: { alias: dashboardAlias },
});
