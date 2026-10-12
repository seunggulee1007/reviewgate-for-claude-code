/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the board's "코드 그래프" tab and the user's mods on Electron. The Mac's
 * rules (Core `CodeGraphText`, `CodeGraphStore`): freshness, why a build cannot run, the build's line, "N분 전", bar shares.
 * The tab's last `code_graph` reply lives in its own small store: a request's reply or one the engine emitted (a build's
 * progress and end reach every window of the engine as events).
 */
import { create } from "zustand";
import type { CodeGraphBuild, CodeGraphEvent, EngineEvent, UserMod } from "@reviewgate/engine";
import { t } from "./i18n";
import { formatElapsed } from "./elapsed";
import { engineRequest, refusalOf } from "./engineRequest";
import { updateReason } from "./sessionTools";

export type Freshness = { kind: "fresh" } | { kind: "behind"; commits: number } | { kind: "unknown" } | { kind: "noCommit" };

/** How far HEAD moved since the report's commit; null without a report. */
export function freshness(reply: CodeGraphEvent): Freshness | null {
  if (!reply.report) return null;
  if (!reply.report.commit) return { kind: "noCommit" };
  if (typeof reply.behind !== "number") return { kind: "unknown" };
  return reply.behind === 0 ? { kind: "fresh" } : { kind: "behind", commits: reply.behind };
}

export function freshnessLabel(f: Freshness): string {
  switch (f.kind) {
    case "fresh":
      return t("Up to date");
    case "behind":
      return t("{0} commits behind HEAD", f.commits);
    case "unknown":
      return t("Its commit is not in this repository");
    case "noCommit":
      return t("Built outside git");
  }
}

const NOT_IGNORED = "git does not ignore graphify-out/ — add graphify-out/ to .gitignore so a build never lands in a review";

/** Why [다시 빌드] / [만들기] cannot run now; null = it can. */
export function buildBlockedReason(reply: CodeGraphEvent | null, unsupported: boolean): string | null {
  if (unsupported) return updateReason();
  if (!reply) return t("Reading the code graph…");
  if (!reply.graphify) return t("graphify is not installed");
  if (reply.outIgnored === false) return t(NOT_IGNORED);
  if (reply.build?.running) return t("A build is running");
  return null;
}

export const installHint = (): string => t("Install it in Terminal: uv tool install graphifyy (or pipx install graphifyy)");
export const buildNote = (): string => t("Only code files go in (like Java) — it uses no tokens");

function parseDate(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The build's line: running with its elapsed time and graphify's latest line, else how the last one ended. */
export function buildLine(build: CodeGraphBuild, nowMs: number = Date.now()): string {
  const started = parseDate(build.startedAt);
  if (build.running) {
    const head = t("Building… {0}", started === null ? "" : formatElapsed((nowMs - started) / 1000));
    return [head, build.line].filter((s): s is string => !!s).join(" · ");
  }
  if (build.timedOut) return t("The build ran over 10 minutes and was stopped");
  const finished = parseDate(build.finishedAt);
  const took = started !== null && finished !== null ? formatElapsed((finished - started) / 1000) : null;
  const head = build.ok ? t("Last build succeeded") : t("Last build failed");
  return [head, took, build.line].filter((s): s is string => !!s).join(" · ");
}

/** "방금" / "3분 전" / "2시간 전" / "4일 전". */
export function ago(iso: string | null | undefined, nowMs: number = Date.now()): string | null {
  const at = parseDate(iso);
  if (at === null) return null;
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{0} min ago", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{0} h ago", hours);
  return t("{0} d ago", Math.floor(hours / 24));
}

/** A refusal of `code_graph` / `code_graph_build` in the user's words. */
export function graphRefusal(code: string, fallback: string): string {
  switch (code) {
    case "graphify_missing":
      return t("graphify is not installed");
    case "graph_build_running":
      return t("A build is running");
    case "graph_out_not_ignored":
      return t(NOT_IGNORED);
    case "no_project":
      return t("Open a project first");
    case "unknown_command":
      return updateReason();
    default:
      return fallback;
  }
}

/** A bar's share of the largest value (0…1; a value never shows as nothing). */
export function share(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(0.02, Math.min(1, value / max));
}

export function fileName(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** graph.html of a graphify-out folder (main checks again that it exists and is a file). */
export function looksLikeGraphHtml(path: string | null | undefined): path is string {
  if (!path || /[\0-\x1f]/.test(path)) return false;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) === "graph.html" && parts.at(-2) === "graphify-out" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}

/** The mod's state in words. */
export function modState(mod: UserMod): string {
  if (mod.loaded) return t("Loaded in this session");
  if (mod.source === "dev") return t("Loads only in the Claude Code session that made it");
  return t("Not loaded in this session");
}

export const modsNote = (): string => t("Mod panels do not show in the app — the board has the same information");

// ---------------------------------------------------------------- the tab's store

export type CodeGraphState = {
  reply: CodeGraphEvent | null;
  loading: boolean;
  /** The last request's refusal in the user's words. */
  error: string | null;
  /** The engine does not know `code_graph` (older engine). */
  unsupported: boolean;
};

type Bridge = Parameters<typeof engineRequest>[1];

export const useCodeGraph = create<CodeGraphState & {
  apply(reply: CodeGraphEvent): void;
  reset(): void;
  refresh(bridge?: Bridge): Promise<void>;
  build(bridge?: Bridge): Promise<void>;
}>((set, get) => {
  const fail = (e: unknown) => {
    const r = refusalOf(e);
    set({ error: graphRefusal(r.code, r.error), ...(r.code === "unknown_command" ? { unsupported: true } : {}) });
  };
  return {
    reply: null,
    loading: false,
    error: null,
    unsupported: false,
    apply(reply) {
      set((s) => ({ reply, error: reply.build && !reply.build.running ? null : s.error }));
    },
    reset() {
      set({ reply: null, loading: false, error: null, unsupported: false });
    },
    async refresh(bridge) {
      if (get().loading) return;
      set({ loading: true });
      try {
        get().apply(await engineRequest({ type: "code_graph" }, bridge));
        set({ error: null });
      } catch (e) {
        fail(e);
      } finally {
        set({ loading: false });
      }
    },
    async build(bridge) {
      set({ error: null });
      try {
        get().apply(await engineRequest({ type: "code_graph_build" }, bridge));
      } catch (e) {
        fail(e);
      }
    },
  };
});

/** The main store's event hook: `code_graph` events (replies and the build's progress / end) go to the tab's store. */
export function applyCodeGraphEvent(ev: EngineEvent): boolean {
  if (ev.type !== "code_graph") return false;
  useCodeGraph.getState().apply(ev);
  return true;
}
