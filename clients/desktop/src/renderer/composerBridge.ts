/**
 * MARK: wave3 desktop-agents — text handed to the composer from outside it (the agent details sheet's "메인으로 보내기",
 * §36.1). The draft is the composer's own state, so the composer registers a listener; text handed over while no composer
 * is mounted waits for the next one. Nothing is ever sent from here: the user reads, adds their words and sends (or queues)
 * with the composer's usual gate.
 */
import { useEffect, useRef } from "react";

type Listener = (text: string) => void;

let listener: Listener | null = null;
let pending: string | null = null;

/** Hands `text` to the composer → true when one took it now (false: it waits for the next composer). */
export function insertIntoComposer(text: string): boolean {
  if (listener) {
    listener(text);
    return true;
  }
  pending = pending ? joinDraft(pending, text) : text;
  return false;
}

/** The composer's side: `onInsert` receives what `insertIntoComposer` hands over (and anything that waited). */
export function useComposerInsert(onInsert: Listener): void {
  const ref = useRef(onInsert);
  ref.current = onInsert;
  useEffect(() => {
    const own: Listener = (text) => ref.current(text);
    listener = own;
    if (pending !== null) {
      const waiting = pending;
      pending = null;
      own(waiting);
    }
    return () => {
      if (listener === own) listener = null;
    };
  }, []);
}

/** The draft with `text` after it (a blank line between), or `text` alone in an empty box. */
export function joinDraft(draft: string, text: string): string {
  const head = draft.replace(/\s+$/, "");
  return head.length === 0 ? text : `${head}\n\n${text}`;
}
