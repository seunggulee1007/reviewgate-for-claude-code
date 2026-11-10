import { describe, expect, it } from "vitest";
import { closeGuardExtras } from "./closeGuardExtras";
import { projectRootHash } from "../shared/hash";
import type { KeepStorage } from "./sessionKeep";

// MARK: polish p-lifecycle (P1-chrome-01): the page's part of the close / quit question.

const storage = (items: Record<string, string>): KeepStorage => ({ getItem: (k) => items[k] ?? null, setItem: () => undefined, removeItem: () => undefined });

function facts(o: { queue?: { text: string; attachments?: unknown[] }[]; running?: number; creating?: boolean } = {}) {
  return {
    state: { project: { root: "/work/acme-api" }, sessions: { currentId: "c1" } },
    queue: { items: (o.queue ?? []).map((m, i) => ({ id: i, ...m })), paused: null, inflight: false, awaitingTurn: false },
    side: { threads: Object.fromEntries(Array.from({ length: o.running ?? 0 }, (_, i) => [`t${i}`, { id: `t${i}`, status: "running" }])) },
    flow: { create: o.creating ? { running: true } : null },
  } as unknown as Parameters<typeof closeGuardExtras>[0];
}

describe("closeGuardExtras", () => {
  it("says the registered lines, the kept draft, the queue and its images, side questions and a workbench being made", () => {
    const hash = projectRootHash("/work/acme-api");
    const x = closeGuardExtras(facts({ queue: [{ text: "a" }, { text: "b", attachments: [{}, {}] }], running: 1, creating: true }), storage({ [`rg.draft.${hash}:c1`]: "half a message" }), () => ["You are writing a review note."]);
    expect(x).toEqual({ lines: ["You are writing a review note."], draft: true, draftImages: 0, queued: 2, queuedImages: 2, sideAnswering: 1, creatingWorkbench: true });
  });

  it("nothing going on says nothing", () => {
    expect(closeGuardExtras(facts(), storage({}), () => [])).toEqual({ lines: [], draft: false, draftImages: 0, queued: 0, queuedImages: 0, sideAnswering: 0, creatingWorkbench: false });
  });
});
