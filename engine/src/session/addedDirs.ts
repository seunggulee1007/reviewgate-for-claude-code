import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { CommandRefused } from "../errors.js";
import { isInside, realpathLenient, samePath } from "../platform/paths.js";

/**
 * docs/PROTOCOL.md §67.1 — `/add-dir` in a classic chat: directories beyond the project folder Claude may work in. The CLI
 * starts with them (the SDK's `additionalDirectories`, the terminal's `--add-dir`); the system instruction names them; an
 * edit there still gets the permission card (`added_directory`) and is listed in `changedOutside` — no snapshot sees it,
 * so the review never shows its diff and nothing there may change unseen.
 */

/** At most this many directories per chat. */
export const MAX_ADDED_DIRS = 20;
/** A typed path longer than this is refused (`dir_path_too_long`). */
export const MAX_DIR_PATH = 4096;

/** `~`, `~/x` (the user's home), an absolute path, or a path relative to `root` (as the terminal resolves it against its cwd). */
export function resolveDirInput(input: string, root: string, home: string = homedir()): string {
  const t = stripQuotes(input.trim());
  if (t === "~") return resolve(home);
  if (t.startsWith("~/") || t.startsWith("~\\")) return resolve(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(root, t);
}

/** A path typed with quotes around it (`"/work/acme lib"`, as a shell would take it). */
function stripQuotes(t: string): string {
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1).trim() : t;
}

/**
 * The real path `input` names when it may be added to a chat whose project is `root` and that has `current` already;
 * refused with a code otherwise: `dir_empty_path`, `dir_path_too_long`, `dir_not_found:<path>`, `dir_not_directory:<path>`,
 * `dir_is_project:<path>` (the project folder or inside it: Claude works there already), `dir_already_added:<path>` (that
 * directory or one it is inside of was added), `dir_too_many`.
 */
export async function validateAddDir(input: unknown, root: string, current: readonly string[], home: string = homedir()): Promise<string> {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new CommandRefused("dir_empty_path", { code: "dir_empty_path" });
  if (raw.length > MAX_DIR_PATH) throw new CommandRefused("dir_path_too_long", { code: "dir_path_too_long" });
  const abs = resolveDirInput(raw, root, home);
  let isDir: boolean;
  try {
    isDir = (await stat(abs)).isDirectory();
  } catch {
    throw new CommandRefused(`dir_not_found:${abs}`, { code: "dir_not_found", paths: [abs] });
  }
  if (!isDir) throw new CommandRefused(`dir_not_directory:${abs}`, { code: "dir_not_directory", paths: [abs] });
  const real = realpathLenient(abs);
  if (isInside(real, root)) throw new CommandRefused(`dir_is_project:${real}`, { code: "dir_is_project", paths: [real] });
  const holder = current.find((d) => isInside(real, d));
  if (holder) throw new CommandRefused(`dir_already_added:${holder}`, { code: "dir_already_added", paths: [holder] });
  if (current.length >= MAX_ADDED_DIRS) throw new CommandRefused("dir_too_many", { code: "dir_too_many" });
  return real;
}

/** `dirs` with `dir` added; a directory already listed that lies inside the new one is folded into it. */
export function withAddedDir(dirs: readonly string[], dir: string): string[] {
  return [...dirs.filter((d) => !isInside(d, dir)), dir];
}

/** The listed directory `path` names (as listed or as its real path); null when it is not one of `dirs`. */
export function findAddedDir(dirs: readonly string[], path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const p = path.trim();
  return dirs.find((d) => samePath(d, p) || samePath(d, realpathLenient(p))) ?? null;
}

/** The added directory that holds `file` (through symlinks); null when none does. */
export function addedDirOf(file: string, dirs: readonly string[]): string | null {
  if (dirs.length === 0) return null;
  return dirs.find((d) => isInside(file, d)) ?? null;
}

/** The engine's system-instruction sentence for a chat with added directories (empty without any). */
export function addedDirsInstruction(dirs: readonly string[]): string {
  if (dirs.length === 0) return "";
  return (
    `The user added ${dirs.length === 1 ? "this directory" : "these directories"} to this session (/add-dir): ${dirs.join(", ")}. ` +
    "You may read and edit files there as well as in the project folder. ReviewGate's review does not show changes there, " +
    "so every edit there asks the user first: make those edits deliberate and say what you changed."
  );
}
