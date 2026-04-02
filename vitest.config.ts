import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000, // LLM calls take time
    hookTimeout: 30_000,
  },
});
