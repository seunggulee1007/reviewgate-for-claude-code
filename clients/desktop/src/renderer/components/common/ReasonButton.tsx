/**
 * MARK: polish p-foundation — P5-sheets-02: a button that is off for a reason says it. While `reason` is set it is dimmed
 * and `aria-disabled` — still focusable and hoverable, so its tooltip (the reason) shows and a screen reader reads it — and
 * a click shows the reason in the window's toast instead of acting. (The pattern of "터미널에서 이어가기".)
 *
 *   <ReasonButton reason={blocker} onClick={write} title={t("Write the message with Claude")}>{t("Claude로 작성")}</ReasonButton>
 *
 * `disabled` stays for a button that has nothing to say (no project at all).
 */
import type { ButtonHTMLAttributes } from "react";
import { showToast } from "../../toast";
import "./common.css";

export function ReasonButton({ reason, onClick, title, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { reason: string | null | undefined }) {
  const off = typeof reason === "string" && reason.length > 0;
  return (
    <button
      type="button"
      {...rest}
      className={`rg-reason ${className ?? ""}`}
      aria-disabled={off || undefined}
      title={off ? reason : title}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          showToast(reason);
          return;
        }
        onClick?.(e);
      }}
    />
  );
}
