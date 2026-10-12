/**
 * The one banner area above the chat / diff (M16 banner tidy): the error banner, the one-time
 * "review restored" banner, the §19.6 slow-start hint (auto-hides after 8 s; docs/PROTOCOL.md §8) and the commit banner (Changes tab).
 * wave1 desktop-review: the §31–32 gate banners (GateBanners) and a restored banner that stays while the review is stale
 * or brought outside changes with it.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { restoredNotice } from "../reviewGate";
import { useStore } from "../store";
import { CommitBanner } from "./diff/CommitBanner";
import { WorkbenchSetupBanner } from "./flow/WorkbenchSetup"; // MARK: wave3 desktop-flow
import { ErrorBanner, StartSlowBanner } from "./ErrorBanner";
import { ExtensionsFallbackBanner } from "./extensions/ExtensionsDialog";
import { TabAttentionBar } from "./TabAttention";
import { GateBanners } from "./GateBanners";
import { CliVersionBanner } from "./CliVersionBanner"; // MARK: wave3 desktop-session
import { StorageBanners } from "./StorageNotices"; // MARK: wave4b w4b-bigturn
import { NotificationTroubleBanner } from "./NotificationNotices"; // MARK: wave4b w4-notify

const RESTORED_HIDE_MS = 8000;

function RestoredBanner() {
  const restored = useStore((s) => s.state.gate.restored);
  // §31.5: changes made while the app was closed came back as outside changes, or the review is stale.
  const { external, stale, sticky } = restoredNotice(useStore((s) => s.state));
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
  return (
    <div className={`banner ${sticky ? "orange" : "blue"}`} role="status" data-testid="Restored banner">
      <span className="grow truncate" title={text}>{text}</span>
      {stale && (
        <button type="button" className="small" onClick={() => openDialog({ kind: "staleReview" })} data-testid="Restored clean up">
          {t("Clean up…")}
        </button>
      )}
      {stale && (
        <button type="button" className="small" onClick={() => void keepReview()} data-testid="Restored keep reviewing">
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

export function BannerStack() {
  const changesTab = useStore((s) => s.tab !== "prs" && s.state.project !== null);
  return (
    <div className="banner-stack" data-testid="Banner stack">
      {/* MARK: wave4b w4b-bigturn — §39.1: a save failed / under 1 GB free (once) */}
      <StorageBanners />
      <ErrorBanner />
      <StartSlowBanner />
      {/* wave3 desktop-session — §36.8 "새 CLI x.y.z — 아직 검증 안 됨" (once per version) */}
      <CliVersionBanner />
      {/* MARK: wave4b w4-notify — §39.6: the OS did not show a notification (once per window) */}
      <NotificationTroubleBanner />
      <TabAttentionBar />
      {changesTab && <ExtensionsFallbackBanner />}
      {changesTab && <RestoredBanner />}
      {changesTab && <GateBanners />}
      {changesTab && <CommitBanner />}
      {/* MARK: wave3 desktop-flow — §36.12: this new workbench's setup failed — the exit and the log */}
      {changesTab && <WorkbenchSetupBanner />}
    </div>
  );
}
