import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

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
  plugins: [tanstackRouter({ target: "react" }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
