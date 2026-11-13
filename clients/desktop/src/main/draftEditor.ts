/**
 * MARK: composer parity — docs/PROTOCOL.md §56.3: Ctrl+G edits the composer's draft in an external editor, as in the
 * terminal (as on the Mac, Core DraftEditor.swift / App ComposerExternalEditor.swift). The draft goes to a .md file in the
 * app's own temp folder, the editor opens it, each save goes back to the renderer (`rg:draftEdit`), and an editor that
 * waits ends the editing when it closes. Which editor: $VISUAL, else $EDITOR — when it opens a window (a terminal editor has
 * no terminal here; a known GUI editor gets its wait flag) —, else VS Code's `code --wait`, else the system's: Notepad on
 * Windows (it waits), `open -t` on macOS and `xdg-open` elsewhere (they do not wait: Done ends it).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DraftEditEvent, DraftEditStart } from "../shared/ipc.js";
import { cmdInvocation, isBatchFile } from "./winCmd.js";

const TERMINAL_ONLY = new Set(["vi", "vim", "nvim", "view", "nano", "pico", "emacs", "ed", "ex", "micro", "hx", "helix", "kak", "joe", "ne", "mg", "jed", "less", "more", "vis", "amp"]);
const WAIT_FLAGS: Record<string, string[]> = {
  code: ["--wait", "-w"], "code-insiders": ["--wait", "-w"], cursor: ["--wait", "-w"], windsurf: ["--wait", "-w"], zed: ["--wait", "-w"],
  subl: ["-w", "--wait"], mate: ["-w", "--wait"], bbedit: ["--wait", "-w"], atom: ["--wait", "-w"], mvim: ["-f"], gvim: ["-f"],
};

export type DraftEditorLaunch =
  /** A command line run by the shell with the file appended (quoted); it waits. */
  | { kind: "shell"; name: string; line: string }
  /** A program and its arguments (the file last). */
  | { kind: "exec"; name: string; exe: string; args: string[]; waits: boolean };

/** `$VISUAL` / `$EDITOR` as a command line that opens a window and waits; null for a terminal editor. */
export function guiCommand(value: string): { name: string; line: string } | null {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const program = (words[0]!.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
  if (program === "emacsclient") return words.includes("-c") || words.includes("--create-frame") ? { name: program, line: value.trim() } : null;
  if (TERMINAL_ONLY.has(program)) return null;
  const flags = WAIT_FLAGS[program];
  if (!flags || words.some((w) => flags.includes(w))) return { name: program, line: value.trim() };
  return { name: program, line: `${value.trim()} ${flags[0]}` };
}

export function draftEditorLaunch(file: string, env: Record<string, string | undefined>, platform: NodeJS.Platform, code: string | null): DraftEditorLaunch {
  for (const key of ["VISUAL", "EDITOR"]) {
    const command = guiCommand(env[key] ?? "");
    if (command) return { kind: "shell", ...command };
  }
  if (code) return { kind: "exec", name: "VS Code", exe: code, args: ["--wait", file], waits: true };
  if (platform === "win32") return { kind: "exec", name: "Notepad", exe: "notepad.exe", args: [file], waits: true };
  if (platform === "darwin") return { kind: "exec", name: "TextEdit", exe: "/usr/bin/open", args: ["-t", file], waits: false };
  return { kind: "exec", name: "xdg-open", exe: "xdg-open", args: [file], waits: false };
}

/** The draft's own temp folder (under the system's). */
export function draftFolder(temp: string): string {
  return join(temp, "ReviewGate", "drafts");
}

/** A save's text as it comes back: trailing newlines (an editor adds one) trimmed. */
export function savedText(raw: string): string {
  return raw.replace(/(\r?\n)+$/, "");
}

type Editing = { file: string; child: ChildProcess | null; last: string; send: (ev: DraftEditEvent) => void };
const editing = new Map<string, Editing>();

/** Writes `text` out and opens it; each save (and the editor's exit) goes to `send`. */
export function startDraftEdit(text: string, opts: { temp: string; env: Record<string, string | undefined>; platform: NodeJS.Platform; code: string | null; send: (ev: DraftEditEvent) => void }): DraftEditStart {
  if (typeof text !== "string" || text.length > 1_000_000) return { ok: false, error: "too_long" };
  const id = randomUUID().slice(0, 8);
  const folder = draftFolder(opts.temp);
  const file = join(folder, `draft-${id}.md`);
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, text, "utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const launch = draftEditorLaunch(file, opts.env, opts.platform, opts.code);
  let child: ChildProcess;
  try {
    if (launch.kind === "shell") {
      child = spawn(`${launch.line} "${file}"`, { shell: true, stdio: "ignore", windowsHide: true });
    } else if (opts.platform === "win32" && isBatchFile(launch.exe)) {
      const inv = cmdInvocation(launch.exe, launch.args, opts.env.ComSpec ?? "cmd.exe");
      child = spawn(inv.file, inv.args, { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    } else {
      child = spawn(launch.exe, launch.args, { stdio: "ignore" });
    }
  } catch (e) {
    rmSync(file, { force: true });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const waits = launch.kind === "shell" || launch.waits;
  const entry: Editing = { file, child: waits ? child : null, last: text, send: opts.send };
  editing.set(id, entry);
  child.on("error", (e) => {
    opts.send({ id, error: e.message, done: true });
    finishDraftEdit(id);
  });
  watchFile(file, { interval: 400 }, (cur: Stats, prev: Stats) => {
    if (cur.mtimeMs !== prev.mtimeMs) readSaved(id);
  });
  if (waits) {
    child.on("exit", () => {
      readSaved(id);
      if (editing.has(id)) opts.send({ id, done: true });
      finishDraftEdit(id);
    });
  }
  return { ok: true, id, name: launch.name, waits };
}

function readSaved(id: string): void {
  const e = editing.get(id);
  if (!e) return;
  let text: string;
  try {
    text = savedText(readFileSync(e.file, "utf8"));
  } catch {
    return;
  }
  if (text === e.last) return;
  e.last = text;
  e.send({ id, text });
}

/** Done / Cancel / the window closing: stop watching and remove the file (the editor's window stays the user's). */
export function finishDraftEdit(id: string): void {
  const e = editing.get(id);
  if (!e) return;
  readSaved(id);
  editing.delete(id);
  unwatchFile(e.file);
  rmSync(e.file, { force: true });
}
