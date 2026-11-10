import type { TranscriptItem } from "../protocol.js";
import { fenceFor, summarizeInput } from "./context.js";

/**
 * §36.10 (SME-02): a side question asked while a main turn runs forks the main session at its last completed turn (or
 * starts fresh in a brand-new chat) — so the fork does not know what the running turn was asked or has done. Its first
 * prompt gets a block summarizing that turn: the request, the main agent's text so far and the tool calls so far.
 */

/** The request is cut at this many chars. */
export const RUNNING_TURN_MESSAGE_CHARS = 4000;
/** The main agent's text so far: its last ~this many chars. */
export const RUNNING_TURN_TEXT_CHARS = 2000;
/** One call's short input is cut at this many chars. */
export const RUNNING_TURN_CALL_CHARS = 200;
/** The newest this many calls are listed. */
export const RUNNING_TURN_CALLS = 40;
/** Transcript rows read back for the running turn (its user message is its first row). */
export const RUNNING_TURN_ROWS = 5000;

/** One tool call of the running turn: name + short input; `agentType` when a subagent made it. */
export type RunningTurnCall = { name: string; input: string; agentType?: string };

export type RunningTurnContext = {
  turn: number;
  /** The turn's request (its user message, or the delivered peer messages); null when unknown. */
  userMessage: string | null;
  /** Repo-relative paths the user mentioned (§23). */
  mentions: string[];
  /** The main agent's text of the turn so far. */
  assistantText: string;
  /** Every call of the turn so far, oldest first (the block shows the newest `RUNNING_TURN_CALLS`). */
  calls: RunningTurnCall[];
};

export function runningTurnHeader(turn: number): string {
  return `[Turn ${turn} in progress — not part of the forked conversation]`;
}

const FILE_TOOLS = /^(Read|Edit|Write|MultiEdit|NotebookEdit|NotebookRead)$/;

function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * The short input of a call (≤ `RUNNING_TURN_CALL_CHARS`): the Bash command on one line, the file of an edit / read tool
 * (repo-relative when `rel` maps it), `(type) description` of an Agent / Task call, else a compact preview of the input.
 */
export function callInputText(name: string, input: Record<string, unknown>, rel: (abs: string) => string | null): string {
  let text: string;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (name === "Bash") text = oneLine(str(input.command));
  else if (FILE_TOOLS.test(name) && (str(input.file_path) || str(input.notebook_path))) {
    const abs = str(input.file_path) || str(input.notebook_path);
    text = rel(abs) ?? abs;
  } else if (/^(Agent|Task)$/.test(name)) {
    const type = str(input.subagent_type);
    const what = oneLine(str(input.description) || str(input.prompt));
    text = type ? `(${type}) ${what}`.trim() : what;
  } else text = summarizeInput(input) ?? "";
  return cut(text, RUNNING_TURN_CALL_CHARS);
}

/**
 * The running turn as the transcript recorded it: the rows of `turn` (its user message — or the delivered peer messages
 * of a peer turn — and its tool calls in order, a subagent's labelled with its agent type). `assistantText` is left empty:
 * the engine holds the turn's text until the turn ends.
 */
export function runningTurnFromRows(rows: readonly TranscriptItem[], turn: number, rel: (abs: string) => string | null): RunningTurnContext {
  const mine = rows.filter((r) => r.turn === turn);
  let userMessage: string | null = null;
  let mentions: string[] = [];
  const peers: string[] = [];
  const agentTypes = new Map<string, string>();
  const calls: RunningTurnCall[] = [];
  for (const r of mine) {
    if (r.kind === "user_message") {
      userMessage = r.text;
      mentions = [...(r.mentions ?? [])];
    } else if (r.kind === "peer_message" && r.state === "delivered" && typeof r.body === "string" && r.body.trim()) {
      peers.push(`[peer message from ${r.fromName ?? r.from}] ${r.body.trim()}`);
    } else if (r.kind === "tool_use") {
      const input = r.input && typeof r.input === "object" ? r.input : {};
      if (/^(Agent|Task)$/.test(r.name)) agentTypes.set(r.id, typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "subagent");
      const call: RunningTurnCall = { name: r.name, input: callInputText(r.name, input, rel) };
      if (r.parentToolUseId) call.agentType = agentTypes.get(r.parentToolUseId) ?? "subagent";
      calls.push(call);
    }
  }
  if (userMessage === null && peers.length > 0) userMessage = peers.join("\n\n");
  return { turn, userMessage, mentions, assistantText: "", calls };
}

function quoted(text: string): string[] {
  const f = fenceFor(text);
  return [f + "text", text, f];
}

/** The block (after the anchor context, before the question). */
export function runningTurnBlock(ctx: RunningTurnContext): string {
  const lines: string[] = [runningTurnHeader(ctx.turn)];
  lines.push("While you answer, the main conversation is still working on this turn; you only see this summary of it.");
  lines.push("The user's request for this turn:");
  if (ctx.userMessage && ctx.userMessage.trim()) lines.push(...quoted(cut(ctx.userMessage.trim(), RUNNING_TURN_MESSAGE_CHARS)));
  else lines.push("(not available)");
  if (ctx.mentions.length > 0) lines.push(`Mentioned: ${ctx.mentions.join(", ")}`);
  const said = ctx.assistantText.trim();
  if (said) {
    let tail = said;
    if (said.length > RUNNING_TURN_TEXT_CHARS) {
      tail = said.slice(-RUNNING_TURN_TEXT_CHARS);
      // Start at a word boundary when one is near.
      const space = tail.search(/\s/);
      if (space >= 0 && space < 40) tail = tail.slice(space + 1);
      tail = "…" + tail;
    }
    lines.push("What the main agent has said so far in this turn (its last part):", ...quoted(tail));
  } else lines.push("What the main agent has said so far in this turn: (no text yet)");
  if (ctx.calls.length === 0) lines.push("Tool calls so far: (none yet)");
  else {
    const shown = ctx.calls.slice(-RUNNING_TURN_CALLS);
    const hidden = ctx.calls.length - shown.length;
    lines.push(`Tool calls so far (oldest first${hidden > 0 ? `; ${hidden} earlier calls not shown` : ""}):`);
    for (const c of shown) {
      const head = c.agentType ? `  - [${c.agentType}] ${c.name}` : `- ${c.name}`;
      lines.push(c.input ? `${head}: ${c.input}` : head);
    }
  }
  return lines.join("\n");
}
