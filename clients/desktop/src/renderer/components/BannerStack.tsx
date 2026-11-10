/**
 * The one banner area above the chat / diff (M16 banner tidy): the error banner, the one-time
 * "review restored" banner, the §19.6 slow-start hint (auto-hides after 8 s; docs/PROTOCOL.md §8) and the commit banner (Changes tab).
 * wave1 desktop-review: the §31–32 gate banners (GateBanners) and a restored banner that stays while the review is stale
 * or brought outside changes with it.
 * polish p-lifecycle (P5-sheets-49): a newer release, in every window (src/main/update.ts).
 */
import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "../../shared/ipc";
import { t } from "../i18n";
import { restoredNotice, staleLines } from "../reviewGate";
import { useStore } from "../store";
import { CommitBanner } from "./diff/CommitBanner";
import { ErrorBanner, StartSlowBanner } from "./ErrorBanner";
import { ExtensionsFallbackBanner } from "./extensions/ExtensionsDialog";
import { TabAttentionBar } from "./TabAttention";
import { GateBanners } from "./GateBanners";
import { StorageBanners } from "./StorageNotices"; // MARK: wave4b w4b-bigturn
import { WindowNotices } from "./WindowNotices"; // r2-review-flow M27: the CLI version, notifications, a workbench's setup

const RESTORED_HIDE_MS = 8000;

function RestoredBanner() {
  const restored = useStore((s) => s.state.gate.restored);
  // §31.5: changes made while the app was closed came back as outside changes, or the review is stale.
  const { external, stale, sticky } = restoredNotice(useStore((s) => s.state));
  const staleGate = useStore((s) => s.state.gate.stale ?? null);
  const openDialog = useStore((s) => s.openDialog);
  const keepReview = useStore((s) => s.keepReview);
  const revealExternal = useStore((s) => s.revealExternalChanges);
  const [dismissed, setDismissed] = useState(false);
  const wasRestored = useRef(false);

  // A fresh restore (false → true) re-arms the banner; it hides itself after 8 s or on Dismiss — not while it is sticky.
  useEffect(() => {
    if (restored && !wasRestored.current) setDismissed(false);
    wasRestored.current = restored;
    if (!restored || sticky) return;
    const id = setTimeout(() => setDismissed(true), RESTORED_HIDE_MS);
    return () => clearTimeout(id);
  }, [restored, sticky]);

  if (!restored || dismissed) return null;
  const text = [t("Review restored from a previous session"), ...(external > 0 ? [t("{0} change(s) came in meanwhile", external)] : []), ...(stale ? [t("This review is old")] : [])].join(" · ");
  // r2-review-flow M29 (§31.5): the stale review's reasons on hover — the banner is where it is decided, never a dialog.
  const why = staleGate ? [text, ...staleLines(staleGate), "", t("Clean up empties the review list and leaves every file on disk as it is; Keep reviewing goes on with it — so does your next message.")].join("\n") : text;
  return (
    <div className={`banner ${sticky ? "orange" : "blue"}`} role="status" data-testid="Restored banner">
      <span className="grow truncate" title={why}>{text}</span>
      {stale && (
        <button type="button" className="small" onClick={() => openDialog({ kind: "finishReview" })} title={t("Empty the review list without touching any file")} data-testid="Restored clean up">
          {t("Clean up…")}
        </button>
      )}
      {stale && (
        <button type="button" className="small primary" onClick={() => void keepReview()} title={t("Keep this review as it is — sending a message keeps it too")} data-testid="Restored keep reviewing">
          {t("Keep reviewing")}
        </button>
      )}
      {!stale && external > 0 && (
        <button type="button" className="small" onClick={revealExternal} data-testid="Restored show outside">
          {t("Show outside changes")}
        </button>
      )}
      <button type="button" className="small" onClick={() => setDismissed(true)} data-testid="Dismiss restored">
        {t("Dismiss")}
      </button>
    </div>
  );
}

// MARK: polish p-lifecycle — P5-sheets-49: "ReviewGate 0.6.0 버전이 나왔어요" — [릴리스 페이지 열기] [나중에].
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const rg = window.rg;
    let live = true;
    void rg.updateStatus?.().then((s) => live && setStatus(s));
    const off = rg.onUpdateStatus?.((s) => setStatus(s));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  if (!status) return null;
  const detail = t("This app is {0}; the latest release is {1}.", status.current, status.version);
  return (
    <div className="banner blue" role="status" data-testid="Update banner">
      <span className="grow truncate" title={detail}>
        <strong>{t("ReviewGate {0} is available", status.version)}</strong> · {detail}
      </span>
      <button type="button" className="small primary" onClick={() => void window.rg.openUpdate?.()} title={status.page} data-testid="Open release page">
        {t("Open Release Page")}
      </button>
      <button type="button" className="small" onClick={() => void window.rg.dismissUpdate?.()} title={t("Hide this version — the next one is announced again")} data-testid="Dismiss update">
        {t("Later")}
      </button>
    </div>
  );
}

export function BannerStack() {
  const changesTab = useStore((s) => s.tab !== "prs" && s.state.project !== null);
  return (
    <div className="banner-stack" data-testid="Banner stack">
      <UpdateBanner />
      {/* MARK: wave4b w4b-bigturn — §39.1: a save failed / under 1 GB free (once) */}
      <StorageBanners />
      <ErrorBanner />
      <StartSlowBanner />
      {/* r2-review-flow M27 (§49.2): the new CLI (§36.8), a notification the OS did not show (§39.6) and a new workbench's
          failed setup (§36.12, Changes tab) — two or more fold into one "알림 N개" chip */}
      <WindowNotices changesTab={changesTab} />
      <TabAttentionBar />
      {changesTab && <ExtensionsFallbackBanner />}
      {changesTab && <RestoredBanner />}
      {changesTab && <GateBanners />}
      {changesTab && <CommitBanner />}
    </div>
  );
}
