import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      // core's own tests use the mock computer as a fixture, but mock
      // depends on core — a package-level devDependency here would make
      // core and mock a build cycle pnpm can't order. Resolving straight to
      // source keeps the test import working without that cycle.
      "@teachreplay/mock": fileURLToPath(new URL("./packages/mock/src/index.ts", import.meta.url)),
    },
  },
});
