import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 20000,
    include: ["test/**/*.test.ts"],
  },
});
