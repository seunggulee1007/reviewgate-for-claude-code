/**
 * MARK: wave2 desktop-diff — "왜" with its source (docs/PROTOCOL.md §34.8, audit comp-01 / agents-03) and the turn's test
 * verdict (§34.9, comp-09), as pure helpers (fileWhy.test.ts):
 * - `readFileWhy`: a lenient `FileWhy` (unknown sources show their text plainly, junk is absent). The display order is the
 *   engine's: reported ("Claude 보고") > same_message > earlier (dimmed "앞선 설명: …") > none ("원인 기록 없음"); a
 *   subagent's own text carries its agent, the main agent's delegation sentence is kept apart ("위임 이유: …").
 * - `summaryWhy`: a turn_summary file's why — `whyDetail`, else an engine before §34's plain `why` ("legacy": shown as it
 *   always was).
 * - `planCardWhy`: a sentence two or more files of a summary card share is shown once at the card's top, numbered; the
 *   files refer to its number (59 % of the files of a 3+-file turn shared one in the user's sessions).
 * - `testVerdict`: "테스트 통과 · 마지막 편집 뒤 실행" / "테스트 실패" / "편집 뒤 테스트 없음" from `lastTest`.
 */
import type { RationaleSource, TurnSummaryFile } from "@reviewgate/engine";
import { t } from "./i18n";

/** §34.8 on a tool row: where its `rationale` came from and how many of the agent's calls ago (absent before §34). */
export type RationaleMeta = { rationaleSource?: RationaleSource; rationaleAge?: number };

/** The `tool_use` (event or transcript row) fields a tool row keeps — known values only. */
export function rationaleMetaOf(ev: { rationaleSource?: unknown; rationaleAge?: unknown }): RationaleMeta {
  const out: RationaleMeta = {};
  if (ev.rationaleSource === "same_message" || ev.rationaleSource === "earlier") out.rationaleSource = ev.rationaleSource;
  if (typeof ev.rationaleAge === "number" && Number.isFinite(ev.rationaleAge) && ev.rationaleAge >= 0) out.rationaleAge = ev.rationaleAge;
  return out;
}

export type WhySourceView = "reported" | "same_message" | "earlier" | "none" | "legacy";

export type WhyView = {
  /** null: no explanation ("원인 기록 없음"; legacy: the old "변경 앞에 설명이 없었습니다"). */
  text: string | null;
  source: WhySourceView;
  /** `earlier`: the agent's tool calls between the text and the change. */
  age: number | null;
  /** The call whose rationale it is (click → the conversation). */
  toolUseId: string | null;
  /** The text is a subagent's: its spawning call and type (`oh-my-claudecode:executor`). */
  agent: { toolUseId: string; type: string | null } | null;
  /** The change ran inside a subagent: the main agent's sentence before that Agent call. */
  delegation: string | null;
};

const KNOWN = new Set(["reported", "same_message", "earlier", "none"]);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/** A wire `FileWhy` as shown; null when there is none / it cannot be read (an engine before §34). */
export function readFileWhy(v: unknown): WhyView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["source"] !== "string") return null;
  const text = str(o["text"]);
  const raw = o["source"];
  const source: WhySourceView = text === null ? "none" : KNOWN.has(raw) && raw !== "none" ? (raw as WhySourceView) : "same_message";
  const age = typeof o["age"] === "number" && Number.isFinite(o["age"]) && o["age"] >= 0 ? o["age"] : null;
  const a = o["agent"];
  const agentId = a && typeof a === "object" ? str((a as Record<string, unknown>)["toolUseId"]) : null;
  const agent = agentId ? { toolUseId: agentId, type: str((a as Record<string, unknown>)["subagentType"]) } : null;
  return { text, source, age, toolUseId: str(o["toolUseId"]), agent, delegation: str(o["delegation"]) };
}

