// `npm run dev`: vite dev server (HMR) + esbuild watch for main/preload + electron pointed at the dev server.
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildMain } from "./build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const electron = require("electron");

await buildMain({ watch: true });
const server = await createServer({ configFile: `${root}vite.config.ts` });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5183/";
const child = spawn(electron, [root, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on("exit", (code) => {
  void server.close();
  process.exit(code ?? 0);
});
