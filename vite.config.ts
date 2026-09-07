import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { skillsApiPlugin } from "./scripts/skills-api.mjs";
import { toolsApiPlugin } from "./scripts/tools-api.mjs";
import { workflowApiPlugin } from "./scripts/workflow-api.mjs";
import { aiApiPlugin } from "./scripts/ai-api.mjs";

export default defineConfig({
  fmt: {
    ignorePatterns: ["src/routeTree.gen.ts", ".zcode", ".firecrawl"],
  },
  lint: {
    ignorePatterns: ["src/routeTree.gen.ts", ".zcode", ".firecrawl"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
  plugins: [
    tanstackRouter({ target: "react" }),
    react(),
    tailwindcss(),
    toolsApiPlugin(),
    skillsApiPlugin(),
    workflowApiPlugin(),
    aiApiPlugin(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
