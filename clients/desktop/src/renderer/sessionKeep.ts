/**
 * Audit polish-03 / polish p-lifecycle P4-composer-07: the composer draft and the message queue live in the renderer, so a
 * reload, closing the window or quitting used to lose them. Both are kept per project in `localStorage` (every window of
 * this app; a project is open in one window at a time): the draft comes back into the composer, the queue comes back paused
 * ("이전에 남겨 둔 메시지예요 — 재개하면 보내요") so nothing goes out twice by surprise — the Mac's `queueKeepChanged`.
 * Attached images are not kept (the close question says so). Storage access never throws (private mode, quota): it is
 * best effort.
 */
import type { SendAttachment } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash";
import { t } from "./i18n";
import { enqueue, type QueuedMessage, type QueueState } from "./sendQueue";

export type KeepStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const QUEUE_PREFIX = "rg.queue.";
const DRAFT_PREFIX = "rg.draft.";

/** The app's `localStorage` (it outlives the window), or null where there is none (tests, a locked-down context). */
export function windowStorage(): KeepStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

type StoredMessage = { text: string; mentions?: string[]; attachments?: SendAttachment[] };

/** The text and mentions — images are not kept (the storage is shared by every project; the close question says so). */
const stored = (m: QueuedMessage): StoredMessage => ({
  text: m.text,
  ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
});

/** Writes the queue of the project `hash` (an empty queue removes it). */
export function saveQueue(storage: KeepStorage, hash: string, items: QueuedMessage[]): void {
  const key = QUEUE_PREFIX + hash;
  try {
    if (items.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(items.map(stored)));
  } catch {
    /* best effort */
  }
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The kept queue of the project `hash` (malformed entries dropped). */
export function loadQueue(storage: KeepStorage, hash: string): StoredMessage[] {
  try {
    const raw = storage.getItem(QUEUE_PREFIX + hash);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: StoredMessage[] = [];
    for (const v of list) {
      if (typeof v !== "object" || v === null) continue;
      const o = v as Record<string, unknown>;
      if (!isString(o["text"]) || o["text"].trim().length === 0) continue;
      const mentions = Array.isArray(o["mentions"]) ? o["mentions"].filter(isString) : [];
      const attachments = Array.isArray(o["attachments"]) ? (o["attachments"] as SendAttachment[]).filter((a) => a && typeof a === "object" && isString(a.dataBase64) && isString(a.mediaType)) : [];
      out.push({ text: o["text"], ...(mentions.length > 0 ? { mentions } : {}), ...(attachments.length > 0 ? { attachments } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/** The queue a project finds when it opens again (or after a reload): the kept messages, paused until the user resumes. */
export function restoredQueue(kept: StoredMessage[]): Pick<QueueState, "items" | "paused"> | null {
  if (kept.length === 0) return null;
  let items: QueuedMessage[] = [];
  for (const m of kept) items = enqueue(items, m.text, false, { mentions: m.mentions, attachments: m.attachments });
  return { items, paused: t("Kept from before — Resume to send") };
}

/** At most this many drafts are kept (the Mac's `maxSavedComposerDrafts`); the least recently typed go first. */
export const MAX_KEPT_DRAFTS = 50;
const DRAFT_INDEX = "rg.draftKeys";

export function saveDraft(storage: KeepStorage | null, hash: string | null, text: string): void {
  if (!storage || !hash) return;
  try {
    const key = DRAFT_PREFIX + hash;
    const index = draftIndex(storage).filter((k) => k !== key);
    if (text.length === 0) storage.removeItem(key);
    else {
      storage.setItem(key, text);
      index.push(key);
      while (index.length > MAX_KEPT_DRAFTS) storage.removeItem(index.shift()!);
    }
    storage.setItem(DRAFT_INDEX, JSON.stringify(index));
  } catch {
    /* best effort */
  }
}

function draftIndex(storage: KeepStorage): string[] {
  try {
    const list: unknown = JSON.parse(storage.getItem(DRAFT_INDEX) ?? "[]");
    return Array.isArray(list) ? list.filter(isString) : [];
  } catch {
    return [];
  }
}

export function loadDraft(storage: KeepStorage | null, hash: string | null): string {
  if (!storage || !hash) return "";
  try {
    return storage.getItem(DRAFT_PREFIX + hash) ?? "";
  } catch {
    return "";
  }
}

type QueueStore = {
  getState(): { state: { project: { root: string } | null }; queue: QueueState };
  setState(patch: (s: { queue: QueueState }) => { queue: QueueState }): void;
  subscribe(listener: (s: { state: { project: { root: string } | null }; queue: QueueState }, prev: { queue: QueueState }) => void): () => void;
};

/** P4-composer-07: the project the window is leaving (switch, close): emptying its queue then keeps the kept copy. */
let leaving: string | null = null;

/** The store's switch / close calls this before it empties the view: the project's queue stays kept for its next open. */
export function keepQueueWhileLeaving(root: string | null): void {
  leaving = root;
}

/**
 * Keeps the queue of the open project in `storage` and brings it back (paused) when that project appears in a window
 * whose queue is empty — a reload, the project opened again, the next launch. A queue emptied by sending or by the user
 * forgets the kept copy; one emptied because the window leaves the project keeps it. Returns the unsubscribe.
 */
export function keepQueueAcrossReloads(store: QueueStore, storage: KeepStorage | null = windowStorage()): () => void {
  if (!storage) return () => undefined;
  let root = store.getState().state.project?.root ?? null;
  return store.subscribe((s, prev) => {
    const now = s.state.project?.root ?? null;
    if (now !== root) {
      root = now;
      leaving = null;
      if (now && s.queue.items.length === 0) {
        const back = restoredQueue(loadQueue(storage, projectRootHash(now)));
        if (back) store.setState((st) => ({ queue: { ...st.queue, ...back } }));
      }
      return;
    }
    if (!now || s.queue.items === prev.queue.items) return;
    // The view emptied as the window leaves the project: kept. Only that once — a switch that did not happen (refused,
    // the lock of another session) must not keep messages the user sends or clears afterwards.
    const left = leaving === now;
    leaving = null;
    if (s.queue.items.length === 0 && left) return;
    saveQueue(storage, projectRootHash(now), s.queue.items);
  });
}
