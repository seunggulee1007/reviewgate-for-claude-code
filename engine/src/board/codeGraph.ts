/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the code graph of the board's "코드 그래프" tab.
 *
 * graphify (`graphify update .`) turns the repository's code into a graph without a model; the board shows what its
 * `graphify-out/GRAPH_REPORT.md` says — never `graph.json` (100 MB+ in a large repository) — how far HEAD has moved since, and runs
 * the update when the user asks. Reads only: nothing here writes outside the `graphify-out/` graphify itself writes.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeGraphBuild, CodeGraphCommunity, CodeGraphEvent, CodeGraphLink, CodeGraphNode, CodeGraphReport } from "../protocol.js";
import { runGit } from "../git/exec.js";
import { listWorktrees } from "../git/worktrees.js";
import { samePath } from "../platform/paths.js";
import { CommandRefused } from "../errors.js";

export const GRAPH_DIR = "graphify-out";
export const REPORT_FILE = "GRAPH_REPORT.md";
export const HTML_FILE = "graph.html";
/** A report larger than this is not read (a large repository's is ~150 KB). */
export const REPORT_MAX_BYTES = 8 * 1024 * 1024;
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** At most one progress emission per this many ms while a build runs. */
export const BUILD_PROGRESS_MS = 1000;
export const GODS_MAX = 15;
export const SURPRISES_MAX = 10;
export const COMMUNITIES_MAX = 15;
export const HUBS_MAX = 20;
export const NAME_MAX = 160;
export const LINE_MAX = 200;

// ---------------------------------------------------------------- the report

const toInt = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const clip = (s: string, max = NAME_MAX): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The body of `## <title…>` up to the next `## ` heading ("" when the report has no such section). */
function section(text: string, title: string): string {
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "m");
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** What graphify's `GRAPH_REPORT.md` says, every list capped (pure; an unknown layout yields zeros and empty lists). */
export function parseGraphReport(md: string): CodeGraphReport {
  const text = md.replace(/\r\n?/g, "\n");
  const title = /^# Graph Report - (.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/m.exec(text);
  const corpus = /^- ([\d,]+) files(?: · ~?([\d,]+) words)?/m.exec(section(text, "Corpus Check"));
  const summary = /^- ([\d,]+) nodes · ([\d,]+) edges · ([\d,]+) communities/m.exec(text);
  const extraction = /^- Extraction: (\d+)% EXTRACTED · (\d+)% INFERRED(?: · (\d+)% AMBIGUOUS)?/m.exec(text);
  const commit = /Built from commit: `([0-9a-fA-F]{4,40})`/.exec(text)?.[1]?.toLowerCase() ?? null;

  const hubLines = [...section(text, "Community Hubs").matchAll(/^- (.+?)\s*$/gm)].map((m) => m[1]!.trim()).filter((s) => s !== "");
  const hubs: string[] = [];
  for (const h of hubLines) {
    if (hubs.length >= HUBS_MAX) break;
    const name = clip(h);
    if (!hubs.includes(name)) hubs.push(name);
  }

  const gods: CodeGraphNode[] = [...section(text, "God Nodes").matchAll(/^\d+\. `(.+?)` - ([\d,]+) edges?\s*$/gm)]
    .map((m) => ({ name: clip(m[1]!), edges: toInt(m[2]) ?? 0 }))
    .slice(0, GODS_MAX);

  const surprises: CodeGraphLink[] = [];
  const lines = section(text, "Surprising Connections").split("\n");
  for (let i = 0; i < lines.length && surprises.length < SURPRISES_MAX; i++) {
    const m = /^- `(.+?)` --(.+?)--> `(.+?)`\s*(?:\[(\w+)\])?\s*$/.exec(lines[i]!);
    if (!m) continue;
    const files = /^\s+(\S.*?)\s+→\s+(\S.*?)\s*$/.exec(lines[i + 1] ?? "");
    surprises.push({
      from: clip(m[1]!),
      relation: clip(m[2]!.trim(), 40),
      to: clip(m[3]!),
      confidence: (m[4] ?? "").toUpperCase(),
      fromFile: files ? clip(files[1]!, 400) : null,
      toFile: files ? clip(files[2]!, 400) : null,
    });
    if (files) i++;
  }

  const communities: CodeGraphCommunity[] = [];
  for (const block of section(text, "Communities").split(/^(?=### Community )/m)) {
    const head = /^### Community (\d+) - "(.*)"\s*$/m.exec(block);
    if (!head) continue;
    const nodes = toInt(/^Nodes \(([\d,]+)\)/m.exec(block)?.[1]);
    if (nodes === null) continue;
    const cohesion = /^Cohesion: ([\d.]+)/m.exec(block)?.[1];
    communities.push({ id: Number(head[1]), name: clip(head[2]!), nodes, cohesion: cohesion !== undefined && Number.isFinite(Number(cohesion)) ? Number(cohesion) : null });
  }
  communities.sort((a, b) => b.nodes - a.nodes || a.id - b.id);

  return {
    name: title ? clip(title[1]!.trim()) : null,
    date: title?.[2] ?? null,
    files: toInt(corpus?.[1]),
    words: toInt(corpus?.[2]),
    nodes: toInt(summary?.[1]) ?? 0,
    edges: toInt(summary?.[2]) ?? 0,
    communities: toInt(summary?.[3]) ?? 0,
    extractedPct: toInt(extraction?.[1]),
    inferredPct: toInt(extraction?.[2]),
    ambiguousPct: toInt(extraction?.[3]),
    commit,
    hubs,
    hubCount: hubLines.length,
    gods,
    surprises,
    bigCommunities: communities.slice(0, COMMUNITIES_MAX),
    isolated: toInt(/\*\*([\d,]+) isolated node\(s\)/.exec(section(text, "Knowledge Gaps"))?.[1]),
  };
}

/** graphify's output → the line the board shows: its result ("Rebuilt: …") or failure, else its last line; ≤ 200 chars. */
export function buildResultLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const pick = [...lines].reverse().find((l) => /rebuilt|nothing|error|fail|traceback/i.test(l)) ?? lines.at(-1) ?? "";
  return clip(pick.replace(/^\[graphify[^\]]*\]\s*/, ""), LINE_MAX);
}

