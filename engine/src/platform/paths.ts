import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * One place for absolute-path handling across POSIX and Windows (docs/M11-WINDOWS.md "Paths").
 *
 * - Wire: repo-relative paths are always POSIX (`src/a.ts`); absolute paths are the host's native
 *   form (`/Users/x/repo`, `C:\Users\x\repo`) — `toNativeAbs` turns git's `C:/…` (or MSYS `/c/…`) into it.
 * - Comparisons never use string prefixes: `compareKey` / `isInsidePath` / `relativeInside` compare
 *   component by component. On win32 that is case-insensitive, accepts both separators, maps the
 *   `\\?\` / `\\.\` / `\??\` prefixes to the plain drive form, drops the trailing dots and spaces
 *   Windows itself ignores (`.git.` is `.git`), and flags alternate data streams (`a.txt:s`,
 *   `dir::$INDEX_ALLOCATION`), reserved device names (`NUL`, `COM1.txt`) and device namespaces
 *   (`\\.\pipe\…`, `\\?\Volume{…}`) as `unsafe` — an unsafe path is never "inside" anything.
 *
 * The pure functions take the flavor explicitly so the win32 rules are unit-tested on every OS;
 * the host wrappers (`realpathLenient`, `isInside`, `toRepoRelative`, `normalizeForCompare`) add
 * symlink / 8.3 short-name resolution through the filesystem.
 */
export type PathFlavor = "posix" | "win32";

export const HOST_FLAVOR: PathFlavor = process.platform === "win32" ? "win32" : "posix";

/** Reserved DOS device names; Windows maps them (also with any extension) to a device, not a file. */
const WIN_DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;

export type ParsedPath = {
  /** `/` (posix), `C:\` or `\\server\share\` (win32; drive letter uppercased); `""` when not absolute. */
  root: string;
  /** Components below the root; `.` and `..` resolved lexically; win32: trailing dots/spaces dropped. */
  parts: string[];
  /** win32 only: an alternate data stream, a reserved device name, a device namespace or a non-absolute path. */
  unsafe: boolean;
};

/** Windows strips trailing dots and spaces of every path component (`a.txt. ` names `a.txt`); `.` / `..` stay. */
function trimWinComponent(c: string): string {
  if (c === "." || c === "..") return c;
  return c.replace(/[. ]+$/, "");
}

/** Lexical parse of an absolute path; no filesystem access. */
export function parseAbs(p: string, flavor: PathFlavor): ParsedPath {
  if (flavor === "posix") {
    const n = path.posix.normalize(p);
    const root = n.startsWith("/") ? "/" : "";
    return { root, parts: n.slice(root.length).split("/").filter((c) => c !== "" && c !== "."), unsafe: false };
  }
  let s = p.replace(/\//g, "\\");
  let unsafe = false;
  // `\\?\C:\x`, `\\.\C:\x` and `\??\C:\x` name the same file as `C:\x`; `\\?\UNC\srv\share` is `\\srv\share`.
  const ns = /^(?:\\\\[?.]\\|\\\?\?\\)(.*)$/s.exec(s);
  if (ns) {
    const rest = ns[1]!;
    if (/^[A-Za-z]:(\\|$)/.test(rest)) s = rest;
    else if (/^UNC(\\|$)/i.test(rest)) s = "\\\\" + rest.slice(4);
    else unsafe = true; // a device, pipe or volume-GUID path
  }
  let root = path.win32.parse(s).root;
  const rest = s.slice(root.length);
  if (/^[A-Za-z]:\\$/.test(root)) root = root[0]!.toUpperCase() + ":\\";
  else if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(root)) root = root.endsWith("\\") ? root : root + "\\";
  else unsafe = true; // drive-relative (`C:x`), rooted without a drive (`\x`) or relative
  const parts: string[] = [];
  for (const raw of rest.split("\\")) {
    if (raw === "") continue;
    const c = trimWinComponent(raw);
    if (c === "") {
      unsafe = true; // `...` / `   `: what Windows makes of it is not worth guessing
      continue;
    }
    if (c === ".") continue;
    if (c === "..") {
      parts.pop();
      continue;
    }
    if (c.includes(":")) unsafe = true; // alternate data stream: invisible to git, so never a reviewable file
    if (WIN_DEVICE_RE.test(trimWinComponent(c.split(":")[0]!))) unsafe = true;
    parts.push(c);
  }
  return { root, parts, unsafe };
}

/** Comparison key of one component: win32 compares the name before any `:stream`, trailing dots/spaces dropped, case-folded. */
function partKey(c: string, flavor: PathFlavor): string {
  if (flavor === "posix") return c;
  return trimWinComponent(c.split(":")[0]!).toLowerCase();
}

/** Equal keys ⇔ the same path for the OS (lexically; resolve symlinks first with `realpathLenient`). */
export function compareKey(p: string, flavor: PathFlavor = HOST_FLAVOR): string {
  const { root, parts } = parseAbs(p, flavor);
  if (flavor === "posix") return root + parts.join("/");
  return root.toLowerCase() + parts.map((c) => partKey(c, flavor)).join("\\");
}

export function samePath(a: string, b: string, flavor: PathFlavor = HOST_FLAVOR): boolean {
  return compareKey(a, flavor) === compareKey(b, flavor);
}

/**
 * True when `child` is `parent` or below it (lexically). `allowUnsafe` keeps an unsafe child in the
 * comparison (for deny lists like the git dir: `gd::$INDEX_ALLOCATION\hooks\x` is inside `gd`).
 */
export function isInsidePath(child: string, parent: string, flavor: PathFlavor = HOST_FLAVOR, opts: { allowUnsafe?: boolean } = {}): boolean {
  const c = parseAbs(child, flavor);
  const p = parseAbs(parent, flavor);
  if ((c.unsafe && !opts.allowUnsafe) || p.unsafe || !c.root || !p.root) return false;
  if (flavor === "posix" ? c.root !== p.root : c.root.toLowerCase() !== p.root.toLowerCase()) return false;
  if (p.parts.length > c.parts.length) return false;
  return p.parts.every((x, i) => partKey(x, flavor) === partKey(c.parts[i]!, flavor));
}

/** POSIX-style path of `child` relative to `parent` when strictly inside it (and safe), else null. */
export function relativeInside(child: string, parent: string, flavor: PathFlavor = HOST_FLAVOR): string | null {
  if (!isInsidePath(child, parent, flavor)) return null;
  const c = parseAbs(child, flavor);
  const n = parseAbs(parent, flavor).parts.length;
  return c.parts.length > n ? c.parts.slice(n).join("/") : null;
}

/**
 * True when a component of `p` names a `.git` entry: case-insensitive on every OS (macOS / Windows file
 * systems are), and on win32 also `.git.`, `.git `, `.git::$INDEX_ALLOCATION`, `.git:stream` and the
 * 8.3 short name `GIT~1`. Both separators are split on everywhere.
 */
export function hasGitComponent(p: string, flavor: PathFlavor = HOST_FLAVOR): boolean {
  return p.split(/[\\/]+/).some((c) => {
    if (flavor === "posix") return c.toLowerCase() === ".git";
    const k = partKey(c, flavor);
    return k === ".git" || /^git~\d+$/.test(k);
  });
}

/**
 * Native absolute form of a path git (or anyone) printed: win32 turns `C:/x/y` and MSYS `/c/x/y`
 * into `C:\x\y` (drive uppercased, as `path.resolve` gives it); trailing separators are dropped
 * except at the root. POSIX paths are only normalized.
 */
export function toNativeAbs(p: string, flavor: PathFlavor = HOST_FLAVOR): string {
  if (flavor === "posix") {
    const n = path.posix.normalize(p);
    return n.length > 1 ? n.replace(/\/+$/, "") : n;
  }
  let s = p;
  const msys = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)(.*)$/.exec(s);
  if (msys) s = `${msys[1]}:${msys[2] || "\\"}`;
  s = path.win32.normalize(s.replace(/\//g, "\\"));
  s = s.replace(/^\\\\\?\\([A-Za-z]:\\)/, "$1");
  s = s.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  const root = path.win32.parse(s).root;
  return s.length > root.length ? s.replace(/\\+$/, "") : s;
}

/**
 * Real path of `p` even when it does not exist yet: the nearest existing ancestor is resolved
 * (symlinks, and on Windows 8.3 short names and the on-disk case via `realpathSync.native`) and the
 * missing tail appended. Native separators. MARK: wave2 check-engine — §35.10: on macOS the on-disk case
 * too (`realpathSync.native`): its file systems are case-insensitive by default, and git reports that spelling.
 */
export function realpathLenient(p: string): string {
  const abs = path.resolve(p);
  const real = HOST_FLAVOR === "win32" || process.platform === "darwin" ? realpathSync.native : realpathSync;
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const r = toNativeAbs(real(cur));
      if (tail.length === 0) return r;
      // Trailing separators of the existing ancestor are dropped so `/` + `x` is `/x`, not `//x`.
      return [r.replace(/[\\/]+$/, ""), ...tail.reverse()].join(path.sep);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return toNativeAbs(abs);
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
      cur = parent;
    }
  }
}

