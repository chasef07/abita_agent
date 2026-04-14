import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    exclude: [
      ".claude/**",
      "dist/**",
      "node_modules/**",
      "src/__tests__/replay.test.ts",
    ],
  },
});
