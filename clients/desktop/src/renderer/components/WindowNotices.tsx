/**
 * r2-review-flow M27 (docs/PROTOCOL.md §49.2), as the Mac's WindowNoticesStack: the window's information banners — a new
 * Claude CLI not verified yet (or a pin waiting for the next start), a notification the OS did not show, a new workbench's
 * setup that failed — each took a full-width row above the panes; at 637 px two of them left the conversation a few lines.
 * One shows as before; two or more fold into one "알림 N개" chip whose popover holds them all, each with its own buttons.
 * Errors, the restored review, the gate's banners and the commit banner stay banners.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { Icon } from "../icons";
import { cliBannerOf, cliInfoOf, pinnedVersionOf } from "../sessionTools";
import { useStore } from "../store";
import { CliVersionBanner } from "./CliVersionBanner";
import { WorkbenchSetupBanner } from "./flow/WorkbenchSetup";
import { NotificationTroubleBanner, useNotificationTroubleShown } from "./NotificationNotices";
import "./windowNotices.css";

export type WindowNotice = "cliVersion" | "notifications" | "setupReport";

/** The information banners that stand, in the order they are drawn (each decides as its banner does). */
export function windowNoticesOf(p: { cliVersion: boolean; notifications: boolean; setupReport: boolean }): WindowNotice[] {
  const all: [WindowNotice, boolean][] = [["cliVersion", p.cliVersion], ["notifications", p.notifications], ["setupReport", p.setupReport]];
  return all.filter(([, shown]) => shown).map(([notice]) => notice);
}

/** Two or more fold into the chip; one is its banner. */
export function foldsWindowNotices(notices: readonly WindowNotice[]): boolean {
  return notices.length >= 2;
}

/** `changesTab`: the workbench's setup banner belongs to the Changes side (as before). */
export function WindowNotices({ changesTab }: { changesTab: boolean }) {
  // The CLI banner's own test (CliVersionBanner): a project, and a version not verified / a pin not yet in use, not closed.
  const cliVersion = useStore((s) => s.state.project !== null && cliBannerOf(cliInfoOf({ cli: s.state.session.cli }), s.cliBannerDismissed, pinnedVersionOf(s.settings?.claudePath ?? "")) !== null);
  const notifications = useNotificationTroubleShown();
  const setupReport = useStore((s) => changesTab && s.flow.setupReport !== null);
  const notices = windowNoticesOf({ cliVersion, notifications, setupReport });
  const banners = (
    <>
      {/* wave3 desktop-session — §36.8 "새 CLI x.y.z — 아직 검증 안 됨" (once per version) */}
      <CliVersionBanner />
      {/* MARK: wave4b w4-notify — §39.6: the OS did not show a notification (once per window) */}
      <NotificationTroubleBanner />
      {/* MARK: wave3 desktop-flow — §36.12: this new workbench's setup failed — the exit and the log */}
      {changesTab && <WorkbenchSetupBanner />}
    </>
  );
  if (!foldsWindowNotices(notices)) return banners;
  return <WindowNoticesChip count={notices.length}>{banners}</WindowNoticesChip>;
}

/** The folded row: "알림 N개", a click opens the banners in a popover (Esc or a click outside closes it). */
export function WindowNoticesChip({ count, children, initiallyOpen = false }: { count: number; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const label = t("{0} notices", count);
  return (
    <div className="banner window-notices" ref={ref} data-testid="Window notices">
      <button
        type="button"
        className="small window-notices-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("The window's notices — the CLI version, notifications, a workbench's setup — click to see them")}
        data-testid="Window notices chip"
      >
        <Icon name="warning" size={12} />
        {label}
      </button>
      {open && (
        <div className="popover window-notices-popover" role="dialog" aria-label={label} data-testid="Window notices popover">
          {children}
        </div>
      )}
    </div>
  );
}
