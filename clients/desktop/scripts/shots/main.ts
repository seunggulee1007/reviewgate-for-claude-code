/**
 * The screenshot harness's Electron main (docs/M11-WINDOWS.md "Screenshot harness"; started by scripts/shots/run.mjs).
 * Loads the built renderer into hidden, offscreen windows whose `window.rg` is the fake bridge (scripts/shots/preload.ts),
 * plays each scene of scripts/shots/scenes/*.json at every size × theme × language, and writes the PNGs and report.json
 * to SHOTS_DIR. Nothing is ever shown: the windows are offscreen and never shown, the app has no Dock icon and may not
 * become active, any show / focus fails the run, and no child process can start (./guard.ts).
 */
import "./guard.js";
import { app, BrowserWindow, ipcMain, nativeTheme, session, type WebContents } from "electron";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { EngineEvent } from "@reviewgate/engine";
import { parseUnifiedDiff } from "../../../../engine/src/diff/parse.js";
import { addSegments } from "../../../../engine/src/diff/segments.js";
import { DEFAULTS } from "../../src/main/settings.js";
import type { AppSettings } from "../../src/shared/ipc.js";
import { projectRootHash } from "../../src/shared/hash.js";
import pkg from "../../package.json";
import { baseState } from "./baseState.js";
import { layoutCheck, type LayoutFinding } from "./layoutCheck.js";

