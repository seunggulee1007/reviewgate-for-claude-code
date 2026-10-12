/**
 * Audit polish-03: the composer draft and the message queue live only in the renderer, so a renderer reload used to
 * lose them. Both are kept per project in `sessionStorage` (this window only, gone when it closes): the draft comes back
 * into the composer, the queue comes back paused ("새로고침 뒤 복원했어요 — 재개하면 보내요") so nothing goes out twice
 * by surprise. Storage access never throws (private mode, quota): it is best effort.
 */
import type { SendAttachment } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash";
import { t } from "./i18n";
import { enqueue, type QueuedMessage, type QueueState } from "./sendQueue";

export type KeepStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const QUEUE_PREFIX = "rg.queue.";
const DRAFT_PREFIX = "rg.draft.";

/** This window's `sessionStorage`, or null where there is none (tests, a locked-down context). */
export function windowStorage(): KeepStorage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

type StoredMessage = { text: string; mentions?: string[]; attachments?: SendAttachment[] };

const stored = (m: QueuedMessage): StoredMessage => ({
  text: m.text,
  ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
  ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
});

/** Writes the queue of the project `hash` (an empty queue removes it). Too big for the storage: the image messages stay out. */
export function saveQueue(storage: KeepStorage, hash: string, items: QueuedMessage[]): void {
  const key = QUEUE_PREFIX + hash;
  try {
    if (items.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(items.map(stored)));
  } catch {
    try {
      const small = items.filter((m) => !m.attachments || m.attachments.length === 0).map(stored);
      if (small.length > 0) storage.setItem(key, JSON.stringify(small));
      else storage.removeItem(key);
    } catch {
      /* best effort */
    }
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

/** The queue a reload brings back: the kept messages, paused until the user resumes. */
export function restoredQueue(kept: StoredMessage[]): Pick<QueueState, "items" | "paused"> | null {
  if (kept.length === 0) return null;
  let items: QueuedMessage[] = [];
  for (const m of kept) items = enqueue(items, m.text, false, { mentions: m.mentions, attachments: m.attachments });
  return { items, paused: t("Restored after a reload — Resume to send") };
}

export function saveDraft(storage: KeepStorage | null, hash: string | null, text: string): void {
  if (!storage || !hash) return;
  try {
    if (text.length === 0) storage.removeItem(DRAFT_PREFIX + hash);
    else storage.setItem(DRAFT_PREFIX + hash, text);
  } catch {
    /* best effort */
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

/**
 * Keeps the queue of the open project in `storage` and brings it back (paused) when that project appears in a window
 * whose queue is empty — what a renderer reload looks like. Switching projects clears the queue as before (and so the
 * kept copy). Returns the unsubscribe.
 */
export function keepQueueAcrossReloads(store: QueueStore, storage: KeepStorage | null = windowStorage()): () => void {
  if (!storage) return () => undefined;
  let root = store.getState().state.project?.root ?? null;
  return store.subscribe((s, prev) => {
    const now = s.state.project?.root ?? null;
    if (now !== root) {
      root = now;
      if (now && s.queue.items.length === 0) {
        const back = restoredQueue(loadQueue(storage, projectRootHash(now)));
        if (back) store.setState((st) => ({ queue: { ...st.queue, ...back } }));
      }
      return;
    }
    if (now && s.queue.items !== prev.queue.items) saveQueue(storage, projectRootHash(now), s.queue.items);
  });
}
