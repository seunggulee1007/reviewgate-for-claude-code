/**
 * MARK: composer parity — docs/PROTOCOL.md §56.2: what Esc (or ↑ in an empty composer) gives back — the messages in Claude's
 * turn it never read, then the whole queue, one per paragraph, with their mentions and images — and what it says about the
 * ones Claude already read. As on the Mac (Core EscTakeBack.swift `GivenBack`).
 */
import type { SendAttachment } from "@reviewgate/engine";
import { t } from "./i18n";

type Steered = { text: string; mentions?: string[] };
type Queued = { text: string; mentions?: string[]; attachments?: SendAttachment[] };

export function givenBack(steered: readonly Steered[], queued: readonly Queued[]): { text: string; mentions: string[]; attachments: SendAttachment[] } | null {
  const all = [...steered, ...queued];
  if (all.length === 0) return null;
  return {
    text: all.map((m) => m.text).join("\n\n"),
    mentions: all.flatMap((m) => m.mentions ?? []),
    attachments: queued.flatMap((m) => m.attachments ?? []),
  };
}

/** Why some stayed: Claude read them already (their rows are in the chat, or come with the turn's end). */
export function readNotice(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? t("Claude already read this message — it stays in the chat") : t("Claude already read {0} of the waiting messages — they stay in the chat", count);
}
