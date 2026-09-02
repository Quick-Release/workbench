import { defineConfig } from "vite-plus";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  fmt: {
    ignorePatterns: ["src/routeTree.gen.ts"],
  },
  lint: {
    ignorePatterns: ["src/routeTree.gen.ts"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
  plugins: [tanstackRouter({ target: "react" }), react()],
});
