/**
 * MARK: c-panel — docs/PROTOCOL.md §57.18: the bottom panel's Run tab, as on the Mac (Core RunConfigs.swift). Named
 * commands per repository (`settings.projectRunConfigs[projectRootHash(flowRepoRoot)]`), each run in its own PTY tab in
 * the project root. The project's files offer candidates — package.json scripts, the Gradle / Maven wrappers — that are
 * never run by themselves: a detected command asks once ("Run this command?") and is then kept as confirmed. Pure (no
 * `electron`, no fs): main detects with its own file reads, the renderer lists and edits, settingsGuard checks.
 */

export type RunConfig = {
  id: string;
  name: string;
  command: string;
  /** Offered by the project's files rather than typed by the user. */
  detected: boolean;
  /** The user answered Run to "Run this command?" — a detected command asks only once. */
  confirmed: boolean;
};

/** A repository's Run tab: the commands it keeps (in order) and the detected ones the user removed (by command). */
export type ProjectRuns = { configs: RunConfig[]; dismissed: string[] };

export const EMPTY_RUNS: ProjectRuns = { configs: [], dismissed: [] };

/** A typed command is the user's own; one the files offered asks before it first runs. */
export function needsConfirmation(c: RunConfig): boolean {
  return c.detected && !c.confirmed;
}

/** What the tab lists: the kept commands, then each detected one neither kept (same command) nor removed. */
export function listedRuns(runs: ProjectRuns | undefined, detected: readonly RunConfig[]): RunConfig[] {
  const r = runs ?? EMPTY_RUNS;
  const kept = new Set(r.configs.map((c) => c.command));
  const gone = new Set(r.dismissed);
  return [...r.configs, ...detected.filter((c) => !kept.has(c.command) && !gone.has(c.command))];
}

/** Keeps `config` (replacing the one with its id, else appended); its command is no longer dismissed. */
export function keepRun(runs: ProjectRuns | undefined, config: RunConfig): ProjectRuns {
  const r = runs ?? EMPTY_RUNS;
  const configs = r.configs.some((c) => c.id === config.id) ? r.configs.map((c) => (c.id === config.id ? config : c)) : [...r.configs, config];
  return { configs, dismissed: r.dismissed.filter((d) => d !== config.command) };
}

/** Removes `config`: a kept one goes; a detected one stays away until Find Again. */
export function removeRun(runs: ProjectRuns | undefined, config: RunConfig): ProjectRuns {
  const r = runs ?? EMPTY_RUNS;
  const dismissed = config.detected && !r.dismissed.includes(config.command) ? [...r.dismissed, config.command] : r.dismissed;
  return { configs: r.configs.filter((c) => c.id !== config.id), dismissed };
}

/** Find Again: the detected commands removed before are offered again. */
export function restoreDetected(runs: ProjectRuns | undefined): ProjectRuns {
  return { configs: [...(runs ?? EMPTY_RUNS).configs], dismissed: [] };
}

/** The stored value for a repository: null (the entry goes) when nothing is kept or removed. */
export function storedRuns(runs: ProjectRuns): ProjectRuns | null {
  return runs.configs.length === 0 && runs.dismissed.length === 0 ? null : runs;
}

// ---------------------------------------------------------------- detection (main reads the files)

export type RunFiles = {
  /** A path relative to the project root exists. */
  exists(relative: string): boolean;
  /** Its text (null: missing, unreadable or over 1 MB). */
  read(relative: string): string | null;
};

const NPM_SCRIPTS = ["dev", "start", "serve", "test", "build"] as const;

/** The candidates a project's files offer (nothing runs): Gradle, Maven, then package.json — as on the Mac. */
export function detectRunCandidates(files: RunFiles, platform: NodeJS.Platform): RunConfig[] {
  return [...gradleCandidates(files, platform), ...mavenCandidates(files, platform), ...npmCandidates(files)];
}

const candidate = (id: string, name: string, command: string): RunConfig => ({ id, name, command, detected: true, confirmed: false });

