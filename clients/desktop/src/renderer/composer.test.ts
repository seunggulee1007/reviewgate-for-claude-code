import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ModelOption, ReviewState, TurnCheckpointView } from "@reviewgate/engine";
import { attachmentRoom, base64Bytes, checkImage, formatBytes, imageTypeOfName, MAX_ATTACHMENT_BYTES, sniffImageType } from "../shared/attachments";
import { attachmentProblemText, mergeImages } from "./composerAttach";
import { initI18n } from "./i18n";
import { addMentions, changedMentionPaths, droppedMentionPaths, MENTION_DRAG_TYPE, mentionLabel, mentionOptions, mentionToken, normalizeMention, removeToken, showChangedShortcut, splitMention, subsequence } from "./mentions";
import { editRetryMode, rewindAvailability, rewindBusy, rewindRefusalView } from "./rewind";
import { enqueue, sendExtras } from "./sendQueue";
import { contextColor, contextLevel, currentModelOption, effortForSwitch } from "./hudModel";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const BMP = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("§23 mentions", () => {
  it("finds the @query at the caret only at a word start, without whitespace", () => {
    expect(mentionToken("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionToken("look at @src/a", 14)).toEqual({ start: 8, query: "src/a" });
    expect(mentionToken("mail me@host", 12)).toBeNull();
    expect(mentionToken("@src a", 6)).toBeNull();
    expect(mentionToken("@src a", 4)).toEqual({ start: 0, query: "src" });
    expect(mentionToken("no at here", 5)).toBeNull();
    expect(mentionToken("x\n@pa", 5)).toEqual({ start: 2, query: "pa" });
  });

  it("removes the token and one doubled space", () => {
    expect(removeToken("see @foo bar", 4, 8)).toEqual({ text: "see bar", caret: 4 });
    expect(removeToken("@foo", 0, 4)).toEqual({ text: "", caret: 0 });
    expect(removeToken("fix @par", 4, 8)).toEqual({ text: "fix ", caret: 4 });
  });

  it("adds paths deduplicated, normalized and capped at 20", () => {
    expect(addMentions(["a.ts"], ["a.ts", "src\\b.ts", "docs/", "./c.md", ""]).list).toEqual(["a.ts", "src/b.ts", "docs", "c.md"]);
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const r = addMentions([], many);
    expect(r.list).toHaveLength(20);
    expect(r.overflow).toBe(5);
    expect(normalizeMention(" src/dir/ ")).toBe("src/dir");
  });

  it("offers the changed-files shortcut (no deleted files) before the matches", () => {
    const changed = changedMentionPaths([
      { path: "a.ts", status: "M" },
      { path: "gone.ts", status: "D" },
      { path: "new.ts", status: "A" },
    ]);
    expect(changed).toEqual(["a.ts", "new.ts"]);
    expect(showChangedShortcut("", 2, "변경된 파일")).toBe(true);
    expect(showChangedShortcut("변경", 2, "변경된 파일")).toBe(true);
    expect(showChangedShortcut("chg", 2, "변경된 파일")).toBe(true);
    expect(showChangedShortcut("zzz", 2, "변경된 파일")).toBe(false);
    expect(showChangedShortcut("", 0, "변경된 파일")).toBe(false);
    const opts = mentionOptions("", [{ path: "src", kind: "dir" }, { path: "a.ts", kind: "file", changed: true }], changed, "변경된 파일");
    expect(opts.map((o) => o.kind)).toEqual(["changed", "item", "item"]);
    expect(subsequence("prs", "parser.ts")).toBe(true);
    expect(subsequence("xyz", "parser.ts")).toBe(false);
  });

  it("labels directories with a slash and splits chips", () => {
    expect(mentionLabel({ path: "src/app", kind: "dir" })).toBe("src/app/");
    expect(mentionLabel({ path: "a.ts", kind: "file" })).toBe("a.ts");
    expect(splitMention("src/app/main.ts")).toEqual({ name: "main.ts", dir: "src/app/" });
    expect(splitMention("README.md")).toEqual({ name: "README.md", dir: "" });
  });

  it("reads only our own drag payload as mentions", () => {
    const dt = (types: string[], data: Record<string, string>) => ({ types, getData: (t: string) => data[t] ?? "" });
    expect(droppedMentionPaths(dt([MENTION_DRAG_TYPE, "text/plain"], { [MENTION_DRAG_TYPE]: "src/a.ts\nb.ts" }))).toEqual(["src/a.ts", "b.ts"]);
    expect(droppedMentionPaths(dt(["Files"], {}))).toEqual([]);
  });
});

describe("§24 attachments", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("sniffs the four image types by magic number", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(BMP)).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(imageTypeOfName("Shot.JPG")).toBe("image/jpeg");
    expect(imageTypeOfName("notes.txt")).toBeNull();
  });

  it("refuses with the engine's codes: type, mismatch, size, empty", () => {
    expect(checkImage("image/png", PNG, 1000)).toEqual({ ok: true, mediaType: "image/png" });
    expect(checkImage("", JPG, 1000)).toEqual({ ok: true, mediaType: "image/jpeg" });
    expect(checkImage("image/jpg", JPG, 1000)).toEqual({ ok: true, mediaType: "image/jpeg" });
    expect(checkImage("image/bmp", BMP, 1000)).toEqual({ ok: false, code: "attachment_type" });
    expect(checkImage("image/png", JPG, 1000)).toEqual({ ok: false, code: "attachment_type" });
    expect(checkImage("image/png", PNG, MAX_ATTACHMENT_BYTES)).toMatchObject({ ok: true });
    expect(checkImage("image/png", PNG, MAX_ATTACHMENT_BYTES + 1)).toEqual({ ok: false, code: "attachment_too_large" });
    expect(checkImage("image/png", PNG, 0)).toEqual({ ok: false, code: "attachment_invalid" });
  });

  it("keeps at most 5 and says why in Korean", () => {
    expect(attachmentRoom(3, 4)).toEqual({ take: 2, dropped: 2 });
    expect(attachmentRoom(5, 1)).toEqual({ take: 0, dropped: 1 });
    const img = (id: number) => ({ ok: true as const, image: { id, name: `${id}.png`, bytes: 10, url: "data:", attachment: { kind: "image" as const, mediaType: "image/png" as const, dataBase64: "AA==" } } });
    const r = mergeImages([img(1).image, img(2).image, img(3).image, img(4).image], [img(5), img(6), { ok: false, text: "x" }]);
    expect(r.list.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(r.errors).toEqual(["x", "이미지는 최대 5장까지 첨부할 수 있어요."]);
    expect(attachmentProblemText("attachment_too_large", "big.png")).toBe("이미지는 5MB 이하만 첨부할 수 있어요 (big.png).");
    expect(attachmentProblemText("attachment_type", "a.bmp")).toContain("PNG, JPEG, GIF, WebP");
  });

  it("formats sizes and decodes base64 lengths", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AA==")).toBe(1);
    expect(base64Bytes("AAA=\n")).toBe(2);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024 + 1)).toBe("3.0 MB");
  });

  it("queues mentions / attachments with the text, only when present", () => {
    const att = { kind: "image" as const, mediaType: "image/png" as const, dataBase64: "AA==" };
    const items = enqueue([], "look", false, { mentions: ["a.ts"], attachments: [att] });
    expect(items[0]).toMatchObject({ text: "look", mentions: ["a.ts"], attachments: [att] });
    expect(enqueue([], "plain", false, { mentions: [], attachments: [] })[0]).toEqual({ id: expect.any(Number), text: "plain" });
    expect(sendExtras({ mentions: [], attachments: [att] })).toEqual({ attachments: [att] });
  });
});

