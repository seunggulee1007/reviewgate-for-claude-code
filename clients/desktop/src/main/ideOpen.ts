/**
 * §62 "Open in IDE" (Windows): a file of the open project at a line, in VS Code (`vscode://file/<abs>:<line>:<col>`),
 * IntelliJ IDEA (`idea://open?file=<abs>&line=<line>`) or the system's default app for the file. The renderer sends only
 * the IDE's name, a repo-relative path and numbers; main builds the URL itself from the window's project root, after the
 * path is checked to stay inside that root (no absolute path, no `..`, no symlink out, a regular file that exists). No
 * URL from the renderer ever reaches the shell.
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type IdeKind = "vscode" | "idea" | "system";
export const IDE_KINDS: readonly IdeKind[] = ["vscode", "idea", "system"];

export type IdeTarget = { kind: "url"; url: string; absolutePath: string } | { kind: "path"; absolutePath: string };
export type IdeRefusal = "bad_request" | "no_project" | "outside_project" | "not_a_file";

type PathApi = Pick<typeof path.posix, "isAbsolute" | "resolve" | "relative" | "sep">;

/** The path API for a root: Windows rules for a drive / UNC root, POSIX otherwise (so tests on any OS read Windows paths). */
export function pathApiFor(root: string): PathApi {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") ? path.win32 : path.posix;
}

const clampNumber = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 10_000_000 ? n : 1);

/**
 * The absolute path of `relPath` under `root` when it stays inside it (lexically: fs checks come after), else null.
 * `relPath` is repo-relative with `/` (as the engine names files); a backslash, NUL or control character, an absolute
 * path, a drive letter or a `..` part is refused.
 */
export function insideRoot(root: string, relPath: unknown): string | null {
  if (typeof root !== "string" || !root || typeof relPath !== "string" || !relPath || relPath.length > 4096) return null;
  if (/[\0-\x1f\\]/.test(relPath) || relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return null;
  if (relPath.split("/").some((part) => part === ".." || part === "")) return null;
  const api = pathApiFor(root);
  if (!api.isAbsolute(root)) return null;
  const abs = api.resolve(root, ...relPath.split("/"));
  const rel = api.relative(api.resolve(root), abs);
  if (!rel || rel.startsWith("..") || api.isAbsolute(rel)) return null;
  return abs;
}

/** `/C:/Users/dev/My%20Project/x.java` or `/Users/dev/x.java`: forward slashes, each part percent-encoded, a drive letter kept. */
export function urlPath(absolutePath: string): string {
  const parts = absolutePath.replace(/\\/g, "/").split("/");
  const encoded = parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join("/");
  return encoded.startsWith("/") ? encoded : `/${encoded}`;
}

export function vscodeUrl(absolutePath: string, line: number, column: number): string {
  return `vscode://file${urlPath(absolutePath)}:${clampNumber(line)}:${clampNumber(column)}`;
}

export function ideaUrl(absolutePath: string, line: number): string {
  return `idea://open?file=${encodeURIComponent(absolutePath.replace(/\\/g, "/"))}&line=${clampNumber(line)}`;
}

/** What `rg:openInIde` opens — pure (no file system): the IDE's URL or the file for the default app, else why not. */
export function ideTarget(root: string | null | undefined, ide: unknown, relPath: unknown, line: unknown, column: unknown): IdeTarget | { refused: IdeRefusal } {
  if (typeof ide !== "string" || !IDE_KINDS.includes(ide as IdeKind)) return { refused: "bad_request" };
  if (!root) return { refused: "no_project" };
  const absolutePath = insideRoot(root, relPath);
  if (!absolutePath) return { refused: "outside_project" };
  if (ide === "system") return { kind: "path", absolutePath };
  const url = ide === "vscode" ? vscodeUrl(absolutePath, clampNumber(line), clampNumber(column)) : ideaUrl(absolutePath, clampNumber(line));
  return { kind: "url", url, absolutePath };
}

/** The file-system half: the target must be a regular file whose real path is inside the root's real path (no symlink out). */
export function checkOnDisk(root: string, absolutePath: string, fs: { realpath(p: string): string; isFile(p: string): boolean } = realFs): IdeRefusal | null {
  try {
    const api = pathApiFor(root);
    const realRoot = fs.realpath(root);
    const real = fs.realpath(absolutePath);
    const rel = api.relative(realRoot, real);
    if (!rel || rel.startsWith("..") || api.isAbsolute(rel)) return "outside_project";
    return fs.isFile(real) ? null : "not_a_file";
  } catch {
    return "not_a_file";
  }
}

const realFs = { realpath: (p: string) => realpathSync.native(p), isFile: (p: string) => statSync(p).isFile() };

/** Only these schemes leave main from here — a second check on what was built. */
export function isIdeUrl(url: string): boolean {
  return /^vscode:\/\/file\//.test(url) || /^idea:\/\/open\?file=/.test(url);
}
