import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
