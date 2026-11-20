import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { compareKey, samePath } from "../platform/paths.js";
import { ExecError } from "../util/exec.js";
import { nulSplit, runGit } from "./exec.js";
import { largeFileLimit } from "./largeFiles.js";

/**
 * §59: a folder that is not a git repository, tracked without git. ReviewGate keeps a hidden (bare) repository for it under
 * the engine's data folder and runs every git call of that folder on it (`registerShadowRepo`), so the review works as in a
 * repository while the folder itself never gets a `.git`.
 */

/** `<dataDir>/shadow-repos/` holds one hidden repository per folder. */
export const SHADOW_REPOS_DIR = "shadow-repos";
/** Written into a hidden repository once it is ready: the folder it belongs to (the per-folder "track without git" choice). */
export const SHADOW_MARKER = "reviewgate-shadow.json";
/** The identity of the hidden repository's own commits (its local config only — never the user's global one). */
export const SHADOW_IDENTITY = { name: "ReviewGate", email: "reviewgate@localhost" } as const;
/** The subject of a baseline commit. */
export const SHADOW_BASELINE_SUBJECT = "ReviewGate baseline";

/** What the hidden repository leaves out by default (`info/exclude`, written once; the folder's own `.gitignore` files apply too). */
export const SHADOW_EXCLUDES: readonly string[] = [
  "node_modules/",
  "bower_components/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "build/",
  "dist/",
  "out/",
  "target/",
  ".gradle/",
  ".next/",
  ".nuxt/",
  ".cache/",
  ".parcel-cache/",
  ".turbo/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".tox/",
  ".terraform/",
  "DerivedData/",
  "*.log",
  "*.tmp",
  "*.swp",
];

/** The size guard: a folder above either limit is refused (`folder_too_large`); the scan itself is capped too. */
export type ShadowLimits = { maxFiles: number; maxBytes: number; scanTimeoutMs: number };
export const SHADOW_LIMITS: ShadowLimits = { maxFiles: 20_000, maxBytes: 1024 * 1024 * 1024, scanTimeoutMs: 60_000 };
let limitsNow: ShadowLimits = SHADOW_LIMITS;
/** Test seam: the limits `scanShadowFolder` / `shadowBaseline` use by default (null: `SHADOW_LIMITS`). */
export function setShadowLimits(limits: ShadowLimits | null): void {
  limitsNow = limits ?? SHADOW_LIMITS;
}

/** The folder holds more than the size guard allows (`limit`: which one; `scan`: listing it did not finish in time). */
export class FolderTooLargeError extends Error {
  constructor(
    public readonly limit: "files" | "bytes" | "scan",
    public readonly files: number,
    public readonly bytes: number,
    limits: ShadowLimits = limitsNow,
  ) {
    const what = limit === "files" ? `more than ${limits.maxFiles} files` : limit === "bytes" ? `more than ${limits.maxBytes} bytes` : "too many files to list in time";
    super(`folder_too_large:${limit} — the folder holds ${what} (${files} files, ${bytes} bytes counted); open a smaller folder or make it a git repository`);
    this.name = "FolderTooLargeError";
  }
}

/** The hidden repository of `folder` (its real path): `<dataDir>/shadow-repos/<name>-<hash of the path>`. */
export function shadowRepoDir(dataDir: string, folder: string): string {
  const hash = createHash("sha256").update(compareKey(folder)).digest("hex").slice(0, 16);
  const name = basename(folder).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "folder";
  return join(dataDir, SHADOW_REPOS_DIR, `${name}-${hash}`);
}

/** True when `folder` (its real path) was tracked without git before: its hidden repository is ready and names it. */
export function hasShadowRepo(dataDir: string, folder: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(shadowRepoDir(dataDir, folder), SHADOW_MARKER), "utf8")) as { path?: unknown } | null;
    return typeof marker?.path === "string" && samePath(marker.path, folder);
  } catch {
    return false;
  }
}

/**
 * Creates the hidden repository of `folder` when there is none yet (`git init --bare`, its own identity, no commit signing,
 * no line-ending conversion, the default excludes) and returns its path. An existing one is returned as it is — its
 * `info/exclude` may have been edited since. The choice is remembered only by `markShadowRepo` (after a good baseline).
 */
export async function prepareShadowRepo(dataDir: string, folder: string): Promise<string> {
  const gitDir = shadowRepoDir(dataDir, folder);
  if (existsSync(join(gitDir, "HEAD"))) return gitDir;
  await mkdir(gitDir, { recursive: true });
  await runGit(gitDir, ["init", "-q", "--bare"], { discover: true });
  const config: [string, string][] = [
    ["user.name", SHADOW_IDENTITY.name],
    ["user.email", SHADOW_IDENTITY.email],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
  ];
  for (const [key, value] of config) await runGit(gitDir, ["config", key, value], { discover: true });
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(join(gitDir, "info", "exclude"), `# ReviewGate: left out of the review of this folder (tracked without git)\n${SHADOW_EXCLUDES.join("\n")}\n`);
  return gitDir;
}

