#!/usr/bin/env node
// Assembles the language server ReviewGate ships for JavaScript / TypeScript / Vue (docs/PROTOCOL.md §73) into <outDir>:
//   <outDir>/node_modules/typescript/            — TypeScript's tsserver: only what it runs (lib/tsserver.js, _tsserver.js,
//                                                   typescript.js, the lib.*.d.ts files, typesMap.json, watchGuard.js),
//                                                   its package.json and licence files; no tsc, no typings, no locales
//   <outDir>/node_modules/@vue/typescript-plugin/ — the Vue plugin and everything it requires bundled into one index.js
//                                                   (esbuild; `typescript` stays external: tsserver hands the plugin its own)
//   <outDir>/LICENSES.md                          — every shipped package's licence, for the third-party notices
//   <outDir>/.lsp-stamp                           — the versions it was built from; an unchanged stamp skips the work
// Pure JavaScript and .d.ts files: nothing native, nothing to sign or notarize separately.
// Usage: node scripts/build-lsp.mjs <outDir>   (scripts/build-sidecar.sh → sidecar/dist/lsp; clients/desktop/scripts/build.mjs
// → clients/desktop/lsp-dist/lsp). The versions are packaging/lsp/package.json's (a workspace: `npm ci` installs them).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(repo, "sidecar/dist/lsp");
if (basename(outDir) !== "lsp") {
  console.error(`build-lsp: the output folder must be named "lsp" (got ${outDir})`);
  process.exit(2);
}
const bundleDir = join(repo, "packaging/lsp");
const req = createRequire(join(bundleDir, "package.json"));
const pkgDir = (name) => dirname(req.resolve(`${name}/package.json`));
const tsDir = pkgDir("typescript");
const vueDir = pkgDir("@vue/typescript-plugin");
const version = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
const stamp = `typescript=${version(tsDir)}\n@vue/typescript-plugin=${version(vueDir)}\nscript=3\n`;
const stampFile = join(outDir, ".lsp-stamp");

if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp
  && existsSync(join(outDir, "node_modules/typescript/lib/tsserver.js")) && existsSync(join(outDir, "node_modules/@vue/typescript-plugin/index.js"))) {
  console.log(`build-lsp: ${outDir} up to date (${stamp.trim().replace(/\n/g, ", ")})`);
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
const tsOut = join(outDir, "node_modules/typescript");
mkdirSync(join(tsOut, "lib"), { recursive: true });
for (const f of ["package.json", "LICENSE.txt", "ThirdPartyNoticeText.txt"]) copyFileSync(join(tsDir, f), join(tsOut, f));
const runtime = new Set(["tsserver.js", "_tsserver.js", "typescript.js", "typesMap.json", "watchGuard.js"]);
for (const f of readdirSync(join(tsDir, "lib"))) {
  if (runtime.has(f) || /^lib\..*\.d\.ts$/.test(f)) copyFileSync(join(tsDir, "lib", f), join(tsOut, "lib", f));
}

// The Vue plugin: one file. esbuild is the sidecar's own build tool (a workspace devDependency).
// A file URL: on Windows an absolute path is not an ESM specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME, "protocol 'd:'").
const { build } = await import(pathToFileURL(pathToEsbuild()).href);
const vueOut = join(outDir, "node_modules/@vue/typescript-plugin");
mkdirSync(vueOut, { recursive: true });
const result = await build({
  entryPoints: [join(vueDir, "index.js")], bundle: true, platform: "node", format: "cjs", target: "node20", minify: true,
  outfile: join(vueOut, "index.js"), external: ["typescript"], metafile: true, legalComments: "none", logLevel: "warning",
});
writeFileSync(join(vueOut, "package.json"), JSON.stringify({ name: "@vue/typescript-plugin", version: version(vueDir), main: "index.js", license: "MIT" }, null, 2) + "\n");
copyFileSync(join(vueDir, "LICENSE"), join(vueOut, "LICENSE"));

// Every package that went into the bundle, with its licence text (the third-party notices quote this file).
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input.replace(/\\/g, "/"));
  if (m) packages.set(m[2], resolve(m[1]));
}
packages.set("typescript", tsDir);
const notices = ["# Language server components (docs/PROTOCOL.md §73)", ""];
for (const [name, dir] of [...packages].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenseFile = readdirSync(dir).find((f) => /^(?:licen[sc]e|copying)(?:\.(?:md|txt))?$/i.test(f));
  notices.push(`## ${name} ${pkg.version} — ${typeof pkg.license === "string" ? pkg.license : "see below"}`, "");
  notices.push("```", licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : `(no licence file in the package; package.json says ${JSON.stringify(pkg.license)})`, "```", "");
}
writeFileSync(join(outDir, "LICENSES.md"), notices.join("\n"));
writeFileSync(stampFile, stamp);
console.log(`build-lsp: wrote ${outDir} (${stamp.trim().replace(/\n/g, ", ")}; ${packages.size} packages)`);

function pathToEsbuild() {
  for (const from of [join(repo, "sidecar/package.json"), join(repo, "clients/desktop/package.json"), join(repo, "package.json")]) {
    try {
      return createRequire(from).resolve("esbuild");
    } catch {
      // the next workspace
    }
  }
  throw new Error("build-lsp: esbuild is not installed (npm ci at the repository root)");
}
