// MARK: lsp — docs/PROTOCOL.md §73: the language server of one project root for JavaScript / TypeScript / Vue — started
// lazily, stopped when idle, restarted after a crash with backoff — and its answers to Go to Definition and Find
// References in §62's shapes. Anything it cannot answer is the caller's to answer with §62 / §65 (`fallback`).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRelativeInside, toRepoRelative } from "../platform/paths.js";
import type { DefinitionCandidate, DefinitionKind, LspFallback, LspQuickInfo, LspState, ReferenceHit } from "../protocol.js";
import { MINIFIED, navPreview, parseSymbol, REFERENCES_DEFAULT_LIMIT, REFERENCES_MAX_LIMIT } from "../files/navigate.js";
import { INDEX_EXCLUDED_DIRS } from "../files/symbolIndex.js";
import type { FileSymbol } from "../files/symbols.js";
import { chooseTsServer, type LspBundle, type TsServerChoice } from "./locate.js";
import { TsServerError, TsServerGone, TsServerProcess, TsServerTimeout } from "./tsserver.js";

/** §73.3: a definition (with its quickinfo) within this long of the command, a start included. */
export const LSP_DEFINITION_TIMEOUT_MS = 3_000;
/** §73.3: references within this long. */
export const LSP_REFERENCES_TIMEOUT_MS = 10_000;
/** §73.2: stopped after this long without a request. */
export const LSP_IDLE_MS = 10 * 60_000;
/** §73.2: VS Code's default cap of tsserver's heap. */
export const LSP_MAX_OLD_SPACE_MB = 3072;
/** §73.2: the implicit project (JS without a tsconfig) holds at most this many files. */
export const LSP_IMPLICIT_FILES_MAX = 5_000;
/** §73.2: at most this many files are open in tsserver (the least recently used closed). */
export const LSP_OPEN_FILES_MAX = 50;
/** §73.2: the 4th crash within 10 minutes leaves the server `failed`. */
export const LSP_CRASH_LIMIT = 4;
export const LSP_CRASH_WINDOW_MS = 10 * 60_000;
/** §73.2: restart after 1 s, 2 s, 4 s … at most 30 s. */
export const LSP_BACKOFF_BASE_MS = 1_000;
export const LSP_BACKOFF_MAX_MS = 30_000;
/** A file larger than this is not sent to the server (generated code, a bundle). */
const LSP_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** `configure` and the start's other requests. */
const START_REQUEST_MS = 30_000;

/** §73.2: the files the language server answers for. */
export const LSP_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/;
const CONFIG_FILE = /(?:^|\/)(?:tsconfig|jsconfig)\.json$/;

// §73.2: the options of the inferred projects and the implicit one (tsserver maps the enum names, case ignored).
const INFERRED_OPTIONS = { allowJs: true, checkJs: false, target: "ESNext", module: "ESNext", moduleResolution: "Bundler", jsx: "Preserve", allowNonTsExtensions: true, resolveJsonModule: true, allowSyntheticDefaultImports: true, skipLibCheck: true };
const IMPLICIT_OPTIONS = { ...INFERRED_OPTIONS, noEmit: true };

export type LspTiming = {
  definitionMs?: number; referencesMs?: number; idleMs?: number; backoffBaseMs?: number; backoffMaxMs?: number;
  crashLimit?: number; crashWindowMs?: number; maxOldSpaceMb?: number;
};

export type LspServiceOptions = {
  root: string;
  /** The bundle (found once by the engine); null: `unavailable`. */
  bundle: () => LspBundle | null;
  /** The worktree's files (tracked + untracked, not ignored) — §65's `git ls-files`. */
  listFiles: () => Promise<string[]>;
  /** `state.nav.lsp` changed. */
  onChange: () => void;
  log?: (msg: string) => void;
  /** The environment of the server (the engine's child env); `ELECTRON_RUN_AS_NODE=1` is added. */
  env?: Record<string, string | undefined>;
  /** Node (default `process.execPath`). */
  execPath?: string;
  timing?: LspTiming;
  now?: () => number;
};

