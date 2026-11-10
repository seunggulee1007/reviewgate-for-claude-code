/**
 * "Open in Editor": VS Code (`code -g path:line`), IntelliJ IDEA (`idea64.exe --line N path` /
 * `idea --line N path`), or the file manager (`shell.showItemInFolder`). Editors are located through
 * the engine's platform `which` (where.exe on Windows) plus the usual install folders.
 */
import { shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createPlatform } from "@reviewgate/engine";
import type { EditorKind } from "../shared/ipc.js";
import { cmdInvocation, isBatchFile } from "./winCmd.js";

const platform = createPlatform(process.platform);

const VSCODE_CANDIDATES: Record<string, string[]> = {
  win32: [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "bin", "code.cmd"),
  ],
  darwin: ["/usr/local/bin/code", "/opt/homebrew/bin/code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
  linux: ["/usr/bin/code", "/snap/bin/code"],
};

const IDEA_CANDIDATES: Record<string, string[]> = {
  win32: [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "IntelliJ IDEA", "bin", "idea64.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "IntelliJ IDEA Community Edition", "bin", "idea64.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "JetBrains", "IntelliJ IDEA", "bin", "idea64.exe"),
  ],
  darwin: [
    "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
    "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
    join(homedir(), "Applications", "IntelliJ IDEA.app", "Contents", "MacOS", "idea"),
  ],
  linux: ["/usr/local/bin/idea", "/snap/bin/intellij-idea-ultimate", "/snap/bin/intellij-idea-community"],
};

async function locate(names: string[], candidates: string[]): Promise<string | null> {
  for (const n of names) {
    const found = await platform.which(n);
    if (found) return found;
  }
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

let vscode: string | null | undefined;
let idea: string | null | undefined;

async function vscodePath(): Promise<string | null> {
  if (vscode === undefined) vscode = await locate(process.platform === "win32" ? ["code.cmd", "code"] : ["code"], VSCODE_CANDIDATES[process.platform] ?? []);
  return vscode;
}

async function ideaPath(): Promise<string | null> {
  if (idea === undefined) idea = await locate(process.platform === "win32" ? ["idea64.exe", "idea.bat"] : ["idea"], IDEA_CANDIDATES[process.platform] ?? []);
  return idea;
}

function run(exe: string, args: string[]): void {
  // `.cmd` / `.bat` shims (code.cmd, idea.bat) need cmd.exe on Windows (Node refuses them without a
  // shell): every argument is quoted and ^-escaped (src/main/winCmd.ts), so spaces, &, ^, %, ( ) and
  // Korean in a path reach the editor unchanged. Everything else is spawned directly.
  const child =
    process.platform === "win32" && isBatchFile(exe)
      ? (() => {
          const inv = cmdInvocation(exe, args, process.env.ComSpec ?? "cmd.exe");
          return spawn(inv.file, inv.args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
        })()
      : spawn(exe, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

/** Returns the editor that was used (so the renderer can remember it), or null when none could be found. */
export async function openInEditor(absolutePath: string, line: number | null, preferred: EditorKind = "auto"): Promise<EditorKind | null> {
  // Renderer input: only an absolute path (no NUL / newline) and a positive line reach a spawn.
  if (typeof absolutePath !== "string" || !isAbsolute(absolutePath) || /[\0\r\n]/.test(absolutePath)) return null;
  if (line !== null && !(Number.isInteger(line) && line > 0)) line = null;
  if (!["auto", "vscode", "idea", "explorer"].includes(preferred)) preferred = "auto";
  const order: EditorKind[] = preferred === "auto" ? ["vscode", "idea", "explorer"] : [preferred, "explorer"];
  for (const kind of order) {
    if (kind === "vscode") {
      const exe = await vscodePath();
      if (!exe) continue;
      run(exe, ["-g", line ? `${absolutePath}:${line}` : absolutePath]);
      return "vscode";
    }
    if (kind === "idea") {
      const exe = await ideaPath();
      if (!exe) continue;
      run(exe, line ? ["--line", String(line), absolutePath] : [absolutePath]);
      return "idea";
    }
    if (kind === "explorer") {
      shell.showItemInFolder(absolutePath);
      return "explorer";
    }
  }
  return null;
}
