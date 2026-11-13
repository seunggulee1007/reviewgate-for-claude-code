/**
 * MARK: wave3 desktop-agents — text handed to the composer from outside it (the agent details sheet's "메인으로 보내기",
 * §36.1). The draft is the composer's own state, so the composer registers a listener; text handed over while no composer
 * is mounted waits for the next one. Nothing is ever sent from here: the user reads, adds their words and sends (or queues)
 * with the composer's usual gate.
 */
import { useEffect, useRef } from "react";
import type { DraftImage } from "./composerAttach";

/** r2-chats-cards M31 / M33 (§9): the chips a held message had in the composer — given back with its text. */
export type ComposerChips = { mentions: string[]; mentionDirs: Record<string, true>; images: DraftImage[] };

/** Where the text goes: after the draft (default), or §56.2 in front of it (messages given back by Esc / ↑). */
export type InsertAt = "end" | "front";

type Listener = (text: string, chips?: ComposerChips, at?: InsertAt) => void;

let listener: Listener | null = null;
let pending: string | null = null;
let pendingChips: ComposerChips | null = null;

/** Hands `text` (and `chips`) to the composer → true when one took it now (false: it waits for the next composer). */
export function insertIntoComposer(text: string, chips?: ComposerChips, at: InsertAt = "end"): boolean {
  if (listener) {
    listener(text, chips, at);
    return true;
  }
  pending = pending ? (at === "front" ? joinDraft(text, pending) : joinDraft(pending, text)) : text;
  if (chips) {
    pendingChips = pendingChips
      ? { mentions: [...pendingChips.mentions, ...chips.mentions], mentionDirs: { ...pendingChips.mentionDirs, ...chips.mentionDirs }, images: [...pendingChips.images, ...chips.images] }
      : chips;
  }
  return false;
}

/** The composer's side: `onInsert` receives what `insertIntoComposer` hands over (and anything that waited). */
export function useComposerInsert(onInsert: Listener): void {
  const ref = useRef(onInsert);
  ref.current = onInsert;
  useEffect(() => {
    const own: Listener = (text, chips, at) => ref.current(text, chips, at);
    listener = own;
    if (pending !== null) {
      const waiting = pending;
      const waitingChips = pendingChips ?? undefined;
      pending = null;
      pendingChips = null;
      own(waiting, waitingChips);
    }
    return () => {
      if (listener === own) listener = null;
    };
  }, []);
}

// MARK: §49 Run as Task — the task the composer handed over started in its workbench: the composer lets the text go.
let taskListener: Listener | null = null;

/** The task `text` (taken from the composer) started in its new workbench: the composer empties its draft if it still holds it. */
export function taskLeftComposer(text: string): void {
  if (text) taskListener?.(text);
}

/** The composer's side of `taskLeftComposer` (nothing waits: a composer that is not mounted has no draft to empty). */
export function useTaskLeftComposer(onStarted: Listener): void {
  const ref = useRef(onStarted);
  ref.current = onStarted;
  useEffect(() => {
    const own: Listener = (text) => ref.current(text);
    taskListener = own;
    return () => {
      if (taskListener === own) taskListener = null;
    };
  }, []);
}

/** The draft with `text` after it (a blank line between), or `text` alone in an empty box. */
export function joinDraft(draft: string, text: string): string {
  const head = draft.replace(/\s+$/, "");
  return head.length === 0 ? text : `${head}\n\n${text}`;
}
