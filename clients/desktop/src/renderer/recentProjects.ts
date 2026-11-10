// MARK: wave4 w4-install — audit daily-17: the recent list as main sees it (src/main/recentProjects.ts): no temporary
// folders, a folder that is gone marked `exists: false` (dimmed, "Not found", never opened), each row removable.
import { useEffect, useState } from "react";
import type { RecentProjectEntry } from "../shared/ipc";
import { useStore } from "./store";

const EMPTY: string[] = [];

/** Re-read when the list changes and when the window comes back (a folder may have been deleted meanwhile). */
export function useRecentEntries(): RecentProjectEntry[] {
  const recents = useStore((s) => s.settings?.recentProjects) ?? EMPTY;
  const [entries, setEntries] = useState<RecentProjectEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.rg.recentProjects?.().then(
        (list) => {
          if (alive) setEntries(list);
        },
        () => undefined,
      );
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [recents]);
  // An older main without the call: every row as stored.
  return entries ?? recents.map((path) => ({ path, exists: true }));
}

/** One row (`path`) or, with null, every folder that is gone. */
export async function removeRecent(path: string | null): Promise<void> {
  if (!window.rg.removeRecentProject) return;
  await window.rg.removeRecentProject(path);
  await useStore.getState().loadSettings();
}
