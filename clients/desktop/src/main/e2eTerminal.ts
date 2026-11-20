/**
 * MARK: terminal-win — PROTOCOL §57.17: `--e2e-terminal`, the hidden Electron run of a terminal chat (Windows CI:
 * `npm run e2e:terminal -w clients/desktop`, scripts/e2e-terminal.mjs). Never on a developer's machine: the launcher
 * refuses outside Windows unless told otherwise, the windows are never shown, userData is the scratch folder of
 * `--rg-user-data`, and claude is the node fake (src/main/pty/testing/fakeClaudeTerminal.cjs) — never the real CLI.
 *
 * The page is driven only through what any renderer has: `window.rg` (the §57.17 contract over real IPC, through the IPC
 * guard and the window's PtyHub), plus CDP for the IME and `sendInputEvent` for Ctrl+`. Steps that need the renderer's
 * terminal (an xterm in the page: IME composition, the Ctrl+` panel) run when the page has one and are reported as
 * skipped otherwise. The JSON report goes to stdout and to `--rg-e2e-out=<file>`; the exit code is 0 / 1, 2 on timeout;
 * a child process left after every engine stopped (OpenConsole.exe counted) fails the run.
 */
import { app, type BrowserWindow } from "electron";
import { realpathSync, writeFileSync } from "node:fs";
import type { ReviewEngine, ReviewState } from "@reviewgate/engine";
import type { PtyExit, PtyOpenResult } from "../shared/ipc.js";
import { countOrphans } from "./orphans.js";

const TIMEOUT_MS = 5 * 60 * 1000;

/** `--rg-user-data=<dir>`: honoured only together with an e2e flag (a normal launch always uses the real userData). */
export function e2eUserDataArg(argv: readonly string[]): string | null {
  if (!argv.includes("--e2e") && !argv.includes("--e2e-terminal")) return null;
  const a = argv.find((x) => x.startsWith("--rg-user-data="));
  const dir = a?.slice("--rg-user-data=".length) ?? "";
  return dir.length > 0 ? dir : null;
}

/** `--rg-e2e-out=<file>` under `--e2e-terminal` only. */
export function e2eOutArg(argv: readonly string[]): string | null {
  if (!argv.includes("--e2e-terminal")) return null;
  const a = argv.find((x) => x.startsWith("--rg-e2e-out="));
  return a ? a.slice("--rg-e2e-out=".length) || null : null;
}

/** Text a terminal showed: escape sequences and line breaks out (ConPTY may wrap a long line). */
export function plainTerminalText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/[\r\n]/g, "");
}

type Win = { win: BrowserWindow; engine: ReviewEngine };
/** `claudePath`: the stored override, which must be the launcher's fake (`REVIEWGATE_E2E_FAKE_CLAUDE`) — never the real CLI. */
type Deps = { createWindow: (opts: { project: string }) => Win; disposeAll: () => Promise<void>; claudePath: () => string };
type Step = { name: string; ok: boolean; ms: number; detail?: string };

export function installTerminalE2E(project: string, deps: Deps, out: string | null): void {
  const steps: Step[] = [];
  const skipped: string[] = [];
  let done = false;
  const finish = async (report: Record<string, unknown>, code: number) => {
    if (done) return;
    done = true;
    await deps.disposeAll().catch(() => undefined);
    let { orphans, orphanNames } = countOrphans();
    for (const deadline = Date.now() + 8000; orphans > 0 && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 500));
      ({ orphans, orphanNames } = countOrphans());
    }
    const json = JSON.stringify({ project, ...report, steps, skipped, orphans, orphanNames });
    process.stdout.write(json + "\n");
    if (out) {
      try {
        writeFileSync(out, json);
      } catch {
        /* stdout has it */
      }
    }
    app.exit(orphans !== 0 && code === 0 ? 1 : code);
  };
  const timer = setTimeout(() => void finish({ ok: false, error: "e2e-terminal timeout" }, 2), TIMEOUT_MS);
  void run(project, deps, steps, skipped)
    .then(() => finish({ ok: true }, 0))
    .catch((err: unknown) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1))
    .finally(() => clearTimeout(timer));
}

