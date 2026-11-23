/**
 * docs/PROTOCOL.md §55.11: what this window's Claude session read when it started (`nextSessionStart`), kept from the
 * moment the app loads — Settings' "다음 세션부터 적용돼요 — [지금 재시작]" compares the settings now with it.
 */
import { create } from "zustand";
import { changedSince, nextSessionStart, sessionStartValues } from "./settingsIndex";
import { useStore } from "./store";

export const useSessionStart = create<{ start: Record<string, string> | null }>(() => ({ start: null }));

useStore.subscribe((s, prev) => {
  const current = useSessionStart.getState().start;
  const start = nextSessionStart(prev.state.session, s.state.session, s.settings, current);
  if (start !== current) useSessionStart.setState({ start });
});

/** The index ids of the settings changed since the session started — they apply once it restarts. */
export function useSettingsWaitingForRestart(): string[] {
  const settings = useStore((s) => s.settings);
  const start = useSessionStart((s) => s.start);
  return start && settings ? changedSince(start, sessionStartValues(settings)) : [];
}
