/**
 * §27 `context_warning`: a slim, non-blocking banner above the composer — "컨텍스트 82% 사용 — 압축하면 이어서
 * 작업하기 편해요" with 압축… (the compact dialog with its focus field) and dismiss. Gone after a compact, a chat
 * switch or a rewind; the engine re-arms the warning once the context drops below 80 %.
 */
import { t } from "../../i18n";
import { useStore } from "../../store";

export function ContextWarningBanner() {
  const warning = useStore((s) => s.contextWarning);
  const dismiss = useStore((s) => s.dismissContextWarning);
  const openDialog = useStore((s) => s.openDialog);
  if (!warning) return null;
  const pct = Math.round(warning.percent);
  return (
    <div className={`context-banner ${pct >= 95 ? "critical" : ""}`} role="status" data-testid="Context warning">
      <span className="ctx-meter" aria-hidden="true">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="grow">{t("Context {0}% used — compacting makes it easier to keep going", pct)}</span>
      <button type="button" className="small" onClick={() => openDialog({ kind: "compact" })} data-testid="Context compact">
        {t("Compact…")}
      </button>
      <button type="button" className="plain tiny" onClick={dismiss} aria-label={t("Dismiss")} title={t("Dismiss")} data-testid="Context dismiss">
        ×
      </button>
    </div>
  );
}
