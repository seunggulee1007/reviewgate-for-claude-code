/**
 * MARK: r2-review-flow — M27: a permission card's place in the transcript is one line — "허용함 · Bash git commit -m …" (the
 * reason's ⚠ kept), a click opens the whole card; while the card waits above the composer (`PermissionSlot`) the line says so
 * and a click brings the card into view. Five answered cards no longer push Claude's report out of a 637 px window, and an
 * open card is never pushed below the window's edge by the conversation.
 */
import { useState } from "react";
import type { ChatItem } from "../../store";
import { useStore } from "../../store";
import { t } from "../../i18n";
import { isPermissionPending, pendingPermissionsOf, reasonView } from "../../permissionQueue";
import { permissionLineHelp, permissionLineStatus, permissionLineText } from "../../permissionLine";
import { useViewing } from "../../viewedChat";
import { PermissionCard } from "./PermissionCard";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

const ICON = { waiting: "✋", allowed: "✓", denied: "✕", sent: "✓", notSent: "✕", handled: "✓" } as const;

export function PermissionLine({ item }: { item: PermissionItem }) {
  const id = item.request.requestId;
  const viewing = useViewing() !== null;
  const pending = useStore((s) => isPermissionPending(s.state, id));
  const open = pending && !viewing;
  const [expanded, setExpanded] = useState(false);
  const status = permissionLineStatus(item.request, item.allowed, open);
  const text = permissionLineText(item.request, item.allowed, open);
  const reason = reasonView(item.request.reason, item.request.file);
  const onClick = () => {
    if (!open) return setExpanded((v) => !v);
    const card = document.querySelector<HTMLElement>(`.permission-slot [data-permission-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card?.classList.add("flash");
    setTimeout(() => card?.classList.remove("flash"), 1600);
  };
  return (
    <div className="permission-line-wrap">
      <button
        type="button"
        className={`permission-line ${status}`}
        onClick={onClick}
        title={permissionLineHelp(status)}
        aria-expanded={open ? undefined : expanded}
        data-testid={open ? "Permission line waiting" : "Permission line decided"}
      >
        <span className="pl-icon" aria-hidden="true">{ICON[status]}</span>
        {reason && <span className={`pl-reason ${reason.tone}`} title={reason.text} aria-label={reason.text}>⚠</span>}
        <span className="truncate grow">{text}</span>
        <span className="pl-chev" aria-hidden="true">{open ? "↓" : expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && !open && <PermissionCard request={item.request} decision={item.allowed} />}
    </div>
  );
}

/** The open permission cards above the composer (as Claude's question, M08), oldest first; none while another chat is shown. */
export function PermissionSlot() {
  const viewing = useViewing() !== null;
  const open = useStore((s) => pendingPermissionsOf(s.state));
  const cards = viewing ? [] : open.filter((r) => r.toolName !== "AskUserQuestion");
  if (cards.length === 0) return null;
  return (
    <div className="permission-slot" role="group" aria-label={t("Waiting for your answer")} data-testid="Permission card slot">
      {cards.map((request) => (
        <PermissionCard key={request.requestId} request={request} decision={null} />
      ))}
    </div>
  );
}
