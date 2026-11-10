/**
 * Messages from the user's other Claude sessions (docs/PROTOCOL.md §29) — the pure part, unit-tested: who sent it (as
 * the sender claims), the card above the composer for what is held, the transcript row once a message was delivered or
 * dropped, the §29 fallback's "handle this message" send, and how `peer_accept` / `peer_dismiss` refusals read on the card.
 */
import type { GateState, PeerInboundMode, PeerMessage, SessionState } from "@reviewgate/engine";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

/** The sender as it names itself (`fromName`), else its socket's pid ("pid 4242"), else the raw address. */
export function peerSenderName(m: { from: string; fromName?: string | null }): string {
  const name = m.fromName?.trim();
  if (name) return name;
  const pid = /cc-socks[\\/](\d+)\.sock$/.exec(m.from)?.[1];
  if (pid) return t("pid {0}", pid);
  return m.from.replace(/^uds:/, "") || t("another session");
}

/**
 * MARK: r2-peers — the engine runs what waits by itself: mode `auto` (the default), every held message from a live session
 * of the user's registry (`sender`), no refusal said otherwise (`notice`). Then there is nothing to decide: one line instead
 * of the card.
 */
export function peerRunsByItself(session: Pick<SessionState, "peerInbound" | "peerInbox">, notice: string | null, hidden: readonly string[] = []): boolean {
  if (session.peerInbound !== "auto" || notice !== null) return false;
  const messages = visiblePeerInbox(session, hidden);
  return messages.length > 0 && messages.every((m) => m.state === "delivering" || (m.state === "held" && !!m.sender));
}

