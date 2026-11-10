/**
 * MARK: r2-peers — docs/PROTOCOL.md §33.2 / §42.2: whom a SendMessage reaches, as far as this session can tell, and when
 * that needs no card. Pure; the session supplies the lookups (its own subagents, the user's session registry).
 */
import type { PeerSessionInfo } from "../protocol.js";

/**
 * Whom a SendMessage's `to` reaches: a subagent this session started (§36.3: the message continues it), or a live session
 * of the user's own registry (§42.2: the address names its socket and its pid is alive). Null for anything else — a bare
 * name (a teammate, a session on another machine the CLI would route through Anthropic's servers), an address no live
 * session lists, a lookup that failed or took too long: an unverified recipient, which keeps the card.
 */
export type SendTarget = { kind: "agent"; agentId: string } | { kind: "session"; session: PeerSessionInfo } | null;

/** The recipient a SendMessage input names (`to`, trimmed); null when it names none. */
export function sendRecipient(input: Record<string, unknown>): string | null {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  return to ? to : null;
}

/** The `remember` key prefix of a SendMessage to one session ("이 세션으로 보내는 메시지는 세션 동안 허용"). */
export const SEND_MESSAGE_KEY_PREFIX = "SendMessage:";

/**
 * The key "이 세션으로 보내는 메시지는 세션 동안 허용" stores for a live session of the user's (`PeerSessionInfo.sessionId`,
 * the conversation its registry entry names): `SendMessage:<session id>`. Null without an id — then nothing can be
 * remembered, and a key never covers a message to another conversation (a new one after `/clear`, another process).
 */
export function sendMessageKey(session: Pick<PeerSessionInfo, "sessionId"> | null | undefined): string | null {
  const id = session?.sessionId?.trim();
  return id ? `${SEND_MESSAGE_KEY_PREFIX}${id}` : null;
}

/** Whether `remembered` holds a key for a message to some session (a SendMessage then needs the recipient's lookup). */
export function remembersSessions(remembered: ReadonlySet<string> | undefined): boolean {
  if (!remembered) return false;
  for (const k of remembered) if (k.startsWith(SEND_MESSAGE_KEY_PREFIX) && k !== "SendMessage:SendMessage") return true;
  return false;
}
