/**
 * MARK: wave4c w4c-commit
 * docs/PROTOCOL.md §41.1 in Electron (the same rules as the Mac's `TeamFormat`): the commit sheet's "팀 형식: …" line from
 * `commit_format`, the PR sheet's metadata kept per project and the readiness of `gh`, and the chat's "대화를 줄였어요" row
 * of a compacted turn. Kept free of React so they are tested.
 */
import type { CommitFormatEvent, GHReadiness, PRCreateMeta, TurnCompaction, TurnUsage } from "@reviewgate/engine";
import { t } from "./i18n";

// ---------------------------------------------------------------- the team's format

/** `{issue}`: the reply's issue when it is for this branch, else the branch's longest run of digits (as the engine without subjects). */
export function issueFor(branch: string | null | undefined, reply: Pick<CommitFormatEvent, "issue" | "branch"> | null): string {
  if (reply && reply.branch === (branch ?? null)) return reply.issue;
  let best = "";
  for (const r of (branch ?? "").match(/[0-9]+/g) ?? []) if (r.length > best.length) best = r;
  return best;
}

/** What the commit sheet says the draft follows: the project's template, else the learned one; null when neither. */
export function teamFormatLine(template: string, branch: string | null | undefined, reply: CommitFormatEvent | null): { text: string; learned: boolean } | null {
  const own = template.trim() ? template : null;
  const raw = own ?? reply?.learned ?? null;
  if (raw === null) return null;
  const text = raw.replaceAll("{issue}", issueFor(branch, reply)).replaceAll("{branch}", branch ?? "");
  const first = text.split("\n")[0] ?? text;
  return { text: first, learned: own === null };
}

/** The learned format offered in the template editor: only when it differs from what is typed. */
export function learnedSuggestion(template: string, reply: CommitFormatEvent | null): string | null {
  const learned = reply?.learned ?? null;
  return learned && learned !== template.trim() ? learned : null;
}

// ---------------------------------------------------------------- the PR sheet

/** The PR sheet's metadata as typed: comma-separated lists. */
export type PRMetaText = { assignees: string; labels: string; reviewers: string; projects: string };

/** The first PR of a project assigns it to the user (`@me`); labels / reviewers / projects start empty. */
export const DEFAULT_PR_META: PRMetaText = { assignees: "@me", labels: "", reviewers: "", projects: "" };

export function metaList(text: string): string[] {
  return [...new Set(text.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** `pr_create`'s metadata fields (empty lists left out). */
export function prCreateMeta(m: PRMetaText): PRCreateMeta {
  const out: PRCreateMeta = {};
  for (const k of ["assignees", "labels", "reviewers", "projects"] as const) {
    const list = metaList(m[k]);
    if (list.length > 0) out[k] = list;
  }
  return out;
}

const META_KEY = "rg.prMeta";
type KV = Pick<Storage, "getItem" | "setItem">;
function storage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The metadata the last PR of `root` used (the defaults for a project without one). */
export function loadPRMeta(root: string | null, kv: KV | null = storage()): PRMetaText {
  if (!root || !kv) return { ...DEFAULT_PR_META };
  try {
    const all = JSON.parse(kv.getItem(META_KEY) ?? "{}") as Record<string, Partial<PRMetaText>>;
    const v = all[root];
    if (!v || typeof v !== "object") return { ...DEFAULT_PR_META };
    const str = (x: unknown, d: string) => (typeof x === "string" ? x : d);
    return { assignees: str(v.assignees, DEFAULT_PR_META.assignees), labels: str(v.labels, ""), reviewers: str(v.reviewers, ""), projects: str(v.projects, "") };
  } catch {
    return { ...DEFAULT_PR_META };
  }
}

export function savePRMeta(root: string | null, m: PRMetaText, kv: KV | null = storage()): void {
  if (!root || !kv) return;
  try {
    const all = JSON.parse(kv.getItem(META_KEY) ?? "{}") as Record<string, PRMetaText>;
    all[root] = m;
    kv.setItem(META_KEY, JSON.stringify(all));
  } catch {
    // a full or blocked storage keeps the defaults
  }
}

/** Why [PR 만들기] is off for `gh` (null when it can run). */
export function ghBlocker(gh: GHReadiness | null | undefined, host: string | null | undefined): string | null {
  if (gh === "not_found") return t("GitHub CLI (gh) is not installed — install it or set its path in Settings");
  if (gh === "not_logged_in") return host ? t("gh is not logged in to {0} — log in on the PR tab", host) : t("gh is not logged in — log in on the PR tab");
  return null;
}

// ---------------------------------------------------------------- a compacted turn

export type CompactedRowFacts = TurnCompaction & { postTokens?: number };

/** The row's facts from a turn end's usage (undefined for a turn that did not compact). */
export function compactedOf(usage: Pick<TurnUsage, "contextTokens"> & { compacted?: TurnCompaction }): CompactedRowFacts | undefined {
  const c = usage.compacted;
  if (!c || (c.trigger !== "manual" && c.trigger !== "auto")) return undefined;
  return { ...c, ...(typeof usage.contextTokens === "number" && usage.contextTokens > 0 ? { postTokens: usage.contextTokens } : {}) };
}

/** `{compacted}` for a turn-end row (nothing for a turn that did not compact; an older engine never sends it). */
export function compactedField(usage: Parameters<typeof compactedOf>[0] | null | undefined): { compacted?: CompactedRowFacts } {
  const c = usage ? compactedOf(usage) : undefined;
  return c ? { compacted: c } : {};
}

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "대화를 줄였어요 · 16.3k → 3.7k 토큰" (auto: "대화가 길어 자동으로 줄였어요 …"). */
export function compactedText(c: CompactedRowFacts): string {
  const head = c.trigger === "auto" ? t("The conversation got long and was compacted") : t("Compacted the conversation");
  const tokens = c.preTokens !== undefined && c.postTokens !== undefined ? ` · ${t("{0} → {1} tokens", kTokens(c.preTokens), kTokens(c.postTokens))}` : "";
  return `${head}${tokens} — ${t("Claude remembers what came before as a summary")}`;
}
