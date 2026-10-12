// scripts/build-sidecar.sh install decisions, checked with RG_DRY_RUN=1 only (nothing is ever installed, stamped or
// bundled) in a throwaway copy of the repository's manifests and scripts:
//   node --test sidecar/test/buildSidecar.test.mjs
// The stamp records the hash of the lockfile's dependencies (`deps-sha256`, scripts/lock-hash.mjs): `make version` —
// which rewrites only the workspaces' version lines — no longer reinstalls node_modules; an older stamp holding the whole
// file's hash (`lock-sha256`) that still matches is migrated without an install. POSIX shell script: skipped on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skip = process.platform === "win32" ? "build-sidecar.sh is the Mac build's POSIX script" : false;

/** A throwaway root: the scripts, the workspace manifests, the real package-lock.json and VERSION. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "rg-buildsidecar-"));
  for (const rel of ["scripts/build-sidecar.sh", "scripts/find-node.sh", "scripts/lock-hash.mjs", "scripts/sync-version.mjs", "package-lock.json", "VERSION", "engine/package.json", "sidecar/package.json", "clients/desktop/package.json"]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(root, rel));
  }
  mkdirSync(join(root, "engine", "src"), { recursive: true }); // sync-version.mjs writes engine/src/version.ts
  return root;
}

/** The decision line of a dry run (RG_DRY_RUN=1 is always set: the script exits before npm). */
function decide(root, env = {}) {
  const r = spawnSync("sh", [join(root, "scripts", "build-sidecar.sh")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CONFIGURATION: "", SKIP_SIDECAR_BUILD: "NO", RG_FORCE_INSTALL: "0", ...env, RG_DRY_RUN: "1", NODE_BIN: dirname(process.execPath) },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RG_DRY_RUN=1 — nothing installed, stamped or bundled/);
  const m = /sidecar: decision=(\w+) — (.*)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  return { action: m[1], reason: m[2] };
}

const hashes = (root) => Object.fromEntries(execFileSync(process.execPath, [join(root, "scripts", "lock-hash.mjs")], { cwd: root, encoding: "utf8" }).trim().split("\n").map((l) => l.split("=")));
const stamp = (root, lines) => {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".reviewgate-stamp"), lines.join("\n") + "\n");
};
/** `make version`: VERSION bumped, scripts/sync-version.mjs writes it into the manifests and package-lock.json. */
const makeVersion = (root, version) => {
  writeFileSync(join(root, "VERSION"), version + "\n");
  execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs")], { cwd: root, stdio: "pipe" });
};

test("make version moves only the full hash: a stamp with the dependency hash skips npm ci", { skip }, () => {
  const root = makeRoot();
  try {
    const before = hashes(root);
    stamp(root, [`deps-sha256=${before.deps}`, `lock-sha256=${before.full}`, "node=v24.0.0", "at=then"]);
    assert.equal(decide(root).action, "skip");
    makeVersion(root, "9.8.7");
    const lock = readFileSync(join(root, "package-lock.json"), "utf8");
    assert.match(lock, /"version": "9\.8\.7"/);
    const after = hashes(root);
    assert.notEqual(after.full, before.full);
    assert.equal(after.deps, before.deps);
    // The dependencies are what was installed: no npm ci (the stamp's whole-file hash is brought up to date).
    assert.equal(decide(root).action, "record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dependency change installs", { skip }, () => {
  const root = makeRoot();
  try {
    const h = hashes(root);
    stamp(root, [`deps-sha256=${h.deps}`, `lock-sha256=${h.full}`]);
    const file = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(file, "utf8"));
    const dep = Object.keys(lock.packages).find((k) => k.startsWith("node_modules/") && lock.packages[k].version);
    lock.packages[dep].version += "-changed";
    writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
    assert.deepEqual(decide(root), { action: "install", reason: "package-lock.json dependencies changed" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older stamp with the whole file's hash: unchanged → recorded without an install, changed → install", { skip }, () => {
  const root = makeRoot();
  try {
    stamp(root, [`lock-sha256=${hashes(root).full}`, "node=v24.0.0", "at=then"]);
    assert.equal(decide(root).action, "record");
    makeVersion(root, "9.8.7");
    // The old stamp cannot tell a version-only edit from a dependency change: installed, as before.
    assert.deepEqual(decide(root), { action: "install", reason: "package-lock.json changed" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no node_modules installs; RG_FORCE_INSTALL=1 installs", { skip }, () => {
  const root = makeRoot();
  try {
    assert.deepEqual(decide(root), { action: "install", reason: "node_modules missing" });
    const h = hashes(root);
    stamp(root, [`deps-sha256=${h.deps}`, `lock-sha256=${h.full}`]);
    assert.equal(decide(root, { RG_FORCE_INSTALL: "1" }).action, "install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules as a symbolic link (a worktree sharing another checkout's tree) is never installed into", { skip }, () => {
  const root = makeRoot();
  const shared = mkdtempSync(join(tmpdir(), "rg-buildsidecar-shared-"));
  try {
    symlinkSync(shared, join(root, "node_modules"));
    const d = decide(root);
    assert.equal(d.action, "linked");
    assert.match(d.reason, /symbolic link .* npm ci is never run here/);
    assert.equal(decide(root, { RG_FORCE_INSTALL: "1" }).action, "linked");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("npm ci keeps the optional platform packages (esbuild's binary must not depend on its install script)", { skip }, () => {
  const script = readFileSync(join(repo, "scripts", "build-sidecar.sh"), "utf8");
  const installs = script.split("\n").filter((l) => /^\s*npm ci\b/.test(l));
  assert.ok(installs.length > 0);
  for (const l of installs) assert.doesNotMatch(l, /--omit=optional|--no-optional/);
});
