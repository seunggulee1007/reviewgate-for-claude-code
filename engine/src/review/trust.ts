/**
 * MARK: wave4c w4c-trust — §41.2 (comp-21): trusted auto-accept. Which pending files of a review list a repository's opt-in
 * rules accept on their own, and what no rule may ever accept. Pure: the gate applies the plan (`ReviewGate.autoAccept`),
 * the engine decides when (after a collection; the lockfile rule also after the user accepts a manifest).
 */
import { posix } from "node:path";
import type { ChangedFile } from "../git/checkpoint.js";
import { isModsGroup } from "../git/mods.js";
import { AUTO_ACCEPT_RULES, type AutoAcceptedFile, type AutoAcceptRule, type AutoAcceptRules, type LastTest } from "../protocol.js";
import { isMcpTool, originOf } from "../session/provenance.js";
import { fileRisks, type FileRiskKind } from "./fileRisk.js";

export type TrustContext = {
  rules: AutoAcceptRules;
  /** The collected turn's last test run (§34.9); null at a manual accept or when no test ran. */
  lastTest: LastTest | null;
  /** Paths rejected before (wholly or in part): this round, earlier rounds the engine remembers, the recent history. */
  rejectedBefore: ReadonlySet<string>;
  /** Paths with review notes (sent or not). */
  noted: ReadonlySet<string>;
  /** Only these rules (a manual accept runs the lockfile rule only). */
  only?: readonly AutoAcceptRule[];
};

/** Why no rule may accept a file — the first that applies, in this order. */
export type AutoAcceptBlock =
  | "not_pending"
  | "mods"
  | "large"
  | "uncaptured"
  | "external"
  | "bash"
  | "mcp"
  | "risk"
  | "partial"
  | "notes"
  | "rejected_before";

/**
 * §40.2 badges no rule waves through: sensitive, deleted (a deleted test is how a failing test "passes"), permission,
 * schema, SQL, settings, CI — and bash / external, which the origin checks name first. `large` (≥ 300 lines), `config`
 * (lockfiles and manifests are config) and `test` do not block.
 */
const BLOCKING_RISKS: ReadonlySet<FileRiskKind> = new Set(["sensitive", "deleted", "permission", "schema", "bash", "sql", "settings", "ci", "external"]);

/** Claude's own edit tools — the only changes a rule may accept (an MCP write is placed by its time window, §31). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Files where whitespace is syntax: indentation (Python, YAML, Pug …) or tabs (make) — `git diff -w` hides real changes there. */
const WHITESPACE_SIGNIFICANT = /(^|\/)(Makefile|GNUmakefile|makefile)$|\.(py|pyi|pyw|ya?ml|mk|make|pug|jade|haml|slim|sass|styl|coffee|nim|fs|fsx|hs|elm|rst|tsv)$/i;

/**
 * Lockfile name → the manifests beside it that write it. pom.xml has no lockfile of Maven's own; `lockfile.json` is the
 * maven-lockfile plugin's.
 */
const LOCKFILE_MANIFESTS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  "package-lock.json": ["package.json"],
  "npm-shrinkwrap.json": ["package.json"],
  "yarn.lock": ["package.json"],
  "pnpm-lock.yaml": ["package.json"],
  "bun.lock": ["package.json"],
  "bun.lockb": ["package.json"],
  "gradle.lockfile": ["build.gradle", "build.gradle.kts"],
  "settings-gradle.lockfile": ["settings.gradle", "settings.gradle.kts"],
  "lockfile.json": ["pom.xml"],
  "Cargo.lock": ["Cargo.toml"],
  "Gemfile.lock": ["Gemfile"],
  "poetry.lock": ["pyproject.toml"],
  "uv.lock": ["pyproject.toml"],
  "Pipfile.lock": ["Pipfile"],
  "composer.lock": ["composer.json"],
  "go.sum": ["go.mod"],
  "Package.resolved": ["Package.swift"],
  "Podfile.lock": ["Podfile"],
  "flake.lock": ["flake.nix"],
  "pubspec.lock": ["pubspec.yaml"],
  "mix.lock": ["mix.exs"],
}));

