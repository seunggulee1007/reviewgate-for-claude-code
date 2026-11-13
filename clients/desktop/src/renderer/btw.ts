/**
 * MARK: composer parity — docs/PROTOCOL.md §56.1: `/btw <question>`, as in the terminal — the app's command (never sent,
 * queued or put into the turn): asked on the side (`btw_ask`), the answer shown over the composer and kept for `/btw` alone
 * in this chat. As on the Mac (Core Btw.swift).
 */
import { create } from "zustand";
import { engineRequest } from "./engineRequest";
import { flowRefusal } from "./flowLogic";
import { t } from "./i18n";

/** The palette's entry, as the CLI's own /btw. */
export const BTW_NAME = "btw";

/** `text` is the `/btw` command → its question ("" for `/btw` alone); null for anything else (`/btwx`, a message). */
export function btwQuestion(text: string): string | null {
  const m = /^\/btw(?=\s|$)([\s\S]*)$/i.exec(text.trim());
  return m ? m[1]!.trim() : null;
}

export function btwDescription(): string {
  return t("Ask a quick side question — Claude keeps working; the answer stays out of the chat");
}

export function btwNothingYet(): string {
  return t("No side answer yet — type /btw and your question");
}

export type BtwAnswer = { question: string; answer: string; viaFork: boolean; synthetic: boolean };
export type BtwOverlay = { kind: "asking"; question: string } | { kind: "answered"; answer: BtwAnswer };
/** A question that got no answer: why, and the question (it goes back into an empty composer). */
export type BtwFailure = { id: number; question: string; text: string };

type BtwState = {
  overlay: BtwOverlay | null;
  last: { chat: string | null; answer: BtwAnswer } | null;
  /** The question in flight (null: none, or cancelled — its answer is dropped). */
  asking: number | null;
  failure: BtwFailure | null;
  ask(question: string, chat: string | null): Promise<void>;
  /** `/btw` alone: this chat's last answer again; false when there is none. */
  showLast(chat: string | null): boolean;
  /** Esc / ↩ / Space / Close; Cancel while it waits. */
  dismiss(): void;
};

let seq = 0;

export const useBtw = create<BtwState>((set, get) => ({
  overlay: null,
  last: null,
  asking: null,
  failure: null,
  async ask(question, chat) {
    const q = question.trim();
    if (!q) return;
    const token = ++seq;
    set({ asking: token, overlay: { kind: "asking", question: q } });
    try {
      const r = await engineRequest({ type: "btw_ask", question: q });
      if (get().asking !== token) return; // cancelled meanwhile: the answer is dropped
      const answer: BtwAnswer = { question: r.question || q, answer: r.answer, viaFork: r.via === "fork", synthetic: r.synthetic === true };
      set({ asking: null, last: { chat, answer }, overlay: { kind: "answered", answer } });
    } catch (e: unknown) {
      if (get().asking !== token) return;
      set({ asking: null, overlay: null, failure: { id: token, question: q, text: flowRefusal(e) } });
    }
  },
  showLast(chat) {
    const last = get().last;
    if (!last || last.chat !== chat) return false;
    set({ overlay: { kind: "answered", answer: last.answer } });
    return true;
  },
  dismiss() {
    set({ asking: null, overlay: null });
  },
}));