syncBuiltinESMExports(); // ./guard.ts's refusals reach `import { spawn } from "node:child_process"` too

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const shotsDir = arg("shots-dir")!;
const rendererDir = arg("renderer")!;
const scenesDir = arg("scenes")!;
const preloadPath = arg("preload")!;
const only = (process.env.SHOTS_SCENES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- invisible: before `ready`

app.setPath("userData", join(shotsDir, "user-data"));
app.setPath("sessionData", join(shotsDir, "user-data"));
app.setPath("logs", join(shotsDir, "logs"));
app.setPath("crashDumps", join(shotsDir, "crash"));
app.commandLine.appendSwitch("use-mock-keychain"); // never the login keychain's "Electron Safe Storage" prompt
app.disableHardwareAcceleration(); // offscreen frames from the software compositor: the same on every Mac
if (process.platform === "darwin") {
  app.setActivationPolicy("prohibited"); // no Dock icon, no menu bar, never the active app (Info.plist LSUIElement too)
  app.dock?.hide();
}

const violations: string[] = [];
const violation = (what: string) => {
  violations.push(what);
  process.stderr.write(`shots: VISIBLE ${what}\n`);
};
app.on("browser-window-focus", () => violation("a window took focus"));
app.on("did-become-active", () => violation("the app became active"));

// ---------------------------------------------------------------- scenes

type Localized = string | { en: string; ko: string };
type Target = { testid?: string; selector?: string; text?: Localized };
type Step =
  | { click: string | Target }
  /** §73.5: selects the first `text` inside `within` (a selector), as a double-click on a name in a diff row would. */
  | { select: { text: string; within?: string; scrollOnly?: boolean } }
  | { type: (Target & { value: Localized }) | { testid: string; value: Localized } }
  | { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { menu: Record<string, unknown> }
  | { event: Record<string, unknown> }
  | { waitFor: string | Target; timeoutMs?: number }
  | { wait: number };
type Reply = unknown;
type Scene = {
  name: string;
  description?: string;
  settings?: Partial<AppSettings>;
  recent?: { path: string; exists: boolean }[];
  state?: Record<string, unknown>;
  /** Engine events after the state (transcript rows, …). */
  events?: Record<string, unknown>[];
  /**
   * `request` replies by command type: a reply, `{"$by": "<field>", "map": {value: reply}}`, `{"__error": "…"}`, or
   * `{"$pending": true}` — a request that never answers (§74: a clone still running while its progress events come).
   */
  replies?: Record<string, Reply>;
  /** Bridge calls (`getSettings` is the scene's settings) by name: the resolved value. */
  bridge?: Record<string, unknown>;
  /** File diffs by path as unified patches: `select_file` replies (`file_diff`). */
  diffs?: Record<string, string>;
  /** §70.1: the open project's sent prompts (oldest first), in the page's localStorage before the app starts. */
  promptHistory?: string[];
  steps?: Step[];
};

type Variant = { size: { name: string; window: [number, number] }; theme: "dark" | "light"; locale: "en" | "ko" };

/**
 * The window sizes shot (outer, as the Windows app's window is sized: 1000 × 637 is the laptop the app is used on, 900 × 560
 * src/main/windows.ts's minWidth / minHeight). The page gets the window less the Windows 11 frame at 100 %: the 31 px
 * title bar, the 20 px menu bar and the 8 px resize borders (left, right and bottom).
 */
const SIZES = [
  { name: "1000x637", window: [1000, 637] as [number, number] },
  { name: "900x560", window: [900, 560] as [number, number] },
];
const FRAME = { w: 16, h: 31 + 20 + 8 };
const THEMES = ["dark", "light"] as const;
const LOCALES = ["en", "ko"] as const;

/**
 * A time relative to the run (§71: a session's start, a reset): `{"$fromNowMs": n}` is epoch ms now + n, `{"$isoFromNow": s}`
 * the ISO time now + s seconds — so "Total duration (wall)" and "Resets 15:00" read as they would.
 */
function relativeTimes(_k: string, v: unknown): unknown {
  if (isPlainObject(v) && Object.keys(v).length === 1) {
    if (typeof v.$fromNowMs === "number") return Date.now() + v.$fromNowMs;
    if (typeof v.$isoFromNow === "number") return new Date(Date.now() + v.$isoFromNow * 1000).toISOString();
  }
  return v;
}

/** A scene file; `extends` names another scene file it is merged over (its `steps` replace the other's). */
function readScene(file: string): Scene {
  const raw = JSON.parse(readFileSync(join(scenesDir, file), "utf8"), relativeTimes) as Scene & { extends?: string };
  if (!raw.extends) return raw;
  const { extends: base, ...rest } = raw;
  return { ...deepMerge(readScene(base), { ...rest, steps: undefined }), steps: rest.steps ?? [] };
}

function loadScenes(): Scene[] {
  return readdirSync(scenesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map(readScene)
    .filter((s) => only.length === 0 || only.includes(s.name));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars replace. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out as T;
}

const loc = (v: Localized, locale: "en" | "ko") => (typeof v === "string" ? v : v[locale]);

// ---------------------------------------------------------------- the fake main: one per window

type Live = { scene: Scene; variant: Variant; settings: AppSettings; unanswered: Set<string> };
const live = new Map<number, Live>();
const liveOf = (sender: WebContents): Live => {
  const l = live.get(sender.id);
  if (!l) throw new Error("shots: a page the harness did not open");
  return l;
};

function stateOf(l: Live): Record<string, unknown> {
  return deepMerge(baseState(), l.scene.state ?? {});
}

function defaults(l: Live, name: string, args: unknown[]): unknown {
  switch (name) {
    case "getSettings":
      return l.settings;
    case "setSettings":
      l.settings = { ...l.settings, ...(args[0] as Partial<AppSettings>) };
      return l.settings;
    case "removeRecentProject":
      return l.settings;
    case "recentProjects":
      return l.scene.recent ?? l.settings.recentProjects.map((path) => ({ path, exists: true }));
    case "readiness":
      return { claude: { ok: true }, ghLogin: { ok: true }, gitIdentity: { ok: true } };
    case "toolchainInfo":
      return { platform: "win32", electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, languageServer: { available: true, typescript: "6.0.3" } };
    case "updateStatus":
      return { current: pkg.version, release: null, install: null, notice: null, downloadPage: "https://example.com/releases" };
    case "pty.info":
      return { available: true, reason: null, osBuild: 22631, shells: ["powershell", "cmd"] };
    case "pty.list":
    case "pty.detectRuns":
    case "pickImages":
      return [];
    case "confirmProjectChange":
      return { asked: false, ok: true };
    case "logError":
      process.stderr.write(`shots: page error (${l.scene.name}): ${String(args[0]).slice(0, 400)}\n`);
      return undefined;
    case "setUI":
    case "copyText":
    case "notify":
    case "openExternal":
    case "chooseDirectory":
    case "pickAddDirectory":
    case "takeWorkbenchSetupReport":
    case "takeWorkbenchDraft":
      return null;
    default:
      l.unanswered.add(`bridge.${name}`);
      return null;
  }
}

/** What an open project's window asks for whatever the scene (empty lists, nothing configured); a scene's `replies` win. */
const COMMON_REPLIES: Record<string, Reply> = {
  branches: { type: "result", ok: true },
  workbench_list: { type: "result", ok: true },
  side_list: { type: "side_threads", mainSessionId: null, threads: [] },
  cli_sessions: { type: "cli_sessions", running: [], resumable: [] },
  permission_rules: { type: "permission_rules", sources: [], rules: [], defaultMode: null, defaultModeSupported: true, applyUserAllowRules: true, applyUserBashRules: true },
  status_line: { type: "status_line", lines: [], updatedAt: null, enabled: true, configured: false },
  commit_format: { type: "commit_format", learned: null, kind: null, examples: [], issue: "", branch: null, effective: null },
};

const pendingForever: Promise<never>[] = [];

function reply(l: Live, cmd: Record<string, unknown>): unknown {
  const type = String(cmd.type);
  if (type === "select_file" && typeof cmd.path === "string" && l.scene.diffs?.[cmd.path] !== undefined) {
    return { type: "file_diff", id: cmd.id, scope: "turn", path: cmd.path, diff: addSegments(parseUnifiedDiff(l.scene.diffs[cmd.path]!)), truncated: false };
  }
  const r = l.scene.replies?.[type] ?? COMMON_REPLIES[type];
  if (r === undefined) {
    l.unanswered.add(`request.${type}`);
    return { __error: `shots: no fixture reply for ${type}` };
  }
  if (isPlainObject(r) && r.$pending === true) {
    // Held for the run: a promise nothing references is collected, and Electron then answers "reply was never sent".
    const never = new Promise<never>(() => undefined);
    pendingForever.push(never);
    return never;
  }
  // §73.5: a reply that never comes (a lookup still running — its "looking" state is the shot).
  // A timer holds the pending reply (a bare never-settling promise is collected and Electron answers "reply was never sent").
  if (isPlainObject(r) && r.$hold === true) return new Promise((resolve) => setTimeout(() => resolve({ __error: "shots: held" }), 600_000).unref());
  if (isPlainObject(r) && typeof r.$by === "string" && isPlainObject(r.map)) {
    const hit = r.map[String(cmd[r.$by])];
    if (hit === undefined) {
      l.unanswered.add(`request.${type}.${String(cmd[r.$by])}`);
      return { __error: `shots: no fixture reply for ${type} ${String(cmd[r.$by])}` };
    }
    return hit;
  }
  return r;
}

ipcMain.on("shots:boot", (e) => {
  const l = liveOf(e.sender);
  e.returnValue = { locale: l.variant.locale, initialProject: null, noStartScreen: true };
});
ipcMain.handle("shots:attach", (e): EngineEvent[] => {
  const l = liveOf(e.sender);
  return [{ type: "state", state: stateOf(l) }, ...(l.scene.events ?? [])] as unknown as EngineEvent[];
});
ipcMain.handle("shots:call", (e, name: string, args: unknown[]) => {
  const l = liveOf(e.sender);
  if (l.scene.bridge && name in l.scene.bridge) return l.scene.bridge[name];
  return defaults(l, name, args);
});
ipcMain.handle("shots:request", (e, cmd: Record<string, unknown>) => reply(liveOf(e.sender), cmd));
ipcMain.handle("shots:send", () => undefined); // commands go nowhere: there is no engine

// ---------------------------------------------------------------- steps

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page-side code of a step (run with `executeJavaScript`, so it is plain JS of its own). */
function pageStep(step: Record<string, unknown>): string {
  return `(async (step) => {
    const sel = (t) => typeof t === "string" ? '[data-testid="' + t + '"]' : t.testid ? '[data-testid="' + t.testid + '"]' : t.selector;
    const find = (t) => {
      if (typeof t === "object" && t.text) {
        const all = [...document.querySelectorAll(t.selector || "button, [role=button], [role=tab], a, label, summary")];
        return all.find((el) => el.textContent.trim() === t.text) || all.find((el) => el.textContent.includes(t.text)) || null;
      }
      return document.querySelector(sel(t));
    };
    if (step.select) {
      const roots = [...document.querySelectorAll(step.select.within || "body")];
      for (const root of roots) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const at = n.textContent.indexOf(step.select.text);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + step.select.text.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          if (step.select.scrollOnly) { n.parentElement.scrollIntoView({ block: "center" }); return null; }
          sel.addRange(range);
          n.parentElement.scrollIntoView({ block: "center" });
          return null;
        }
      }
      return "no text to select " + JSON.stringify(step.select);
    }
    if (step.click) {
      const el = find(step.click);
      if (!el) return "no element for click " + JSON.stringify(step.click);
      el.scrollIntoView({ block: "nearest" });
      el.click();
      return null;
    }
    if (step.type) {
      const el = find(step.type);
      if (!el) return "no field for type " + JSON.stringify(step.type);
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, step.type.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return null;
    }
    if (step.key) {
      const target = document.activeElement || document.body;
      const init = { key: step.key, bubbles: true, cancelable: true, ctrlKey: !!step.ctrl, shiftKey: !!step.shift, altKey: !!step.alt };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return null;
    }
    if (step.waitFor) {
      const until = Date.now() + (step.timeoutMs || 4000);
      while (Date.now() < until) {
        if (find(step.waitFor)) return null;
        await new Promise((r) => setTimeout(r, 50));
      }
      return "never appeared: " + JSON.stringify(step.waitFor);
    }
    return null;
  })(${JSON.stringify(step)})`;
}

async function runStep(wc: WebContents, step: Step, locale: "en" | "ko"): Promise<string | null> {
  if ("wait" in step) {
    await sleep(step.wait);
    return null;
  }
  if ("menu" in step) {
    wc.send("shots:menu", step.menu);
    await sleep(150);
    return null;
  }
  if ("event" in step) {
    wc.send("shots:evt", step.event);
    await sleep(100);
    return null;
  }
  const local = JSON.parse(JSON.stringify(step), (_k, v) => (isPlainObject(v) && typeof v.en === "string" && typeof v.ko === "string" && Object.keys(v).length === 2 ? loc(v as Localized, locale) : v));
  const err = (await wc.executeJavaScript(pageStep(local))) as string | null;
  await sleep(120);
  return err;
}

// ---------------------------------------------------------------- one shot

type ShotResult = { scene: string; file: string; variant: string; findings: LayoutFinding[]; errors: string[]; unanswered: string[] };

/** Fraction of sampled pixels that differ from the first one: ~0 is a blank (one-colour) shot. */
function varied(bitmap: Buffer): number {
  const step = 4 * 97;
  let diff = 0;
  let n = 0;
  for (let i = 0; i < bitmap.length; i += step) {
    n += 1;
    if (Math.abs(bitmap[i]! - bitmap[0]!) + Math.abs(bitmap[i + 1]! - bitmap[1]!) + Math.abs(bitmap[i + 2]! - bitmap[2]!) > 24) diff += 1;
  }
  return n === 0 ? 0 : diff / n;
}

async function shoot(scene: Scene, variant: Variant, index: number): Promise<ShotResult> {
  const [ww, wh] = variant.size.window;
  const tag = `${variant.size.name}-${variant.theme}-${variant.locale}`;
  const file = join(shotsDir, "shots", `${scene.name}--${tag}.png`);
  const errors: string[] = [];
  nativeTheme.themeSource = variant.theme;
  const win = new BrowserWindow({
    width: ww - FRAME.w,
    height: wh - FRAME.h,
    useContentSize: true,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: variant.theme === "dark" ? "#1e1e1e" : "#ffffff",
    webPreferences: {
      preload: preloadPath,
      offscreen: true,
      partition: `shots-${index}`, // in memory: no localStorage carried from one shot to the next
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.on("show", () => violation(`${scene.name} ${tag}: window shown`));
  win.on("focus", () => violation(`${scene.name} ${tag}: window focused`));
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("console-message", (details) => {
    if (details.level === "error") errors.push(`console: ${details.message.slice(0, 300)}`);
  });
  wc.on("render-process-gone", (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  const l: Live = { scene, variant, settings: { ...DEFAULTS, ...scene.settings, appearance: variant.theme }, unanswered: new Set() };
  live.set(wc.id, l);
  try {
    await win.loadFile(join(rendererDir, "index.html"));
    const root = (scene.state?.project as { root?: string } | null | undefined)?.root;
    if (scene.promptHistory && root) {
      // The composer reads the history when it mounts: write it, then load the page again (the partition keeps it).
      const key = `rg.promptHistory.${projectRootHash(root)}`;
      await wc.executeJavaScript(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(scene.promptHistory))})`);
      await win.loadFile(join(rendererDir, "index.html"));
    }
    const ready = await wc.executeJavaScript(`new Promise((r) => { const t0 = Date.now(); const tick = () => document.querySelector('[data-testid="App"]') ? r(true) : Date.now() - t0 > 8000 ? r(false) : setTimeout(tick, 50); tick(); })`);
    if (!ready) errors.push("the app never rendered");
    await sleep(400);
    for (const step of scene.steps ?? []) {
      const err = await runStep(wc, step, variant.locale);
      if (err) errors.push(`step: ${err}`);
    }
    await wc.executeJavaScript(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    await sleep(350);
    if (process.env.SHOTS_PROBE) process.stdout.write(`probe ${scene.name} ${tag}: ${JSON.stringify(await wc.executeJavaScript(process.env.SHOTS_PROBE).catch((e: unknown) => String(e)))}\n`);
    const findings = (await wc.executeJavaScript(`(${layoutCheck.toString()})(${JSON.stringify({ home: homedir() })})`)) as LayoutFinding[];
    const image = await wc.capturePage();
    if (image.isEmpty() || varied(image.toBitmap()) < 0.01) findings.push({ kind: "BLANK", what: "the shot is one colour", rect: null });
    if (win.isVisible()) violation(`${scene.name} ${tag}: window visible`);
    mkdirSync(join(shotsDir, "shots"), { recursive: true });
    writeFileSync(file, image.toPNG());
    return { scene: scene.name, file, variant: tag, findings, errors, unanswered: [...l.unanswered] };
  } finally {
    live.delete(wc.id);
    win.destroy();
    await session.fromPartition(`shots-${index}`).clearStorageData().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- the run

async function run(): Promise<number> {
  const scenes = loadScenes();
  if (scenes.length === 0) throw new Error(`shots: no scene matches SHOTS_SCENES=${only.join(",")}`);
  const results: ShotResult[] = [];
  let index = 0;
  for (const scene of scenes) {
    for (const size of SIZES) {
      for (const theme of THEMES) {
        for (const locale of LOCALES) {
          const r = await shoot(scene, { size, theme, locale }, index++);
          results.push(r);
          const marks = [...r.findings.map((f) => `${f.kind} ${f.what}`), ...r.errors];
          process.stdout.write(`${marks.length === 0 ? "ok  " : "MARK"} ${scene.name} ${r.variant}${marks.length ? `\n       ${marks.join("\n       ")}` : ""}\n`);
        }
      }
    }
  }
  const marked = results.filter((r) => r.findings.length > 0 || r.errors.length > 0);
  const unanswered = [...new Set(results.flatMap((r) => r.unanswered.map((u) => `${r.scene}: ${u}`)))];
  writeFileSync(join(shotsDir, "report.json"), JSON.stringify({ results, violations, unanswered }, null, 2));
  for (const u of unanswered) process.stdout.write(`note: no fixture for ${u}\n`);
  process.stdout.write(`shots: ${results.length} PNGs in ${join(shotsDir, "shots")}; ${marked.length} marked; ${violations.length} visibility violations\n`);
  return marked.length > 0 || violations.length > 0 ? 1 : 0;
}

void app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (e) {
    process.stderr.write(`shots: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  }
  app.exit(code);
});
app.on("window-all-closed", () => undefined); // the run decides when to quit
