/**
 * MARK: r2-review-flow — M27: an open permission card sits above the composer; in the transcript every card is one line (the Mac's Core
 * ReviewFlow+PermissionLine.swift).
 */
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "./i18n";
import { callTitle } from "./agentGlance";

// ---------------------------------------------------------------- M27 a permission card in the transcript is one line

export type PermissionLineStatus = "waiting" | "allowed" | "denied" | "sent" | "notSent" | "handled";

export function permissionLineStatus(request: Pick<PermissionRequest, "toolName">, decision: boolean | null, isOpen: boolean): PermissionLineStatus {
  const send = request.toolName === "SendMessage";
  if (decision === true) return send ? "sent" : "allowed";
  if (decision === false) return send ? "notSent" : "denied";
  return isOpen ? "waiting" : "handled";
}

/** What the call is, on one line: the command's first line (Bash), the file (edit tools), else the readable call name. */
export function permissionCall(request: Pick<PermissionRequest, "toolName" | "input" | "file">): string {
  const command = typeof request.input["command"] === "string" ? (request.input["command"] as string).trim() : "";
  if (command.length > 0) {
    const [first = command] = command.split(/\r?\n/);
    return `${request.toolName} ${first}${/\r?\n/.test(command) ? " …" : ""}`;
  }
  if (request.file) return `${request.toolName} ${request.file}`;
  return callTitle(request.toolName, request.input);
}

/** "허용함 · Bash git commit -m …". */
export function permissionLineText(request: Pick<PermissionRequest, "toolName" | "input" | "file">, decision: boolean | null, isOpen: boolean): string {
  const call = permissionCall(request);
  switch (permissionLineStatus(request, decision, isOpen)) {
    case "waiting":
      return t("Waiting for your answer below · {0}", call);
    case "allowed":
      return t("Allowed · {0}", call);
    case "denied":
      return t("Denied · {0}", call);
    case "sent":
      return t("Sent · {0}", call);
    case "notSent":
      return t("Not sent · {0}", call);
    case "handled":
      return t("Handled · {0}", call);
  }
}

export function permissionLineHelp(status: PermissionLineStatus): string {
  return status === "waiting" ? t("The card waits above the message box — click to bring it into view") : t("Click to show the whole card");
}
