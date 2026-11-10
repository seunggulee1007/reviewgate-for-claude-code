/**
 * docs/PROTOCOL.md §53 in the commit sheet's "나눠서 커밋" mode — the pure logic: the cards (commits in order) and the
 * "커밋하지 않음" area as one state, moved part by part. A part is one hunk of a file that has hunks, or a whole-only file
 * (`hunk: null`). Building the `commit_series` command, the button's reason and the refusals in words live here too.
 */
import { t } from "./i18n";
import { leadingCode } from "./engineRequest";
import { flowRefusalText } from "./flowLogic";
import { refusalMessage } from "./errorCodes";
import type { CommitFile, CommitPart, CommitPlan, SeriesCommit } from "@reviewgate/engine";

/** `hunk`: a hunk id, or null = the whole (whole-only) file. */
export type SplitPart = { path: string; hunk: number | null };
export type SplitCard = { id: number; message: string; why?: string; parts: SplitPart[] };
/** `to`: a card id, or "none" = 커밋하지 않음. */
export type SplitTarget = number | "none";
export type SplitSnapshot = { cards: SplitCard[]; unassigned: SplitPart[]; nextId: number };
export type SplitState = SplitSnapshot & {
  /** The cards from before the last "AI로 나누기" (null = none to restore). */
  before: SplitSnapshot | null;
};

export const partKey = (p: SplitPart): string => `${p.path}#${p.hunk ?? "whole"}`;

/** Every part the files can be split into, in file order. */
export function allParts(files: CommitFile[]): SplitPart[] {
  return files.flatMap((f): SplitPart[] => (f.hunks.length === 0 ? [{ path: f.path, hunk: null }] : f.hunks.map((h) => ({ path: f.path, hunk: h.id }))));
}

/** Parts in file order, then hunk id (a card always lists its files the way the diff does). */
export function sortParts(files: CommitFile[], parts: SplitPart[]): SplitPart[] {
  const order = new Map(files.map((f, i) => [f.path, i]));
  return [...parts].sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9) || (a.hunk ?? -1) - (b.hunk ?? -1));
}

/** Starting state: one card with everything (the mode works without AI). */
export function initialSplit(files: CommitFile[], message = ""): SplitState {
  return { cards: [{ id: 1, message, parts: allParts(files) }], unassigned: [], nextId: 2, before: null };
}

export type SplitAction =
  | { type: "init"; files: CommitFile[]; message: string }
  | { type: "message"; card: number; message: string }
  /** `hunk` undefined = every part of `path` that is in `from`. */
  | { type: "move"; files: CommitFile[]; from: SplitTarget; to: SplitTarget; path: string; hunk?: number | null }
  | { type: "addCard" }
  | { type: "deleteCard"; files: CommitFile[]; card: number }
  | { type: "reorder"; card: number; by: -1 | 1 }
  | { type: "propose"; files: CommitFile[]; commits: CommitPlan[]; unassigned: CommitPart[] }
  | { type: "restore" };

const snapshotOf = (s: SplitState): SplitSnapshot => ({ cards: s.cards, unassigned: s.unassigned, nextId: s.nextId });

export function splitReducer(s: SplitState, a: SplitAction): SplitState {
  switch (a.type) {
    case "init":
      return initialSplit(a.files, a.message);
    case "message":
      return { ...s, cards: s.cards.map((c) => (c.id === a.card ? { ...c, message: a.message } : c)) };
    case "move": {
      if (a.from === a.to) return s;
      const matches = (p: SplitPart) => p.path === a.path && (a.hunk === undefined || p.hunk === a.hunk);
      const source = a.from === "none" ? s.unassigned : (s.cards.find((c) => c.id === a.from)?.parts ?? []);
      const moving = source.filter(matches);
      if (moving.length === 0) return s;
      if (a.to !== "none" && !s.cards.some((c) => c.id === a.to)) return s;
      const cards = s.cards.map((c) => {
        if (c.id === a.from) return { ...c, parts: c.parts.filter((p) => !matches(p)) };
        if (c.id === a.to) return { ...c, parts: sortParts(a.files, [...c.parts, ...moving]) };
        return c;
      });
      const unassigned = a.from === "none" ? s.unassigned.filter((p) => !matches(p)) : a.to === "none" ? sortParts(a.files, [...s.unassigned, ...moving]) : s.unassigned;
      return { ...s, cards, unassigned };
    }
    case "addCard":
      return { ...s, cards: [...s.cards, { id: s.nextId, message: "", parts: [] }], nextId: s.nextId + 1 };
    case "deleteCard": {
      const card = s.cards.find((c) => c.id === a.card);
      if (!card) return s;
      return { ...s, cards: s.cards.filter((c) => c.id !== a.card), unassigned: sortParts(a.files, [...s.unassigned, ...card.parts]) };
    }
    case "reorder": {
      const i = s.cards.findIndex((c) => c.id === a.card);
      const j = i + a.by;
      if (i < 0 || j < 0 || j >= s.cards.length) return s;
      const cards = [...s.cards];
      [cards[i], cards[j]] = [cards[j]!, cards[i]!];
      return { ...s, cards };
    }
    case "propose": {
      const known = new Map(a.files.map((f) => [f.path, f]));
      const used = new Set<string>();
      const expand = (p: CommitPart): SplitPart[] => {
        const f = known.get(p.path);
        if (!f) return [];
        const ids = f.hunks.length === 0 ? [null] : p.hunks === undefined ? f.hunks.map((h) => h.id) : p.hunks.filter((id) => f.hunks.some((h) => h.id === id));
        return ids.map((hunk) => ({ path: p.path, hunk })).filter((part) => !used.has(partKey(part)) && (used.add(partKey(part)), true));
      };
      let nextId = s.nextId;
      const cards: SplitCard[] = a.commits.map((c) => ({ id: nextId++, message: c.message, ...(c.why ? { why: c.why } : {}), parts: sortParts(a.files, c.parts.flatMap(expand)) }));
      // What the proposal left out (and anything the engine named in `unassigned`) stays uncommitted.
      const unassigned = sortParts(a.files, allParts(a.files).filter((p) => !used.has(partKey(p))));
      return { cards, unassigned, nextId, before: snapshotOf(s) };
    }
    case "restore":
      return s.before ? { ...s.before, before: null } : s;
  }
}

