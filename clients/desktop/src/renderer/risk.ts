/**
 * Review triage: risk badges for a changed file (sensitive / deleted / large / Bash-changed / outside the app /
 * config / test) and the "risky first" ordering of the Changes list. Heuristics for where to look first, not verdicts.
 * "Bash" and "outside the app" come from the engine's `origin` (docs/PROTOCOL.md §31), never from an empty `tools`.
 */
import type { ChangedFileState } from "@reviewgate/engine";
import { t } from "./i18n";
import { originOf } from "./reviewGate";
import { isSensitivePath } from "./sensitive";

export type RiskKind =
  | "sensitive" | "deleted" | "bash" | "external" | "large" | "config" | "test"
  // MARK: wave4b w4b-files — §40.2: the engine's new kinds (comp-12)
  | "permission" | "schema" | "sql" | "settings" | "ci";

/** A change of at least this many added + deleted lines is flagged "large". */
export const LARGE_CHANGE_LINES = 300;

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|Podfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|Package\.resolved|gradle\.lockfile)$/;
const CONFIG =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|[^/]+\.config\.(js|cjs|mjs|ts|cts|mts|json)|\.eslintrc[^/]*|\.prettierrc[^/]*|\.babelrc[^/]*|\.npmrc|\.nvmrc|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|CMakeLists\.txt|Package\.swift|project\.pbxproj|[^/]+\.xcconfig|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|pom\.xml|Cargo\.toml|go\.mod|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|Gemfile|Podfile|[^/]+\.ya?ml|[^/]+\.toml|[^/]+\.ini|[^/]+\.plist|[^/]+\.entitlements)$/;
const TEST = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|[^/]*Tests)\/|[._-](test|spec)\.[A-Za-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(swift|kt|java|cs)$/;

/** Ordered most → least alarming; the first ones carry more weight in the sort. */
const WEIGHT: Record<RiskKind, number> = { sensitive: 100, deleted: 50, bash: 30, large: 25, external: 20, config: 15, test: 0, permission: 40, schema: 35, sql: 25, settings: 20, ci: 20 };

/** The fields the badges look at — a live `ChangedFileState` or a `turn_summary` file mapped onto them. */
export type RiskInput = Pick<ChangedFileState, "path" | "status" | "tools" | "added" | "deleted"> & {
  origin?: string | null;
  // MARK: wave4b w4b-files — §40.2: what the engine decided (absent from an older engine: the rules below decide).
  risks?: readonly string[];
  riskScore?: number;
};

export function riskKinds(f: RiskInput): RiskKind[] {
  // MARK: wave4b w4b-files — §40.2: the engine's badges when it sent them (unknown kinds of a newer engine dropped).
  if (Array.isArray(f.risks)) return f.risks.filter((k): k is RiskKind => (ALL_RISKS as readonly string[]).includes(k));
  const out: RiskKind[] = [];
  const origin = originOf(f);
  if (isSensitivePath(f.path)) out.push("sensitive");
  if (f.status === "D") out.push("deleted");
  if (origin === "bash") out.push("bash");
  if (origin === "external") out.push("external");
  if (f.added + f.deleted >= LARGE_CHANGE_LINES) out.push("large");
  if (LOCKFILE.test(f.path) || CONFIG.test(f.path)) out.push("config");
  if (TEST.test(f.path)) out.push("test");
  return out;
}

export function riskScore(f: ChangedFileState): number {
  if (typeof f.riskScore === "number" && Number.isFinite(f.riskScore)) return f.riskScore; // MARK: wave4b w4b-files — §40.2
  return riskKinds(f).reduce((n, k) => n + WEIGHT[k], 0);
}

/** Riskiest first; ties keep git order (Array.prototype.sort is stable). */
export function sortByRisk(files: ChangedFileState[]): ChangedFileState[] {
  return files
    .map((f, i) => ({ f, i, score: riskScore(f) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.f);
}

export function riskLabel(k: RiskKind): string {
  switch (k) {
    case "sensitive":
      return t("Sensitive");
    case "deleted":
      return t("Deleted");
    case "bash":
      return t("Changed by Bash");
    case "external":
      return t("Outside change");
    case "large":
      return t("Large");
    case "config":
      return t("Config");
    case "test":
      return t("Test");
    // MARK: wave4b w4b-files — §40.2
    case "permission":
      return t("Permission");
    case "schema":
      return t("Schema");
    case "sql":
      return t("SQL");
    case "settings":
      return t("Settings file");
    case "ci":
      return t("CI");
  }
}

export function riskHelp(k: RiskKind): string {
  switch (k) {
    case "sensitive":
      return t("Claude settings, hooks, MCP config, CLAUDE.md, CI workflows or env files — check carefully before accepting");
    case "deleted":
      return t("The file was deleted");
    case "bash":
      return t("Changed by a shell command rather than an edit tool — the change was not shown to you as an edit");
    case "external":
      return t("Not changed by a Claude tool — it may be the IDE, another session or a git pull");
    case "large":
      return t("{0}+ lines changed", LARGE_CHANGE_LINES);
    case "config":
      return t("Build / dependency configuration or a lockfile");
    case "test":
      return t("Test file");
    // MARK: wave4b w4b-files — §40.2
    case "permission":
      return t("The file's permission changed — e.g. made executable (644 → 755)");
    case "schema":
      return t("Database schema or migration (*.sql, db/migration, Flyway, Liquibase)");
    case "sql":
      return t("MyBatis mapper — the SQL the app runs");
    case "settings":
      return t("Settings or credentials (application*.yml, *.properties) — may hold connection details or secrets");
    case "ci":
      return t("Build pipeline (Jenkinsfile, GitHub workflows, …) — runs on the build server");
  }
}

/** pill colour class per badge (styles.css `.pill.*`). */
export function riskTone(k: RiskKind): string {
  switch (k) {
    case "sensitive":
    case "deleted":
      return "red";
    case "bash":
    case "large":
      return "orange";
    case "external":
      return "gray external";
    case "config":
      return "gray";
    case "test":
      return "green";
    // MARK: wave4b w4b-files — §40.2
    case "permission":
    case "schema":
      return "orange";
    case "sql":
    case "settings":
    case "ci":
      return "gray";
  }
}

// MARK: wave4b w4b-files — §40.2: the engine's order (FILE_RISK_KINDS), also the legend's.
export const ALL_RISKS: RiskKind[] = ["sensitive", "deleted", "permission", "schema", "bash", "sql", "large", "settings", "ci", "external", "config", "test"];
