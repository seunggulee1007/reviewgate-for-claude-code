/**
 * Store slice for messages from the user's other Claude sessions (docs/PROTOCOL.md §29): the card's answers
 * (`peer_accept` / `peer_dismiss` with every held id the card shows), the project's mode (`peer_set`), the transcript rows
 * of delivered / dropped messages, and the fallback row's "이 메시지 처리하기" (an ordinary send). The held messages
 * themselves are `state.session.peerInbox`. Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { PeerInboundMode, PeerMessage, PermissionRequest } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { peerCardModel, peerRefusalNotice, peerRowOf, unpromptedSendText } from "./peer";
import { agentBundle, bundles, pendingPermissionsOf, permissionBundle } from "./permissionQueue";
import { showToast } from "./toast";
import type { Store } from "./store";

/** Refusals that come with their own `error` event (banner + row): the card does not repeat them. */
const ANNOUNCED = new Set(["peer_release_failed", "lfs_missing"]);

export type PeerSlice = {
  /** Why the card's last answer did not go through (`peer_inbox_changed`, `gate_closed:*`, …); null = nothing to say. */
  peerNotice: string | null;
  /** A `peer_accept` / `peer_dismiss` is waiting for its reply (the card's buttons are off). */
  peerBusy: "accept" | "dismiss" | null;
  /** Held ids a `peer_none` reply showed are gone (hidden until the next snapshot drops them). */
  peerHidden: string[];

  /** A `peer_message` event: a delivered / dropped message becomes a transcript row; a new held one clears the card's notice. */
  applyPeerMessage(m: PeerMessage): void;
  /** Another project in this window: nothing of the card carries over. */
  resetPeer(): void;
  /** [Claude가 처리] → `peer_accept {ids}` → null, or the refusal text. */
  acceptPeers(): Promise<string | null>;
  /** [거절] → `peer_dismiss {ids}` → null, or the refusal text. */
  dismissPeers(): Promise<string | null>;
  /** This project's §29 mode (`peer_set`) → null, or the refusal text. */
  setPeerMode(mode: PeerInboundMode): Promise<string | null>;
  /** §29 fallback row ("이 메시지 처리하기"): its body goes out as an ordinary message — queued while the gate is closed. */
  handleUnpromptedPeer(rowId: number): void;

  // MARK: r2-peers — M26: parallel subagents' cards answered at once (each still its own permission_response)
  /** Subagents (`agent.agentId`) whose requests "이 에이전트의 요청은 이번 턴 동안 허용" answers as they come; emptied at turn end. */
  turnAllowedAgents: string[];
  /** "대기 중 N개 모두 허용": allows every open request that may go together (`permissionBundle`). */
  allowWaitingPermissions(): void;
  /** "이 에이전트의 요청은 이번 턴 동안 허용": the agent's open requests now, and the ones it raises until the turn ends. */
  allowAgentForTurn(agentId: string): void;
  /** A `permission_request` of an agent allowed for the turn is answered at once (true); anything else waits for its card. */
  answerIfAgentAllowed(request: PermissionRequest): boolean;
  /** The turn ended: "이번 턴 동안" is over. */
  endTurnAllowances(): void;
};

export const createPeerSlice: StateCreator<Store, [], [], PeerSlice> = (set, get) => {
  const answer = async (type: "peer_accept" | "peer_dismiss"): Promise<string | null> => {
    const s = get();
    const card = peerCardModel(s.state.session, s.state.gate, s.peerHidden);
    if (!card || card.heldIds.length === 0) return "peer_none";
    if (s.peerBusy) return "peer_busy";
    set({ peerBusy: type === "peer_accept" ? "accept" : "dismiss", peerNotice: null });
    try {
      await engineRequest({ type, ids: card.heldIds });
      set({ peerBusy: null });
      await get().settle();
      return null;
    } catch (e) {
      const r = refusalOf(e);
      const { notice, hide } = peerRefusalNotice(r);
      set({ peerBusy: null, peerNotice: ANNOUNCED.has(r.code) ? null : notice, ...(hide ? { peerHidden: card.heldIds } : {}) });
      return r.error;
    }
  };

  return {
    peerNotice: null,
    peerBusy: null,
    peerHidden: [],
    turnAllowedAgents: [],

    applyPeerMessage(m) {
      if (m.state === "held") {
        if (get().peerNotice && get().peerBusy === null) set({ peerNotice: null });
        return;
      }
      if (m.state !== "delivered" && m.state !== "dropped") return;
      // The engine may say it twice (a reconnect): one row per message and state.
      if (get().transcript.some((i) => i.kind === "peer" && i.messageId === m.id && i.state === m.state)) return;
      const row = peerRowOf(m, nextPeerRowId());
      if (!row) return;
      set((s) => ({ transcript: [...finishStreamingRows(s.transcript), row] }));
    },

    resetPeer() {
      set({ peerNotice: null, peerBusy: null, peerHidden: [], turnAllowedAgents: [] });
    },

    acceptPeers: () => answer("peer_accept"),
    dismissPeers: () => answer("peer_dismiss"),

    async setPeerMode(mode) {
      if (!get().state.project) return "no_project";
      try {
        await engineRequest({ type: "peer_set", mode });
        await get().settle();
        return null;
      } catch (e) {
        const words = refusalMessage(refusalOf(e));
        showToast(words);
        return words;
      }
    },

    allowWaitingPermissions() {
      for (const p of permissionBundle(pendingPermissionsOf(get().state))) get().respondPermission(p.requestId, true);
    },

    allowAgentForTurn(agentId) {
      if (!get().turnAllowedAgents.includes(agentId)) set((s) => ({ turnAllowedAgents: [...s.turnAllowedAgents, agentId] }));
      for (const p of agentBundle(pendingPermissionsOf(get().state), agentId)) get().respondPermission(p.requestId, true);
    },

    answerIfAgentAllowed(request) {
      const agentId = request.agent?.agentId;
      if (!agentId || !get().turnAllowedAgents.includes(agentId) || !bundles(request)) return false;
      get().respondPermission(request.requestId, true);
      return true;
    },

    endTurnAllowances() {
      if (get().turnAllowedAgents.length > 0) set({ turnAllowedAgents: [] });
    },

    handleUnpromptedPeer(rowId) {
      const row = get().transcript.find((i) => i.kind === "peer" && i.id === rowId);
      if (!row || row.kind !== "peer" || !row.unprompted || row.handled || !row.body) return;
      const text = unpromptedSendText(row);
      set((s) => ({ transcript: s.transcript.map((i) => (i.kind === "peer" && i.id === rowId ? { ...i, handled: true as const } : i)) }));
      if (get().state.gate.canSend) get().send(text);
      else get().enqueueMessage(text);
    },
  };
};

/** Row ids of peer rows: negative, so they never meet the store's own counter. */
let peerRowSeq = -1;
const nextPeerRowId = () => peerRowSeq--;

/** A streaming assistant message ends where a peer row starts (same rule as the store's `finishStreaming`). */
function finishStreamingRows(items: Store["transcript"]): Store["transcript"] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }];
  return items;
}
