/**
 * MARK: polish p-foundation — P1-chrome-34: the chrome's icons as one small inline SVG set instead of Unicode characters
 * (↻ ✕ ☁ ⑂ ▼ ＋ － 📁 ⚠️), whose size, weight and baseline changed with every font (Segoe UI Symbol, colour emoji on
 * Windows) — the Mac draws SF Symbols. 16 px, the text colour, 1.5 px strokes; hidden from screen readers, so the
 * button keeps its own `aria-label` / `title`.
 *
 *   <button aria-label={t("Refresh")} title={t("Refresh")}><Icon name="refresh" /></button>
 */
import type { ReactElement } from "react";
import "./components/common/common.css";

export type IconName = "refresh" | "close" | "cloud" | "branch" | "chevronDown" | "folder" | "plus" | "minus" | "warning" | "copy" | "check";

const PATHS: Record<IconName, ReactElement> = {
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 3v2.5h-2.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  cloud: <path d="M4.75 12.5h6.5a2.75 2.75 0 0 0 .3-5.48 4 4 0 0 0-7.7.98A2.25 2.25 0 0 0 4.75 12.5z" />,
  branch: (
    <>
      <circle cx="5" cy="3.75" r="1.5" />
      <circle cx="5" cy="12.25" r="1.5" />
      <circle cx="11" cy="5.25" r="1.5" />
      <path d="M5 5.25v5.5M11 6.75c0 2.5-6 1.75-6 4" />
    </>
  ),
  chevronDown: <path d="M4.5 6.25 8 9.75l3.5-3.5" />,
  folder: <path d="M2.25 4.5c0-.69.56-1.25 1.25-1.25h2.9l1.4 1.5h4.7c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-9c-.69 0-1.25-.56-1.25-1.25z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  warning: (
    <>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.25v.01" />
    </>
  ),
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
      <path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25h-5.5c-.69 0-1.25.56-1.25 1.25v5.5c0 .69.56 1.25 1.25 1.25h1.75" />
    </>
  ),
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
};

/** One icon: `size` px square, drawn in the current text colour. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`rg-icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
