/**
 * r2-chats-cards M31 / M33 (§9 "Held switches"): runs `drainPendingSwitch` after every snapshot and queue change while the
 * chat tabs are on screen (ChatTabs mounts it), with the store's switches and queue. Kept apart from pendingSwitch.ts so
 * that one stays free of the store (storeSessions imports it).
 */
import { insertIntoComposer } from "./composerBridge";
import { drainPendingSwitch, onHeldMessageBack, usePendingSwitch } from "./pendingSwitch";
import { useStore } from "./store";
import { untilLive } from "./viewedChat";

export function startPendingSwitchDrain(): () => void {
  onHeldMessageBack((text, chips) => {
    insertIntoComposer(text, chips);
  });
  const drain = () =>
    void drainPendingSwitch({
      state: () => useStore.getState().state,
      queued: () => {
        const q = useStore.getState().queue;
        return q.items.length > 0 || q.inflight;
      },
      newChat: () => useStore.getState().newChat(),
      openChat: (id) => useStore.getState().openChat(id),
      untilLive: (id) => untilLive(id),
      enqueue: (text, extras) => useStore.getState().enqueueMessage(text, false, extras ?? {}),
      fail: (message) => useStore.setState({ lastError: message, errorBanner: { message, scope: "session", fatal: false } }),
    });
  const stopStore = useStore.subscribe((s, prev) => {
    if (s.state !== prev.state || s.queue !== prev.queue) drain();
  });
  const stopPending = usePendingSwitch.subscribe((s, prev) => {
    if (s.pending !== prev.pending && s.pending !== null) drain();
  });
  return () => {
    stopStore();
    stopPending();
  };
}
