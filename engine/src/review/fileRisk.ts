/**
 * MARK: wave4b w4b-files — §40.2 (comp-12): the risk badges of a changed file, decided once here and sent as
 * `state.changedFiles[].risks` / `riskScore` so the Mac and Electron show the same badges in the same "risky first" order
 * (each used to carry its own rules, weights and thresholds). Heuristics for where to look first, not verdicts.
 * Clients fall back to their own rules only for an older engine that sends no `risks`.
 */
import { originOf } from "../session/provenance.js";
import type { ChangeStatus } from "../git/checkpoint.js";

/** Badge order (most serious first) — the order of `risks`. Unknown kinds from a newer engine are ignored by clients. */
export const FILE_RISK_KINDS = [
  "sensitive",
  "deleted",
  "permission",
  "schema",
  "bash",
  "sql",
  "large",
  "settings",
  "ci",
  "external",
  "config",
  "test",
] as const;
export type FileRiskKind = (typeof FILE_RISK_KINDS)[number];

/**
 * Weights of the "risky first" order (`riskScore` = their sum). A test file weighs less than nothing, so it never sorts
 * above the code it tests (comp-12: `*Test.java` came before the service it covers on the Mac).
 */
export const FILE_RISK_WEIGHT: Record<FileRiskKind, number> = {
  sensitive: 100,
  deleted: 50,
  permission: 40,
  schema: 35,
  bash: 30,
  sql: 25,
  large: 25,
  settings: 20,
  ci: 20,
  external: 20,
  config: 15,
  test: -1,
};

/** At least this many added + deleted lines is "large". */
export const LARGE_CHANGE_LINES = 300;

/** The fields the badges look at (a gate file; `oldMode` / `newMode` from the checkpoint's raw diff, §40.2). */
export type FileRiskInput = {
  path: string;
  oldPath?: string | null;
  status: ChangeStatus;
  added: number;
  deleted: number;
  tools: readonly string[];
  toolUseIds?: readonly string[];
  oldMode?: string;
  newMode?: string;
};

// Claude settings and hooks, MCP config, CLAUDE.md, CI workflows, env files (the clients' isSensitivePath).
const SENSITIVE = [/(^|\/)\.claude\//, /(^|\/)\.mcp\.json$/, /(^|\/)CLAUDE\.md$/, /(^|\/)\.github\/workflows\//, /(^|\/)[^/]*\.env[^/]*$/];
// Spring settings and credentials: application*.yml / .yaml / .properties, bootstrap*.…, any *.properties.
const SETTINGS = /(^|\/)((application|bootstrap)[^/]*\.(ya?ml|properties)|[^/]+\.properties)$/i;
// MyBatis: an XML under a mapper(s) / sqlmap folder, or *Mapper.xml / *Dao.xml anywhere.
const SQL = /(^|\/)(mappers?|sqlmaps?)\/(.+\/)?[^/]+\.xml$|(^|\/)[^/]*(Mapper|Dao)\.xml$/i;
// Schema: SQL scripts, Flyway / Liquibase migrations and changelogs.
const SCHEMA = /\.sql$|(^|\/)db\/migrations?\/|(^|\/)(flyway|liquibase)\/|(^|\/)(db\.)?changelog[^/]*\.(xml|ya?ml|json)$/i;
const CI = /(^|\/)Jenkinsfile[^/]*$|(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)(azure|bitbucket)-pipelines\.ya?ml$|(^|\/)\.travis\.ya?ml$/;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|Podfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|Package\.resolved|gradle\.lockfile|uv\.lock|[^/]+\.lock)$/i;
const CONFIG =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|[^/]+\.config\.(js|cjs|mjs|ts|cts|mts|json)|\.[^/]*rc(\.(json|js|cjs|ya?ml))?|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|CMakeLists\.txt|Package\.swift|project\.yml|project\.pbxproj|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|Cargo\.toml|go\.mod|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|Gemfile|Podfile|[^/]+\.(ya?ml|toml|ini|cfg|conf|plist|xcconfig|entitlements))$/i;
// Test folders (src/test/…, __tests__, spec, e2e, FooTests/), *.test.* / *.spec.* / *_test.* / test_*.py, FooTest(s) / FooIT.
const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|[^/]*tests)\//i;
const TEST_NAME = /[._-](test|spec)\.[A-Za-z0-9]+$|_(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+$|(Tests?|IT)\.(swift|kt|kts|java|cs|scala|groovy)$/;

const isSensitive = (p: string) => SENSITIVE.some((re) => re.test(p));
const isExec = (mode: string | undefined) => mode === "100755";

/** The badges of one changed file, in `FILE_RISK_KINDS` order. */
export function fileRisks(f: FileRiskInput): FileRiskKind[] {
  const found = new Set<FileRiskKind>();
  const paths = [f.path, ...(f.oldPath ? [f.oldPath] : [])];
  const sensitive = paths.some(isSensitive);
  if (sensitive) found.add("sensitive");
  if (f.status === "D") found.add("deleted");
  if ((f.oldMode !== undefined && f.newMode !== undefined && f.oldMode !== f.newMode) || (f.status === "A" && isExec(f.newMode))) found.add("permission");
  const schema = SCHEMA.test(f.path);
  if (schema) found.add("schema");
  const origin = originOf(f);
  if (origin === "bash") found.add("bash");
  if (!schema && SQL.test(f.path)) found.add("sql");
  if (f.added + f.deleted >= LARGE_CHANGE_LINES) found.add("large");
  const settings = SETTINGS.test(f.path);
  if (settings && !sensitive) found.add("settings");
  const ci = CI.test(f.path);
  if (ci) found.add("ci");
  if (origin === "external") found.add("external");
  // One badge per file kind: settings / CI / schema / sensitive files are not "config" as well.
  if (!settings && !ci && !schema && !sensitive && (LOCKFILE.test(f.path) || CONFIG.test(f.path))) found.add("config");
  if (TEST_DIR.test(f.path) || TEST_NAME.test(f.path)) found.add("test");
  return FILE_RISK_KINDS.filter((k) => found.has(k));
}

/** Sum of the weights; 0 for an ordinary edit, below 0 for an ordinary test file. */
export function fileRiskScore(kinds: readonly FileRiskKind[]): number {
  return kinds.reduce((n, k) => n + FILE_RISK_WEIGHT[k], 0);
}

/** `risks` / `riskScore` of `state.changedFiles[]` (derived whenever the state is built — never stored). */
export function fileRiskFields(f: FileRiskInput): { risks: FileRiskKind[]; riskScore: number } {
  const risks = fileRisks(f);
  return { risks, riskScore: fileRiskScore(risks) };
}
