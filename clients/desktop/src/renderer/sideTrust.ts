/**
 * Side questions you can trust (docs/PROTOCOL.md §40.3, wave4b w4b-side) — the pure part, unit-tested: the web setting
 * in words, a thread's fork point ("턴 N 시점") and [최신 대화로 다시 묻기], a passage of Claude's answer as an anchor, the
 * warning before a chat switch cuts running answers, the side model choices. Same rules and keys as the Mac
 * (Core `SideTrust.swift`).
 */
import type { ModelOption, SideAnchor, SideThread } from "@reviewgate/engine";
import { t } from "./i18n";
import type { SideState } from "./sideThreads";

export type SideWebMode = "off" | "rules" | "on";
export const SIDE_WEB_MODES: readonly SideWebMode[] = ["off", "rules", "on"];

/** `settings.sideWeb` as stored; absent / unknown = off (an old `sideAllowWeb: true` was only the default). */
export function sideWebModeOf(v: unknown): SideWebMode {
  return v === "rules" || v === "on" ? v : "off";
}

export function sideWebLabel(m: SideWebMode): string {
  switch (m) {
    case "off":
      return t("Off");
    case "rules":
      return t("Only sites my Claude Code rules allow");
    case "on":
      return t("Any site");
  }
}

/** The line under the picker: what the choice lets a side question do. */
export function sideWebHelp(m: SideWebMode): string {
  return m === "off"
    ? t("Side questions answer from the code and the conversation only.")
    : m === "rules"
      ? t("Only the WebFetch(domain:…) / WebSearch rules you allowed in Claude Code. Code you read can still leave in a request to those sites.")
      : t("Code a side question read can leave your computer: a page it opens may carry it in the address.");
}

/** "턴 N 시점": the last main turn the thread's side session knows; null when it started without one. */
export function forkPointLabel(th: Pick<SideThread, "fork"> | undefined): string | null {
  const n = th?.fork?.atTurn;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? t("As of turn {0}", n) : null;
}

/** The main conversation went on since the fork: [최신 대화로 다시 묻기] is worth offering (`turn`: hud.turnCount). */
export function forkIsBehind(th: Pick<SideThread, "fork"> | undefined, turn: number | null | undefined): boolean {
  const n = th?.fork?.atTurn;
  return typeof n === "number" && typeof turn === "number" && turn > n;
}

/** What [최신 대화로 다시 묻기] asks: the text being typed, else the thread's last question; null when there is none. */
export function reforkQuestion(th: Pick<SideThread, "messages"> | undefined, typed: string): string | null {
  const q = typed.trim();
  if (q) return q;
  const last = [...(th?.messages ?? [])].reverse().find((m) => m.role === "user" && m.text.trim());
  return last ? last.text.trim() : null;
}

/** §40.3: a quoted passage is cut here (the engine cuts at the same length). */
export const QUOTE_MAX = 2000;

/** "곁질문으로 묻기" on selected text of Claude's answer: `{quote: {text, turn}}`, or null for an empty selection. */
export function quoteAnchor(selection: string, turn: number | null | undefined): SideAnchor | null {
  const text = selection.replace(/\s+$/g, "").replace(/^\s+/g, "");
  if (!text) return null;
  const cut = text.length > QUOTE_MAX ? text.slice(0, QUOTE_MAX - 1) + "…" : text;
  return { quote: { text: cut, turn: typeof turn === "number" && turn > 0 ? turn : null } };
}

/** The anchor chip of a quote: `인용 · 턴 4`. */
export function quoteLabel(q: { text: string; turn?: number | null }): string {
  return typeof q.turn === "number" ? t("Quote · turn {0}", q.turn) : t("Quote");
}

/** The thread head line of a quote: `“first words…” · 턴 4`. */
export function quoteTitle(q: { text: string; turn?: number | null }): string {
  const one = q.text.replace(/\s+/g, " ").trim();
  const head = one.length > 80 ? one.slice(0, 79) + "…" : one;
  return typeof q.turn === "number" ? `“${head}” · ${t("turn {0}", q.turn)}` : `“${head}”`;
}

/** Before a chat switch: running side answers would be cut — the confirm text, or null when none runs. */
export function sideSwitchWarning(s: SideState): string | null {
  const n = Object.values(s.threads).filter((th) => th.status === "running").length;
  return n > 0 ? t("A side question is still answering ({0}). Switching chats stops it — switch anyway?", n) : null;
}

export type SideModelChoice = { value: string; label: string };

/** The side model picker: "same as main" first, the session's models, and a stored value the list does not have. */
export function sideModelChoices(models: readonly Pick<ModelOption, "value" | "displayName">[], current: string): SideModelChoice[] {
  const out: SideModelChoice[] = [{ value: "", label: t("Same as the main conversation") }];
  for (const m of models) if (m.value && !out.some((o) => o.value === m.value)) out.push({ value: m.value, label: m.displayName || m.value });
  const cur = current.trim();
  if (cur && !out.some((o) => o.value === cur)) out.push({ value: cur, label: cur });
  return out;
}
