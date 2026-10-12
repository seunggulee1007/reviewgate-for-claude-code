/**
 * MARK: wave4b w4-notify — §39.6: a clicked OS notification (main has already brought its window forward, restored from
 * the taskbar): back to the review tab from PRs, its chat tab, and the card / summary it was about — as on the Mac
 * (`WindowModel.openFromNotification`, `AttentionReveal`). The plan is pure; components/NotificationNotices.tsx runs it.
 */
import type { NotificationClick } from "../shared/ipc";
import type { Tab } from "./store";

/** Where the chat scrolls: a permission / question card (flashed), the plan card, the newest turn summary card. */
export type ClickReveal = { kind: "card"; requestId: string } | { kind: "plan" } | { kind: "turn" } | null;
/** `showChat`: the chat the window shows (`viewedChat.viewChat`: the running chat → back to it, another → read-only). */
export type ClickPlan = { tab: "changes" | null; showChat: string | null; reveal: ClickReveal };

export function notificationClickPlan(
  click: NotificationClick,
  here: { tab: Tab; currentChatId: string | null; openTabIds: readonly string[] },
): ClickPlan {
  const chat = click.target?.chatId ?? null;
  // wave4b integration (§39.2 × §39.6), as the Mac's `WindowModel.openFromNotification`: a click never switches the
  // Claude session. The running chat's notification shows the running chat again (its card is there, also when another
  // chat is shown read-only); one from a chat the session has left since shows that chat read-only while its tab is open.
  const other = chat !== null && chat !== here.currentChatId;
  const showChat = other ? (here.openTabIds.includes(chat) ? chat : null) : here.currentChatId;
  let reveal: ClickReveal = null;
  if (click.kind === "permission" || click.kind === "question") {
    reveal = click.target?.requestId ? { kind: "card", requestId: click.target.requestId } : null;
  } else if (click.kind === "plan") {
    reveal = { kind: "plan" };
  } else if (click.kind === "turn_done") {
    reveal = { kind: "turn" };
  }
  // A chat that is not open as a tab any more: its rows are not on screen, the window only comes forward.
  if (other && showChat === null) reveal = null;
  return { tab: here.tab === "prs" ? "changes" : null, showChat, reveal };
}
