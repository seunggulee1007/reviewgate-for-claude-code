import type { BtwExchange } from "../session/claude.js";

/**
 * docs/PROTOCOL.md §56.1 `/btw <question>`: a quick side question, as in the terminal — answered from the conversation as it
 * is, with no tools, while Claude works or not; the answer is shown apart and joins neither the chat nor its history.
 */

/** Longer questions are refused (`question_too_long`), as `side_ask` (§21). */
export const MAX_BTW_QUESTION = 20_000;
/** The earlier exchanges of a chat handed to the next question (oldest dropped first). */
export const BTW_HISTORY = 10;
/** An answer slower than this is given up (`btw_failed`); the CLI's request is cancelled. */
export const BTW_TIMEOUT_MS = 180_000;

/** The fork's system-prompt append (the CLI's own `side_question` reminder, for a fork that has the same context). */
export const BTW_SYSTEM = [
  "This is a side question from the user (/btw), asked next to the main conversation. Answer it directly in a single response.",
  "- You are a separate, lightweight instance: the main agent is not interrupted and goes on working.",
  "- You have NO tools: never write tool calls or their output as text. If answering needs reading files, running commands or",
  "  searching, say it can't be checked from a side question and suggest asking in the main conversation.",
  "- Answer only from what you already know of the conversation; if you don't know, say so. Never promise to do anything.",
].join("\n");

/** The fork's prompt: the chat's earlier /btw exchanges (the CLI passes them as turns; a fork reads them here), then the question. */
export function btwForkPrompt(question: string, history: readonly BtwExchange[]): string {
  if (history.length === 0) return question;
  const earlier = history.map((h) => `Q: ${h.question}\nA: ${h.response}`).join("\n\n");
  return `Earlier side questions in this chat:\n\n${earlier}\n\nThe side question now:\n${question}`;
}

/** The current chat's /btw exchanges; another chat starts with none. */
export class BtwHistory {
  private chatId: string | null = null;
  private items: BtwExchange[] = [];

  of(chatId: string | null): BtwExchange[] {
    if (chatId !== this.chatId) {
      this.chatId = chatId;
      this.items = [];
    }
    return [...this.items];
  }

  add(chatId: string | null, exchange: BtwExchange): void {
    this.of(chatId);
    this.items.push(exchange);
    if (this.items.length > BTW_HISTORY) this.items.splice(0, this.items.length - BTW_HISTORY);
  }
}