const cp = (p: Partial<TurnCheckpointView> & { turn: number }): TurnCheckpointView => ({
  prompt: "p",
  startedAt: "2026-10-21T00:00:00Z",
  endedAt: "2026-10-21T00:01:00Z",
  filesChanged: 1,
  filesSince: 2,
  canRewindFiles: true,
  canRewindConversation: true,
  ...p,
});
const stateWith = (checkpoints: TurnCheckpointView[], phase = "idle", starting = false): ReviewState =>
  ({ session: { starting, checkpoints }, gate: { phase } }) as unknown as ReviewState;

describe("§26 rewind availability", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("follows the checkpoint's flags and the H3 lock", () => {
    const s = stateWith([cp({ turn: 1 }), cp({ turn: 2, canRewindFiles: false }), cp({ turn: 3, canRewindConversation: false })]);
    expect(rewindAvailability(s, 1)).toMatchObject({ busy: null, conversation: { ok: true }, files: { ok: true }, both: { ok: true } });
    const two = rewindAvailability(s, 2);
    expect(two.files.ok).toBe(false);
    expect(two.both.ok).toBe(false);
    expect(two.conversation.ok).toBe(true);
    expect(editRetryMode(two, true)).toBe("conversation");
    expect(editRetryMode(rewindAvailability(s, 1), true)).toBe("both");
    expect(editRetryMode(rewindAvailability(s, 1), false)).toBe("conversation");
    expect(rewindAvailability(s, 3).conversation.ok).toBe(false);
    const none = rewindAvailability(s, 9);
    expect(none.checkpoint).toBeNull();
    expect(none.conversation.ok).toBe(false);
    expect(rewindAvailability(s, undefined).files.ok).toBe(false);
    expect(rewindBusy(stateWith([], "running"))).toMatch(/작업 중/);
    expect(rewindBusy(stateWith([], "reverting"))).toMatch(/되돌리는 중/);
    expect(rewindBusy(stateWith([], "idle", true))).toMatch(/시작 중/);
    expect(rewindBusy(stateWith([], "reviewing"))).toBeNull();
  });

  it("presents refusals: force confirm, finish the review, wait", () => {
    expect(rewindRefusalView({ code: "file_changed_since_review", message: "x", paths: ["a.ts"] })).toEqual({ kind: "force", paths: ["a.ts"] });
    expect(rewindRefusalView({ code: "review_pending", message: "x" })).toMatchObject({ kind: "review" });
    expect(rewindRefusalView({ code: "notes_pending", message: "x" }).kind).toBe("review");
    expect((rewindRefusalView({ code: "review_pending", message: "x" }) as { message: string }).message).toContain("먼저 리뷰를 마무리하세요");
    expect(rewindRefusalView({ code: "session_busy", message: "x" }).kind).toBe("busy");
    expect(rewindRefusalView({ code: "unknown_turn", message: "no" })).toEqual({ kind: "error", message: "no" });
  });
});

