import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOpenableMarkdown } from "./markdownOpen";
import { validateCommand } from "./ipcGuard";

/** wave4d w4d-config — docs/PROTOCOL.md §42.3: only a Markdown file that exists reaches the default app; the editor's commands pass. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("openMarkdown guard", () => {
  it("opens an existing .md file and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-md-"));
    dirs.push(dir);
    const md = join(dir, "CLAUDE.md");
    writeFileSync(md, "# x");
    expect(isOpenableMarkdown(md)).toBe(true);
    expect(isOpenableMarkdown(join(dir, "missing.md"))).toBe(false);
    mkdirSync(join(dir, "Evil.md"));
    expect(isOpenableMarkdown(join(dir, "Evil.md"))).toBe(false); // a folder (an app bundle) named .md
    writeFileSync(join(dir, "run.sh"), "echo");
    expect(isOpenableMarkdown(join(dir, "run.sh"))).toBe(false);
    expect(isOpenableMarkdown("CLAUDE.md")).toBe(false); // relative
    expect(isOpenableMarkdown(`${md}\n`)).toBe(false);
    expect(isOpenableMarkdown(42)).toBe(false);
  });

  it("the claude_md commands are client commands", () => {
    expect(validateCommand({ type: "claude_md_read", path: "CLAUDE.md" }).ok).toBe(true);
    expect(validateCommand({ type: "claude_md_write", path: "CLAUDE.md", text: "x", baseSha: null }).ok).toBe(true);
  });
});
