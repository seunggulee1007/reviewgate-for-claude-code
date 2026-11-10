/**
 * Paths whose acceptance deserves a second look (docs/AUDIT-2026-09-14.md §1.8 / §1.9): Claude
 * settings and hooks, MCP config, CLAUDE.md, CI workflows, env files. Repo-relative, `/`-separated.
 */
const SENSITIVE: RegExp[] = [
  /(^|\/)\.claude\//, // .claude/**
  /(^|\/)\.mcp\.json$/,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)\.github\/workflows\//, // .github/workflows/**
  /(^|\/)[^/]*\.env[^/]*$/, // *.env*
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE.some((re) => re.test(path));
}