/** `compareKey` of the real path: equal for two spellings of one file (case, 8.3, symlinks, separators). */
export function normalizeForCompare(p: string): string {
  return compareKey(realpathLenient(p));
}

/** True when the lexical form of `p` (before symlink resolution) is unsafe on this host (see `parseAbs`). */
function lexicallyUnsafe(p: string): boolean {
  return HOST_FLAVOR === "win32" && parseAbs(path.resolve(p), HOST_FLAVOR).unsafe;
}

/** `child` (resolved through symlinks) is `parent` or inside it; never for an unsafe path. */
export function isInside(child: string, parent: string): boolean {
  if (lexicallyUnsafe(child)) return false;
  return isInsidePath(realpathLenient(child), realpathLenient(parent));
}

/** POSIX repo-relative path of `abs` (resolved through symlinks) when strictly inside `root`, else null. */
export function toRepoRelative(abs: string, root: string): string | null {
  if (lexicallyUnsafe(abs)) return null;
  return relativeInside(realpathLenient(abs), realpathLenient(root));
}

/**
 * A client-supplied repo-relative path (an @-mention, §23) as the POSIX repo-relative form of what it names, or
 * null when it is absolute, empty, holds control characters, leaves the repository (`..`, a symlink pointing
 * outside, a Windows ADS / device name) or names something inside git's own `.git` directory.
 */
export function repoRelativeInside(root: string, rel: string): string | null {
  if (typeof rel !== "string") return null;
  const raw = rel.trim().replace(/[\\/]+$/, "");
  if (!raw || /[\0-\x1f]/.test(raw) || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
  const inside = toRepoRelative(path.resolve(root, raw), root);
  if (inside === null || hasGitComponent(inside) || hasGitComponent(raw)) return null;
  return inside;
}
