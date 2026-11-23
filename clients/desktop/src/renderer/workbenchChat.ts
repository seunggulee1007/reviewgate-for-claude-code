/**
 * docs/PROTOCOL.md §9 "New Chat in a Workbench" (워크벤치에서 새 대화), as on the Mac (Core Session/WorkbenchChat.swift). One
 * folder is one review gate, so turns go one at a time per worktree and a new chat asked for while Claude works waits
 * (pendingSwitch.ts). The way out that does not wait is a workbench: a worktree of its own with its own branch, window and
 * Claude. This makes one from HEAD in one step — a branch name ready to accept, `workbench_create`, its window — and a
 * message held for the switch moves into that window's composer (never sent; main's `rg:takeWorkbenchDraft`). Client-only.
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";
import { isShadowProject } from "./noGit";
import { giveBackChips, takePendingSwitchForWorkbench, type HeldMessage, type PendingSwitch } from "./pendingSwitch";
import { composerTaskText } from "./runAsTask";

export const WORKBENCH_CHAT_PREFIX = "wb/";

const pad = (n: number) => String(n).padStart(2, "0");

/** `wb/<yyMMdd-HHmm>` (`utc`: in UTC, else local time); `-2`, `-3`… after it when a branch of that name exists already. */
export function suggestWorkbenchChatBranch(existing: readonly string[], now: Date = new Date(), utc = false): string {
  const [y, mo, d, h, mi] = utc
    ? [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()]
    : [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()];
  const base = `${WORKBENCH_CHAT_PREFIX}${pad(y % 100)}${pad(mo)}${pad(d)}-${pad(h)}${pad(mi)}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** The branch the dialog starts with: unused by any branch or workbench of this repository. */
export function workbenchChatBranchFor(s: Pick<ReviewState, "branches" | "workbenches">, now: Date = new Date()): string {
  const names = [...(s.branches?.list ?? []).map((b) => b.name), ...(s.workbenches?.list ?? []).map((w) => w.branch ?? "")];
  return suggestWorkbenchChatBranch(names.filter((n) => n.length > 0), now);
}

/** Why "New Chat in a Workbench" cannot run here (null: it can) — no project, or a folder tracked without git (§59). */
export function workbenchChatRefusal(s: Pick<ReviewState, "project">): string | null {
  if (!s.project) return t("Open a project first (⌘O)");
  if (isShadowProject(s)) return t("Workbenches need a git repository — this folder is tracked without git");
  return null;
}

/** Held messages as one composer text: each one's text and its @ mentions, one after another (null: none). */
export function heldText(messages: readonly HeldMessage[]): string | null {
  const parts = messages.map((m) => composerTaskText(m.text, m.extras?.mentions ?? m.chips?.mentions ?? [])).filter((p) => p.length > 0);
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** What the held switch would hand to the workbench's composer (null: nothing — a held new chat has no message). */
export function heldForWorkbench(pending: PendingSwitch | null): string | null {
  return pending?.kind === "open" ? heldText(pending.messages) : null;
}

/**
 * The workbench was made instead of waiting: the held switch is called off here and the text held with it goes to that
 * workbench's composer (returned; null: none). Images cannot travel to another window: they come back to this composer, as
 * "Run as Task" leaves them (§49).
 */
export function handHeldSwitchToWorkbench(): string | null {
  const messages = takePendingSwitchForWorkbench();
  const images = messages.flatMap((m) => m.chips?.images ?? []);
  if (images.length > 0) giveBackChips({ mentions: [], mentionDirs: {}, images });
  return heldText(messages);
}
