/**
 * docs/PROTOCOL.md §56.6, the same rules as the Mac (Core HandledCardFold.swift): permission cards and Claude's questions that
 * are decided — allowed, denied, answered, skipped or handled elsewhere — and come one after another in the transcript fold
 * into one quiet line, "권한 3건 처리됨 ▸", that opens to the lines it holds. A card still waiting is never folded; any other
 * row ends a run; fewer than `MIN_CARDS` stay as they are.
 */
import { t } from "./i18n";

export type HandledOutcome = "allowed" | "denied" | "handled" | "answered" | "skipped";
export type HandledCounts = { permissions: number; questions: number } & Record<HandledOutcome, number>;
export type HandledRun<E> = { kind: "handled"; id: number; entries: E[]; counts: HandledCounts };
export type HandledPiece<E> = { kind: "single"; entry: E } | HandledRun<E>;

/** Fewer decided cards in a row than this stay as they are. */
export const MIN_CARDS = 2;

/** A permission item's outcome: null while it still waits for an answer (`open`), and for every other row. */
export function handledOutcome(item: { kind: string; request?: { toolName: string }; allowed?: boolean | null }, open: boolean): { question: boolean; outcome: HandledOutcome } | null {
  if (item.kind !== "permission" || !item.request) return null;
  const question = item.request.toolName === "AskUserQuestion";
  const allowed = item.allowed ?? null;
  if (allowed === null && open) return null;
  if (allowed === true) return { question, outcome: question ? "answered" : "allowed" };
  if (allowed === false) return { question, outcome: question ? "skipped" : "denied" };
  return { question, outcome: "handled" };
}

const emptyCounts = (): HandledCounts => ({ permissions: 0, questions: 0, allowed: 0, denied: 0, handled: 0, answered: 0, skipped: 0 });

/** `entries` with every run of at least `MIN_CARDS` decided cards folded; `card` says what an entry is (null: not a decided card). */
export function foldHandled<E>(entries: readonly E[], id: (e: E) => number, card: (e: E) => { question: boolean; outcome: HandledOutcome } | null): HandledPiece<E>[] {
  const out: HandledPiece<E>[] = [];
  let run: E[] = [];
  let counts = emptyCounts();
  const flush = () => {
    if (run.length >= MIN_CARDS) out.push({ kind: "handled", id: id(run[0]!), entries: run, counts });
    else for (const entry of run) out.push({ kind: "single", entry });
    run = [];
    counts = emptyCounts();
  };
  for (const entry of entries) {
    const c = card(entry);
    if (!c) {
      flush();
      out.push({ kind: "single", entry });
      continue;
    }
    run.push(entry);
    if (c.question) counts.questions += 1;
    else counts.permissions += 1;
    counts[c.outcome] += 1;
  }
  flush();
  return out;
}

/** "권한 3건 처리됨", "권한 2건 · 질문 1건 처리됨", "질문 2건 처리됨". */
export function handledSummary(c: HandledCounts): string {
  if (c.permissions > 0 && c.questions > 0) return t("{0} permission(s) · {1} question(s) handled", c.permissions, c.questions);
  if (c.questions > 0) return t("{0} question(s) handled", c.questions);
  return t("{0} permission(s) handled", c.permissions);
}

/** "허용 2 · 거부 1 · 건너뜀 1" — the outcomes that are not zero. */
export function handledDetail(c: HandledCounts): string {
  const parts: string[] = [];
  if (c.allowed > 0) parts.push(t("Allowed {0}", c.allowed));
  if (c.denied > 0) parts.push(t("Denied {0}", c.denied));
  if (c.answered > 0) parts.push(t("Answered {0}", c.answered));
  if (c.skipped > 0) parts.push(t("Skipped {0}", c.skipped));
  if (c.handled > 0) parts.push(t("Handled elsewhere {0}", c.handled));
  return parts.join(" · ");
}