async function until<T>(what: string, f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

async function run(project: string, deps: Deps, steps: Step[], skipped: string[]): Promise<void> {
  const step = async (name: string, f: () => Promise<string | void>) => {
    const t0 = Date.now();
    try {
      const detail = await f();
      steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  const fake = process.env.REVIEWGATE_E2E_FAKE_CLAUDE ?? "";
  if (!fake || deps.claudePath() !== fake) throw new Error("settings.claudePath is not the launcher's fake claude: refusing to run (never the real claude)");
  const { win, engine } = deps.createWindow({ project });
  const wc = win.webContents;
  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>;
  const state = (): ReviewState => engine.state;
  const output = async (id: string) => plainTerminalText(await js<string>(`(window.__rgTermE2E.out[${JSON.stringify(id)}] || "")`));
  const exits = () => js<PtyExit[]>("window.__rgTermE2E.exits");
  const input = (id: string, data: string) => js(`window.rg.pty.input(${JSON.stringify(id)}, ${JSON.stringify(data)})`);
  const hasXterm = () => js<boolean>("!!document.querySelector('.xterm-helper-textarea')");

  await step("the page and the project", async () => {
    await until("window.rg", () => js<boolean>("!!(window.rg && window.rg.pty)").catch(() => false), 60_000);
    // Every byte the page gets from its PTYs, by id (the page's own terminal, if any, gets them too).
    await js(`(() => { if (window.__rgTermE2E) return; const s = window.__rgTermE2E = { out: {}, exits: [] };
      window.rg.pty.onData((id, d) => { s.out[id] = (s.out[id] || "") + d; });
      window.rg.pty.onExit((e) => s.exits.push(e)); })()`);
    await until("the project", () => state().project !== null && state().session.open, 60_000);
    const info = await js<{ available: boolean; reason: string | null }>("window.rg.pty.info()");
    if (!info.available) throw new Error(`no PTY: ${info.reason}`);
  });

  let sessionId = "";
  let chat = "";
  await step("New Terminal Chat, its PTY opened through rg:pty:open", async () => {
    await js(`window.rg.send({ type: "session_new", kind: "terminal" })`);
    sessionId = await until("the terminal chat", () => {
      const st = state();
      const id = st.sessions.currentId;
      return id && st.sessions.list.some((m) => m.id === id && m.kind === "terminal") && st.session.terminal ? id : null;
    });
    // The renderer may not ask for the spec: main keeps it (and the hook token) to itself.
    const refused = await js<string>(`window.rg.request({ type: "terminal_spec", sessionId: ${JSON.stringify(sessionId)} }).then(() => "replied", (e) => String(e && e.message))`);
    if (!refused.includes("rejected command")) throw new Error(`terminal_spec from the page: ${refused}`);
    const r = await js<PtyOpenResult>(`window.rg.pty.open({ kind: "chat", sessionId: ${JSON.stringify(sessionId)}, cols: 300, rows: 40 })`);
    if (!r.ok) throw new Error(`open refused: ${r.code} ${r.error}`);
    chat = r.ptyId;
    const again = await js<PtyOpenResult>(`window.rg.pty.open({ kind: "chat", sessionId: ${JSON.stringify(sessionId)}, cols: 300, rows: 40 })`);
    if (!again.ok || again.ptyId !== chat) throw new Error("a second open did not return the running PTY");
  });

  await step("banner in the terminal", async () => {
    await until("the banner", async () => (await output(chat)).includes(`fake-claude session=${sessionId} resume=false term=ReviewGate token=yes literal=true`));
    await until("terminal_started", () => state().session.terminal?.running === true);
  });

  await step("write → reviewing", async () => {
    await input(chat, "write\r");
    await until("the review", () => state().gate.phase === "reviewing" && state().changedFiles.some((f) => f.path === "notes.txt"));
  });

  await step("reject → the next prompt carries it", async () => {
    await js(`window.rg.send({ type: "reject", paths: ["notes.txt"] })`);
    await until("rejected", () => !state().changedFiles.some((f) => f.path === "notes.txt" && f.state === "pending"));
    await input(chat, "again\r");
    await until("the context line", async () => /context: \[Review gate\].*Rejected/.test(await output(chat)));
  });

  if (await hasXterm()) {
    await step("IME composition of 한 reaches the PTY as UTF-8", async () => {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await js("document.querySelector('.xterm-helper-textarea').focus()");
      for (const text of ["ㅎ", "하", "한"]) await dbg.sendCommand("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
      await dbg.sendCommand("Input.insertText", { text: "한" });
      await input(chat, "\r");
      await until("ed959c", async () => (await output(chat)).includes("hex ed959c"));
    });
    await step("Ctrl+` opens the shell panel (a first shell tab)", async () => {
      const before = (await js<{ kind: string }[]>("window.rg.pty.list()")).filter((p) => p.kind === "shell").length;
      wc.sendInputEvent({ type: "keyDown", keyCode: "`", modifiers: ["control"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "`", modifiers: ["control"] });
      await until("a shell PTY", async () => (await js<{ kind: string }[]>("window.rg.pty.list()")).filter((p) => p.kind === "shell").length > before, 15_000);
    });
  } else {
    skipped.push("IME composition (no terminal in this page)", "Ctrl+` panel (no terminal in this page)");
  }

  await step("a shell tab starts in the project", async () => {
    const shell = process.platform === "win32" ? "cmd" : "powershell";
    const r = await js<PtyOpenResult>(`window.rg.pty.open({ kind: "shell", shell: ${JSON.stringify(shell)}, cols: 300, rows: 30 })`);
    if (!r.ok) throw new Error(`shell refused: ${r.code} ${r.error}`);
    await input(r.ptyId, process.platform === "win32" ? "echo [%CD%]\r" : 'echo "[$PWD]"\r');
    const shown = await until("the folder", async () => {
      const all = [...(await output(r.ptyId)).matchAll(/\[([^\[\]%$]+)\]/g)].map((m) => m[1]!.trim());
      return all.find((p) => sameFolder(p, project)) ?? null;
    });
    await input(r.ptyId, "exit\r");
    await until("the shell's exit", async () => (await exits()).some((e) => e.ptyId === r.ptyId));
    return shown;
  });

  await step("/exit, then the chat's PTY is gone", async () => {
    await input(chat, "/exit\r");
    const e = await until("the chat's exit", async () => (await exits()).find((x) => x.ptyId === chat));
    if (e.exitCode !== 0) throw new Error(`exit code ${e.exitCode}`);
    await until("terminal not running", () => state().session.terminal?.running === false);
    for (const p of await js<{ ptyId: string }[]>("window.rg.pty.list()")) await js(`window.rg.pty.kill(${JSON.stringify(p.ptyId)})`);
  });
}