/** Remembers that `folder` is tracked without git (`hasShadowRepo`): the next open of it goes straight to its hidden repository. */
export async function markShadowRepo(dataDir: string, folder: string): Promise<void> {
  if (hasShadowRepo(dataDir, folder)) return;
  const marker = { version: 1, path: folder, createdAt: new Date().toISOString() };
  await writeFile(join(shadowRepoDir(dataDir, folder), SHADOW_MARKER), JSON.stringify(marker, null, 2) + "\n");
}

export type ShadowScan = { files: number; bytes: number; largeUntracked: string[] };

/**
 * The size guard over what the hidden repository would hold: the files `git ls-files --cached --others --exclude-standard`
 * names (the excludes and the folder's `.gitignore` files applied) and their bytes — an untracked file at least the large-file
 * limit (§39.1) is left out of the bytes (a snapshot keeps a stub for it, never its content). `workTree` must be registered.
 */
export async function scanShadowFolder(workTree: string, limits: ShadowLimits = limitsNow, largeBytes = largeFileLimit()): Promise<ShadowScan> {
  const list = async (args: string[]): Promise<string[]> => {
    let out;
    try {
      out = await runGit(workTree, ["ls-files", "-z", ...args], { timeoutMs: limits.scanTimeoutMs, allowFailure: true });
    } catch (e) {
      // More output than a listing may hold: far above any limit.
      if (e instanceof ExecError) throw new FolderTooLargeError("files", limits.maxFiles + 1, 0, limits);
      throw e;
    }
    if (out.timedOut) throw new FolderTooLargeError("scan", 0, 0, limits);
    if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr.trim()}`);
    return nulSplit(out.stdout);
  };
  const [tracked, untracked] = await Promise.all([list(["--cached"]), list(["--others", "--exclude-standard"])]);
  const files = new Set(tracked).size + untracked.length;
  if (files > limits.maxFiles) throw new FolderTooLargeError("files", files, 0, limits);
  const isUntracked = new Set(untracked);
  const paths = [...new Set([...tracked, ...untracked])];
  const largeUntracked: string[] = [];
  let bytes = 0;
  for (let i = 0; i < paths.length; i += 256) {
    const chunk = paths.slice(i, i + 256);
    const sizes = await Promise.all(chunk.map((p) => lstat(join(workTree, p)).then((st) => (st.isFile() ? st.size : 0), () => 0)));
    chunk.forEach((p, k) => {
      const size = sizes[k]!;
      if (largeBytes > 0 && size >= largeBytes && isUntracked.has(p)) largeUntracked.push(p);
      else bytes += size;
    });
    if (bytes > limits.maxBytes) throw new FolderTooLargeError("bytes", files, bytes, limits);
  }
  return { files, bytes, largeUntracked };
}

export type ShadowBaseline = ShadowScan & { head: string; committed: boolean };

/**
 * Makes the folder's current state the hidden repository's HEAD (and index): the size guard, `git add -A` (untracked large
 * files left out — snapshots keep stubs for them, as in a repository), then a commit "ReviewGate baseline" when the tree
 * differs from HEAD's. `workTree` must be registered (`registerShadowRepo`).
 */
export async function shadowBaseline(workTree: string, limits: ShadowLimits = limitsNow): Promise<ShadowBaseline> {
  const scan = await scanShadowFolder(workTree, limits);
  const specs = scan.largeUntracked.length > 0 ? [".", ...scan.largeUntracked.map((p) => `:(exclude,literal)${p}`)] : [];
  const timeoutMs = 300_000;
  if (specs.length === 0) await runGit(workTree, ["add", "-A"], { timeoutMs });
  else await runGit(workTree, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { timeoutMs, stdin: Buffer.from(specs.join("\0") + "\0") });
  const tree = (await runGit(workTree, ["write-tree"])).text.trim();
  const headOut = await runGit(workTree, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
  const head = headOut.status === 0 ? headOut.text.trim() : "";
  if (head) {
    const headTree = (await runGit(workTree, ["rev-parse", "--verify", "--quiet", `${head}^{tree}`], { allowFailure: true })).text.trim();
    if (headTree === tree) return { ...scan, head, committed: false };
  }
  const env = {
    GIT_AUTHOR_NAME: SHADOW_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SHADOW_IDENTITY.email,
    GIT_COMMITTER_NAME: SHADOW_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SHADOW_IDENTITY.email,
  };
  const sha = (await runGit(workTree, ["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : []), "-m", SHADOW_BASELINE_SUBJECT], { env })).text.trim();
  await runGit(workTree, ["update-ref", "-m", "reviewgate: baseline", "HEAD", sha]);
  return { ...scan, head: sha, committed: true };
}
