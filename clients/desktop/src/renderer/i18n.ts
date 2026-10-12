/**
 * Tiny i18n: `t("English key", ...args)` — the English strings the Mac app uses are the keys;
 * `ko.json` is generated from App/Localizable.xcstrings (scripts/gen-i18n.mjs). `{0}`, `{1}` … are
 * substituted; on non-mac platforms ⌘ shortcuts in the strings are rewritten as Ctrl ones.
 */
import ko from "./i18n/ko.json";

const dicts: Record<string, Record<string, string>> = { ko };
let lang = "en";
let mac = false;

export function initI18n(locale: string, platform: string): void {
  lang = locale.toLowerCase().startsWith("ko") ? "ko" : "en";
  mac = platform === "darwin";
}

export function currentLanguage(): string {
  return lang;
}

const KEY_MAP: [RegExp, string][] = [
  [/⌥⌘↩/g, "Ctrl+Alt+Enter"],
  [/⌘⇧↩/g, "Ctrl+Shift+Enter"],
  [/⌥⌘\//g, "Ctrl+Alt+/"], // wave4 w4-input (polish-05): the side question
  [/⌥⌘([A-Z])/g, "Ctrl+Alt+$1"], // wave4 w4-input (polish-06): ⌥⌘N, a note on the selected line
  [/⌘⇧\//g, "Ctrl+Shift+/"], // MARK: wave4d w4d-windows (polish-07)
  [/⌘⇧([A-Z])/g, "Ctrl+Shift+$1"],
  [/⌘↩/g, "Ctrl+Enter"],
  [/⇧↩/g, "Shift+Enter"],
  [/⌘\//g, "Ctrl+/"],
  [/⌘,/g, "Ctrl+,"],
  [/⌘([A-Z.\[\]])/g, "Ctrl+$1"],
  [/⌘([1-9])/g, "Ctrl+$1"], // wave4 w4-input (polish-06): ⌘1…⌘9, the chat tabs
  [/⌥-/g, "Alt-"],
  // wave3 check-clients: ⌫ is a Mac glyph — "⌘⌫ …" and a built "Ctrl+⌫" hint read Backspace on Windows / Linux.
  [/⌘⌫/g, "Ctrl+Backspace"],
  [/⌫/g, "Backspace"],
];

export function t(key: string, ...args: (string | number)[]): string {
  let s = (lang !== "en" && dicts[lang]?.[key]) || key;
  if (args.length > 0) s = s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
  if (!mac) for (const [re, rep] of KEY_MAP) s = s.replace(re, rep);
  return s;
}

/** Relative time ("3 hours ago") in the UI language. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = (then - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang === "ko" ? "ko" : "en", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return rtf.format(Math.round(diff / (86400 * 30)), "month");
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "ko" ? "ko" : "en", { dateStyle: "medium", timeStyle: "short" }).format(d);
}
