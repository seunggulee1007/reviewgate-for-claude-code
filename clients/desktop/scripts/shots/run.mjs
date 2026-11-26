// `npm run shots` (docs/M11-WINDOWS.md "Screenshot harness"): the Windows client's screens as PNGs, quietly, on this Mac.
// Builds the renderer and the harness into SHOTS_DIR (default $TMPDIR/reviewgate-win-shots — never the repo), then runs
// the harness (scripts/shots/main.ts) in the Electron of devDependencies. Nothing shows and nothing takes focus:
// - on macOS it runs from a clone of Electron.app whose Info.plist says LSUIElement (no Dock icon, no menu bar) under a
//   bundle id of its own, signed ad hoc, unregistered from LaunchServices afterwards; the harness also sets the
//   activation policy to "prohibited" (it can never become the active app) before anything starts;
// - its windows are offscreen (`webPreferences.offscreen`) and never shown; a show, a focus or the app becoming active
//   is a VISIBLE violation and fails the run — and this script checks from outside, every half second, that the app
//   is a UIElement and never the front app (`lsappinfo`, read only);
// - the page's `window.rg` is a fake (scripts/shots/preload.ts) answered from scripts/shots/scenes/*.json: no engine, no
//   `claude`, no git — the harness's main refuses to start any child process at all (scripts/shots/guard.ts);
// - its user data, logs and caches live under SHOTS_DIR; the keychain is Chromium's mock one (no prompt).
//
//   SHOTS_DIR     scratch folder (default $TMPDIR/reviewgate-win-shots); PNGs in SHOTS_DIR/shots, report.json beside them
//   SHOTS_SCENES  comma-separated scene names to shoot (default: all)
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = resolve(here, "../..");
const repo = resolve(desktop, "../..");
const enginePath = resolve(repo, "engine/src/index.ts");
const shotsDir = resolve(process.env.SHOTS_DIR || join(tmpdir(), "reviewgate-win-shots"));
mkdirSync(shotsDir, { recursive: true });
if ((realpathSync(shotsDir) + sep).startsWith(realpathSync(repo) + sep)) {
  console.error(`shots: SHOTS_DIR must be outside the repository (${shotsDir})`);
  process.exit(2);
}
rmSync(join(shotsDir, "shots"), { recursive: true, force: true });

// ---------------------------------------------------------------- build: the renderer as shipped, the harness

const rendererDir = join(shotsDir, "renderer");
await viteBuild({ configFile: join(desktop, "vite.config.ts"), logLevel: "error", build: { outDir: rendererDir, emptyOutDir: true } });
const harnessDir = join(shotsDir, "harness");
const common = { bundle: true, platform: "node", target: "node20", alias: { "@reviewgate/engine": enginePath }, external: ["electron"], logLevel: "warning" };
await build({ ...common, entryPoints: [join(here, "main.ts")], outfile: join(harnessDir, "main.mjs"), format: "esm", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
await build({ ...common, entryPoints: [join(here, "preload.ts")], outfile: join(harnessDir, "preload.cjs"), format: "cjs" });
// The app's entry: an error in the main process ends the run on stderr — never Electron's error dialog box.
writeFileSync(
  join(harnessDir, "entry.mjs"),
  [
    "const die = (e) => { process.stderr.write(`shots: ${e?.stack ?? e}\\n`); process.exit(1); };",
    "process.on('uncaughtException', die);",
    "process.on('unhandledRejection', die);",
    "await import('./main.mjs').catch(die);",
  ].join("\n"),
);

// ---------------------------------------------------------------- the Electron to run

const require = createRequire(import.meta.url);
const electronBin = require("electron"); // the path of the binary npm put in node_modules (no download)
let bin = electronBin;
let quietApp = null;
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
if (process.platform === "darwin") {
  const sourceApp = electronBin.slice(0, electronBin.indexOf(".app/") + 4);
  const version = readFileSync(join(dirname(require.resolve("electron")), "dist", "version"), "utf8").trim();
  quietApp = join(shotsDir, "quiet", "ReviewGateShots.app");
  const marker = join(shotsDir, "quiet", "version");
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== version) {
    rmSync(join(shotsDir, "quiet"), { recursive: true, force: true });
    mkdirSync(join(shotsDir, "quiet"), { recursive: true });
    try {
      execFileSync("cp", ["-cR", sourceApp, quietApp]); // an APFS clone: no copy of the 250 MB
    } catch {
      execFileSync("cp", ["-R", sourceApp, quietApp]);
    }
    const plist = join(quietApp, "Contents", "Info.plist");
    execFileSync("plutil", ["-replace", "LSUIElement", "-bool", "true", plist]);
    execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", "io.github.seunggulee1007.reviewgate.shots-win", plist]);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", quietApp], { stdio: "ignore" });
    writeFileSync(marker, version);
  }
  bin = join(quietApp, "Contents", "MacOS", "Electron");
  const uiElement = execFileSync("plutil", ["-extract", "LSUIElement", "raw", join(quietApp, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  if (uiElement !== "true" && uiElement !== "1") {
    console.error(`shots: ${quietApp} is not an LSUIElement app — not starting it`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- run, watching from outside

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = [
  join(harnessDir, "entry.mjs"),
  `--shots-dir=${shotsDir}`,
  `--renderer=${rendererDir}`,
  `--scenes=${join(here, "scenes")}`,
  `--preload=${join(harnessDir, "preload.cjs")}`,
];
const child = spawn(bin, args, { env, stdio: ["ignore", "inherit", "pipe"] });
const quiet = /^\[\d+:\d+\/[\d.]+:(?:WARNING|INFO|VERBOSE)|^\s*$/;
child.stderr.on("data", (b) => {
  for (const line of String(b).split("\n")) if (!quiet.test(line)) process.stderr.write(`${line}\n`);
});

const watch = { samples: 0, types: new Set(), front: 0 };
const lsappinfo = (...a) => {
  try {
    return execFileSync("lsappinfo", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
const timer =
  process.platform === "darwin"
    ? setInterval(() => {
        const type = /"ApplicationType"="([^"]+)"/.exec(lsappinfo("info", "-only", "applicationtype", String(child.pid)))?.[1];
        if (!type) return; // not registered yet (or gone)
        watch.samples += 1;
        watch.types.add(type);
        const front = lsappinfo("front").trim();
        const frontPid = /"pid"=(\d+)/.exec(lsappinfo("info", "-only", "pid", front))?.[1];
        if (frontPid === String(child.pid)) watch.front += 1;
      }, 500)
    : null;

const code = await new Promise((r) => child.on("exit", (c, signal) => r(c ?? (signal ? 1 : 0))));
if (timer) clearInterval(timer);
if (quietApp) {
  try {
    execFileSync(lsregister, ["-u", quietApp], { stdio: "ignore" });
  } catch {
    // never registered: nothing to undo
  }
}
let failed = code !== 0;
if (process.platform === "darwin") {
  const types = [...watch.types];
  const ok = types.every((t) => t === "UIElement" || t === "BackgroundOnly") && watch.front === 0;
  console.log(`shots: from outside — ${watch.samples} samples, application type ${types.join(", ") || "never registered"}, front app ${watch.front} times`);
  if (!ok) {
    console.error("shots: VISIBLE — the harness showed in the Dock or became the front app");
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
