// Builds dist/main/main.mjs (ESM, engine bundled, SDK external), dist/main/preload.cjs and dist/renderer/ (vite).
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const enginePath = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));

export async function buildMain({ watch = false } = {}) {
  const common = {
    bundle: true,
    platform: "node",
    target: "node20",
    sourcemap: true,
    alias: { "@reviewgate/engine": enginePath },
    external: ["electron", "@anthropic-ai/claude-agent-sdk"],
    logLevel: "info",
  };
  const main = { ...common, entryPoints: [`${root}src/main/main.ts`], outfile: `${root}dist/main/main.mjs`, format: "esm" };
  const preload = { ...common, entryPoints: [`${root}src/preload.ts`], outfile: `${root}dist/main/preload.cjs`, format: "cjs" };
  if (watch) {
    const { context } = await import("esbuild");
    const a = await context(main);
    const b = await context(preload);
    await Promise.all([a.watch(), b.watch()]);
    return;
  }
  await build(main);
  await build(preload);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await rm(`${root}dist`, { recursive: true, force: true });
  await buildMain();
  await viteBuild({ configFile: `${root}vite.config.ts`, logLevel: "info" });
}
