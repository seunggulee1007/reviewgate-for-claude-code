import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Renderer only; the main process and preload are bundled by esbuild (scripts/build.mjs).
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  base: "./",
  plugins: [
    react(),
    {
      // The packaged renderer has no dev server: its CSP allows no connections beyond 'self' (index.html keeps vite's HMR socket for `npm run dev`).
      name: "reviewgate-csp",
      apply: "build",
      transformIndexHtml: (html) => html.replace(/connect-src [^;"]*/, "connect-src 'self'"),
    },
  ],
  resolve: {
    alias: { "@reviewgate/engine": fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
    target: "chrome130",
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: "iife" },
  server: { port: 5183, strictPort: true },
});