/** Who sent `messages`, each once, oldest first: the registry's name of the sending session when known, else `peerSenderName`. */
export function peerSenderNames(messages: readonly PeerMessage[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    const name = m.sender?.name?.trim() || peerSenderName(m);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The held / delivering messages the card shows (oldest first), minus the ones a `peer_none` reply hid. */
export function visiblePeerInbox(session: Pick<SessionState, "peerInbox">, hidden: readonly string[] = []): PeerMessage[] {
  return (session.peerInbox ?? []).filter((m) => (m.state === "held" || m.state === "delivering") && !hidden.includes(m.id));
}

export type PeerCardModel = {
  messages: PeerMessage[];
  /** What `peer_accept` / `peer_dismiss` must name: every held id the card shows (§29 `ids`). */
  heldIds: string[];
  /** Distinct senders, oldest first. */
  senders: string[];
  /** A `peer_accept` is running (`delivering`): spinner, buttons off. */
  delivering: boolean;
  /** Some message was held because the sender's permission mode differs (`cause: "mode-mismatch"`). */
  modeMismatch: boolean;
  /** Why "Claude가 처리" is off (null = it can be pressed). */
  acceptBlocked: string | null;
  /** Shown while a review is open: the result joins it. */
  joinsReview: boolean;
};

/**
 * The card for the held messages; null when nothing is waiting. `otherReason`: the composer's words for a closed gate
 * (`cannotSendReason`) — used when the gate is closed for something other than running work.
 */
export function peerCardModel(
  session: Pick<SessionState, "peerInbox" | "externalTurn">,
  gate: Pick<GateState, "canSend" | "phase" | "blockedReason">,
  hidden: readonly string[] = [],
  otherReason: string | null = null,
): PeerCardModel | null {
  const messages = visiblePeerInbox(session, hidden);
  if (messages.length === 0) return null;
  const senders: string[] = [];
  for (const m of messages) {
    const n = peerSenderName(m);
    if (!senders.includes(n)) senders.push(n);
  }
  const delivering = messages.some((m) => m.state === "delivering");
  return {
    messages,
    heldIds: messages.filter((m) => m.state === "held").map((m) => m.id),
    senders,
    delivering,
    modeMismatch: messages.some((m) => m.cause === "mode-mismatch"),
    acceptBlocked: gate.canSend ? null : peerAcceptBlocked(session, gate, otherReason),
    joinsReview: gate.canSend && gate.phase === "reviewing",
  };
}

const BUSY_REASONS: ReadonlySet<string> = new Set(["running", "awaiting_permission", "collecting", "starting", "reverting"]);

/** The tooltip of a disabled "Claude가 처리" (`!gate.canSend`): another session's turn, running work, else `otherReason`. */
export function peerAcceptBlocked(session: Pick<SessionState, "externalTurn">, gate: Pick<GateState, "phase" | "blockedReason">, otherReason: string | null = null): string {
  if (session.externalTurn) return t("You can handle it once the other work is done");
  if ((gate.blockedReason !== null && BUSY_REASONS.has(gate.blockedReason)) || BUSY_REASONS.has(gate.phase)) return t("You can handle it once the current work is done");
  return otherReason ?? t("You can handle it once the current work is done");
}

export type PeerRow = {
  kind: "peer";
  id: number;
  messageId: string;
  from: string;
  fromName: string | null;
  verifiedPeerPid: number | null;
  state: "delivered" | "dropped";
  outcome?: string;
  body?: string;
  turn?: number;
  unprompted?: true;
  /** The fallback row's "이 메시지 처리하기" was used (sent or queued). */
  handled?: true;
};

/** A delivered / dropped message (the `peer_message` event or a restored row) → the transcript row (other states → null). */
export function peerRowOf(
  m: { id: string; from: string; fromName?: string | null; verifiedPeerPid?: number | null; state: string; outcome?: string; body?: string; turn?: number; unprompted?: true },
  id: number,
): PeerRow | null {
  if (m.state !== "delivered" && m.state !== "dropped") return null;
  return {
    kind: "peer",
    id,
    messageId: m.id,
    from: m.from,
    fromName: m.fromName ?? null,
    verifiedPeerPid: typeof m.verifiedPeerPid === "number" ? m.verifiedPeerPid : null,
    state: m.state,
    ...(m.outcome ? { outcome: m.outcome } : {}),
    ...(typeof m.body === "string" ? { body: m.body } : {}),
    ...(typeof m.turn === "number" ? { turn: m.turn } : {}),
    ...(m.unprompted ? { unprompted: true as const } : {}),
  };
}

/** A dropped message in words, by `outcome` (refused / expired / discarded / the CLI's own word). */
export function droppedText(row: Pick<PeerRow, "from" | "fromName" | "outcome">): string {
  const name = peerSenderName(row);
  switch (row.outcome) {
    case "refused":
      return t("You declined the message from the {0} session", name);
    case "expired":
      return t("The message from the {0} session expired — ask that session to send it again", name);
    case "discarded":
      return t("The session ended, so the message from the {0} session was not delivered", name);
    default:
      return row.outcome ? t("The message from the {0} session was not delivered ({1})", name, row.outcome) : t("The message from the {0} session was not delivered", name);
  }
}

/** §29 fallback ("이 메시지 처리하기"): the body goes out as an ordinary message of the user's. */
export function unpromptedSendText(row: Pick<PeerRow, "from" | "fromName" | "body">): string {
  return `${t("Message from another session ({0}):", peerSenderName(row))}\n${row.body ?? ""}`;
}

/**
 * A refused `peer_accept` / `peer_dismiss` → what the card says (`peer_none` hides the card instead: null + `hide`).
 * `gate_closed:*` keeps the usual words.
 */
export function peerRefusalNotice(r: { code: string; error: string; detail: string; paths?: string[] }): { notice: string | null; hide: boolean } {
  if (r.code === "peer_none") return { notice: null, hide: true };
  return { notice: refusalMessage(r), hide: false };
}

/** The three §29 modes in the order the settings and the project menu list them. */
export const PEER_MODES: readonly PeerInboundMode[] = ["ask", "auto", "off"];

/** MARK: r2-peers — `auto` is the default now (an absent setting): the labels say which one is, in the Mac's words. */
export const DEFAULT_PEER_MODE: PeerInboundMode = "auto";

export function peerModeLabel(mode: PeerInboundMode): string {
  switch (mode) {
    case "ask":
      return t("Ask first");
    case "auto":
      return t("Handle on arrival (default)");
    case "off":
      return t("Don't accept");
  }
}
