/**
 * Store slice (wave1 desktop-review, docs/PROTOCOL.md §31–32): the stale-review sheet (`gate.stale` → "정리 / 이어서
 * 리뷰"), `finish_review` / `keep_review`, the dismissed gate banners (src/renderer/reviewGate.ts `GateNoticeMemory`),
 * "무시 패턴에 추가" for unreadable files and the second confirm before outside changes are reverted. Spread into
 * `useStore` (store.ts); the members are declared in `Store` under "MARK: wave1 desktop-review".
 */
import type { StateCreator } from "zustand";
import type { ChangedFileState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import {
  addIgnorePatternLines,
  carryGateNotices,
  dismissConcurrent,
  dismissGateNotice,
  EMPTY_GATE_NOTICES,
  isExternalChange,
  staleSheetKey,
} from "./reviewGate";
import type { Store } from "./store";
// MARK: wave2 check-clients
import { t } from "./i18n";

/**
 * The outside changes a second confirm listed are still exactly what would be reverted: from "Reject all" (`all`) the
 * pending outside changes are that list (no new one slipped in meanwhile — `reject_all {includeExternal}` would revert
 * it unseen); for one file, it is still a pending outside change (not edited by Claude, accepted or gone since).
 * Uncaptured files are never reverted, so they are on neither side.
 */
export function externalListUnchanged(paths: readonly string[], all: boolean, files: readonly ChangedFileState[]): boolean {
  const pending = new Set(files.filter((f) => f.state === "pending" && isExternalChange(f) && f.uncaptured !== true).map((f) => f.path));
  if (!paths.every((p) => pending.has(p))) return false;
  return !all || pending.size === new Set(paths).size;
}

/** The dialogs this slice drives (members of `Dialog`). */
export type ReviewGateDialog =
  /** §31.2: "these may not be Claude's — revert them too?" before outside changes are reverted (`all`: from "Reject all"). */
  | { kind: "rejectExternal"; paths: string[]; all: boolean }
  /** §31.5: the restored review is stale — "정리" (`finish_review`) / "이어서 리뷰" (`keep_review`). */
  | { kind: "staleReview" }
  /** §31.5: "리뷰 끝내기" confirm. */
  | { kind: "finishReview" };

export type ReviewGateSlice = Pick<
  Store,
  "gateNotices" | "dismissGateNotice" | "dismissConcurrentClaude" | "finishReview" | "keepReview" | "ignoreSkippedFiles" | "revealExternalChanges" | "confirmRejectExternal" | "answerRejectExternal"
>;

export const createReviewGateSlice: StateCreator<Store, [], [], ReviewGateSlice> = (set, get, api) => {
  const log = (line: string) =>
    set((s) => {
      const logs = [...s.logs, line];
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      return { logs };
    });
  /** A refusal shown in the top banner (no transcript row), like the store's own `notice`. */
  const notice = (message: string, code?: string) => set({ lastError: message, errorBanner: { message, scope: "session", fatal: false, ...(code ? { code } : {}) } });

  /** The pending "revert outside changes too?" answer; a replaced / closed dialog counts as "keep them". */
  let externalResolver: ((revert: boolean) => void) | null = null;
  const takeResolver = () => {
    const r = externalResolver;
    externalResolver = null;
    return r;
  };

  const reviewCommand = async (cmd: { type: "finish_review" } | { type: "keep_review" }): Promise<string | null> => {
    if (!get().state.project) return "no_project";
    try {
      await engineRequest(cmd);
      await get().settle();
      return null;
    } catch (e) {
      const r = refusalOf(e);
      log(`[warn] ${cmd.type}: ${r.error}`);
      notice(refusalMessage(r), r.code);
      return r.error;
    }
  };

  /** The stale review whose sheet was already shown (project + save time): it opens once, as soon as no other dialog is up. */
  let staleShown: string | null = null;

  api.subscribe((st, prev) => {
    // §31.5: a stale review opens its sheet once; the sheet goes when the flag does (keep_review, finish_review, a new turn).
    const key = staleSheetKey(st.state);
    if (key === null) {
      if (st.dialog?.kind === "staleReview") set({ dialog: null });
    } else if (key !== staleShown && !st.dialog) {
      staleShown = key;
      set({ dialog: { kind: "staleReview" } });
    }
    if (st.state.gate !== prev.state.gate) {
      const notices = carryGateNotices(get().gateNotices, prev.state.gate, st.state.gate);
      if (notices !== get().gateNotices) set({ gateNotices: notices });
    }
    if (prev.dialog?.kind === "rejectExternal" && get().dialog?.kind !== "rejectExternal") takeResolver()?.(false);
  });

  return {
    gateNotices: EMPTY_GATE_NOTICES,

    dismissGateNotice(kind) {
      set((s) => ({ gateNotices: dismissGateNotice(s.gateNotices, kind, s.state.gate) }));
    },

    dismissConcurrentClaude() {
      set((s) => ({ gateNotices: dismissConcurrent(s.gateNotices, s.state.gate) }));
    },

    finishReview: () => reviewCommand({ type: "finish_review" }),
    keepReview: () => reviewCommand({ type: "keep_review" }),

    async ignoreSkippedFiles() {
      const skipped = get().state.gate.snapshotSkipped ?? [];
      if (skipped.length === 0) return;
      try {
        const settings = get().settings ?? (await get().loadSettings());
        const { text, added } = addIgnorePatternLines(settings.checkpointIgnorePatterns ?? "", skipped.map((s) => s.path));
        if (added.length > 0) {
          await get().saveSettings({ checkpointIgnorePatterns: text });
          log(`[info] ignore patterns += ${added.join(", ")}`);
        }
        get().dismissGateNotice("skipped");
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e));
      }
    },

    revealExternalChanges() {
      const f = get().state.changedFiles.find((x) => x.state === "pending" && isExternalChange(x)) ?? get().state.changedFiles.find((x) => isExternalChange(x));
      if (f) get().revealFile(f.path);
    },

    confirmRejectExternal(paths, all) {
      takeResolver()?.(false);
      return new Promise<boolean>((resolve) => {
        // wave2 check-clients (as the Mac's `confirmExternalReject`): only the list the user confirmed is reverted.
        externalResolver = (revert) => {
          if (revert && !externalListUnchanged(paths, all, get().state.changedFiles)) {
            notice(t("The files changed meanwhile, so nothing was reverted — check the list again"));
            return resolve(false);
          }
          resolve(revert);
        };
        set({ dialog: { kind: "rejectExternal", paths, all } });
      });
    },

    answerRejectExternal(revert) {
      const r = takeResolver();
      if (get().dialog?.kind === "rejectExternal") set({ dialog: null });
      r?.(revert);
    },
  };
};
