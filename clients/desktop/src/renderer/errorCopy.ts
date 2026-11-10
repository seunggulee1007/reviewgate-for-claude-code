/**
 * r2-chats-cards — polish P1-chrome-29, as on the Mac (SessionErrorBanner.swift `copyText`, `scopeHelp`): what "오류 복사" puts
 * on the clipboard for a bug report, and what the banner's scope chip means.
 */
import { t } from "./i18n";

/** polish P1-chrome-29: what "오류 복사" puts on the clipboard — the message, the CLI's words, the code. */
export function errorCopyText(message: string, detail?: string | null, code?: string | null, repeat?: string | null): string {
  return [message + (repeat ? ` ${repeat}` : ""), detail && detail !== message ? detail : null, code ? `code: ${code}` : null].filter(Boolean).join("\n");
}

/** polish P1-chrome-29: the scope chip's meaning (the Mac's words). */
export function scopeHelp(scope: string): string {
  switch (scope) {
    case "engine":
      return t("The app's engine");
    case "session":
      return t("The Claude Code session");
    case "git":
      return t("A git command");
    case "pr":
      return t("GitHub (gh)");
    default:
      return t("The app");
  }
}
