/**
 * MARK: polish p-foundation — P3-transcript-11 / P1-chrome-13: copy with a confirmation, one way everywhere.
 *
 *   <CopyButton text={item.text} title={t("Copy the message")} />            // "복사" → "복사됨" for 1.4 s
 *   <CopyButton text={() => output} iconOnly title={t("Copy Output")} />   // a copy icon → a check
 *   void copyWithToast(path);                                             // menus: "복사됨: <path>" in the toast
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Icon } from "../../icons";
import { middleTruncate, showToast } from "../../toast";
import "./common.css";

/** A copied value shown in "복사됨: …" is cut in the middle past this many characters. */
export const COPIED_SHOWN_LIMIT = 80;
/** How long a copy button says "복사됨". */
export const COPIED_MS = 1400;

/** "복사됨: <text>" for one line (middle-cut past 80 characters), "복사됨" for more. */
export function copiedText(text: string): string {
  const line = text.trim();
  if (!line || /[\r\n]/.test(line)) return t("Copied");
  return t("Copied: {0}", middleTruncate(line, COPIED_SHOWN_LIMIT));
}

/** Copies `text` and confirms in the window's toast — `toast` when given, else `copiedText(text)`. */
export async function copyWithToast(text: string, toast?: string): Promise<void> {
  await window.rg.copyText(text);
  showToast(toast ?? copiedText(text));
}

export function CopyButton(props: {
  /** What to copy — a function is read at the click. */
  text: string | (() => string);
  /** The tooltip (default "복사"). */
  title?: string;
  /** A copy icon (a check once copied) instead of the words "복사" / "복사됨". */
  iconOnly?: boolean;
  className?: string;
  testId?: string;
  /** Also confirm in the toast (its words, or `copiedText`). */
  toast?: boolean | string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const label = copied ? t("Copied") : t("Copy");
  return (
    <button
      type="button"
      className={props.className ?? "msg-action"}
      onClick={(e) => {
        e.stopPropagation();
        const text = typeof props.text === "function" ? props.text() : props.text;
        void window.rg.copyText(text).then(() => {
          if (props.toast) showToast(typeof props.toast === "string" ? props.toast : copiedText(text));
        });
        setCopied(true);
      }}
      title={props.title ?? t("Copy")}
      aria-label={props.iconOnly ? (props.title ?? label) : undefined}
      data-testid={props.testId}
    >
      {props.iconOnly ? <Icon name={copied ? "check" : "copy"} size={14} /> : label}
    </button>
  );
}
