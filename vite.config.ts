import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { toolsApiPlugin } from "./scripts/tools-api.mjs";

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
  plugins: [tanstackRouter({ target: "react" }), react(), tailwindcss(), toolsApiPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
