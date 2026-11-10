import { describe, expect, it } from "vitest";
import { registerUnsavedWork, unsavedWorkLines } from "./unsavedWork";

// polish p-foundation — P2-review-21: the close / quit confirmation lists what each piece of open work says it would lose.

describe("unsaved work", () => {
  it("lists the lines that have something to say, in key order; removing one ends it", () => {
    let draft = "";
    const offNote = registerUnsavedWork("noteDraft", () => (draft ? "A review note is being written" : null));
    const offQueue = registerUnsavedWork("composerQueue", () => "2 messages wait in the queue");
    expect(unsavedWorkLines()).toEqual(["2 messages wait in the queue"]);
    draft = "rename this";
    expect(unsavedWorkLines()).toEqual(["2 messages wait in the queue", "A review note is being written"]);
    offQueue();
    expect(unsavedWorkLines()).toEqual(["A review note is being written"]);
    offNote();
    expect(unsavedWorkLines()).toEqual([]);
  });

  it("a key registered again replaces the first; the old removal leaves the new one", () => {
    const offOld = registerUnsavedWork("commitMessage", () => "old");
    const offNew = registerUnsavedWork("commitMessage", () => "new");
    expect(unsavedWorkLines()).toEqual(["new"]);
    offOld();
    expect(unsavedWorkLines()).toEqual(["new"]);
    offNew();
    expect(unsavedWorkLines()).toEqual([]);
  });

  it("a provider that throws is left out", () => {
    const off = registerUnsavedWork("broken", () => {
      throw new Error("gone");
    });
    expect(unsavedWorkLines()).toEqual([]);
    off();
  });
});
