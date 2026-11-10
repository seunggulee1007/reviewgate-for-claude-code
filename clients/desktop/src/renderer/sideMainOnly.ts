/**
 * MARK: r2-skills-side — side questions (docs/PROTOCOL.md §21), pure and unit-tested:
 * - M18: a skill or slash command asked in a side question runs in the main conversation only — `side_ask` is refused
 *   `side_command:<name>`, or the side policy denies the answer's `Skill` call. [메인 대화로 보내기] sends the question there as
 *   typed (no side prefix): `mainOnlyRequest`.
 * - P3-transcript-28: what is typed and not asked yet — the new-question text by anchor (`sideDraftKey`), each thread's
 *   follow-up — is kept per chat (`localStorage` `rg.sideDrafts.<chatId>`), so closing the panel, another "왜?", another
 *   thread or a restart never loses it.
 */
import type { SideAnchor, SideMessage, SideThread } from "@reviewgate/engine";

/** A request a side question cannot run, to send to the main conversation as typed. */
export type SideMainOnly = { text: string; name: string };

/** The skill a side answer tried to run (a `Skill` call the side policy denied), else null. */
export function deniedSkill(message: SideMessage | undefined): string | null {
  if (!message || message.role !== "assistant") return null;
  const call = [...(message.toolCalls ?? [])].reverse().find((c) => c.name === "Skill" && c.denied === true);
  if (!call) return null;
  const input = call.input as Record<string, unknown>;
  const name = typeof input["skill"] === "string" ? input["skill"] : typeof input["command"] === "string" ? input["command"] : "";
  return name || "Skill";
}

/** What [메인 대화로 보내기] sends for a thread: a refused question (`stored`), else — when its answer tried to run a skill — its last question. */
export function mainOnlyRequest(stored: SideMainOnly | undefined, thread: SideThread | undefined): SideMainOnly | null {
  if (stored) return stored;
  if (!thread || thread.status === "running") return null;
  const answer = [...thread.messages].reverse().find((m) => m.role === "assistant");
  const skill = deniedSkill(answer);
  const question = [...thread.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  return skill && question ? { text: question, name: skill } : null;
}

/** The name `side_command:<name>` carries, shown as a command (`/acme-verify`). */
export function shownCommand(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

// ---------------------------------------------------------------- drafts (P3-transcript-28)

export type SideDrafts = { chatId: string | null; compose: Record<string, string>; followUps: Record<string, string> };
export const EMPTY_DRAFTS: SideDrafts = { chatId: null, compose: {}, followUps: {} };
const KEY_PREFIX = "rg.sideDrafts.";

/** The new-question draft's key for `anchor` (its path / line / hunk / call / history entry / PR line / quote); "" in general. */
export function sideDraftKey(anchor: SideAnchor | null | undefined): string {
  if (!anchor) return "";
  if (anchor.pr) return `pr:${anchor.pr.number}:${anchor.pr.path}:${anchor.pr.line ?? ""}`;
  if (anchor.quote) return `quote:${anchor.quote.turn ?? ""}:${anchor.quote.text.slice(0, 80)}`;
  return [anchor.entryId ?? "", anchor.path ?? "", anchor.hunkId ?? "", anchor.line ?? "", anchor.side ?? "", anchor.toolUseId ?? ""].join("|");
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function strings(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0));
}

/** The chat's kept drafts (none without a chat or storage). */
export function loadDrafts(chatId: string | null, store: Storage | null = storage()): SideDrafts {
  if (!chatId || !store) return { ...EMPTY_DRAFTS, chatId };
  try {
    const raw = JSON.parse(store.getItem(KEY_PREFIX + chatId) ?? "null") as { compose?: unknown; followUps?: unknown } | null;
    return { chatId, compose: strings(raw?.compose), followUps: strings(raw?.followUps) };
  } catch {
    return { ...EMPTY_DRAFTS, chatId };
  }
}

/** Writes the chat's drafts (an empty set removes the entry). */
export function saveDrafts(drafts: SideDrafts, store: Storage | null = storage()): void {
  if (!drafts.chatId || !store) return;
  const key = KEY_PREFIX + drafts.chatId;
  try {
    if (Object.keys(drafts.compose).length === 0 && Object.keys(drafts.followUps).length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ compose: drafts.compose, followUps: drafts.followUps }));
  } catch {
    // A full or blocked storage keeps the drafts in memory only.
  }
}

/** `map` with `key` set to `text` (removed when empty). */
export function withDraft(map: Record<string, string>, key: string, text: string): Record<string, string> {
  const { [key]: _old, ...rest } = map;
  return text.length > 0 ? { ...rest, [key]: text } : rest;
}
