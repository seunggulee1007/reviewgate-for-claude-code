/**
 * Which engine events deserve an OS notification while the window is in the background (pure, unit-tested):
 * a finished turn ("N file(s) awaiting review"), a permission request, a proposed plan, a question card, a message
 * another Claude session sent (§29, held for the user) and the errors that need the user to act. Main shows it only
 * when the window is not focused (src/main/notify.ts).
 */
import type { EngineEvent } from "@reviewgate/engine";
import type { NotifyRequest, NotifyTarget } from "../shared/ipc";
import { errorEventText, presentationOf } from "./errorCodes";
import { t } from "./i18n";
import { peerSenderName } from "./peer";
import { turnDoneBody } from "./reviewGate";
import type { TurnStop } from "./workSafety"; // MARK: wave4 w4-safety

/**
 * Error codes that wait for the user even when not fatal. `lfs_missing` (§32) stands in for `send_failed` /
 * `collect_failed` when git-lfs is missing; `unprompted_blocked` is not one of them — §29's fallback only informs.
 */
const ACTION_CODES = new Set(["usage_limit", "collect_failed", "send_failed", "revert_failed", "commit_failed", "extensions_init_timeout", "lfs_missing"]);

const firstLine = (s: string, max = 160): string => {
  const line = s.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

/** True for an `error` event the user has to do something about (never a notice: §30 / §33.4 / §29, M4). */
export function needsAction(ev: { fatal: boolean; code?: string }): boolean {
  const p = presentationOf(ev.code);
  if (p === "retrying" || p === "startSlow" || p === "info" || p === "warning") return false;
  return ev.fatal || p === "auth" || p === "fatalSession" || p === "planFailed" || (ev.code !== undefined && ACTION_CODES.has(ev.code));
}

/** `peerInbound`: the effective §29 mode — `auto` runs held messages from a live session of the user's by itself, so their arrival needs no one. */
export function notificationFor(
  ev: EngineEvent,
  // MARK: wave4 w4-safety — daily-14: `stop` (why the turn stopped) goes on its turn_end; `suppress`: posted elsewhere.
  // MARK: wave4b w4-notify — `chatId`: the chat a click opens (`state.sessions.currentId`).
  ctx: { project: string | null; peerInbound?: string; stop?: TurnStop | null; suppress?: boolean; chatId?: string | null },
): NotifyRequest | null {
  if (ctx.suppress) return null;
  const title = ctx.project ? `ReviewGate — ${ctx.project}` : "ReviewGate";
  // MARK: wave4b w4-notify — §39.6: the Mac's headline and detail as one line ("허용이 필요해요 — Bash: git status"); a click
  // opens the chat and the card / summary (`target`).
  const withTarget = (n: NotifyRequest, requestId?: string): NotifyRequest => {
    const target: NotifyTarget = { ...(ctx.chatId ? { chatId: ctx.chatId } : {}), ...(requestId ? { requestId } : {}) };
    return Object.keys(target).length > 0 ? { ...n, target } : n;
  };
  switch (ev.type) {
    case "turn_end": {
      // §31: files changed outside the app are counted apart (the badge rule: pending − external).
      const done = turnDoneBody(ev);
      const headline = ev.stopReason === "interrupted" ? t("The turn was stopped") : t("Work finished");
      // daily-14: a stop reason replaces the headline; with nothing to review it says it alone.
      const body = ctx.stop ? (ev.files > 0 ? `${ctx.stop.text} — ${done}` : ctx.stop.text) : `${headline} — ${done}`;
      return withTarget({ kind: "turn_done", title, body, key: `turn:${ev.usage.durationMs}:${ev.files}:${ev.added}:${ev.deleted}` });
    }
    case "permission_request": {
      if (ev.toolName === "AskUserQuestion") {
        const qs = Array.isArray(ev.input["questions"]) ? (ev.input["questions"] as { question?: unknown }[]) : [];
        const q = typeof qs[0]?.question === "string" ? (qs[0].question as string) : "";
        const asked = t("Claude asked a question");
        return withTarget({ kind: "question", title, body: q ? `${asked} — ${firstLine(q)}` : asked, key: `perm:${ev.requestId}` }, ev.requestId);
      }
      if (ev.toolName === "SendMessage") {
        // §33.2: a message to another Claude session — say so instead of the bare tool name.
        const to = typeof ev.input["to"] === "string" ? firstLine(ev.input["to"] as string, 80) : "";
        return withTarget(
          { kind: "permission", title, body: to ? t("Claude wants to send a message to another session: {0}", to) : t("Claude wants to send a message to another session"), key: `perm:${ev.requestId}` },
          ev.requestId,
        );
      }
      const raw = typeof ev.input["command"] === "string" ? (ev.input["command"] as string) : (ev.file ?? (typeof ev.input["url"] === "string" ? (ev.input["url"] as string) : ""));
      const detail = firstLine(raw, 120);
      const what = detail ? `${ev.toolName}: ${detail}` : ev.toolName;
      const agent = firstLine(ev.agent?.subagentType ?? ev.agent?.description ?? "", 60);
      const body = agent ? `${t("Permission needed — {0} agent", agent)} · ${what}` : `${t("Permission needed")} — ${what}`;
      return withTarget({ kind: "permission", title, body, key: `perm:${ev.requestId}` }, ev.requestId);
    }
    case "plan_proposed":
      return withTarget({ kind: "plan", title, body: `${t("Approve the plan")} — ${firstLine(ev.plan) || t("(untitled)")}`, key: `plan:${ev.path ?? ""}:${ev.plan.length}` });
    case "peer_message":
      // §29: only the arrival of a held message waits for the user; `auto` takes one from a live session of the user's
      // (`sender`) by itself — r2-peers: one the registry does not vouch for still waits, so it is announced.
      if (ev.message.state !== "held" || (ctx.peerInbound === "auto" && ev.message.sender)) return null;
      return { kind: "peer_message", title, body: t("{0} session sent a message", peerSenderName(ev.message)), key: `peer:${ev.message.id}` };
    case "error":
      if (!needsAction(ev)) return null;
      return { kind: "error", title, body: firstLine(errorEventText(ev), 300) || ev.message.slice(0, 300), key: `error:${ev.code ?? ev.message.slice(0, 80)}` };
    default:
      return null;
  }
}
