/**
 * MARK: wave4d w4d-speed — audit polish-09: Claude's answer streams as `text_delta`s, and each one is a new `transcript` array
 * whose only new item is the last assistant row (the store copies that row with the longer text; every other row object stays
 * the same). The chat list subscribes to the transcript's *shape* — the array it last drew, kept for as long as only that
 * row's text grows — so a delta redraws the streaming row (which reads its live text, `liveAssistant`) and nothing else: not
 * the hundreds of rows above it, not the index, the find plan or the agent groups built from them. Any other change (a tool
 * call, a result, a permission card, an older row, a new chat) is a new shape.
 */
import type { ChatItem } from "./store";

export type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;

/** `next` is `prev` with only its last row — the same assistant message — changed (its text grew, or its streaming ended). */
export function sameShape(prev: readonly ChatItem[], next: readonly ChatItem[]): boolean {
  if (prev === next) return true;
  const n = next.length;
  if (prev.length !== n) return false;
  if (n === 0) return true;
  const a = prev[n - 1]!;
  const b = next[n - 1]!;
  if (a.kind !== "assistant" || b.kind !== "assistant" || a.id !== b.id) return false;
  for (let i = n - 2; i >= 0; i--) if (prev[i] !== next[i]) return false;
  return true;
}

let lastIn: ChatItem[] | null = null;
let lastShape: ChatItem[] | null = null;

/**
 * The live transcript's shape: the array the list drew while only the streaming row changed since, else `items` itself. A
 * zustand selector (`useStore((s) => transcriptShape(s.transcript))`): the same state always gives the same array.
 */
export function transcriptShape(items: ChatItem[]): ChatItem[] {
  if (items === lastIn && lastShape !== null) return lastShape;
  const shape = lastShape !== null && sameShape(lastShape, items) ? lastShape : items;
  lastIn = items;
  lastShape = shape;
  return shape;
}

/**
 * The assistant row as it is now: a row of the shape may be the copy from when its streaming began. A finished row (and a
 * row of another chat shown read-only) is never streaming, so it is its own live version.
 */
export function liveAssistant(items: readonly ChatItem[], item: AssistantItem): AssistantItem {
  if (!item.streaming) return item;
  const last = items[items.length - 1];
  return last && last.kind === "assistant" && last.id === item.id ? last : item;
}
