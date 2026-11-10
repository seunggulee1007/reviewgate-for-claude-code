import type { LastTest } from "../protocol.js";
import type { ToolCallInfo } from "./summary.js";

/**
 * §34.9 `turn_summary.lastTest`: the turn's last recognized, not backgrounded test call by `tool_result` order
 * (subagents included) — `testOutcome` is only set for those — with `afterLastEdit` (no file-changing call — an edit with
 * a successful result, a Bash call with attributed files — finished after it) and `runs` (the turn's test calls); null
 * when none ran. Calls are the engine's remembered tool calls (`turn`, `resultSeq`, `fileChanging` set as they happen).
 */
export function lastTestOf(calls: ReadonlyMap<string, ToolCallInfo>, turn: number): LastTest | null {
  let last: { id: string; call: ToolCallInfo; seq: number } | null = null;
  let runs = 0;
  for (const [id, call] of calls) {
    if (call.turn !== turn || call.testOutcome === undefined || call.resultSeq === undefined) continue;
    runs++;
    if (!last || call.resultSeq > last.seq) last = { id, call, seq: call.resultSeq };
  }
  if (!last) return null;
  let afterLastEdit = true;
  for (const [id, call] of calls) {
    if (id === last.id || call.turn !== turn || call.fileChanging !== true || call.resultSeq === undefined) continue;
    if (call.resultSeq > last.seq) {
      afterLastEdit = false;
      break;
    }
  }
  return {
    verdict: last.call.testOutcome!,
    command: last.call.command ?? "",
    toolUseId: last.id,
    at: last.call.resultAt ?? "",
    afterLastEdit,
    runs,
  };
}
