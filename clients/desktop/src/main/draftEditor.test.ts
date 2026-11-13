import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftEditEvent } from "../shared/ipc.js";
import { draftEditorLaunch, draftFolder, finishDraftEdit, guiCommand, savedText, startDraftEdit } from "./draftEditor.js";

// docs/PROTOCOL.md §56.3 on Windows: which editor Ctrl+G opens the draft in, and the draft's round trip. Mac:
// DraftEditorTests.swift.

const FILE = "C:\\Users\\dev\\AppData\\Local\\Temp\\ReviewGate\\drafts\\draft-1.md";

describe("§56.3 which editor", () => {
  it("$VISUAL, then $EDITOR — a known GUI editor gets its wait flag, a terminal one is passed over", () => {
    expect(draftEditorLaunch(FILE, { VISUAL: "zed", EDITOR: "subl" }, "win32", null)).toEqual({ kind: "shell", name: "zed", line: "zed --wait" });
    expect(draftEditorLaunch(FILE, { EDITOR: "subl" }, "win32", null)).toEqual({ kind: "shell", name: "subl", line: "subl -w" });
    expect(draftEditorLaunch(FILE, { VISUAL: "vim", EDITOR: "nano" }, "win32", "C:\\code.cmd")).toEqual({ kind: "exec", name: "VS Code", exe: "C:\\code.cmd", args: ["--wait", FILE], waits: true });
    expect(guiCommand("code -w")).toEqual({ name: "code", line: "code -w" });
    expect(guiCommand("C:\\Tools\\code.cmd")).toEqual({ name: "code", line: "C:\\Tools\\code.cmd --wait" });
    expect(guiCommand("emacsclient -t")).toBeNull();
    expect(guiCommand("emacsclient -c")).toEqual({ name: "emacsclient", line: "emacsclient -c" });
    expect(guiCommand("   ")).toBeNull();
  });

  it("none set and no VS Code: Notepad on Windows (it waits), open -t on macOS and xdg-open elsewhere (they do not)", () => {
    expect(draftEditorLaunch(FILE, {}, "win32", null)).toEqual({ kind: "exec", name: "Notepad", exe: "notepad.exe", args: [FILE], waits: true });
    expect(draftEditorLaunch("/tmp/d.md", {}, "darwin", null)).toEqual({ kind: "exec", name: "TextEdit", exe: "/usr/bin/open", args: ["-t", "/tmp/d.md"], waits: false });
    expect(draftEditorLaunch("/tmp/d.md", {}, "linux", null)).toMatchObject({ exe: "xdg-open", waits: false });
  });

  it("the app's own temp folder; a save's trailing newlines are trimmed", () => {
    expect(draftFolder("/var/tmp")).toBe(join("/var/tmp", "ReviewGate", "drafts"));
    expect(savedText("Fix the cart\n\n")).toBe("Fix the cart");
    expect(savedText("a\r\nb\r\n")).toBe("a\r\nb");
  });
});

describe.skipIf(process.platform === "win32")("§56.3 the round trip (a POSIX shell stands in for the editor)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes the draft, sends each save back, and Done removes the file", async () => {
    const temp = mkdtempSync(join(tmpdir(), "rg-draft-"));
    temps.push(temp);
    const events: DraftEditEvent[] = [];
    // An editor command that returns at once and waits for nothing: the watching is what is tested.
    const started = startDraftEdit("Fix the cart", { temp, env: { VISUAL: "true" }, platform: process.platform, code: null, send: (ev) => events.push(ev) });
    expect(started).toMatchObject({ ok: true, name: "true", waits: true });
    if (!started.ok) return;
    const folder = draftFolder(temp);
    const [name] = readdirSync(folder);
    expect(readFileSync(join(folder, name!), "utf8")).toBe("Fix the cart");
    // The shell editor exits at once: its exit ends the editing (done), the file goes.
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.done) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(events.at(-1)).toEqual({ id: started.id, done: true });
    expect(readdirSync(folder)).toEqual([]);
    finishDraftEdit(started.id); // a second finish is a no-op
  });

  it("a save while it is open comes back once; Done stops it", async () => {
    const temp = mkdtempSync(join(tmpdir(), "rg-draft-"));
    temps.push(temp);
    const events: DraftEditEvent[] = [];
    const started = startDraftEdit("draft", { temp, env: { VISUAL: "sleep 3;" }, platform: "linux", code: null, send: (ev) => events.push(ev) });
    if (!started.ok) throw new Error(started.error);
    const folder = draftFolder(temp);
    const file = join(folder, readdirSync(folder)[0]!);
    await new Promise((r) => setTimeout(r, 1100)); // a later mtime than the write
    writeFileSync(file, "draft, edited\n");
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([{ id: started.id, text: "draft, edited" }]);
    finishDraftEdit(started.id);
    expect(readdirSync(folder)).toEqual([]);
  });
});