type Position = { rel: string; abs: string; text: string; line: number; offset: number; word: string };
type Span = { line: number; offset: number };
type TsFileSpan = { file: string; start: Span; end: Span; lineText?: string; isDefinition?: boolean };
type TsQuickInfo = { kind?: string; displayString?: string; documentation?: string | { text: string }[] };

export type LspDefinitionAnswer = { ok: true; symbol: string; candidates: DefinitionCandidate[]; quickInfo?: LspQuickInfo } | { ok: false; fallback: LspFallback | null };
export type LspReferencesAnswer = { ok: true; symbol: string; hits: ReferenceHit[]; files: number; truncated: boolean } | { ok: false; fallback: LspFallback | null };

export type LspDefinitionQuery = { symbol: unknown; fromPath?: unknown; line?: unknown; column?: unknown; symbolsOf?: (path: string) => Promise<readonly FileSymbol[] | null> };
export type LspReferencesQuery = { symbol: unknown; fromPath?: unknown; line?: unknown; column?: unknown; limit?: unknown; symbolsOf?: (path: string) => Promise<readonly FileSymbol[] | null> };

/** tsserver's ScriptElementKind → §62's DefinitionKind. */
export function kindOf(tsKind: string | undefined): DefinitionKind | null {
  switch (tsKind) {
    case "class": case "local class": return "class";
    case "interface": return "interface";
    case "enum": return "enum";
    case "enum member": return "constant";
    case "type": case "type parameter": return "type";
    case "module": case "external module name": return "module";
    case "function": case "local function": return "function";
    case "method": return "method";
    case "constructor": case "construct": return "constructor";
    case "property": case "getter": case "setter": case "accessor": case "JSX attribute": return "property";
    case "var": case "let": case "const": case "local var": case "using": case "await using": case "parameter": case "alias": return "variable";
    default: return null;
  }
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export class LspService {
  private proc: TsServerProcess | null = null;
  private starting: Promise<TsServerProcess | null> | null = null;
  private status: LspState["status"] | "idle" = "idle";
  private choice: TsServerChoice | null = null;
  private error: string | undefined;
  private crashes: number[] = [];
  private restarts = 0;
  private enabled = true;
  private disposed = false;
  /** Absolute path → the sha1 of the contents last sent (insertion order = least recently used first). */
  private open = new Map<string, string>();
  private implicitStale = true;
  private implicitName: string | null = null;
  private files: string[] | null = null;
  private loading = 0;
  /** Requests past `ready()` and not answered yet (the idle timer waits for them). */
  private busy = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly t: Required<LspTiming>;
  private readonly now: () => number;

  constructor(private readonly opts: LspServiceOptions) {
    const t = opts.timing ?? {};
    this.t = {
      definitionMs: t.definitionMs ?? LSP_DEFINITION_TIMEOUT_MS, referencesMs: t.referencesMs ?? LSP_REFERENCES_TIMEOUT_MS,
      idleMs: t.idleMs ?? LSP_IDLE_MS, backoffBaseMs: t.backoffBaseMs ?? LSP_BACKOFF_BASE_MS, backoffMaxMs: t.backoffMaxMs ?? LSP_BACKOFF_MAX_MS,
      crashLimit: t.crashLimit ?? LSP_CRASH_LIMIT, crashWindowMs: t.crashWindowMs ?? LSP_CRASH_WINDOW_MS, maxOldSpaceMb: t.maxOldSpaceMb ?? LSP_MAX_OLD_SPACE_MB,
    };
    this.now = opts.now ?? Date.now;
  }

  /** `state.nav.lsp`: absent while idle or off. */
  get state(): LspState | undefined {
    if (this.status === "idle" || !this.enabled) return undefined;
    return {
      status: this.status,
      ...(this.choice ? { typescript: { ...this.choice.typescript } } : {}),
      ...((this.status === "failed" || this.status === "unavailable") && this.error ? { error: this.error } : {}),
      ...(this.restarts > 0 ? { restarts: this.restarts } : {}),
    };
  }

  /** Test seam: the running process. */
  get process(): TsServerProcess | null {
    return this.proc;
  }

  /** `Settings.languageServer`: off stops it; on again forgets a `failed`. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      void this.shutdown("idle");
    } else {
      this.crashes = [];
      if (this.status === "failed") this.status = "idle";
      this.opts.onChange();
    }
  }

  /** After a turn's collection or a refresh: the implicit project's file list is taken again on the next request. */
  filesChanged(): void {
    this.implicitStale = true;
    this.files = null;
  }

  /** §73.2: the code browser shows a JS / TS / Vue file — start, and open it so its project loads. */
  warm(relPath: unknown): void {
    if (!this.enabled || this.disposed || typeof relPath !== "string" || !LSP_FILE.test(relPath)) return;
    const rel = repoRelativeInside(this.opts.root, relPath);
    if (rel === null) return;
    this.touchIdle();
    void (async () => {
      const proc = await this.ensure();
      if (!proc) return;
      const abs = join(this.opts.root, rel);
      const text = await readFile(abs, "utf8").catch(() => null);
      if (text === null || text.length > LSP_FILE_MAX_BYTES) return;
      const deadline = this.now() + START_REQUEST_MS;
      await this.syncImplicit(proc, deadline);
      await this.syncFile(proc, abs, rel, text, deadline);
    })().catch(() => undefined);
  }

  /** `close_project`, a switch, `dispose`. */
  async stop(): Promise<void> {
    this.disposed = true;
    await this.shutdown("idle");
  }

  // ---------------------------------------------------------------- requests

  async definition(q: LspDefinitionQuery): Promise<LspDefinitionAnswer> {
    const started = this.now();
    const deadline = started + this.t.definitionMs;
    const pos = await this.position(q.symbol, q.fromPath, q.line, q.column);
    if (!pos) return { ok: false, fallback: null };
    if (!this.enabled) return { ok: false, fallback: "off" };
    const ready = await this.ready(deadline);
    if ("fallback" in ready) return { ok: false, fallback: ready.fallback };
    const { proc, wasStarting } = ready;
    this.busy += 1;
    try {
      await this.syncImplicit(proc, deadline);
      await this.syncFile(proc, pos.abs, pos.rel, pos.text, deadline);
      const at = { file: pos.abs, line: pos.line, offset: pos.offset };
      const [defs, info] = await Promise.all([
        proc.request<{ definitions?: TsFileSpan[] }>("definitionAndBoundSpan", at, this.left(deadline)),
        proc.request<TsQuickInfo>("quickinfo", at, this.left(deadline)).catch((e: unknown) => {
          if (e instanceof TsServerError) return null;
          throw e;
        }),
      ]);
      const reads = new Map<string, Promise<string[] | null>>();
      const linesOf = (rel: string) => {
        let p = reads.get(rel);
        if (!p) reads.set(rel, (p = readFile(join(this.opts.root, rel), "utf8").then((t) => t.split(/\r?\n/), () => null)));
        return p;
      };
      const seen = new Set<string>();
      const inRoot: { rel: string; def: TsFileSpan }[] = [];
      for (const def of defs?.definitions ?? []) {
        const rel = this.relOf(def.file);
        if (rel === null || seen.has(`${rel}:${def.start.line}`)) continue;
        seen.add(`${rel}:${def.start.line}`);
        inRoot.push({ rel, def });
      }
      if (inRoot.length === 0) return { ok: false, fallback: "no_result" };
      const candidates = await Promise.all(inRoot.slice(0, 50).map(async ({ rel, def }, i): Promise<DefinitionCandidate> => {
        const fileItself = def.start.line === 1 && def.start.offset === 1 && def.end.line === 1 && def.end.offset === 1;
        if (fileItself) {
          return { path: rel, line: 1, column: 1, kind: rel.endsWith(".vue") ? "component" : "module", preview: rel.slice(rel.lastIndexOf("/") + 1), score: 1000 - i * 10 };
        }
        const lines = await linesOf(rel);
        const text = lines?.[def.start.line - 1] ?? "";
        const name = text.slice(def.start.offset - 1, def.end.line === def.start.line ? def.end.offset - 1 : undefined);
        const sym = (await q.symbolsOf?.(rel).catch(() => null))?.find((s) => s.line === def.start.line && (s.name === name || s.column === def.start.offset));
        let kind: DefinitionKind | null = sym?.kind ?? null;
        if (!kind && i < 5) {
          const there = await proc.request<TsQuickInfo>("quickinfo", { file: def.file, line: def.start.line, offset: def.start.offset }, this.left(deadline)).catch(() => null);
          kind = kindOf(there?.kind);
        }
        return {
          path: rel, line: def.start.line, column: def.start.offset, kind: kind ?? "variable", preview: navPreview(text, def.start.offset),
          score: 1000 - i * 10, ...(sym?.container ? { container: sym.container } : {}),
        };
      }));
      const quickInfo = info?.displayString ? quickInfoOf(info) : undefined;
      return { ok: true, symbol: pos.word, candidates, ...(quickInfo ? { quickInfo } : {}) };
    } catch (e) {
      return { ok: false, fallback: this.failure(e, wasStarting) };
    } finally {
      this.busy -= 1;
      this.touchIdle();
    }
  }

  async references(q: LspReferencesQuery): Promise<LspReferencesAnswer> {
    const deadline = this.now() + this.t.referencesMs;
    const pos = await this.position(q.symbol, q.fromPath, q.line, q.column);
    if (!pos) return { ok: false, fallback: null };
    if (!this.enabled) return { ok: false, fallback: "off" };
    const ready = await this.ready(deadline);
    if ("fallback" in ready) return { ok: false, fallback: ready.fallback };
    const { proc, wasStarting } = ready;
    this.busy += 1;
    const limit = typeof q.limit === "number" && Number.isFinite(q.limit) && q.limit >= 1 ? Math.min(REFERENCES_MAX_LIMIT, Math.floor(q.limit)) : REFERENCES_DEFAULT_LIMIT;
    try {
      await this.syncImplicit(proc, deadline);
      await this.syncFile(proc, pos.abs, pos.rel, pos.text, deadline);
      const body = await proc.request<{ refs?: TsFileSpan[] }>("references", { file: pos.abs, line: pos.line, offset: pos.offset }, this.left(deadline));
      const byLine = new Map<string, ReferenceHit & { def: boolean }>();
      for (const ref of body?.refs ?? []) {
        const rel = this.relOf(ref.file);
        if (rel === null) continue;
        const key = `${rel}\0${ref.start.line}`;
        const had = byLine.get(key);
        if (had) {
          if (ref.isDefinition) had.def = true;
          continue;
        }
        const text = ref.lineText ?? "";
        byLine.set(key, { path: rel, line: ref.start.line, column: ref.start.offset, preview: navPreview(text, ref.start.offset), def: ref.isDefinition === true });
      }
      if (byLine.size === 0) return { ok: false, fallback: "no_result" };
      const from = pos.rel;
      const fromDir = dirOf(from);
      const rank = (p: string): number => (p === from ? 0 : dirOf(p) === fromDir ? 1 : 2);
      const all = [...byLine.values()].sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
      const kept = all.slice(0, limit);
      const hits: ReferenceHit[] = await Promise.all(kept.map(async ({ def, ...h }) => {
        if (!def) return h;
        let kind = (await q.symbolsOf?.(h.path).catch(() => null))?.find((s) => s.line === h.line)?.kind ?? null;
        if (!kind) {
          const there = await proc.request<TsQuickInfo>("quickinfo", { file: join(this.opts.root, h.path), line: h.line, offset: h.column }, this.left(deadline)).catch(() => null);
          kind = kindOf(there?.kind);
        }
        return { ...h, kind: kind ?? "variable" };
      }));
      return { ok: true, symbol: pos.word, hits, files: new Set(hits.map((h) => h.path)).size, truncated: all.length > limit };
    } catch (e) {
      return { ok: false, fallback: this.failure(e, wasStarting) };
    } finally {
      this.busy -= 1;
      this.touchIdle();
    }
  }

  // ---------------------------------------------------------------- the process

  private left(deadline: number): number {
    return Math.max(1, deadline - this.now());
  }

  private failure(e: unknown, wasStarting: boolean): LspFallback {
    if (e instanceof TsServerTimeout) return wasStarting || this.loading > 0 ? "starting" : "timeout";
    if (e instanceof TsServerGone) return "failed";
    if (e instanceof TsServerError) return "no_result";
    this.opts.log?.(`lsp: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }

  /** The server within `deadline`, or why not. */
  private async ready(deadline: number): Promise<{ proc: TsServerProcess; wasStarting: boolean } | { fallback: LspFallback }> {
    this.touchIdle();
    if (this.proc && this.status === "ready") return { proc: this.proc, wasStarting: this.loading > 0 };
    if (this.status === "unavailable") return { fallback: "unavailable" };
    if (this.status === "failed") return { fallback: "failed" };
    if (this.restartTimer) return { fallback: "starting" }; // backing off after a crash
    const start = this.ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), this.left(deadline));
    });
    const got = await Promise.race([start, late]);
    clearTimeout(timer);
    if (got === "late") return { fallback: "starting" };
    if (!got) return { fallback: (this.status as string) === "unavailable" ? "unavailable" : "failed" }; // the start changed it
    return { proc: got, wasStarting: true };
  }

  private ensure(): Promise<TsServerProcess | null> {
    if (this.proc && this.status === "ready") return Promise.resolve(this.proc);
    if (this.starting) return this.starting;
    if (this.disposed || !this.enabled || this.status === "failed" || this.status === "unavailable") return Promise.resolve(null);
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<TsServerProcess | null> {
    this.status = "starting";
    this.opts.onChange();
    const bundle = this.opts.bundle();
    if (!bundle) {
      this.status = "unavailable";
      this.error = "the language server is not part of this build";
      this.opts.onChange();
      return null;
    }
    const files = await this.fileList().catch(() => [] as string[]);
    if (this.disposed || !this.enabled) return null;
    this.choice = chooseTsServer(this.opts.root, bundle, new Set(files));
    const proc = new TsServerProcess({
      execPath: this.opts.execPath ?? process.execPath, tsserver: this.choice.tsserver, pluginProbe: this.choice.pluginProbe,
      cwd: this.opts.root, env: this.opts.env ?? process.env, maxOldSpaceMb: this.t.maxOldSpaceMb,
    }, (event) => {
      if (event === "projectLoadingStart") this.loading += 1;
      else if (event === "projectLoadingFinish") this.loading = Math.max(0, this.loading - 1);
    });
    this.proc = proc;
    this.loading = 0;
    this.open.clear();
    this.implicitName = null;
    this.implicitStale = true;
    void proc.exit.then((e) => this.exited(proc, e));
    try {
      await proc.request("configure", {
        hostInfo: "reviewgate",
        preferences: { includePackageJsonAutoImports: "off", providePrefixAndSuffixTextForRename: false },
        extraFileExtensions: [{ extension: ".vue", isMixedContent: false, scriptKind: 7 /* Deferred */ }],
      }, START_REQUEST_MS);
      await proc.request("compilerOptionsForInferredProjects", { options: INFERRED_OPTIONS }, START_REQUEST_MS);
    } catch (e) {
      this.opts.log?.(`lsp: start failed: ${e instanceof Error ? e.message : String(e)}`);
      if (proc.alive) proc.crash(); // a start that does not answer counts as a crash (exited(): backoff, the limit)
      return null;
    }
    if (this.proc !== proc) return null;
    this.status = "ready";
    this.opts.log?.(`lsp: tsserver ${this.choice.typescript.version} (${this.choice.typescript.source}) ready for ${this.opts.root}`);
    this.opts.onChange();
    return proc;
  }

  private exited(proc: TsServerProcess, e: { expected: boolean; reason: string }): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.open.clear();
    this.loading = 0;
    if (e.expected || this.disposed || !this.enabled) {
      if (this.status !== "failed" && this.status !== "unavailable") this.status = "idle";
      this.opts.onChange();
      return;
    }
    const now = this.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.t.crashWindowMs), now];
    this.restarts += 1;
    this.opts.log?.(`lsp: tsserver exited (${e.reason}); crash ${this.crashes.length} within ${Math.round(this.t.crashWindowMs / 60_000)} min`);
    if (this.crashes.length >= this.t.crashLimit) {
      this.status = "failed";
      this.error = `the language server stopped ${this.crashes.length} times in ${Math.round(this.t.crashWindowMs / 60_000)} minutes (${e.reason})`;
      this.opts.onChange();
      return;
    }
    this.status = "starting";
    this.opts.onChange();
    const delay = Math.min(this.t.backoffMaxMs, this.t.backoffBaseMs * 2 ** (this.crashes.length - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensure();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async shutdown(next: "idle"): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.idleTimer = null;
    this.restartTimer = null;
    const proc = this.proc;
    const starting = this.starting;
    this.proc = null;
    this.open.clear();
    if (this.status !== "unavailable") this.status = next;
    this.opts.onChange();
    await proc?.stop();
    // A start in flight stops its process itself once it sees it is no longer wanted.
    const late = await starting?.catch(() => null);
    if (late && late !== this.proc) await late.stop();
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.starting || this.busy > 0) {
        this.touchIdle(); // never in the middle of a start or a request
        return;
      }
      if (this.proc) {
        this.opts.log?.("lsp: idle — stopping tsserver");
        void this.shutdown("idle");
      }
    }, this.t.idleMs);
    this.idleTimer.unref?.();
  }

  // ---------------------------------------------------------------- files

  private async fileList(): Promise<string[]> {
    if (!this.files) this.files = await this.opts.listFiles();
    return this.files;
  }

  /** §73.2: the files in no tsconfig / jsconfig folder are one external project, so references see all of them. */
  private async syncImplicit(proc: TsServerProcess, deadline: number): Promise<void> {
    if (!this.implicitStale) return;
    this.implicitStale = false;
    const files = await this.fileList().catch(() => [] as string[]);
    const configDirs = files.filter((f) => CONFIG_FILE.test(f)).map(dirOf);
    const inConfig = (f: string) => configDirs.some((d) => d === "" || f.startsWith(`${d}/`));
    const roots = files.filter((f) => LSP_FILE.test(f) && !MINIFIED.test(f) && !excluded(f) && !inConfig(f)).sort().slice(0, LSP_IMPLICIT_FILES_MAX);
    const name = join(this.opts.root, "reviewgate-implicit.jsproj");
    if (roots.length === 0) {
      if (this.implicitName) await proc.request("closeExternalProject", { projectFileName: name }, this.left(deadline)).catch(() => undefined);
      this.implicitName = null;
      return;
    }
    await proc.request("openExternalProject", { projectFileName: name, rootFiles: roots.map((f) => ({ fileName: join(this.opts.root, f) })), options: IMPLICIT_OPTIONS }, this.left(deadline));
    this.implicitName = name;
  }

  /** The file as it is on disk now (`updateOpen` when it changed since it was last sent); at most 50 open. */
  private async syncFile(proc: TsServerProcess, abs: string, rel: string, text: string, deadline: number): Promise<void> {
    const hash = sha1(text);
    const had = this.open.get(abs);
    this.open.delete(abs);
    this.open.set(abs, hash);
    if (had === hash) return;
    const closed: string[] = [];
    while (this.open.size > LSP_OPEN_FILES_MAX) {
      const oldest = this.open.keys().next().value as string;
      this.open.delete(oldest);
      closed.push(oldest);
    }
    const kind = /\.(?:ts|mts|cts)$/.test(rel) ? "TS" : rel.endsWith(".tsx") ? "TSX" : rel.endsWith(".jsx") ? "JSX" : rel.endsWith(".vue") ? undefined : "JS";
    try {
      await proc.request("updateOpen", {
        openFiles: [{ file: abs, fileContent: text, projectRootPath: this.opts.root, ...(kind ? { scriptKindName: kind } : {}) }],
        changedFiles: [], closedFiles: closed,
      }, this.left(deadline));
    } catch (e) {
      this.open.delete(abs); // sent again next time
      throw e;
    }
  }

  /** Repo-relative (inside the root, never under `.git`), else null. */
  private relOf(file: string): string | null {
    const rel = toRepoRelative(resolve(file), this.opts.root);
    if (rel === null || rel === "" || rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/")) return null;
    return rel;
  }

  /** §73.3: where on `fromPath`'s `line` the symbol is (the occurrence at / nearest to `column`), else null. */
  private async position(symbol: unknown, fromPath: unknown, line: unknown, column: unknown): Promise<Position | null> {
    if (typeof fromPath !== "string" || typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
    const q = parseSymbol(symbol);
    if (q.form === "tag") return null;
    const rel = repoRelativeInside(this.opts.root, fromPath);
    if (rel === null || !LSP_FILE.test(rel)) return null;
    const abs = join(this.opts.root, rel);
    const text = await readFile(abs, "utf8").catch(() => null);
    if (text === null || text.length > LSP_FILE_MAX_BYTES) return null;
    const lineText = text.split(/\r?\n/)[line - 1];
    if (lineText === undefined) return null;
    const needle = q.form === "fqn" ? q.word.slice(q.word.lastIndexOf(".") + 1) : q.word;
    const re = q.form === "path" ? new RegExp(escapeRe(needle), "g")
      : q.form === "kebab" ? new RegExp(String.raw`(?<![\w-])${escapeRe(needle)}(?![\w-])`, "g")
        : new RegExp(String.raw`(?<![\w$])${escapeRe(needle)}(?![\w$])`, "g");
    const starts: number[] = [];
    for (let m = re.exec(lineText); m; m = re.exec(lineText)) starts.push(m.index);
    if (starts.length === 0) return null;
    const col = typeof column === "number" && Number.isFinite(column) ? column - 1 : null;
    let at = starts[0]!;
    if (col !== null) {
      const inside = starts.find((s) => col >= s && col < s + needle.length);
      at = inside ?? starts.reduce((best, s) => (Math.abs(s - col) < Math.abs(best - col) ? s : best), starts[0]!);
    }
    return { rel, abs, text, line, offset: at + 1, word: q.word };
  }
}

function excluded(path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (INDEX_EXCLUDED_DIRS.has(parts[i]!)) return true;
  return false;
}

function quickInfoOf(info: TsQuickInfo): LspQuickInfo {
  const doc = typeof info.documentation === "string" ? info.documentation : Array.isArray(info.documentation) ? info.documentation.map((p) => p.text).join("") : "";
  return {
    display: (info.displayString ?? "").slice(0, 2_000),
    ...(doc.trim() ? { documentation: doc.trim().slice(0, 2_000) } : {}),
    ...(info.kind ? { kind: info.kind } : {}),
  };
}
