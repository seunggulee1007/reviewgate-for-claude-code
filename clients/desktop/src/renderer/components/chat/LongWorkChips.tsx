/**
 * MARK: wave4 w4-longwork
 * docs/PROTOCOL.md §38.2 on screen (as on the Mac): [이어서 계속] on the tool-call limit's banner, "풀리면 이어서 하기" on the
 * usage limit's banner, and the HUD chip — "사용량 한도 — 오후 3:00에 풀려요" while a limit is on (a click turns the resume
 * on / off), else the five-hour / weekly use when the CLI reports it (orange from 80 %).
 */
import { useEffect, useState } from "react";
import { resetTimeText } from "../../errorCodes";
import { t } from "../../i18n";
import { activeLimitReset, isUsageLimited, limitChipText, usageMeter } from "../../longWork";
import { useStore } from "../../store";

/** Re-renders every 30 s, so a chip whose reset passed goes away by itself. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function ContinueWorkButton() {
  const continueWork = useStore((s) => s.continueWork);
  const dismissError = useStore((s) => s.dismissError);
  const open = useStore((s) => s.state.project !== null && s.state.session.open);
  return (
    <button
      type="button"
      className="small primary"
      disabled={!open}
      onClick={() => {
        continueWork();
        dismissError();
      }}
      title={t("Sends “continue” to this chat — queued while Claude is busy")}
      data-testid="Continue from banner"
    >
      {t("Continue the work")}
    </button>
  );
}

export function LimitResumeToggle() {
  const armed = useStore((s) => s.limitResume.armed);
  const canArm = useStore((s) => activeLimitReset(s.state.hud.rateLimits, s.limitResume.limitResetAt, Date.now()) !== null);
  const arm = useStore((s) => s.armLimitResume);
  const cancel = useStore((s) => s.cancelLimitResume);
  const disabled = !armed && !canArm;
  return (
    <label
      className="check small"
      style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
      title={disabled ? t("The reset time is not known, so it cannot continue by itself") : t("Sends “continue” once, a minute after the limit resets, when Claude is idle. Sending another message or quitting the app cancels it.")}
      data-testid="Continue when the limit resets"
    >
      <input type="checkbox" checked={armed} disabled={disabled} onChange={(e) => (e.target.checked ? arm() : cancel())} />
      {t("Continue when it resets")}
    </label>
  );
}

export function UsageLimitChip() {
  const now = useNow();
  const windows = useStore((s) => s.state.hud.rateLimits);
  const lastReset = useStore((s) => s.limitResume.limitResetAt);
  const armed = useStore((s) => s.limitResume.armed);
  const arm = useStore((s) => s.armLimitResume);
  const cancel = useStore((s) => s.cancelLimitResume);
  if (isUsageLimited(windows, lastReset, now)) {
    const reset = activeLimitReset(windows, lastReset, now);
    const label = limitChipText(reset !== null ? resetTimeText(new Date(reset).toISOString()) : null, armed);
    return (
      <button
        type="button"
        className="pill orange"
        disabled={!armed && reset === null}
        onClick={() => (armed ? cancel() : arm())}
        title={armed ? t("Cancel auto-continue") : `${t("Continue when it resets")} — ${t("Sends “continue” once, a minute after the limit resets, when Claude is idle. Sending another message or quitting the app cancels it.")}`}
        aria-pressed={armed}
        data-testid="HUD usage limit"
      >
        <span aria-hidden="true">{armed ? "↻" : "⏳"}</span> {label}
      </button>
    );
  }
  const meter = usageMeter(windows);
  if (!meter) return null;
  return (
    <span className={`item num ${meter.high ? "usage-high" : ""}`} style={meter.high ? { color: "var(--orange)" } : undefined} title={t("Claude subscription use: the five-hour and weekly limits")} data-testid="HUD usage meter">
      {meter.text}
    </span>
  );
}