/** A turn_summary file's why: `whyDetail`, else the engine-before-§34 `why` / `whyToolUseId`. */
export function summaryWhy(f: TurnSummaryFile): WhyView {
  return (
    readFileWhy(f.whyDetail) ?? {
      text: str(f.why),
      source: "legacy",
      age: null,
      toolUseId: str(f.whyToolUseId),
      agent: null,
      delegation: null,
    }
  );
}

/** A sentence shown once at the top of a card: the why (or the delegation) `paths` share, numbered `n`. */
export type SharedWhy = { n: number; kind: "why" | "delegation"; view: WhyView; paths: string[] };
/** Per file: its own why / delegation, or the number of the shared sentence it carries. */
export type FileWhyRef = { why: WhyView | number; delegation: string | number | null };
export type CardWhy = { shared: SharedWhy[]; files: Map<string, FileWhyRef> };

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

export function planCardWhy(files: readonly TurnSummaryFile[]): CardWhy {
  const views = files.map((f) => ({ path: f.path, view: summaryWhy(f) }));
  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const { view } of views) {
    if (view.text !== null) bump(`w\u0000${norm(view.text)}`);
    if (view.delegation !== null) bump(`d\u0000${norm(view.delegation)}`);
  }
  const shared: SharedWhy[] = [];
  const numbers = new Map<string, number>();
  const ref = (key: string, kind: SharedWhy["kind"], view: WhyView, path: string): number | null => {
    if ((count.get(key) ?? 0) < 2) return null;
    let n = numbers.get(key);
    if (n === undefined) {
      n = shared.length + 1;
      numbers.set(key, n);
      shared.push({ n, kind, view, paths: [] });
    }
    shared[n - 1]!.paths.push(path);
    return n;
  };
  const out = new Map<string, FileWhyRef>();
  for (const { path, view } of views) {
    const why = view.text !== null ? ref(`w\u0000${norm(view.text)}`, "why", view, path) : null;
    const del = view.delegation !== null ? ref(`d\u0000${norm(view.delegation)}`, "delegation", { ...view, text: view.delegation, source: "same_message", agent: null, delegation: null }, path) : null;
    out.set(path, { why: why ?? view, delegation: del ?? view.delegation });
  }
  return { shared, files: out };
}

export type TestVerdictView = { tone: "green" | "red" | "gray" | "orange"; text: string; title: string; toolUseId: string | null };

/**
 * The summary card's test line; null for an engine before §34 (no `lastTest` field) or an unreadable value.
 * wave3 check-clients — the same rule as the Mac's TestVerdictLine: a run an edit came after covers nothing, whatever it
 * said (a failure may be fixed by that edit) — orange "편집 뒤 테스트 없음", the tooltip keeping what it said; no test this
 * turn is the same words in grey.
 */
export function testVerdict(lastTest: unknown): TestVerdictView | null {
  if (lastTest === undefined) return null;
  if (lastTest === null) return { tone: "gray", text: t("No tests after the last edit"), title: t("No test command ran in this turn"), toolUseId: null };
  if (typeof lastTest !== "object") return null;
  const o = lastTest as Record<string, unknown>;
  const command = typeof o["command"] === "string" ? o["command"] : "";
  const runs = typeof o["runs"] === "number" && o["runs"] > 1 ? ` · ×${o["runs"]}` : "";
  const title = `$ ${command.replace(/\s+/g, " ").trim()}${runs}`;
  const toolUseId = str(o["toolUseId"]);
  const failed = o["verdict"] === "fail";
  if (!failed && o["verdict"] !== "pass") return null;
  if (o["afterLastEdit"] !== true) {
    const said = failed ? t("The last test failed before a later edit") : t("The last test passed before a later edit");
    return { tone: "orange", text: t("No tests after the last edit"), title: `${said}\n${title}`, toolUseId };
  }
  if (failed) return { tone: "red", text: `✕ ${t("Tests failed")}`, title, toolUseId };
  return { tone: "green", text: `✓ ${t("Tests passed · ran after the last edit")}`, title, toolUseId };
}
