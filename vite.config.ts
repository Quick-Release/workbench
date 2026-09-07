import tailwindcss from "@tailwindcss/vite";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { skillsApiPlugin } from "./scripts/skills-api.mjs";
import { toolsApiPlugin } from "./scripts/tools-api.mjs";
import { workflowApiPlugin } from "./scripts/workflow-api.mjs";
import { aiApiPlugin } from "./scripts/ai-api.mjs";

// Shared by the dev/build pipeline and the dashboard test project: vitest
// projects don't inherit the root config's plugins or resolve (ticket #29).
const dashboardPlugins = [
  tanstackRouter({ target: "react" }),
  react(),
  tailwindcss(),
  toolsApiPlugin(),
  skillsApiPlugin(),
  workflowApiPlugin(),
  aiApiPlugin(),
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
      // The worker suite (ticket #29): behavioral tests driven inside the
      // real workerd runtime against the deployed-config entry — same
      // wrangler.jsonc alchemy deploys, requests in, responses out.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./worker/wrangler.jsonc" },
          }),
        ],
        test: {
          include: ["worker/runtime.test.mjs"],
          pool: "@cloudflare/vitest-pool-workers",
        },
      },
    ],
  },
  plugins: dashboardPlugins,
  resolve: { alias: dashboardAlias },
});
