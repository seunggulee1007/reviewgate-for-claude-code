import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchEntries, fuzzyScore, mentionToken, FileIndex } from "../src/files/fileIndex.js";
import { MAX_ATTACHMENT_BYTES, prepareAttachments, sniffImage } from "../src/session/attachments.js";
import { checkpointFilePath, filesPlan, newRecord } from "../src/review/checkpoints.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { SESSION_FILE } from "../src/review/persist.js";
import { repoRelativeInside } from "../src/platform/paths.js";
import type { TranscriptItem } from "../src/protocol.js";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §23–28: file mentions (`list_files`, `send.mentions`), image attachments (`send.attachments`,
 * `attachment_get`), model / effort switching (`set_model`), turn checkpoints + `rewind`, `compact` +
 * `context_warning`, and `interrupt` waiting for the collection.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-m23"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\n");
  write(dir, "src/engine/gate.ts", "export const g = 1;\n");
  write(dir, "src/engine/state.ts", "export const s = 1;\n");
  write(dir, "docs/PROTOCOL.md", "# protocol\n");
  write(dir, "my notes.txt", "spaced\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** The id the CLI reports: a fork's new id, a resumed one, else the pre-chosen one. */
const cliId = (s: FakeClaudeSession): string => (s.opts.settings.forkAt ? s.opts.settings.sessionId! : s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!);

let uuidSeq = 0;
/**
 * The session's own attribution of what `mutate` wrote (§31): every file left changed against HEAD, as Claude's Edit calls —
 * a file rewind restores Claude's changes only (§35.11: what nothing of Claude's explains stays).
 */
function claudeWrote(h: Harness): ToolFileEntry[] {
  const root = h.engine.state.project?.root;
  if (!root) return [];
  const entries = sh(root, "status", "--porcelain", "-z", "-uall").split("\0").filter(Boolean);
  const out: ToolFileEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    out.push({ path: join(root, e.slice(3)), tools: ["Edit"], count: 1, toolUseIds: [`edit-${uuidSeq}-${i}`] });
    if (/^[RC]/.test(e)) i += 1; // a rename's source path follows
  }
  return out;
}