describe("§25 model picker / §27 context meter", () => {
  const models: ModelOption[] = [
    { value: "default", displayName: "Default (recommended)", description: "Opus 5.5" },
    { value: "sonnet", displayName: "Sonnet", description: "fast", resolvedModel: "claude-sonnet-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    { value: "opus", displayName: "Opus", description: "deep", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  ];

  it("finds the current option by selectedModel, null = default, else the reported id", () => {
    expect(currentModelOption(models, null, "claude-opus-5-5")!.value).toBe("default");
    expect(currentModelOption(models, "sonnet", null)!.value).toBe("sonnet");
    expect(currentModelOption(models.slice(1), "claude-sonnet-5-5", "claude-sonnet-5-5")!.value).toBe("sonnet");
    expect(currentModelOption([], null, null)).toBeNull();
  });

  it("keeps the effort when the next model takes it, else resets it to the default", () => {
    expect(effortForSwitch(models[2]!, "max")).toBeUndefined();
    expect(effortForSwitch(models[1]!, "max")).toBeNull();
    expect(effortForSwitch(models[0]!, "high")).toBeNull();
    expect(effortForSwitch(models[1]!, null)).toBeUndefined();
  });

  it("turns amber at 80 % and red at 95 %", () => {
    expect(contextLevel(0.79)).toBe("ok");
    expect(contextLevel(0.8)).toBe("warn");
    expect(contextLevel(0.949)).toBe("warn");
    expect(contextLevel(0.95)).toBe("critical");
    expect(contextColor(0.5)).toBe("var(--green)");
    expect(contextColor(0.82)).toBe("var(--orange)");
    expect(contextColor(0.97)).toBe("var(--red)");
  });
});

// ---------------------------------------------------------------- store flows (engine bridge mocked)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("composer store flows", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  const withProject = (useStore: Awaited<ReturnType<typeof loadStore>>, patch: Record<string, unknown> = {}) => {
    const s = useStore.getState().state;
    useStore.setState({
      state: { ...s, project: { path: "/p", root: "/p", name: "p" } as never, gate: { ...s.gate, canSend: true, phase: "idle" }, ...patch } as ReviewState,
      queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
    });
  };

  it("sends mentions and attachments; user rows keep turn / mentions / attachments", async () => {
    const useStore = await loadStore();
    withProject(useStore);
    const att = { kind: "image" as const, mediaType: "image/png" as const, dataBase64: "iVBORw0KGgo=" };
    useStore.getState().send(" look ", { mentions: ["a.ts"], attachments: [att] });
    expect(sent.at(-1)).toEqual({ type: "send", text: "look", mentions: ["a.ts"], attachments: [att] });
    useStore.getState().send("plain", { mentions: [] });
    expect(sent.at(-1)).toEqual({ type: "send", text: "plain" });
    const ref = { kind: "image" as const, hash: "a".repeat(64), mediaType: "image/png" as const, bytes: 8 };
    useStore.getState().handleEvent({ type: "user_message", text: "look", turn: 4, mentions: ["a.ts"], attachments: [ref] });
    expect(useStore.getState().transcript.at(-1)).toMatchObject({ kind: "user", text: "look", turn: 4, mentions: ["a.ts"], attachments: [ref] });
    useStore.setState({ replaceTranscript: true });
    useStore.getState().handleEvent({ type: "transcript_restore", items: [{ at: "x", turn: 2, kind: "user_message", text: "old", mentions: ["b.ts"] }] });
    expect(useStore.getState().transcript).toEqual([{ kind: "user", id: expect.any(Number), text: "old", turn: 2, mentions: ["b.ts"] }]);
  });

  it("a refused send reaches the banner in Korean", async () => {
    const useStore = await loadStore();
    withProject(useStore);
    respond = (c) => (c.type === "send" ? { ok: false, error: "invalid_mention:../x", code: "invalid_mention" } : { ok: true, reply: {} });
    useStore.getState().send("x", { mentions: ["../x"] });
    await flush();
    await flush();
    expect(useStore.getState().errorBanner?.message).toBe("이 파일은 언급할 수 없어요: ../x");
  });

  it("Stop & send = interrupt, then send right behind it (§28); a refusal re-queues it paused", async () => {
    const useStore = await loadStore();
    withProject(useStore, {});
    useStore.setState((s) => ({ state: { ...s.state, gate: { ...s.state.gate, canSend: false, phase: "running" } } }));
    useStore.getState().interruptAndSend("now this", { mentions: ["a.ts"] });
    expect(sent.map((c) => c.type)).toEqual(["interrupt", "send"]);
    expect(sent[1]).toEqual({ type: "send", text: "now this", mentions: ["a.ts"] });
    await flush();
    expect(useStore.getState().queue).toMatchObject({ inflight: false, awaitingTurn: true, skipInterruptPause: true });

    sent.length = 0;
    respond = (c) => (c.type === "send" ? { ok: false, error: "gate_closed:running", code: "gate_closed" } : { ok: true, reply: {} });
    useStore.setState((s) => ({ queue: { ...s.queue, awaitingTurn: false } }));
    useStore.getState().interruptAndSend("again");
    await flush();
    await flush();
    // Still running: first in the queue, not paused — it goes out when the gate opens.
    let q = useStore.getState().queue;
    expect(q.items[0]!.text).toBe("again");
    expect(q.paused).toBeNull();

    respond = (c) => (c.type === "send" ? { ok: false, error: "attachment_type:#1 bmp", code: "attachment_type" } : { ok: true, reply: {} });
    useStore.setState((s) => ({ queue: { ...s.queue, items: [] } }));
    useStore.getState().interruptAndSend("bad");
    await flush();
    await flush();
    q = useStore.getState().queue;
    expect(q.items[0]!.text).toBe("bad");
    expect(q.paused).toContain("PNG, JPEG, GIF, WebP");
  });

  it("context_warning raises the banner; compact sends the focus and clears it", async () => {
    const useStore = await loadStore();
    withProject(useStore);
    useStore.getState().handleEvent({ type: "context_warning", percent: 82.4, contextTokens: 164_800, contextWindow: 200_000 });
    expect(useStore.getState().contextWarning).toMatchObject({ percent: 82.4 });
    expect(await useStore.getState().compact("  the parser  ")).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "compact", focus: "the parser" });
    expect(useStore.getState().contextWarning).toBeNull();
    respond = () => ({ ok: false, error: "focus_too_long", code: "focus_too_long" });
    expect(await useStore.getState().compact("x")).toMatch(/2,000/);
  });

  it("set_model sends the effort only when given; refusals come back in words", async () => {
    const useStore = await loadStore();
    withProject(useStore);
    expect(await useStore.getState().setModel("sonnet")).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "set_model", model: "sonnet" });
    await useStore.getState().setModel("opus", null);
    expect(sent.at(-1)).toEqual({ type: "set_model", model: "opus", effort: null });
    respond = () => ({ ok: false, error: "invalid_model:x y", code: "invalid_model" });
    expect(await useStore.getState().setModel("x y")).toContain("x y");
  });

  it("a conversation rewind replaces the transcript and moves the tab to the fork", async () => {
    const useStore = await loadStore();
    withProject(useStore, {
      sessions: { list: [], currentId: "old", openTabIds: ["other", "old"] },
    });
    useStore.setState({ contextWarning: { percent: 90, contextTokens: 1, contextWindow: 1, at: 0 } });
    respond = (c) => {
      if (c.type === "rewind") {
        // The engine switches chats and restores the kept rows before replying.
        useStore.getState().handleEvent({ type: "transcript_restore", items: [{ at: "x", turn: 1, kind: "user_message", text: "kept" }] });
        return { ok: true, reply: { type: "rewound", toTurn: 2, mode: "both", restoredFiles: ["a.ts"], sessionId: "fork" } };
      }
      return { ok: true, reply: {} };
    };
    useStore.setState({ transcript: [{ kind: "user", id: 1, text: "gone", turn: 2 }] });
    const r = await useStore.getState().rewind({ toTurn: 2, mode: "both", editText: " redo ", mentions: ["a.ts"] });
    expect(r).toEqual({ ok: true, restoredFiles: ["a.ts"], sessionId: "fork" });
    expect(sent.find((c) => c.type === "rewind")).toEqual({ type: "rewind", toTurn: 2, mode: "both", editText: "redo", mentions: ["a.ts"] });
    expect(useStore.getState().transcript.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["kept"]);
    expect(sent.find((c) => c.type === "tabs_set")).toEqual({ type: "tabs_set", openTabIds: ["other", "fork"] });
    expect(useStore.getState().contextWarning).toBeNull();
    expect(useStore.getState().rewinding).toBe(false);
  });

  it("a refused rewind keeps the transcript and carries code / paths", async () => {
    const useStore = await loadStore();
    withProject(useStore);
    respond = () => ({ ok: false, error: "file_changed_since_review:a.ts", code: "file_changed_since_review", paths: ["a.ts"] });
    const r = await useStore.getState().rewind({ toTurn: 1, mode: "files" });
    expect(r).toMatchObject({ ok: false, code: "file_changed_since_review", paths: ["a.ts"] });
    expect(useStore.getState().replaceTranscript).toBe(false);
    respond = () => ({ ok: false, error: "review_pending", code: "review_pending" });
    const r2 = await useStore.getState().rewind({ toTurn: 1, mode: "conversation" });
    expect(r2).toMatchObject({ ok: false, code: "review_pending" });
    expect(useStore.getState().replaceTranscript).toBe(false);
  });
});