/** The rules a stored / sent value turns on: known keys with `true` only (anything else is off). */
export function normalizeAutoAcceptRules(v: unknown): AutoAcceptRules {
  const out: AutoAcceptRules = {};
  if (!v || typeof v !== "object") return out;
  for (const rule of AUTO_ACCEPT_RULES) if ((v as Record<string, unknown>)[rule] === true) out[rule] = true;
  return out;
}

export function anyAutoAcceptRule(rules: AutoAcceptRules): boolean {
  return AUTO_ACCEPT_RULES.some((r) => rules[r] === true);
}

/** The manifests in the lockfile's own folder that write it; [] when `path` is no lockfile. */
export function lockfileManifests(path: string): string[] {
  const name = posix.basename(path);
  const manifests = LOCKFILE_MANIFESTS.get(name) ?? [];
  const dir = posix.dirname(path);
  return manifests.map((m) => (dir === "." ? m : `${dir}/${m}`));
}

export function isWhitespaceSignificant(path: string): boolean {
  return WHITESPACE_SIGNIFICANT.test(path);
}

/** Why no rule may accept `f` (null: a rule may). */
export function autoAcceptBlock(f: ChangedFile, ctx: Pick<TrustContext, "rejectedBefore" | "noted">): AutoAcceptBlock | null {
  if (f.state !== "pending") return "not_pending";
  const paths = f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path];
  if (paths.some(isModsGroup)) return "mods";
  if (f.tooLarge) return "large";
  if (f.uncaptured) return "uncaptured";
  if (originOf(f) === "external") return "external";
  if (f.tools.includes("Bash")) return "bash";
  if (f.tools.some(isMcpTool) || !f.tools.some((t) => EDIT_TOOLS.has(t))) return "mcp";
  if (fileRisks(f).some((k) => BLOCKING_RISKS.has(k))) return "risk";
  if (f.partial || (f.rejectedHunks ?? 0) > 0) return "partial";
  if (paths.some((p) => ctx.noted.has(p))) return "notes";
  if (paths.some((p) => ctx.rejectedBefore.has(p))) return "rejected_before";
  return null;
}

/**
 * The files the rules accept, in list order. Rules, first that fits: `whitespace` — §34.7 `whitespaceOnly`, a modified file
 * whose whitespace is no syntax; `tests` — a test file (§40.2 `test`) when the turn's last test run passed after its last
 * edit (§34.9); `lockfile` — a lockfile whose manifest beside it is accepted (by the user, or by a rule in this pass).
 */
export function planAutoAccept(files: readonly ChangedFile[], ctx: TrustContext): AutoAcceptedFile[] {
  const on = (r: AutoAcceptRule) => ctx.rules[r] === true && (!ctx.only || ctx.only.includes(r));
  if (!AUTO_ACCEPT_RULES.some(on)) return [];
  const plan = new Map<string, AutoAcceptRule>();
  const open = files.filter((f) => autoAcceptBlock(f, ctx) === null);
  const testPassed = ctx.lastTest !== null && ctx.lastTest.verdict === "pass" && ctx.lastTest.afterLastEdit;
  for (const f of open) {
    if (on("whitespace") && f.whitespaceOnly === true && f.status === "M" && !isWhitespaceSignificant(f.path)) plan.set(f.path, "whitespace");
    else if (on("tests") && testPassed && fileRisks(f).includes("test")) plan.set(f.path, "tests");
  }
  if (on("lockfile")) {
    const accepted = (p: string) => plan.has(p) || files.some((x) => x.path === p && x.state === "accepted");
    for (const f of open) {
      if (plan.has(f.path) || f.status === "D") continue;
      if (lockfileManifests(f.path).some(accepted)) plan.set(f.path, "lockfile");
    }
  }
  return files.filter((f) => plan.has(f.path)).map((f) => ({ path: f.path, rule: plan.get(f.path)! }));
}
