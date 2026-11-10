import { beforeAll, describe, expect, it } from "vitest";
import type { EngineEvent, TranscriptItem } from "@reviewgate/engine";
import { resetRowTimes, ROW_TIMES_GENERATION, rowTime, stampRestored, stampRow } from "./rowTimes";

// polish p-foundation — P3-transcript-25: a chat row's time lives in a side table by row id — stamped when a row arrives
// live, and with the record's `at` when it comes back (the chat's record, an older page). The Mac's `RowClockTests`.

describe("row times", () => {
  it("a row keeps the time it was stamped with; one that does not read has none", () => {
    resetRowTimes();
    stampRow(1, 1000);
    stampRow(2, "2026-11-05T06:42:10.500Z");
    stampRow(3, "not a time");
    expect(rowTime(1)).toBe(1000);
    expect(rowTime(2)).toBe(Date.parse("2026-11-05T06:42:10.500Z"));
    expect(rowTime(3)).toBeUndefined();
    expect(rowTime(99)).toBeUndefined();
    // A stamp that does not read takes back an earlier one.
    stampRow(1, "garbage");
    expect(rowTime(1)).toBeUndefined();
  });

  it("the rows a restored item became get its time", () => {
    resetRowTimes();
    const rows = [{ id: 10 }, { id: 11 }, { id: 12 }];
    stampRestored(rows, 1, "2026-11-04T23:59:59Z");
    expect(rowTime(10)).toBeUndefined();
    expect(rowTime(11)).toBe(Date.parse("2026-11-04T23:59:59Z"));
    expect(rowTime(12)).toBe(Date.parse("2026-11-04T23:59:59Z"));
  });

  it("keeps the newest two generations", () => {
    resetRowTimes();
    for (let id = 0; id < ROW_TIMES_GENERATION * 2 + 1; id++) stampRow(id, id);
    expect(rowTime(0)).toBeUndefined();
    expect(rowTime(ROW_TIMES_GENERATION - 1)).toBeUndefined();
    expect(rowTime(ROW_TIMES_GENERATION)).toBe(ROW_TIMES_GENERATION);
    expect(rowTime(ROW_TIMES_GENERATION * 2)).toBe(ROW_TIMES_GENERATION * 2);
  });
});

describe("the store stamps its chat rows", () => {
  let useStore: typeof import("./store").useStore;
  beforeAll(async () => {
    (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
    (globalThis as unknown as { window: unknown }).window = {
      matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
      rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
    };
    useStore = (await import("./store")).useStore;
  });

  it("live rows when they arrive, restored rows with their record's time", () => {
    resetRowTimes();
    useStore.setState({ transcript: [], transcriptRestored: false, replaceTranscript: false });
    const before = Date.now();
    const send = (ev: EngineEvent) => useStore.getState().handleEvent(ev);
    send({ type: "user_message", text: "fix the mapper", turn: 1 } as EngineEvent);
    send({ type: "text_delta", text: "Done." } as EngineEvent);
    const live = useStore.getState().transcript;
    expect(live.map((r) => r.kind)).toEqual(["user", "assistant"]);
    for (const row of live) {
      const at = rowTime(row.id);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    }
    const restored: TranscriptItem[] = [
      { at: "2026-11-05T06:42:10.500Z", turn: 1, kind: "user_message", text: "yesterday's question" },
      { at: "2026-11-05T06:43:00.000Z", turn: 1, kind: "assistant_text", text: "the answer" },
    ];
    send({ type: "transcript_restore", items: restored } as EngineEvent);
    const rows = useStore.getState().transcript;
    const asked = rows.find((r) => r.kind === "user" && r.text === "yesterday's question")!;
    const answered = rows.find((r) => r.kind === "assistant" && r.text === "the answer")!;
    expect(rowTime(asked.id)).toBe(Date.parse("2026-11-05T06:42:10.500Z"));
    expect(rowTime(answered.id)).toBe(Date.parse("2026-11-05T06:43:00.000Z"));
  });
});
