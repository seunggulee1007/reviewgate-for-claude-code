/**
 * MARK: wave4b w4-notify — §39.6 notifications you notice, as on the Mac: a clicked notification lands on its chat and the
 * card / summary it was about (`notificationClickPlan`), a notification the OS did not show is said once in the window
 * ([알림 설정 열기] [닫기]), and Settings › Notifications has one switch per group plus where to look in the OS.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { AppSettings, NotificationClick } from "../../shared/ipc";
import { t } from "../i18n";
import { notificationClickPlan, type ClickReveal } from "../notifyClick";
import { sessionsOf } from "../sessions";
import { useStore } from "../store";
import { viewChat } from "../viewedChat";
import { revealPermissionCard } from "./chat/PermissionBits";

/** The OS refused one of this window's notifications (main says so once per window). */
const useTrouble = create<{ trouble: boolean }>(() => ({ trouble: false }));

/** Where to look in the OS when notifications do not show. */
function osHint(): string {
  return window.rg.platform === "win32"
    ? t("Check Windows Settings › System › Notifications for ReviewGate, and Do not disturb (Focus assist).")
    : t("Check the system's notification settings for ReviewGate.");
}

const canOpenOsSettings = (): boolean => typeof window.rg.openNotificationSettings === "function" && (window.rg.platform === "win32" || window.rg.platform === "darwin");

function revealInDom(reveal: ClickReveal): void {
  if (!reveal) return;
  if (reveal.kind === "card") {
    revealPermissionCard(reveal.requestId);
    return;
  }
  const el = reveal.kind === "plan" ? document.querySelector<HTMLElement>('[data-testid="Plan card"]') : [...document.querySelectorAll<HTMLElement>('[data-testid="Turn summary"]')].pop();
  el?.scrollIntoView({ block: reveal.kind === "plan" ? "nearest" : "start", behavior: "smooth" });
}

/** Subscribes the window to its clicked notifications and to the OS refusing one (App, once). */
export function useNotificationNotices(): void {
  useEffect(() => {
    const offClick = window.rg.onNotificationClick?.((click: NotificationClick) => {
      const s = useStore.getState();
      const sessions = sessionsOf(s.state);
      const plan = notificationClickPlan(click, { tab: s.tab, currentChatId: sessions.currentId, openTabIds: sessions.openTabIds });
      if (plan.tab) s.setTab(plan.tab);
      // After the tab / chat has rendered its rows (a chat shown read-only once its saved rows are read). Nothing switches.
      const reveal = () => void setTimeout(() => revealInDom(plan.reveal), 300);
      if (plan.showChat) void viewChat(plan.showChat).then(reveal, reveal);
      else reveal();
    });
    const offTrouble = window.rg.onNotificationTrouble?.(() => useTrouble.setState({ trouble: true }));
    return () => {
      offClick?.();
      offTrouble?.();
    };
  }, []);
}

/** Once per window: the OS did not show a notification — where to look; [닫기] closes it for good (Settings keeps the hint). */
export function NotificationTroubleBanner() {
  const trouble = useTrouble((s) => s.trouble);
  const dismissed = useStore((s) => s.settings?.notificationsHintDismissed === true);
  const save = useStore((s) => s.saveSettings);
  if (!trouble || dismissed) return null;
  return (
    <div className="banner orange" role="status" data-testid="Notifications trouble banner">
      <span className="grow" title={osHint()}>
        {t("A ReviewGate notification did not appear")} — {osHint()}
      </span>
      {canOpenOsSettings() && (
        <button type="button" className="small" onClick={() => void window.rg.openNotificationSettings?.()} data-testid="Notifications trouble open settings">
          {t("Open notification settings")}
        </button>
      )}
      <button
        type="button"
        className="small"
        onClick={() => {
          useTrouble.setState({ trouble: false });
          void save({ notificationsHintDismissed: true });
        }}
        data-testid="Notifications trouble close"
      >
        {t("Close")}
      </button>
    </div>
  );
}

/** Settings › Notifications below the main switch: one switch per group (all on by default) and where to look in the OS. */
export function NotificationGroupsSection({ settings, patch }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const off = settings.notifications === false;
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={settings.notifyWaiting !== false} disabled={off} onChange={(e) => patch({ notifyWaiting: e.target.checked })} data-testid="Notify waiting" />
        {t("Permission requests, questions and plans")}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.notifyTurnEnd !== false} disabled={off} onChange={(e) => patch({ notifyTurnEnd: e.target.checked })} data-testid="Notify turn end" />
        {t("When work finishes")}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.notifyOther !== false} disabled={off} onChange={(e) => patch({ notifyOther: e.target.checked })} data-testid="Notify other" />
        {t("Everything else (errors, side questions, other sessions, subagents)")}
      </label>
      <div className="note">{t("Clicking a notification opens its window, chat and card.")}</div>
      <div className="note" data-testid="Notifications OS hint">
        {t("If notifications do not appear:")} {osHint()}{" "}
        {canOpenOsSettings() && (
          <button type="button" className="small" onClick={() => void window.rg.openNotificationSettings?.()} data-testid="Open notification settings">
            {t("Open notification settings")}
          </button>
        )}
      </div>
    </>
  );
}