/** `id 'application'`, `id("application")`, `` `application` ``, `apply plugin: 'application'`, or an `application {` block. */
export function appliesApplicationPlugin(text: string): boolean {
  return /(id\s*\(?\s*["']application["']|`application`|apply\s+plugin\s*:\s*["']application["']|^\s*application\s*\{)/m.test(text);
}

/** The wrapper: `.\gradlew.bat` on Windows, `./gradlew` elsewhere (bootRun with Spring Boot's plugin, run with the application plugin, test). */
function gradleCandidates(f: RunFiles, platform: NodeJS.Platform): RunConfig[] {
  const win = platform === "win32";
  const wrapper = win ? "gradlew.bat" : "gradlew";
  if (!f.exists(wrapper)) return [];
  const builds = ["build.gradle", "build.gradle.kts"].filter((p) => f.exists(p));
  if (builds.length === 0 && !f.exists("settings.gradle") && !f.exists("settings.gradle.kts")) return [];
  const text = builds.map((p) => f.read(p) ?? "").join("\n");
  const tasks: string[] = [];
  if (text.includes("org.springframework.boot")) tasks.push("bootRun");
  if (appliesApplicationPlugin(text)) tasks.push("run");
  tasks.push("test");
  const run = win ? ".\\gradlew.bat" : "./gradlew";
  return tasks.map((t) => candidate(`gradle:${t}`, `Gradle: ${t}`, `${run} ${t}`));
}

/** `.\mvnw.cmd` / `./mvnw` with a pom.xml: spring-boot:run (Spring Boot's plugin or parent), test. */
function mavenCandidates(f: RunFiles, platform: NodeJS.Platform): RunConfig[] {
  const win = platform === "win32";
  if (!f.exists(win ? "mvnw.cmd" : "mvnw") || !f.exists("pom.xml")) return [];
  const pom = f.read("pom.xml") ?? "";
  const goals: string[] = [];
  if (pom.includes("spring-boot-maven-plugin") || pom.includes("spring-boot-starter-parent")) goals.push("spring-boot:run");
  goals.push("test");
  const run = win ? ".\\mvnw.cmd" : "./mvnw";
  return goals.map((g) => candidate(`maven:${g}`, `Maven: ${g}`, `${run} ${g}`));
}

/** package.json's dev / start / serve / test / build scripts with the project's package manager. */
function npmCandidates(f: RunFiles): RunConfig[] {
  const text = f.read("package.json");
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const pkg = json as { scripts?: unknown; packageManager?: unknown };
  if (typeof pkg.scripts !== "object" || pkg.scripts === null) return [];
  const scripts = pkg.scripts as Record<string, unknown>;
  const manager = packageManagerOf(typeof pkg.packageManager === "string" ? pkg.packageManager : null, f);
  return NPM_SCRIPTS.filter((s) => typeof scripts[s] === "string").map((s) => candidate(`npm:${s}`, `${manager}: ${s}`, scriptCommand(manager, s)));
}

/** `packageManager` ("pnpm@9…") first, then the lockfile; npm when there is neither. */
export function packageManagerOf(declared: string | null, f: Pick<RunFiles, "exists">): string {
  const name = declared?.split("@")[0];
  if (name && ["npm", "pnpm", "yarn", "bun"].includes(name)) return name;
  if (f.exists("pnpm-lock.yaml")) return "pnpm";
  if (f.exists("yarn.lock")) return "yarn";
  if (f.exists("bun.lockb") || f.exists("bun.lock")) return "bun";
  return "npm";
}

/** `npm test` / `npm start` / `npm run dev`; yarn runs a script by name; bun's `test` is its own runner, so `bun run`. */
export function scriptCommand(manager: string, script: string): string {
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return script === "test" || script === "start" ? `${manager} ${script}` : `${manager} run ${script}`;
}

// ---------------------------------------------------------------- renderer → main checks (src/main/settingsGuard.ts)

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const line = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0") && !/[\r\n]/.test(v);

export function isRunConfig(v: unknown): v is RunConfig {
  if (!plain(v)) return false;
  if (!Object.keys(v).every((k) => k === "id" || k === "name" || k === "command" || k === "detected" || k === "confirmed")) return false;
  return line(v.id, 100) && line(v.name, 200) && line(v.command, 4000) && typeof v.detected === "boolean" && typeof v.confirmed === "boolean";
}

/** A repository's entry as the renderer may store it: ≤ 100 commands, ≤ 100 removed ones. */
export function isProjectRuns(v: unknown): v is ProjectRuns {
  if (!plain(v) || !Object.keys(v).every((k) => k === "configs" || k === "dismissed")) return false;
  const { configs, dismissed } = v as { configs: unknown; dismissed: unknown };
  return Array.isArray(configs) && configs.length <= 100 && configs.every(isRunConfig) && Array.isArray(dismissed) && dismissed.length <= 100 && dismissed.every((d) => line(d, 4000));
}

/** Main, before it opens a run PTY: the kept, runnable command of that id (a detected one only once confirmed). */
export function runnableCommand(runs: ProjectRuns | undefined, id: unknown): string | null {
  if (typeof id !== "string") return null;
  const c = runs?.configs.find((x) => x.id === id);
  return c && !needsConfirmation(c) ? c.command : null;
}
