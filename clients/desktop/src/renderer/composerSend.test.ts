import { describe, expect, it } from "vitest";
import { collectFailedNotice, returnAction } from "./composerSend";

// MARK: r2-review-flow — M30, as on the Mac (Core ReviewFlowComposerTests.swift).

describe("Enter / ⌘↩ always does something (M30, §3)", () => {
  const action = (o: Partial<Parameters<typeof returnAction>[0]>) =>
    returnAction({ hasText: true, canSend: false, queueMode: false, canSteer: false, sessionEnded: false, canRestart: false, ...o });
  it("sends, steers, queues, or restarts an ended session and sends", () => {
    expect(action({ canSend: true })).toBe("send");
    expect(action({ queueMode: true, canSteer: true })).toBe("steer");
    expect(action({ queueMode: true })).toBe("queue");
    expect(action({ queueMode: true, sessionEnded: true, canRestart: true })).toBe("restartAndSend");
    expect(action({ queueMode: true, sessionEnded: true })).toBe("queue");
    expect(action({})).toBe("nothing");
    expect(action({ canSend: true, hasText: false })).toBe("nothing");
    expect(collectFailedNotice("git: index.lock exists\nmore")).toBe("Could not collect the last turn's changes (git: index.lock exists) — your next message collects them with its own");
  });
});
