/**
 * wave4 w4-input (polish-14): an elapsed time in the UI language — "0.9s · 12s · 4m 05s · 1h 02m" in English as before,
 * "0.9초 · 12초 · 4분 5초 · 1시간 2분" in Korean (the Mac's ElapsedFormat). Under a minute it shows tenths below 10 s,
 * or always with `tenths` (the HUD's turn time).
 */
import { currentLanguage } from "./i18n";

/**
 * A clock that ticks once a second (the running `!` command's row, §67.3): whole seconds from the start ("8s"), never a
 * tenth that only changes with the tick ("8.3s", "9.3s" …); a minute and more as `formatElapsed` (the Mac's
 * `ElapsedFormat.ticking`).
 */
export function formatTicking(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s >= 60) return formatElapsed(s);
  return `${Math.floor(s)}${currentLanguage() === "ko" ? "초" : "s"}`;
}

export function formatElapsed(seconds: number, opts: { tenths?: boolean } = {}): string {
  const s = Math.max(0, seconds);
  const ko = currentLanguage() === "ko";
  if (s < 60) return `${s.toFixed(opts.tenths || s < 10 ? 1 : 0)}${ko ? "초" : "s"}`;
  const whole = Math.floor(s);
  const m = Math.floor(whole / 60);
  if (m < 60) return ko ? `${m}분 ${whole % 60}초` : `${m}m ${String(whole % 60).padStart(2, "0")}s`;
  return ko ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