/** The latest line of graphify's output while it runs. */
export function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return clip((lines.at(-1) ?? "").replace(/^\[graphify[^\]]*\]\s*/, ""), LINE_MAX);
}

// ---------------------------------------------------------------- graphify

function isRunnable(path: string, isWindows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `~/.local/bin/graphify` (uv's tool folder) when it is there, else graphify on PATH; null: not installed. */
export async function findGraphify(opts: { isWindows: boolean; home?: string; which: (name: string) => Promise<string | null> }): Promise<string | null> {
  const home = opts.home ?? homedir();
  for (const name of opts.isWindows ? ["graphify.exe", "graphify"] : ["graphify"]) {
    const local = join(home, ".local", "bin", name);
    if (isRunnable(local, opts.isWindows)) return local;
  }
  return opts.which("graphify").catch(() => null);
}

// ---------------------------------------------------------------- the service

export type CodeGraphDeps = {
  /** The project root, null without a project. */
  root: () => string | null;
  /** The graphify program (cached by the caller as it likes); null: not installed. */
  graphify: () => Promise<string | null>;
  /** Environment of the build (PATH from the login shell). */
  env: () => Record<string, string | undefined>;
  killTree: (pid: number) => Promise<void>;
  isWindows: boolean;
  /** Emits a `code_graph` event without an id (progress, the end of a build). */
  emit: (ev: CodeGraphEvent) => void;
  log?: (level: "info" | "warn" | "debug", msg: string) => void;
  now?: () => number;
  timeoutMs?: number;
  progressMs?: number;
};

type ReportCache = { path: string; mtimeMs: number; size: number; report: CodeGraphReport | null; error?: "unreadable" | "too_large" };

/** One project's code graph: the report's summary (re-read when its mtime / size changes), freshness, the build. */
export class CodeGraph {
  private report: ReportCache | null = null;
  private behindCache: { key: string; behind: number | null } | null = null;
  private mainRoot: { root: string; main: string | null } | null = null;
  private build: CodeGraphBuild | null = null;
  private buildRoot: string | null = null;
  private starting = false;
  private stopBuild: (() => void) | null = null;
  private last: CodeGraphEvent | null = null;

  constructor(private readonly deps: CodeGraphDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The project changed: caches and the last build's result go (a running build is stopped). */
  reset(): void {
    this.stop();
    this.report = null;
    this.behindCache = null;
    this.mainRoot = null;
    this.build = null;
    this.buildRoot = null;
    this.last = null;
  }

  /** Stops a running build (the engine closes / the project changes). */
  stop(): void {
    this.stopBuild?.();
    this.stopBuild = null;
  }

  get isBuilding(): boolean {
    return this.starting || this.build?.running === true;
  }

  /** The `code_graph` reply: the report this worktree has (else the main worktree's), its freshness, graphify, the build. */
  async snapshot(): Promise<CodeGraphEvent> {
    const root = this.deps.root();
    if (!root) throw new CommandRefused("no_project");
    const found = await this.findReport(root);
    const cache = found ? this.readReport(found.path, found.stat) : null;
    const head = await gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const commit = cache?.report?.commit ?? null;
    const behind = commit && head ? await this.behind(root, commit, head) : null;
    const html = found ? join(dirname(found.path), HTML_FILE) : null;
    const ev: CodeGraphEvent = {
      type: "code_graph",
      root,
      reportPath: found?.path ?? null,
      ...(found?.shared ? { shared: true as const } : {}),
      builtAt: found ? new Date(found.stat.mtimeMs).toISOString() : null,
      report: cache?.report ?? null,
      ...(cache?.error ? { reportError: cache.error } : {}),
      head: head ? head.slice(0, 8) : null,
      behind,
      htmlPath: html && existsSync(html) ? html : null,
      graphify: await this.deps.graphify(),
      outIgnored: await this.outIgnored(root),
      build: this.build && this.buildRoot && samePath(this.buildRoot, root) ? { ...this.build } : null,
    };
    this.last = ev;
    return ev;
  }

  /**
   * `code_graph_build`: `graphify update .` in the project root, in the background — refused without graphify, while one
   * runs, and when git would see `graphify-out/` (a build during a turn would land in its review). Replies at once.
   */
  async startBuild(): Promise<CodeGraphEvent> {
    const root = this.deps.root();
    if (!root) throw new CommandRefused("no_project");
    if (this.isBuilding) throw new CommandRefused("graph_build_running");
    this.starting = true;
    try {
      const bin = await this.deps.graphify();
      if (!bin) throw new CommandRefused("graphify_missing");
      if ((await this.outIgnored(root)) === false) throw new CommandRefused("graph_out_not_ignored");
      this.build = { running: true, startedAt: new Date(this.now()).toISOString() };
      this.buildRoot = root;
      this.run(bin, root);
    } finally {
      this.starting = false;
    }
    return this.snapshot();
  }

  private run(bin: string, root: string): void {
    const deps = this.deps;
    let output = "";
    let lastSent = 0;
    let pending: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;
    const progressMs = deps.progressMs ?? BUILD_PROGRESS_MS;
    const sendProgress = () => {
      if (settled || !this.build?.running) return;
      lastSent = Date.now();
      const line = lastLine(output);
      if (line && line !== this.build.line) {
        this.build = { ...this.build, line };
        if (this.last) deps.emit({ ...this.last, build: { ...this.build } });
      }
    };
    const append = (chunk: string) => {
      output = (output + chunk).slice(-64 * 1024);
      const wait = progressMs - (Date.now() - lastSent);
      if (wait <= 0) sendProgress();
      else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          sendProgress();
        }, wait);
        pending.unref?.();
      }
    };
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(deps.env())) if (v !== undefined) env[k] = v;
    env.GRAPHIFY_NO_TIPS = "1";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["update", "."], { cwd: root, env, detached: !deps.isWindows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.finish(root, null, `${e instanceof Error ? e.message : String(e)}`, false);
      return;
    }
    deps.log?.("info", `graphify update . in ${root} (pid ${child.pid ?? "?"})`);
    const kill = () => {
      if (child.pid !== undefined) void deps.killTree(child.pid).catch(() => undefined);
    };
    this.stopBuild = kill;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, deps.timeoutMs ?? BUILD_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const done = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending) clearTimeout(pending);
      if (this.stopBuild === kill) this.stopBuild = null;
      this.finish(root, code, error ? `${output}\n${error}` : output, timedOut);
    };
    child.on("error", (e) => {
      // The program never started: no `close` follows for sure.
      if (child.pid === undefined) done(null, e.message);
    });
    child.on("close", (code) => done(code));
  }

  private finish(root: string, exitCode: number | null, output: string, timedOut: boolean): void {
    if (!this.build || !this.buildRoot || !samePath(this.buildRoot, root)) return;
    const ok = !timedOut && exitCode === 0;
    this.build = {
      running: false,
      startedAt: this.build.startedAt,
      finishedAt: new Date(this.now()).toISOString(),
      ok,
      exitCode: timedOut ? null : exitCode,
      ...(timedOut ? { timedOut: true as const } : {}),
      line: buildResultLine(output),
    };
    this.deps.log?.(ok ? "info" : "warn", `graphify update . ended: ${timedOut ? "timed out" : `exit ${exitCode}`} — ${this.build.line ?? ""}`);
    this.report = null;
    this.behindCache = null;
    void this.snapshot()
      .then((ev) => this.deps.emit(ev))
      .catch((e) => this.deps.log?.("warn", `code_graph after build: ${e instanceof Error ? e.message : String(e)}`));
  }

  // ---- helpers

  private async findReport(root: string): Promise<{ path: string; stat: Stats; shared: boolean } | null> {
    const own = statFile(join(root, GRAPH_DIR, REPORT_FILE));
    if (own) return { path: join(root, GRAPH_DIR, REPORT_FILE), stat: own, shared: false };
    const main = await this.mainWorktree(root);
    if (!main || samePath(main, root)) return null;
    const path = join(main, GRAPH_DIR, REPORT_FILE);
    const st = statFile(path);
    return st ? { path, stat: st, shared: true } : null;
  }

  /** The main worktree of the repository (`git worktree list` first entry), cached per root. */
  private async mainWorktree(root: string): Promise<string | null> {
    if (this.mainRoot && samePath(this.mainRoot.root, root)) return this.mainRoot.main;
    let main: string | null = null;
    try {
      const first = (await listWorktrees(root))[0];
      main = first && !first.bare ? first.path : null;
    } catch {
      main = null;
    }
    this.mainRoot = { root, main };
    return main;
  }

  private readReport(path: string, st: Stats): ReportCache {
    const c = this.report;
    if (c && c.path === path && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    let next: ReportCache;
    if (st.size > REPORT_MAX_BYTES) next = { path, mtimeMs: st.mtimeMs, size: st.size, report: null, error: "too_large" };
    else {
      try {
        next = { path, mtimeMs: st.mtimeMs, size: st.size, report: parseGraphReport(readFileSync(path, "utf8")) };
      } catch {
        next = { path, mtimeMs: st.mtimeMs, size: st.size, report: null, error: "unreadable" };
      }
    }
    this.report = next;
    return next;
  }

  /** `git rev-list --count <commit>..HEAD`, cached per (commit, HEAD); null when the commit is not in this repository. */
  private async behind(root: string, commit: string, head: string): Promise<number | null> {
    const key = `${root}\0${commit}\0${head}`;
    if (this.behindCache?.key === key) return this.behindCache.behind;
    let behind: number | null = null;
    const full = await gitText(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    if (full) {
      const n = Number(await gitText(root, ["rev-list", "--count", `${full}..${head}`]));
      behind = Number.isInteger(n) && n >= 0 ? n : null;
    }
    this.behindCache = { key, behind };
    return behind;
  }

  /** git ignores `graphify-out/` here (true / false); null outside git. */
  private async outIgnored(root: string): Promise<boolean | null> {
    try {
      const r = await runGit(root, ["check-ignore", "-q", `${GRAPH_DIR}/${REPORT_FILE}`], { allowFailure: true, timeoutMs: 10_000 });
      return r.status === 0 ? true : r.status === 1 ? false : null;
    } catch {
      return null;
    }
  }
}

function statFile(path: string): Stats | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function gitText(root: string, args: string[]): Promise<string | null> {
  try {
    const r = await runGit(root, args, { allowFailure: true, timeoutMs: 10_000 });
    const t = r.text.trim();
    return r.status === 0 && t ? t : null;
  } catch {
    return null;
  }
}
