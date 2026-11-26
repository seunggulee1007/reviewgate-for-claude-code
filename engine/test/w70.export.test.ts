import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../src/protocol.js";
import { chatExportText, exportFileName, nthResponse, responses, writeExport } from "../src/session/exportChat.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §70.3: `/export` and `/copy` in a classic chat. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
const temp = (name: string): string => {
  const d = realpathSync(makeTempDir(name));
  dirs.push(d);
  return d;
};

function makeRepo(): string {
  const dir = temp("rg-export");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const at = "2026-11-26T10:00:00.000Z";
const rows: TranscriptItem[] = [
  { at, turn: 1, kind: "user_message", text: "Fix the login test\nplease" },
  { at, turn: 1, kind: "assistant_text", text: "Looking at it." },
  { at, turn: 1, kind: "tool_use", id: "t1", name: "Edit", input: { file_path: "/work/acme/src/login.ts" }, file: "src/login.ts" },
  { at, turn: 1, kind: "tool_use", id: "t2", name: "Read", input: { file_path: "/work/acme/x.ts" }, parentToolUseId: "ag" },
  { at, turn: 1, kind: "tool_result", toolUseId: "t1", isError: false, preview: "Updated src/login.ts\nmore" },
  { at, turn: 1, kind: "assistant_text", text: "Fixed." },
  { at, turn: 2, kind: "shell", id: "s1", command: "npm test", cwd: "/work/acme", output: "ok\n", exitCode: 0, durationMs: 10 },
  { at, turn: 2, kind: "user_message", text: "Thanks" },
  { at, turn: 2, kind: "assistant_text", text: "You're welcome." },
];

describe("§70.3 the text (pure)", () => {
  it("renders the conversation in the terminal's shapes", () => {
    expect(chatExportText(rows)).toBe(
      [
        "> Fix the login test\n  please",
        "⏺ Looking at it.",
        "⏺ Edit(src/login.ts)\n  ⎿  Updated src/login.ts",
        "⏺ Fixed.",
        "! npm test\n  ⎿  ok",
        "> Thanks",
        "⏺ You're welcome.",
      ].join("\n\n") + "\n",
    );
    expect(chatExportText([])).toBe("");
  });

  it("/copy N picks the Nth-latest answer (a turn's text joined)", () => {
    expect(responses(rows)).toEqual(["Looking at it.\n\nFixed.", "You're welcome."]);
    expect(nthResponse(rows, undefined)).toBe("You're welcome.");
    expect(nthResponse(rows, 2)).toBe("Looking at it.\n\nFixed.");
    expect(() => nthResponse(rows, 3)).toThrow("no_response:3");
    expect(() => nthResponse(rows, 0)).toThrow(/^invalid_copy_n/);
    expect(() => nthResponse(rows, 1.5)).toThrow(/^invalid_copy_n/);
  });

  it("proposes a dated name from the first message", () => {
    expect(exportFileName(rows, new Date(2026, 10, 26, 14, 30, 5))).toBe("2026-11-26-143005-fix-the-login-test-please.txt");
    expect(exportFileName([], new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02-030405-conversation.txt");
  });

  it("writes relative to the project, refuses an existing file unless replace", async () => {
    const root = temp("rg-export-write");
    expect(await writeExport("out.txt", root, "hi\n", false)).toBe(join(root, "out.txt"));
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hi\n");
    await expect(writeExport("out.txt", root, "again\n", false)).rejects.toThrow(`export_exists:${join(root, "out.txt")}`);
    await writeExport(join(root, "out.txt"), root, "again\n", true);
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("again\n");
    await expect(writeExport("  ", root, "x", false)).rejects.toThrow("export_empty_path");
    await expect(writeExport("missing/dir/out.txt", root, "x", false)).rejects.toThrow(/^export_failed:ENOENT/);
    await expect(writeExport("~/rg-x.txt", root, "x", false, root)).resolves.toBe(join(root, "rg-x.txt"));
  });
});

describe("§70.3 export_chat / copy_response", () => {
  it("replies with the chat's text, writes a file, and copies an answer", async () => {
    const root = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "export_chat" })).rejects.toThrow("no_project");
    await h.open(root);
    await expect(h.engine.request({ type: "export_chat" })).rejects.toThrow("export_empty");
    await expect(h.engine.request({ type: "copy_response" })).rejects.toThrow("no_response:1");

    await h.engine.request({ type: "send", text: "Change README" });
    h.session().emit({ type: "text_delta", text: "Done — README changed." });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running", "turn ended");

    const reply = await h.engine.request({ type: "export_chat" });
    expect(reply.type).toBe("chat_export");
    expect(reply.path).toBeNull();
    expect(reply.text).toContain("> Change README");
    expect(reply.text).toContain("⏺ Done — README changed.");
    expect(reply.name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-change-readme\.txt$/);

    const out = await h.engine.request({ type: "export_chat", path: "chat.txt" });
    expect(out.path).toBe(join(root, "chat.txt"));
    expect(readFileSync(join(root, "chat.txt"), "utf8")).toBe(reply.text);
    writeFileSync(join(root, "keep.txt"), "mine");
    await expect(h.engine.request({ type: "export_chat", path: "keep.txt" })).rejects.toThrow(/^export_exists:/);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("mine");

    const copied = await h.engine.request({ type: "copy_response" });
    expect(copied).toMatchObject({ type: "response_text", n: 1, text: "Done — README changed." });
  });
});
