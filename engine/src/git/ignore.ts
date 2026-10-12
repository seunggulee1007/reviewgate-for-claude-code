/**
 * Gitignore-style filter applied to the per-turn changed-files list (e.g. `.omc/` written by user
 * hooks). A pattern matches when the repo-relative path has it as a prefix, or — when the pattern
 * contains `*` — when the glob matches the full path or, for patterns without `/`, the last path
 * component. `*` matches any run of characters including `/`.
 */
export function matchesIgnore(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.startsWith("/") ? raw.slice(1) : raw;
    if (!pattern) return false;
    if (path.startsWith(pattern)) return true;
    if (!pattern.includes("*")) return false;
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*")}$`);
    if (re.test(path)) return true;
    if (!pattern.includes("/")) {
      const name = path.split("/").pop() ?? "";
      return re.test(name);
    }
    return false;
  });
}

/** Parses one-pattern-per-line text; blank lines and `#` comments are skipped. */
export function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [".omc/", ".claude/settings.local.json"];
