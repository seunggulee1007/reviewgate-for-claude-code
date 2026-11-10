/**
 * Repo-relative form of an absolute path the engine or the CLI reported, or null when it is not under
 * `root`. The engine sends native absolute paths (`C:\Users\x\repo` on Windows, docs/PROTOCOL.md
 * "Paths"); a tool's own input may spell the same file with `/`, another drive-letter case or other
 * letter case, so Windows-style paths (drive letter or UNC) compare case-insensitively with both
 * separators. Display / fallback matching only — the engine does the security-relevant checks.
 */
export function relativeToRoot(path: string, root: string | null | undefined): string | null {
  if (!root) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(root);
  const r = norm(root);
  const p = norm(path);
  const fold = (s: string) => (windows ? s.toLowerCase() : s);
  if (r === "" || !fold(p).startsWith(fold(r) + "/")) return null;
  return p.slice(r.length + 1);
}