/** The `commit_series` commits: a file with hunks goes as `hunks` (always), a whole-only file whole. */
export function buildSeries(s: SplitState): CommitPlan[] {
  return s.cards.map((c) => {
    const byPath = new Map<string, number[] | null>();
    for (const p of c.parts) {
      if (p.hunk === null) byPath.set(p.path, null);
      else byPath.set(p.path, [...(byPath.get(p.path) ?? []), p.hunk]);
    }
    const parts: CommitPart[] = [...byPath].map(([path, hunks]) => (hunks === null ? { path } : { path, hunks: [...hunks].sort((x, y) => x - y) }));
    return { message: c.message.trim(), parts };
  });
}

/** Why "커밋 N개 만들기" is off; null = it can run. */
export function seriesBlocker(s: SplitState, busy: { splitting?: boolean; committing?: boolean } = {}): string | null {
  if (busy.splitting) return t("Splitting…");
  if (busy.committing) return t("Committing…");
  if (s.cards.length === 0) return t("Add a commit first");
  const emptyMsg = s.cards.findIndex((c) => c.message.trim() === "");
  if (emptyMsg >= 0) return t("Commit {0} has no message", emptyMsg + 1);
  const noParts = s.cards.findIndex((c) => c.parts.length === 0);
  if (noParts >= 0) return t("Commit {0} has no changes", noParts + 1);
  return null;
}

const shaList = (made: SeriesCommit[]): string => made.map((c) => c.shortSha).join(", ");

/** The success line: "커밋 3개를 만들었어요 (a1b2c3d, …)". */
export function seriesDoneText(made: SeriesCommit[], pushed: boolean): string {
  const line = t("Made {0} commit(s): {1}", made.length, shaList(made));
  return pushed ? `${line} · ${t("pushed")}` : line;
}

/** A refusal of the three §53 commands in the user's words (`code:detail` as the engine sent it). */
export function splitRefusalText(error: string): string {
  const code = leadingCode(error);
  const detail = error.startsWith(`${code}:`) ? error.slice(code.length + 1).trim() : "";
  switch (code) {
    case "commit_split_failed":
      return detail ? t("Claude could not split the changes: {0}", detail) : t("Claude could not split the changes");
    case "invalid_part":
      return t("{0} cannot be committed this way — it is not an accepted file, or the part is gone", detail);
    case "hunk_twice":
      return t("{0} is in two commits — a part can only be in one", detail);
    case "empty_message":
      return t("A commit has no message");
    case "git_identity_missing":
      return detail ? t("Git identity is not configured (user.name / user.email).{0}", ` ${detail}`) : t("Git identity is not configured (user.name / user.email).{0}", "");
    case "session_running":
      return t("Claude is working…");
    case "merge_unresolved":
      return t("There are unresolved merge conflicts — resolve them first");
    case "commit_failed":
      return detail ? t("git could not commit: {0}", detail) : t("git could not commit");
    default:
      return flowRefusalText(code, detail) ?? refusalMessage({ code, error, detail });
  }
}

/** A series that stopped: what was made, then why. */
export function seriesFailureText(error: string, made: SeriesCommit[]): string {
  const why = splitRefusalText(error);
  return made.length > 0 ? `${t("Made {0} commit(s): {1}", made.length, shaList(made))} — ${t("then it stopped")}: ${why}` : why;
}
