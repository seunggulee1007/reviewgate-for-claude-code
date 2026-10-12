import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/git/checkpoint.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.5: `reject_hunks` that keeps part of a file re-checks its §34.7 `whitespaceOnly` (one `-w` numstat
 * of that file). Before, the flag stayed what the collection said: a file whose only real hunk was rejected — what is left
 * is an indentation change — was not marked (no "공백만" badge, not folded), and nothing recomputed it until the next
 * rebuild of the list.
 */

const BASE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]) => lines.join("\n") + "\n";
/** Line 2 really changes; line 28 only gains indentation (far enough apart: two hunks). */
const EDITED = BASE.map((l, i) => (i === 1 ? "two!" : i === 27 ? `    ${l}` : l));

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function reviewing(): Promise<Harness> {
  const dir = realpathSync(makeTempDir("rg-hunksws"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "f.txt", text(BASE));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "edit" });
  write(dir, "f.txt", text(EDITED));
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "reviewing");
  return h;
}

const file = (h: Harness) => h.engine.state.changedFiles.find((f) => f.path === "f.txt") as (ChangedFile & { whitespaceOnly?: true }) | undefined;

describe("reject_hunks re-checks whitespaceOnly (§37.5)", () => {
  it("rejecting the only real hunk leaves an indentation change: the file is whitespaceOnly now", async () => {
    const h = await reviewing();
    expect(file(h)?.whitespaceOnly).toBeUndefined();
    await h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0] });
    expect(file(h)).toMatchObject({ partial: true, added: 1, deleted: 1, whitespaceOnly: true });
  });

  it("rejecting the indentation hunk leaves the real change: still not whitespaceOnly", async () => {
    const h = await reviewing();
    await h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [1] });
    expect(file(h)).toMatchObject({ partial: true, added: 1, deleted: 1 });
    expect(file(h)?.whitespaceOnly).toBeUndefined();
  });
});
