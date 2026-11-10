// MARK: r2-review-flow — polish P4-composer-08: the composer reports, per chat, a typed draft and attached images, so the chat
// tabs can show a tab still holding them (and ask before its images are lost).
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerPresence } from "./storeComposer";

describe("what each chat's composer holds (P4-composer-08)", () => {
  beforeEach(() => useComposerPresence.getState().clear());

  it("keeps a chat with a draft or images, and forgets it once both are gone", () => {
    const { report } = useComposerPresence.getState();
    report("c1", { images: 2, draft: false });
    report("c2", { images: 0, draft: true });
    expect(useComposerPresence.getState().byChat).toEqual({ c1: { images: 2, draft: false }, c2: { images: 0, draft: true } });
    report("c1", { images: 0, draft: false });
    expect(useComposerPresence.getState().byChat).toEqual({ c2: { images: 0, draft: true } });
  });

  it("does not notify for a report that changes nothing", () => {
    const { report } = useComposerPresence.getState();
    report("c1", { images: 1, draft: true });
    let calls = 0;
    const off = useComposerPresence.subscribe(() => calls++);
    report("c1", { images: 1, draft: true });
    report("c9", { images: 0, draft: false }); // nothing held, nothing known: no change either
    expect(calls).toBe(0);
    report("c1", { images: 1, draft: false });
    expect(calls).toBe(1);
    off();
  });
});
