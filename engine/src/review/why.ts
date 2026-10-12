import type { FileWhy } from "../protocol.js";
import { mentionsPath, plainText, type ToolCallInfo } from "./summary.js";

/**
 * §34.8 "why" (docs/PROTOCOL.md §34.8): the best explanation the engine has for a file's change, with where it came
 * from. Pure functions; the engine feeds them its remembered tool calls and the turn's reports.
 *
 * (1) `reported` — the turn-end reports name the file: a subagent's report (the Agent call's result) for a file it
 *     changed, else the main agent's last text (after its last tool call); (2) this turn's touching calls with a
 *     rationale — `same_message` before `earlier`, then the smallest age, then the latest call; (3) for a file this turn
 *     did not change, the earlier turns' calls of the same review; (4) `none`. `agent`: the text is a subagent's;
 *     `delegation`: the change ran in a subagent — the rationale of the spawning Agent call.
 */

/** One report sentence / list item; `heading` / `label` items name what the items under them are about. */
export type ReportItem = { text: string; kind: "heading" | "label" | "entry" | "sentence"; reason?: string };

/** The reported text of a file: at most this many items … */
export const REPORTED_MAX_ITEMS = 2;
/** … and this many chars. */
export const REPORTED_MAX_CHARS = 300;

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;
const LIST_RE = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}/;
/** `path: reason`, `path — reason`, `path - reason`, `path → reason` (the prefix is checked to name the file). */
const PATH_REASON_RE = /^(.{1,200}?)\s*(?::|—|–|->|→|=>|\s-\s)\s*(.+)$/;

/** Splits a paragraph line into sentences (`.` `!` `?` `。` followed by whitespace: `Foo.java` stays whole). */
function sentences(line: string): string[] {
  return line
    .split(/(?<=[.!?。])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The sentences / list items of a report (markdown): fenced code is skipped, headings and label lines (`**Foo.java**:`)
 * are kept as such, list items and table rows are entries (a row's first cell, or a `path: reason` item, carries its
 * `reason`), paragraphs are split into sentences. Inline markdown is stripped (`plainText`).
 */
export function reportItems(text: string): ReportItem[] {
  const items: ReportItem[] = [];
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence || !raw.trim()) continue;
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const t = plainText(heading[1]!);
      if (t) items.push({ text: t, kind: "heading" });
      continue;
    }
    if (raw.trim().startsWith("|")) {
      if (TABLE_SEPARATOR_RE.test(raw.replace(/\|/g, " "))) continue;
      const cells = raw.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => plainText(c)).filter((c) => c.length > 0);
      if (cells.length === 0) continue;
      const reason = cells.slice(1).join(" — ");
      items.push({ text: cells.join(" — "), kind: "entry", ...(reason ? { reason } : {}) });
      continue;
    }
    const list = LIST_RE.exec(raw);
    const body = plainText(list ? list[1]! : raw);
    if (!body) continue;
    if (body.endsWith(":") && body.length <= 200) {
      items.push({ text: body.slice(0, -1).trim(), kind: "label" });
      continue;
    }
    if (list) {
      const pr = PATH_REASON_RE.exec(body);
      items.push({ text: body, kind: "entry", ...(pr && pr[2]!.trim() ? { reason: pr[2]!.trim() } : {}) });
      continue;
    }
    for (const s of sentences(body)) items.push({ text: s, kind: "sentence" });
  }
  return items;
}

/** Words a `path, path and path:` head may hold besides the paths themselves. */
const PATH_LIST_WORD_RE = /^(?:and|or|&|및|그리고|또는|\(?(?:new|added|deleted|renamed|신규|추가|삭제|수정)\)?)$/i;

/** `head` is a list of paths (`Svc.java`, `a/b.ts, c.ts and d.ts`, `Svc.java와 Repo.java`), not a sentence. */
function isPathList(head: string): boolean {
  const words = head.split(/[\s,]+/).filter((w) => w.length > 0);
  return words.length > 0 && words.every((w) => /[./\\]/.test(w) || PATH_LIST_WORD_RE.test(w));
}

/** The reason of a `path: reason` item whose head is a list of paths naming `path`. */
function reasonFor(item: ReportItem, mentions: (s: string) => boolean): string | null {
  if (!item.reason) return null;
  const head = item.text.slice(0, item.text.length - item.reason.length).replace(/\s*(?::|—|–|->|→|=>|\s-\s)\s*$/, "");
  return isPathList(head) && mentions(head) ? item.reason : null;
}

/**
 * The reported text for a changed file (`oldPath`: a rename's old name counts too): `path: reason` items first (their
 * reason), then a heading / label naming the file explained by the items under it, then any item mentioning it
 * (`mentionsPath`, §15) — at most 2 items, 300 chars. null when the report never names the file.
 */
export function reportedFor(path: string, oldPath: string | null, items: readonly ReportItem[]): string | null {
  const mentions = (s: string) => mentionsPath(s, path) || (oldPath !== null && oldPath !== path && mentionsPath(s, oldPath));
  const picked: string[] = [];
  const used = new Set<number>();
  const take = (i: number, text: string) => {
    if (picked.length >= REPORTED_MAX_ITEMS || used.has(i)) return;
    used.add(i);
    picked.push(text);
  };
  items.forEach((item, i) => {
    const r = reasonFor(item, mentions);
    if (r !== null) take(i, r);
  });
  items.forEach((item, i) => {
    if ((item.kind !== "heading" && item.kind !== "label") || !mentions(item.text)) return;
    used.add(i);
    // A heading explains the entries / sentences under it, a label the list entries right after it.
    for (let k = i + 1, n = 0; k < items.length && n < REPORTED_MAX_ITEMS; k++) {
      const next = items[k]!;
      if (next.kind === "heading" || next.kind === "label" || (item.kind === "label" && next.kind !== "entry")) break;
      take(k, next.text);
      n++;
    }
  });
  items.forEach((item, i) => {
    if (item.kind === "heading" || item.kind === "label" || !mentions(item.text)) return;
    take(i, item.text);
  });
  if (picked.length === 0) return null;
  const text = picked.join(" ");
  return text.length > REPORTED_MAX_CHARS ? text.slice(0, REPORTED_MAX_CHARS - 1).trimEnd() + "…" : text;
}

