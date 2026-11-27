// MARK: lsp — docs/PROTOCOL.md §73.1 / §73.4: which tsserver runs (the project's own TypeScript 5.x–6.x when it is
// installed, else the bundled 6.0.3) and where the bundle with the Vue plugin is.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The bundle: tsserver and the folder holding `node_modules/@vue/typescript-plugin`. */
export type LspBundle = { tsserver: string; pluginProbe: string; typescriptVersion: string };
export type TsServerChoice = { tsserver: string; pluginProbe: string; typescript: { version: string; source: "project" | "bundled" } };

const readVersion = (pkgJson: string): string | null => {
  try {
    const v = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
};

/** `<dir>/node_modules/typescript/lib/tsserver.js` and `<dir>/node_modules/@vue/typescript-plugin`, else null. */
function bundleAt(dir: string): LspBundle | null {
  const tsserver = join(dir, "node_modules", "typescript", "lib", "tsserver.js");
  const version = readVersion(join(dir, "node_modules", "typescript", "package.json"));
  if (!version || !existsSync(tsserver) || !existsSync(join(dir, "node_modules", "@vue", "typescript-plugin", "package.json"))) return null;
  return { tsserver, pluginProbe: dir, typescriptVersion: version };
}

/** The development workspace (`packaging/lsp`, resolved through `node_modules`): its typescript and the plugin's folder. */
function devBundle(): LspBundle | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = dirname(req.resolve("@reviewgate/lsp-bundle/package.json"));
    const tsPkg = req.resolve("typescript/package.json", { paths: [pkg] });
    const vuePkg = req.resolve("@vue/typescript-plugin/package.json", { paths: [pkg] });
    const marker = `${sep}node_modules${sep}@vue${sep}typescript-plugin${sep}package.json`;
    const version = readVersion(tsPkg);
    if (!version || !vuePkg.endsWith(marker)) return null;
    return { tsserver: join(dirname(tsPkg), "lib", "tsserver.js"), pluginProbe: vuePkg.slice(0, -marker.length), typescriptVersion: version };
  } catch {
    return null;
  }
}

/**
 * §73.4: `lspDir` (EngineOptions), else `REVIEWGATE_LSP_DIR`, else `lsp/` next to the running engine file (`sidecar.mjs`),
 * else the development workspace. Null: no usable bundle (`unavailable`).
 */
export function findBundle(lspDir?: string, env: Record<string, string | undefined> = process.env): LspBundle | null {
  if (lspDir) return bundleAt(lspDir);
  if (env.REVIEWGATE_LSP_DIR) return bundleAt(env.REVIEWGATE_LSP_DIR);
  let here: string | null = null;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    // not a file URL
  }
  return (here ? bundleAt(join(here, "lsp")) : null) ?? devBundle();
}

/** A TypeScript the Vue plugin and the protocol work with: 5.0 up to (not including) 7 — 7 is the native port. */
export function usableTypeScript(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  return major >= 5 && major < 7;
}

/**
 * §73.1: the project's `node_modules/typescript` when it is 5.x–6.x with a tsserver and git does not list it (installed,
 * not committed — `listed` = the paths `git ls-files --cached --others --exclude-standard` gave), else the bundle's.
 */
export function chooseTsServer(root: string, bundle: LspBundle, listed: ReadonlySet<string>): TsServerChoice {
  const dir = join(root, "node_modules", "typescript");
  const version = readVersion(join(dir, "package.json"));
  const tsserver = join(dir, "lib", "tsserver.js");
  if (version && usableTypeScript(version) && existsSync(tsserver) && !listed.has("node_modules/typescript/package.json") && !listed.has("node_modules/typescript/lib/tsserver.js")) {
    return { tsserver, pluginProbe: bundle.pluginProbe, typescript: { version, source: "project" } };
  }
  return { tsserver: bundle.tsserver, pluginProbe: bundle.pluginProbe, typescript: { version: bundle.typescriptVersion, source: "bundled" } };
}
