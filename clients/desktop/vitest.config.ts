import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests of the pure modules of the main process (src/main/*.test.ts) and the renderer (src/renderer/*.test.ts).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: { "@reviewgate/engine": fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["src/main/**/*.test.ts", "src/renderer/**/*.test.ts"],
    environment: "node",
    // Cold imports of the store and big component graphs run inside the first test or hook of each (isolated) file; slow CI runners need far more than 5 s / 10 s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
