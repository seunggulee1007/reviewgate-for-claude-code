// docs/PROTOCOL.md §70.3 on Windows: /export and /copy — the commands sent, the clipboard write (stubbed: never the real
// clipboard), the save dialog's pick, the refusals in the user's words and the dialog as markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => { ok: true; reply: unknown } | { ok: false; error: string; code?: string } = () => ({ ok: true, reply: { type: "result", ok: true } });

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      onEvent: () => () => undefined,
      copyText: async () => {
        throw new Error("the real clipboard must not be written in a test");
      },
      platform: "win32",
      sep: "\\",
    },
  };
  return { mod: await import("./chatExport"), dialog: await import("./components/dialogs/ChatExportDialog") };
}

describe("§70.3 /export and /copy on Windows", () => {
  beforeAll(() => initI18n("en", "win32"));
  afterAll(() => initI18n("en", "darwin"));
  let m: Awaited<ReturnType<typeof load>>;
  const copied: string[] = [];
  const copy = async (text: string) => {
    copied.push(text);
  };

  beforeEach(async () => {
    sent.length = 0;
    copied.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
    m = await load();
  });

  it("/copy N parses its argument and copies that answer", async () => {
    expect(m.mod.copyArgument("")).toBe(1);
    expect(m.mod.copyArgument(" 3 ")).toBe(3);
    expect(m.mod.copyArgument("0")).toBeNull();
    expect(m.mod.copyArgument("two")).toBeNull();
    answer = () => ({ ok: true, reply: { type: "response_text", n: 2, text: "Done." } });
    const r = await m.mod.copyResponse("2", copy);
    expect(sent).toEqual([{ type: "copy_response", n: 2 }]);
    expect(copied).toEqual(["Done."]);
    expect(r).toEqual({ ok: true, notice: "Copied Claude's answer 2 back" });
    const bad = await m.mod.copyResponse("x", copy);
    expect(bad.ok).toBe(false);
    expect(sent).toHaveLength(1); // nothing sent for a non-number
  });

  it("a refusal reads in the user's words and copies nothing", async () => {
    answer = () => ({ ok: false, error: "no_response:1", code: "no_response" });
    expect(await m.mod.copyResponse("", copy)).toEqual({ ok: false, notice: "Claude has not answered in this chat yet" });
    expect(copied).toEqual([]);
  });

  it("/export file writes there; one that exists is refused", async () => {
    answer = () => ({ ok: true, reply: { type: "chat_export", text: "> hi\n", name: "n.txt", path: "C:\\work\\acme\\chat.txt" } });
    const r = await m.mod.exportToFile("chat.txt");
    expect(sent).toEqual([{ type: "export_chat", path: "chat.txt" }]);
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("chat.txt");
    answer = () => ({ ok: false, error: "export_exists:C:\\work\\acme\\chat.txt", code: "export_exists" });
    const refused = await m.mod.exportToFile("chat.txt");
    expect(refused).toEqual({ ok: false, notice: "C:\\work\\acme\\chat.txt exists already — /export never replaces a file" });
  });

  it("/export alone: the text for the dialog; Copy and Save (the dialog's pick, replace)", async () => {
    answer = () => ({ ok: true, reply: { type: "chat_export", text: "> hi\n\n⏺ Hello.\n", name: "2026-11-26-120000-hi.txt", path: null } });
    const loaded = await m.mod.loadExport();
    expect(sent).toEqual([{ type: "export_chat" }]);
    expect("export" in loaded && loaded.export.name).toBe("2026-11-26-120000-hi.txt");
    const exp = "export" in loaded ? loaded.export : { text: "", name: "", path: null };
    expect(await m.mod.copyExport(exp, copy)).toEqual({ ok: true, notice: "Copied the conversation to the clipboard" });
    expect(copied).toEqual([exp.text]);
    expect(await m.mod.saveExport(exp, async () => null)).toBeNull(); // cancelled: nothing sent
    expect(sent).toHaveLength(1);
    answer = () => ({ ok: true, reply: { type: "chat_export", text: exp.text, name: exp.name, path: "C:\\Users\\dev\\chat.txt" } });
    const saved = await m.mod.saveExport(exp, async (name) => `C:\\Users\\dev\\${name}`);
    expect(sent[1]).toEqual({ type: "export_chat", path: "C:\\Users\\dev\\2026-11-26-120000-hi.txt", replace: true });
    expect(saved?.ok).toBe(true);
    expect(m.mod.exportSize(exp.text)).toBe("3 lines · 15 characters");
  });

  it("the dialog: the preview, the size, Copy as the default and Save with tooltips", () => {
    const html = renderToStaticMarkup(createElement(m.dialog.ChatExportDialog, { export: { text: "> hi\n", name: "n.txt", path: null }, onClose: () => undefined }));
    expect(html).toContain("Export Conversation");
    expect(html).toContain("&gt; hi");
    expect(html).toContain("1 lines · 5 characters");
    expect(html).toContain('data-testid="Chat export copy"');
    expect(html).toContain("Puts the whole conversation on the clipboard as plain text");
    expect(html).toContain("Choose where to save the conversation as a text file");
  });
});
