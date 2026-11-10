/**
 * `electron . --e2e` (docs/M11-WINDOWS.md): the primary window's renderer runs a scripted sequence
 * against the REAL engine + real `claude` (src/renderer/e2e.ts), a secondary window verifies the
 * lock-conflict / take-over dialog, screenshots go to REVIEWGATE_E2E_SHOT_DIR, the JSON report goes
 * to stdout and the process exits 0 (1 on a failed step, 2 on timeout).
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { countOrphans } from "./orphans.js";

export type E2EMode = { project: string };

type Deps = {
  createWindow: (opts: { e2eRole: "primary" | "secondary" }) => unknown;
  disposeAll: () => Promise<void>;
};

/** The whole scenario (M20's plan block included) runs ~9 min; the CLI's own `api_retry` can add several. */
const TIMEOUT_MS = 20 * 60 * 1000;

export function installE2E(mode: E2EMode, deps: Deps): void {
  let secondaryResolve: ((r: unknown) => void) | null = null;
  const shotDir = process.env.REVIEWGATE_E2E_SHOT_DIR ?? join(app.getPath("temp"), "reviewgate-e2e");

  const finish = async (report: Record<string, unknown>, code: number) => {
    await deps.disposeAll().catch(() => undefined);
    // Children still alive after every engine was disposed (src/main/orphans.ts; ps on macOS, CIM / wmic on Windows).
    // The engine's login-shell probe (`zsh -lic`, ≤ 5 s) may still be winding down; a leaked `claude` stays.
    let { orphans, orphanNames } = countOrphans();
    for (const deadline = Date.now() + 6000; orphans > 0 && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 500));
      ({ orphans, orphanNames } = countOrphans());
    }
    process.stdout.write(JSON.stringify({ project: mode.project, ...report, orphans, orphanNames }) + "\n");
    app.exit(orphans > 0 && code === 0 ? 1 : code);
  };

  const timer = setTimeout(() => void finish({ ok: false, error: "e2e timeout" }, 2), TIMEOUT_MS);

  ipcMain.on("rg:e2e:report", (evt, result: Record<string, unknown>) => {
    if (result.role === "secondary") {
      BrowserWindow.fromWebContents(evt.sender)?.close();
      const r = secondaryResolve;
      secondaryResolve = null;
      r?.(result);
      return;
    }
    clearTimeout(timer);
    void finish(result, result.ok === false ? 1 : 0);
  });

  ipcMain.handle("rg:e2e:screenshot", async (evt, name: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) throw new Error("no window");
    const image = await win.webContents.capturePage();
    mkdirSync(shotDir, { recursive: true });
    const file = join(shotDir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    return file;
  });

  // Only under `--e2e`: the scenario verifies files on disk through this (never registered otherwise, §2.1).
  ipcMain.handle("rg:e2e:readFile", (_e, path: string) => readFile(path, "utf8").catch(() => null));

  ipcMain.handle("rg:e2e:gitLog", () => {
    try {
      return execFileSync("git", ["-C", mode.project, "log", "-1", "--format=%H%n%s"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  });

  ipcMain.handle("rg:e2e:openSecondary", () => {
    return new Promise<unknown>((resolve) => {
      secondaryResolve = resolve;
      deps.createWindow({ e2eRole: "secondary" });
      setTimeout(() => {
        if (secondaryResolve) {
          secondaryResolve = null;
          resolve({ ok: false, error: "secondary window timeout" });
        }
      }, 120_000);
    });
  });
}