const WHY_SOURCES: ReadonlySet<string> = new Set(["reported", "same_message", "earlier", "none"]);

/** A `FileWhy` as this engine writes it (a restored review file is checked before its `why` is kept). */
export function isFileWhy(v: unknown): v is FileWhy {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return typeof w.source === "string" && WHY_SOURCES.has(w.source) && (w.text === null || typeof w.text === "string");
}

/** What `fileWhy` reads: the remembered calls, the collected turn, the main agent's report of that turn. */
export type WhyContext = {
  calls: ReadonlyMap<string, ToolCallInfo>;
  turn: number;
  /** The main agent's text after its last tool call of the turn ("" when none). */
  mainReport: string;
  /** A refresh / restore (no turn collected): `turn` is the last one, and its calls are earlier ones too. */
  noTurn?: boolean;
};

type Candidate = { id: string; call: ToolCallInfo; order: number };

/** `same_message` (or an older engine's call without a source) before `earlier`, then the smallest age, then the latest. */
function best(candidates: Candidate[]): Candidate | null {
  let pick: Candidate | null = null;
  const rank = (c: Candidate) => [c.call.rationaleSource === "earlier" ? 1 : 0, c.call.rationaleAge ?? 0, -c.order] as const;
  for (const c of candidates) {
    if (!pick) {
      pick = c;
      continue;
    }
    const [a, b] = [rank(c), rank(pick)];
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) pick = c;
  }
  return pick;
}

/** The subagent of a call (`agent`) and the main agent's words for spawning it (`delegation`). */
function agentOf(call: ToolCallInfo, calls: ReadonlyMap<string, ToolCallInfo>): Pick<FileWhy, "agent" | "delegation"> {
  const parent = call.parentToolUseId;
  if (parent === undefined) return {};
  const spawn = calls.get(parent);
  return {
    agent: { toolUseId: parent, ...(spawn?.subagentType ? { subagentType: spawn.subagentType } : {}) },
    ...(spawn?.rationale ? { delegation: spawn.rationale } : {}),
  };
}

function fromCall(c: Candidate, calls: ReadonlyMap<string, ToolCallInfo>, turn: number): FileWhy {
  const source = c.call.rationaleSource === "earlier" ? "earlier" : "same_message";
  return {
    text: c.call.rationale!,
    source,
    ...(source === "earlier" ? { age: c.call.rationaleAge ?? 0 } : {}),
    toolUseId: c.id,
    ...agentOf(c.call, calls),
    turn: c.call.turn ?? turn,
  };
}

/**
 * The §34.8 `FileWhy` of one review file. `changedThisTurn`: the collected turn changed it (its own start tree → B) —
 * else only the earlier turns' calls apply (a file the turn left alone keeps its earlier explanation).
 */
export function fileWhy(file: { path: string; oldPath: string | null; toolUseIds: readonly string[] }, ctx: WhyContext, changedThisTurn: boolean): FileWhy {
  const touching: Candidate[] = [];
  file.toolUseIds.forEach((id, i) => {
    const call = ctx.calls.get(id);
    if (call) touching.push({ id, call, order: call.seq ?? i });
  });
  const thisTurn = touching.filter((c) => c.call.turn === undefined || c.call.turn === ctx.turn);
  if (changedThisTurn) {
    // (1) the reports: the subagents that changed the file (latest first), then the main agent's.
    const agents = [...new Set([...thisTurn].sort((a, b) => b.order - a.order).map((c) => c.call.parentToolUseId).filter((p): p is string => p !== undefined))];
    for (const agent of agents) {
      const spawn = ctx.calls.get(agent);
      const text = spawn?.report ? reportedFor(file.path, file.oldPath, reportItems(spawn.report)) : null;
      if (text === null) continue;
      return {
        text,
        source: "reported",
        agent: { toolUseId: agent, ...(spawn?.subagentType ? { subagentType: spawn.subagentType } : {}) },
        ...(spawn?.rationale ? { delegation: spawn.rationale } : {}),
        turn: ctx.turn,
      };
    }
    const main = ctx.mainReport ? reportedFor(file.path, file.oldPath, reportItems(ctx.mainReport)) : null;
    if (main !== null) return { text: main, source: "reported", turn: ctx.turn };
    // (2) this turn's calls with a rationale.
    const pick = best(thisTurn.filter((c) => !!c.call.rationale));
    if (pick) return fromCall(pick, ctx.calls, ctx.turn);
  } else {
    // (3) the earlier turns' calls of the review.
    const earlier = (t: number | undefined) => t !== undefined && (t < ctx.turn || (ctx.noTurn === true && t === ctx.turn));
    const pick = best(touching.filter((c) => !!c.call.rationale && earlier(c.call.turn)));
    if (pick) return fromCall(pick, ctx.calls, ctx.turn);
  }
  // (4) no record — a change that ran in a subagent still says who asked for it.
  const latest = [...thisTurn].sort((a, b) => b.order - a.order).find((c) => c.call.parentToolUseId !== undefined);
  const delegation = latest ? ctx.calls.get(latest.call.parentToolUseId!)?.rationale : undefined;
  return { text: null, source: "none", ...(changedThisTurn && delegation ? { delegation } : {}), turn: ctx.turn };
}
