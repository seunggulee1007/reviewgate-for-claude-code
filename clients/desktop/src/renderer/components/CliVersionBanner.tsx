/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.8 (daily-06): "새 CLI x.y.z — 아직 검증 안 됨" from `session.cli` — once per version (closing it
 * keeps it closed, app-wide), with "이전 버전으로 고정" when the previous version is still installed. A pin waits for the
 * next session start: the banner then offers "지금 재시작". The `cli_version_changed` notice is the chat row (never a
 * second banner).
 */
import { t } from "../i18n";
import { cliBannerOf, cliInfoOf, pinnedVersionOf, type CliBanner } from "../sessionTools";
import { isRunning, useStore } from "../store";
import "./sessionTools.css";

export function CliVersionBanner() {
  const hasProject = useStore((s) => s.state.project !== null);
  const cli = useStore((s) => s.state.session.cli);
  const claudePath = useStore((s) => s.settings?.claudePath ?? "");
  const dismissed = useStore((s) => s.cliBannerDismissed);
  const pinError = useStore((s) => s.cliPinError);
  const canRestart = useStore((s) => s.state.session.canRestart && !isRunning(s.state) && !s.state.session.starting);
  const pin = useStore((s) => s.pinCliVersion);
  const restart = useStore((s) => s.restartSession);
  const dismiss = useStore((s) => s.dismissCliBanner);
  if (!hasProject) return null;
  const banner = cliBannerOf(cliInfoOf({ cli }), dismissed, pinnedVersionOf(claudePath));
  if (!banner) return null;
  return (
    <CliVersionBannerView
      banner={banner}
      pinError={pinError}
      canRestart={canRestart}
      onPin={(version) => void pin(version)}
      onRestart={() => void restart()}
      onDismiss={() => dismiss(banner.kind === "pinned" ? `pin:${banner.version}` : banner.version)}
    />
  );
}

/** The banner itself (props only, so it renders in tests). */
export function CliVersionBannerView(p: { banner: CliBanner; pinError: string | null; canRestart: boolean; onPin: (version: string) => void; onRestart: () => void; onDismiss: () => void }) {
  const b = p.banner;
  if (b.kind === "pinned") {
    return (
      <div className="banner blue cli-banner" role="status" data-testid="CLI pinned banner">
        <span className="glyph" aria-hidden="true">ⓘ</span>
        <span className="grow truncate">{t("Pinned {0} — it is used from the next session start", b.version)}</span>
        <button type="button" className="small primary" disabled={!p.canRestart} onClick={p.onRestart} title={p.canRestart ? t("Restarts the Claude session (the conversation is resumed); the review is not touched") : t("Wait for Claude to finish the turn")} data-testid="CLI pinned restart">
          {t("Restart now")}
        </button>
        <button type="button" className="plain small" onClick={p.onDismiss} aria-label={t("Dismiss")} title={t("Dismiss")}>✕</button>
      </div>
    );
  }
  const previous = b.previous?.path ? b.previous : null;
  return (
    <div className="banner orange cli-banner" role="status" data-testid="CLI version banner">
      <span className="glyph" aria-hidden="true">⚠</span>
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="bold truncate">{t("New CLI {0} — not verified yet", b.version)}</span>
        {b.range && <span className="caption truncate cli-banner-sub">{t("ReviewGate was checked with Claude Code {0} – {1}.", b.range.min, b.range.max)}</span>}
        {p.pinError && (
          <span className="caption cli-banner-error" role="alert" data-testid="CLI pin error">
            {t("Not used: {0}", p.pinError)}
          </span>
        )}
      </span>
      {previous && (
        <button type="button" className="small" onClick={() => p.onPin(previous.version)} title={t("Uses Claude Code {0} instead of the newest one (~/.local/share/claude/versions)", previous.version)} data-testid="CLI pin previous">
          {t("Pin previous version")}
        </button>
      )}
      <button type="button" className="plain small" onClick={p.onDismiss} aria-label={t("Dismiss")} title={t("Dismiss")} data-testid="CLI banner dismiss">✕</button>
    </div>
  );
}
