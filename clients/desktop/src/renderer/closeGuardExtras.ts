/**
 * MARK: polish p-lifecycle — P1-chrome-01 / P2-review-21 / P3-transcript-29 / P4-composer-07: what only this page knows when
 * main asks before closing the window or quitting (src/shared/closeGuard.ts `CloseGuardExtras`): the lines the window's parts
 * registered (unsavedWork.ts), whether a message is being typed (it is kept), the queue (kept, back paused) and its
 * images (not kept), side questions still answering and a workbench being created.
 */
import type { CloseGuardExtras } from "../shared/closeGuard";
import { projectRootHash } from "../shared/hash";
import { loadDraft, windowStorage, type KeepStorage } from "./sessionKeep";
import { runningCount } from "./sideThreads";
import type { Store } from "./store";
import { unsavedWorkLines } from "./unsavedWork";
import { chatDraftKey } from "./workSafety";

type Facts = Pick<Store, "state" | "queue" | "side" | "flow">;

export function closeGuardExtras(s: Facts, storage: KeepStorage | null = windowStorage(), lines: () => string[] = unsavedWorkLines): CloseGuardExtras {
  const root = s.state.project?.root ?? null;
  const key = chatDraftKey(root ? projectRootHash(root) : null, s.state.sessions?.currentId);
  return {
    lines: lines(),
    draft: loadDraft(storage, key).trim().length > 0,
    // The composer's own images register a line of their own (they are its state).
    draftImages: 0,
    queued: s.queue.items.length,
    queuedImages: s.queue.items.reduce((n, m) => n + (m.attachments?.length ?? 0), 0),
    sideAnswering: runningCount(s.side),
    creatingWorkbench: s.flow.create?.running === true,
  };
}
