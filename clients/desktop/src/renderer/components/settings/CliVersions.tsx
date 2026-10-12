/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.8 in Settings › General: "CLI 버전 고정" — the native installer's versions (`cli_versions`, newest
 * first) with verified / current / pinned, a pin per version (main builds and checks the path, `rg:pinClaudeVersion`) and
 * back to the newest (auto-detect). An engine before §36.8 shows the list off with the reason.
 */
import { useEffect } from "react";
import type { CliVersionsEvent } from "@reviewgate/engine";
import { t } from "../../i18n";
import { cliInfoOf, pinnedVersionOf, updateReason } from "../../sessionTools";
import { useStore } from "../../store";
import "../sessionTools.css";

export function CliVersionSection() {
  const versions = useStore((s) => s.cliVersions);
  const loading = useStore((s) => s.cliVersionsLoading);
  const error = useStore((s) => s.cliVersionsError);
  const supported = useStore((s) => s.cliVersionsSupported);
  const pinError = useStore((s) => s.cliPinError);
  const claudePath = useStore((s) => s.settings?.claudePath ?? "");
  const cli = useStore((s) => s.state.session.cli);
  const load = useStore((s) => s.loadCliVersions);
  const pin = useStore((s) => s.pinCliVersion);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <CliVersionView
      versions={versions}
      loading={loading}
      error={error ?? (pinError ? t("Not used: {0}", pinError) : null)}
      supported={supported}
      pinned={pinnedVersionOf(claudePath)}
      running={cliInfoOf({ cli })?.version ?? null}
      onPin={(v) => void pin(v)}
      onRefresh={() => void load()}
    />
  );
}

/** The section (props only, so it renders in tests). `pinned`: the version `claudePath` pins; `running`: the session's CLI. */
export function CliVersionView(p: { versions: CliVersionsEvent | null; loading: boolean; error: string | null; supported: boolean; pinned: string | null; running: string | null; onPin: (version: string | null) => void; onRefresh: () => void }) {
  const list = p.versions?.versions ?? [];
  const current = p.versions?.current ?? p.running;
  return (
    <section data-testid="CLI versions">
      <h4 className="row" style={{ gap: 6 }}>
        <span>{t("Pin CLI version")}</span>
        <span className="spacer" />
        {p.loading ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <button type="button" className="plain small" disabled={!p.supported} onClick={p.onRefresh} title={t("Refresh")} aria-label={t("Refresh")} data-testid="CLI versions refresh">
            ↻
          </button>
        )}
      </h4>
      {!p.supported ? (
        <div className="note" data-testid="CLI versions unavailable">⚠ {updateReason()}</div>
      ) : list.length === 0 ? (
        <div className="note">{p.loading ? "" : t("No versions of the native installer (~/.local/share/claude/versions).")}</div>
      ) : (
        <ul className="cli-versions" aria-label={t("Pin CLI version")}>
          {list.map((v) => {
            const isPinned = p.pinned === v.version;
            return (
              <li key={v.version} className="cli-version-row" data-testid={`CLI version ${v.version}`}>
                <span className="mono">{v.version}</span>
                <span className={`pill ${v.verified ? "green" : "orange"}`}>{v.verified ? t("verified") : t("not verified")}</span>
                {current === v.version && <span className="pill gray">{t("current")}</span>}
                {isPinned && <span className="pill">{t("pinned")}</span>}
                <span className="spacer" />
                <button type="button" className="small" disabled={isPinned} onClick={() => p.onPin(v.version)} title={v.path} aria-label={`${t("Pin")} ${v.version}`} data-testid={`CLI pin ${v.version}`}>
                  {t("Pin")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {p.pinned && (
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="small" onClick={() => p.onPin(null)} data-testid="CLI unpin">
            {t("Back to the newest (auto-detect)")}
          </button>
        </div>
      )}
      {p.error && <div className="caption cli-versions-error" role="alert">{p.error}</div>}
      <div className="note">{t("Pinning uses that version from the next session start. The native installer keeps its versions in ~/.local/share/claude/versions.")}</div>
    </section>
  );
}