/** One turn: send, mutate the worktree, end it (with a chain uuid and Claude's edits); waits until it was collected. */
async function turn(h: Harness, text: string, mutate: () => void = () => {}, extra: Record<string, unknown> = {}): Promise<string> {
  const before = h.engine.state.hud.turnCount;
  await h.engine.handle({ type: "send", text, ...extra } as never);
  const s = h.session();
  s.emitSessionInfo({ sessionId: cliId(s) });
  mutate();
  const uuid = `uuid-${++uuidSeq}`;
  s.emitTurnEnd({ sessionId: cliId(s), lastUuid: uuid, toolFiles: claudeWrote(h) });
  await h.waitFor((st) => st.hud.turnCount > before && st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn collected");
  await h.settle();
  return uuid;
}

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("§23 file mentions", () => {
  it("fuzzy matching: basename beats path spread, subsequence, changed files first, cap 50", () => {
    const entries = ["src/engine/gate.ts", "src/engine/state.ts", "docs/PROTOCOL.md", "src/agents.ts", "gadget/x.ts"].map((p) => ({ path: p, lower: p.toLowerCase(), base: p.split("/").pop()!.toLowerCase(), kind: "file" as const }));
    expect(fuzzyScore("gte", entries[0]!)).not.toBeNull();
    expect(fuzzyScore("zzz", entries[0]!)).toBeNull();
    const r = searchEntries(entries, "gate", new Set());
    expect(r[0]!.path).toBe("src/engine/gate.ts");
    const withChanged = searchEntries(entries, "ts", new Set(["src/agents.ts"]));
    expect(withChanged[0]).toEqual({ path: "src/agents.ts", kind: "file", changed: true });
    expect(searchEntries(entries, "", new Set(), 2)).toHaveLength(2);
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}.ts`, lower: `f${i}.ts`, base: `f${i}.ts`, kind: "file" as const }));
    expect(searchEntries(many, "f", new Set(), 500)).toHaveLength(50);
    expect(mentionToken("src/a.ts")).toBe("@src/a.ts");
    expect(mentionToken("src", "dir")).toBe("@src/");
    expect(mentionToken("my notes.txt")).toBe('@"my notes.txt"');
  });

  it("repoRelativeInside refuses escapes, absolute paths and .git", () => {
    const dir = track(makeRepo());
    expect(repoRelativeInside(dir, "src/engine/gate.ts")).toBe("src/engine/gate.ts");
    expect(repoRelativeInside(dir, "./src/../README.md")).toBe("README.md");
    expect(repoRelativeInside(dir, "src/")).toBe("src");
    expect(repoRelativeInside(dir, "../outside")).toBeNull();
    expect(repoRelativeInside(dir, "/etc/passwd")).toBeNull();
    expect(repoRelativeInside(dir, ".git/config")).toBeNull();
    expect(repoRelativeInside(dir, "")).toBeNull();
    expect(repoRelativeInside(dir, "a\nb")).toBeNull();
  });

  it("list_files: files + directories, review files first and flagged, cache refreshed at turn end", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    let r = await h.engine.request({ type: "list_files", query: "gate" });
    expect(r.items[0]).toEqual({ path: "src/engine/gate.ts", kind: "file" });
    r = await h.engine.request({ type: "list_files", query: "engine" });
    expect(r.items.some((i) => i.path === "src/engine" && i.kind === "dir")).toBe(true);
    // Not there yet: a file the next turn creates shows up once the turn was collected (cache invalidated).
    expect((await h.engine.request({ type: "list_files", query: "newfile" })).items).toEqual([]);
    await turn(h, "add a file", () => write(dir, "lib/newfile.ts", "x\n"));
    r = await h.engine.request({ type: "list_files", query: "ts" });
    expect(r.items[0]).toEqual({ path: "lib/newfile.ts", kind: "file", changed: true });
    expect(r.query).toBe("ts");
    expect((await h.engine.request({ type: "list_files", query: "", limit: 3 })).items).toHaveLength(3);
  });

  it("send.mentions: validated, appended as native @-mentions, carried on user_message and the transcript row", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await expect(h.engine.request({ type: "send", text: "look", mentions: ["../x"] })).rejects.toThrow(/invalid_mention/);
    await expect(h.engine.request({ type: "send", text: "look", mentions: [".git/config"] })).rejects.toThrow(/invalid_mention/);
    await expect(h.engine.request({ type: "send", text: "look", mentions: Array.from({ length: 21 }, () => "README.md") })).rejects.toThrow(/too_many_mentions/);
    expect(h.session().sends).toHaveLength(0);
    await h.engine.request({ type: "send", text: "Explain these", mentions: ["src/engine/gate.ts", "docs", "my notes.txt", "src/engine/gate.ts"] });
    expect(h.session().sends[0]!.text).toBe('Explain these\n\nReferenced files: @src/engine/gate.ts @docs/ @"my notes.txt"');
    const um = h.ofType("user_message").at(-1)!;
    expect(um).toMatchObject({ text: "Explain these", mentions: ["src/engine/gate.ts", "docs", "my notes.txt"] });
    h.session().emitTurnEnd({ sessionId: cliId(h.session()) });
    await h.waitFor((s) => s.gate.phase === "idle" && s.hud.turnCount === 1, "turn end");
    const rows = readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptItem);
    expect(rows.find((r) => r.kind === "user_message")).toMatchObject({ text: "Explain these", mentions: ["src/engine/gate.ts", "docs", "my notes.txt"] });
  });

  it("FileIndex.invalidate drops a listing that is still loading", async () => {
    let calls = 0;
    const idx = new FileIndex(async () => {
      calls += 1;
      return calls === 1 ? ["old.ts"] : ["new.ts"];
    });
    const first = idx.search("ts", new Set());
    idx.invalidate();
    expect((await first).map((i) => i.path)).toEqual(["old.ts"]);
    expect((await idx.search("ts", new Set())).map((i) => i.path)).toEqual(["new.ts"]);
  });
});

describe("§24 image attachments", () => {
  it("prepareAttachments refusals", () => {
    const img = { kind: "image", mediaType: "image/png", dataBase64: PNG_1x1 };
    expect(prepareAttachments([img])[0]!.ref).toMatchObject({ kind: "image", mediaType: "image/png", bytes: 70 });
    expect(() => prepareAttachments(Array(6).fill(img))).toThrow(/too_many_attachments/);
    expect(() => prepareAttachments([{ ...img, mediaType: "image/bmp" }])).toThrow(/attachment_type/);
    expect(() => prepareAttachments([{ ...img, kind: "file" }])).toThrow(/attachment_type/);
    expect(() => prepareAttachments([{ ...img, mediaType: "image/jpeg" }])).toThrow(/attachment_type/);
    expect(() => prepareAttachments([{ ...img, dataBase64: "not base64!" }])).toThrow(/attachment_invalid/);
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 10);
    Buffer.from(PNG_1x1, "base64").copy(big);
    expect(() => prepareAttachments([{ ...img, dataBase64: big.toString("base64") }])).toThrow(/attachment_too_large/);
    expect(sniffImage(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("images reach the session as content blocks; the transcript keeps a hash; attachment_get returns the bytes", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await expect(h.engine.request({ type: "send", text: "x", attachments: [{ kind: "image", mediaType: "image/webp", dataBase64: PNG_1x1 }] })).rejects.toThrow(/attachment_type/);
    await h.engine.request({ type: "send", text: "What is this?", attachments: [{ kind: "image", mediaType: "image/png", dataBase64: PNG_1x1 }] });
    const sent = h.session().sends[0]!;
    expect(sent.text).toBe("What is this?");
    expect(sent.images).toEqual([{ mediaType: "image/png", dataBase64: PNG_1x1 }]);
    const um = h.ofType("user_message").at(-1)!;
    const hash = um.attachments![0]!.hash;
    expect(um.attachments).toEqual([{ kind: "image", hash, mediaType: "image/png", bytes: 70 }]);
    expect(existsSync(join(dir, ".git", "reviewgate", "attachments", `${hash}.png`))).toBe(true);
    const transcript = readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8");
    expect(transcript).toContain(hash);
    expect(transcript).not.toContain(PNG_1x1.slice(0, 30));
    const got = await h.engine.request({ type: "attachment_get", hash });
    expect(got).toMatchObject({ type: "attachment", hash, mediaType: "image/png", dataBase64: PNG_1x1 });
    await expect(h.engine.request({ type: "attachment_get", hash: "0".repeat(64) })).rejects.toThrow(/unknown_attachment/);
    await expect(h.engine.request({ type: "attachment_get", hash: "../../etc" })).rejects.toThrow(/unknown_attachment/);
  });
});

describe("§25 model / effort", () => {
  it("set_model switches the live session, persists per project and seeds the next session start", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    let s = await h.open(dir);
    expect(s.session.selectedModel).toBeNull();
    expect(s.session.effort).toBeNull();
    expect(s.session.availableModels!.map((m) => m.value)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
    await expect(h.engine.request({ type: "set_model", model: "rm -rf /" })).rejects.toThrow(/invalid_model/);
    await expect(h.engine.request({ type: "set_model", model: "sonnet", effort: "turbo" as never })).rejects.toThrow(/invalid_effort/);
    // Allowed while a turn runs: it applies from the next request.
    await h.engine.handle({ type: "send", text: "work" });
    await h.engine.request({ type: "set_model", model: "sonnet", effort: "low" });
    expect(h.session().models).toEqual(["sonnet"]);
    expect(h.session().efforts).toEqual(["low"]);
    s = await h.waitFor((st) => st.session.selectedModel === "sonnet", "selected model");
    expect(s.session.effort).toBe("low");
    // The CLI's own list replaces the static one.
    h.session().emit({ type: "models_info", models: [{ value: "sonnet", displayName: "Sonnet 5.5", description: "d", supportedEffortLevels: ["low", "bogus", "high"], supportsEffort: true }, { nope: 1 }] });
    s = await h.waitFor((st) => st.session.availableModels?.[0]?.value === "sonnet", "models");
    expect(s.session.availableModels).toEqual([{ value: "sonnet", displayName: "Sonnet 5.5", description: "d", supportsEffort: true, supportedEffortLevels: ["low", "high"] }]);
    h.session().emitTurnEnd();
    await h.waitFor((st) => st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn end");
    await h.settle();
    const file = JSON.parse(readFileSync(join(dir, ".git", SESSION_FILE), "utf8"));
    expect(file).toMatchObject({ model: "sonnet", effort: "low" });
    // A later session of the project starts with it.
    await h.engine.handle({ type: "restart_session" });
    await h.waitFor((st) => st.session.open && !st.session.starting, "restarted");
    expect(h.session().opts.settings).toMatchObject({ model: "sonnet", effort: "low" });
    // effort: null = the model's default; "default" = the CLI's default model.
    await h.engine.request({ type: "set_model", model: "default", effort: null });
    expect(h.session().models).toEqual([null]);
    expect(h.session().efforts).toEqual([null]);
    s = await h.waitFor((st) => st.session.selectedModel === null && st.session.effort === null, "defaults");
    // Reopened: the stored choice applies.
    await h.engine.request({ type: "set_model", model: "haiku" });
    await h.engine.handle({ type: "close_project" });
    await h.open(dir);
    expect(h.session().opts.settings.model).toBe("haiku");
    expect(h.session().opts.settings.effort).toBeUndefined();
    expect(h.engine.state.session.selectedModel).toBe("haiku");
  });
});

describe("§26 checkpoints and rewind", () => {
  it("checkpoints per turn; files rewind restores only what Claude changed, refuses over user edits unless force", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "create a", () => write(dir, "a.txt", "a1\n"));
    await h.engine.request({ type: "accept_all" });
    write(dir, "u.txt", "user only\n"); // the user's own file, never touched by a turn
    await turn(h, "change a, add b", () => {
      write(dir, "a.txt", "a2\n");
      write(dir, "b.txt", "b2\n");
    });
    // A question while reviewing (A kept): the turn's own start tree, so it lists only what it changed.
    await turn(h, "add c", () => write(dir, "c.txt", "c3\n"));
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(s.session.checkpoints!.map((c) => [c.turn, c.prompt, c.filesChanged, c.filesSince, c.canRewindFiles, c.canRewindConversation])).toEqual([
      [1, "create a", 1, 3, true, true],
      [2, "change a, add b", 2, 3, true, true],
      [3, "add c", 1, 1, true, true],
    ]);
    await expect(h.engine.request({ type: "rewind", toTurn: 9, mode: "files" })).rejects.toThrow(/unknown_turn/);
    await expect(h.engine.request({ type: "rewind", toTurn: 2, mode: "sideways" as never })).rejects.toThrow(/invalid_rewind_mode/);

    // The user edited a.txt after turn 2 left it: refused, nothing written.
    write(dir, "a.txt", "mine\n");
    const err = await h.engine.request({ type: "rewind", toTurn: 2, mode: "files" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/file_changed_since_review:a\.txt/);
    const refusal = h.ofType("result").at(-1)!;
    expect(refusal).toMatchObject({ ok: false, code: "file_changed_since_review", paths: ["a.txt"] });
    expect(read(dir, "b.txt")).toBe("b2\n");

    const r = await h.engine.request({ type: "rewind", toTurn: 2, mode: "files", force: true });
    expect(r).toMatchObject({ type: "rewound", toTurn: 2, mode: "files", restoredFiles: ["a.txt", "b.txt", "c.txt"] });
    expect(read(dir, "a.txt")).toBe("a1\n");
    expect(read(dir, "b.txt")).toBeNull();
    expect(read(dir, "c.txt")).toBeNull();
    expect(read(dir, "u.txt")).toBe("user only\n");
    // The review followed the worktree: everything reverted to A → nothing left.
    s = await h.waitFor((st) => st.gate.phase === "idle", "review resolved by the rewind");
    expect(s.changedFiles).toEqual([]);

    // Further back: turn 1's start (a.txt did not exist). The rewind record counts as the last writer.
    const r1 = await h.engine.request({ type: "rewind", toTurn: 1, mode: "files" });
    expect(r1.restoredFiles).toEqual(["a.txt"]);
    expect(read(dir, "a.txt")).toBeNull();
    expect(read(dir, "u.txt")).toBe("user only\n");
    expect(read(dir, "README.md")).toBe("line1\n");
  });

  it("files rewind inside a standing review re-diffs it; an accepted file whose content changed is pending again", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "edit readme", () => write(dir, "README.md", "line1\nmore\n"));
    await turn(h, "edit readme again", () => write(dir, "README.md", "line1\nmore\nand more\n"));
    await h.engine.request({ type: "accept_all" });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "accepted"]]);
    await h.engine.request({ type: "rewind", toTurn: 2, mode: "files" });
    expect(read(dir, "README.md")).toBe("line1\nmore\n");
    const s = await h.waitFor((st) => st.changedFiles[0]?.state === "pending", "pending again");
    expect(s.changedFiles.map((f) => [f.path, f.added])).toEqual([["README.md", 1]]);
    expect(s.gate.phase).toBe("reviewing");
  });

  it("conversation rewind forks the chat right before the turn, keeps the old chat, sends editText", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    const u1 = await turn(h, "first question");
    await turn(h, "second question");
    const oldId = h.engine.state.sessions.currentId!;
    const oldSession = h.session();
    await expect(h.engine.request({ type: "rewind", toTurn: 2, mode: "conversation" })).resolves.toMatchObject({ type: "rewound", mode: "conversation", restoredFiles: [] });
    let s = h.engine.state;
    const newId = s.sessions.currentId!;
    expect(newId).not.toBe(oldId);
    expect(oldSession.disposed).toBe(true);
    // The fork: resume the CLI session at the last chain uuid of turn 1, into the new chat's own id.
    expect(h.session().opts.settings).toMatchObject({ resumeSessionId: oldId, forkAt: u1, sessionId: newId });
    const metas = new Map(s.sessions.list.map((m) => [m.id, m]));
    expect(metas.get(oldId)!.title).toBe("first question (되돌리기 전)");
    expect(metas.get(newId)).toMatchObject({ title: "first question", turns: 1, forkedFrom: { sessionId: oldId, turn: 2 } });
    expect(s.sessions.openTabIds).toEqual([newId]);
    expect(s.session.checkpoints!.map((c) => c.turn)).toEqual([1]);
    const restore = h.ofType("transcript_restore").at(-1)!;
    expect(restore.items.filter((i) => i.kind === "user_message").map((i) => (i as { text: string }).text)).toEqual(["first question"]);
    // The pending fork survives a restart until the CLI reported in.
    await h.engine.handle({ type: "restart_session" });
    await h.waitFor((st) => st.session.open && !st.session.starting, "restarted");
    expect(h.session().opts.settings).toMatchObject({ resumeSessionId: oldId, forkAt: u1, sessionId: newId });
    // The next turn is numbered 2 again; once the CLI reported the fork, a restart resumes it normally.
    await turn(h, "second question, reworded");
    s = h.engine.state;
    expect(s.session.checkpoints!.map((c) => [c.turn, c.prompt])).toEqual([[1, "first question"], [2, "second question, reworded"]]);
    expect(JSON.parse(readFileSync(checkpointFilePath(join(dir, ".git"), newId), "utf8")).pendingFork).toBeNull();
    await h.engine.handle({ type: "restart_session" });
    await h.waitFor((st) => st.session.open && !st.session.starting, "restarted");
    expect(h.session().opts.settings.resumeSessionId).toBe(newId);
    expect(h.session().opts.settings.forkAt).toBeUndefined();

    // Back to the very first turn: a fresh chat (nothing before it), and editText goes out as its first turn.
    const r = await h.engine.request({ type: "rewind", toTurn: 1, mode: "conversation", editText: "first question, but better" });
    expect(r.sessionId).not.toBe(newId);
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(h.session().opts.settings.sessionId).toBe(r.sessionId);
    expect(h.session().sends.map((x) => x.text)).toEqual(["first question, but better"]);
    expect(h.engine.state.gate.phase).toBe("running");
  });

  it("rewind is refused while anything is in flight; conversation needs a known fork point", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "one");
    await h.engine.handle({ type: "send", text: "two" });
    await expect(h.engine.request({ type: "rewind", toTurn: 1, mode: "both" })).rejects.toThrow(/session_busy/);
    // An abnormal end (no chain uuid): the turn after it cannot be rewound to conversation-wise.
    h.session().emit({ type: "error", message: "boom", fatal: true });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "closed");
    await h.waitFor((s) => s.session.open && !s.session.starting, "auto restart", 15_000).catch(() => undefined);
    await h.engine.handle({ type: "restart_session" });
    await h.waitFor((s) => s.session.open && !s.session.starting, "restarted");
    await turn(h, "three");
    const cps = h.engine.state.session.checkpoints!;
    expect(cps.map((c) => [c.turn, c.canRewindConversation])).toEqual([[1, true], [2, true], [3, false]]);
    await expect(h.engine.request({ type: "rewind", toTurn: 3, mode: "conversation" })).rejects.toThrow(/rewind_unavailable:conversation/);
  });

  it("filesPlan: a gap in the timeline (never collected) makes the file rewind unavailable", () => {
    const a = newRecord("turn", { turn: 1, startTree: "s1", endTree: "e1", files: ["a"] });
    const b = newRecord("turn", { turn: 2, startTree: "s2", endTree: null, files: null });
    expect(filesPlan([a], 0)).toMatchObject({ startTree: "s1", paths: ["a"] });
    expect(filesPlan([a, b], 0)).toBeNull();
  });
});

describe("§27 compact / context warning, §28 interrupt", () => {
  it("compact sends /compact <focus> without the review summary prefix and keeps the summary for the next message", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "edit", () => write(dir, "README.md", "line1\nx\n"));
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "compact", focus: "keep the\nreview  decisions" });
    expect(h.session().sends.at(-1)!.text).toBe("/compact keep the review decisions");
    expect(h.engine.state.commit.suggestedMessage.startsWith("edit")).toBe(true);
    h.session().emitTurnEnd({ sessionId: cliId(h.session()) });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "compact turn end");
    await h.engine.request({ type: "send", text: "next" });
    expect(h.session().sends.at(-1)!.text).toBe("[Review gate] Accepted: README.md.\n\nnext");
    await expect(h.engine.request({ type: "compact", focus: "x".repeat(2001) })).rejects.toThrow(/focus_too_long|gate_closed/);
  });

  it("context_warning once when the context crosses 80 %, again after it dropped below", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    const end = async (contextTokens: number) => {
      const before = h.engine.state.hud.turnCount;
      await h.engine.handle({ type: "send", text: `t${contextTokens}` });
      h.session().emitTurnEnd({ usage: { contextTokens, contextWindow: 200_000 } });
      await h.waitFor((s) => s.hud.turnCount > before && s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn");
    };
    await end(100_000);
    await end(170_000);
    await end(180_000);
    expect(h.ofType("context_warning")).toEqual([{ type: "context_warning", percent: 85, contextTokens: 170_000, contextWindow: 200_000 }]);
    await end(20_000); // after a compaction
    await end(190_000);
    expect(h.ofType("context_warning").map((e) => e.percent)).toEqual([85, 95]);
  });

  it("interrupt waits until the turn ended and was collected, so a queued send goes out", async () => {
    const dir = track(makeRepo());
    const h = harness({ interruptWaitMs: WAIT_MS });
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "long job" });
    h.session().emit({ type: "permission_request", requestId: "p1", toolName: "Bash", input: { command: "make" } });
    const interrupted = h.engine.request({ type: "interrupt" });
    const queued = h.engine.request({ type: "send", text: "do this instead" });
    setTimeout(() => {
      write(dir, "README.md", "line1\nhalf\n");
      h.session().emitTurnEnd({ stopReason: "interrupted" });
    }, 50);
    await interrupted;
    expect(h.session().interrupts).toBe(1);
    expect(h.ofType("turn_end").at(-1)!.stopReason).toBe("interrupted");
    await queued;
    expect(h.session().sends.map((s) => s.text)).toEqual(["long job", "do this instead"]);
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
  });
});
