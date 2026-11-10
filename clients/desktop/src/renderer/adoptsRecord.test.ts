import { describe, expect, it } from "vitest";
import type { ReviewState, SessionMeta } from "@reviewgate/engine";
import { adoptsRecord } from "./sessions";

// §35.4: the first message sent from a record (a chat Claude Code could not resume) makes its new chat — the queue
// typed there goes on in it; any other change of the current chat still stops the queue ("The chat changed").
const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ id, title: id, createdAt: "t", updatedAt: "t", turns: 1, lastUserText: null, ...extra }) as SessionMeta;
const st = (currentId: string, list: SessionMeta[], phase: ReviewState["gate"]["phase"]): ReviewState =>
  ({ sessions: { currentId, list, openTabIds: list.map((m) => m.id) }, gate: { phase } }) as unknown as ReviewState;

describe("adoptsRecord (§35.4)", () => {
  it("a record's first send: the new chat it made, while that turn runs", () => {
    const record = meta("rec", { resumeFailed: true });
    expect(adoptsRecord(st("rec", [record], "idle"), st("new", [record, meta("new")], "running"))).toBe(true);
  });
  it("not when the user opens another chat, starts a new one while idle, or leaves an ordinary chat", () => {
    const record = meta("rec", { resumeFailed: true });
    const other = meta("other");
    expect(adoptsRecord(st("rec", [record, other], "idle"), st("other", [record, other], "running"))).toBe(false);
    expect(adoptsRecord(st("rec", [record], "idle"), st("new", [record, meta("new")], "idle"))).toBe(false);
    expect(adoptsRecord(st("a", [meta("a")], "idle"), st("b", [meta("a"), meta("b")], "running"))).toBe(false);
    expect(adoptsRecord(st("rec", [record], "idle"), st("rec", [record], "running"))).toBe(false);
  });
});
