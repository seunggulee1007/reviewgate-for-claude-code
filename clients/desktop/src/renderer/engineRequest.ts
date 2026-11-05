/**
 * Engine requests with the refusal details of docs/PROTOCOL.md §19.6. A refused command rejects with an
 * `EngineRefusal`: `message` is still the engine's `error` text (what older code parses), `code` the stable id
 * (the leading word of `error` when the engine sent none), `paths` the files a refusal is about.
 */
import type { EngineCommand, PartialSeries, ReplyFor } from "@reviewgate/engine";
import type { RGBridge } from "../shared/ipc";

export class EngineRefusal extends Error {
  readonly code: string;
  readonly paths?: string[];
  /** §53: what a `commit_series` that stopped in the middle made (on its `commit_failed` refusal). */
  readonly partial?: PartialSeries;
  constructor(message: string, code?: string, paths?: string[], partial?: PartialSeries) {
    super(message);
    this.name = "EngineRefusal";
    this.code = code ?? leadingCode(message);
    if (paths) this.paths = paths;
    if (partial) this.partial = partial;
  }
}

/** The engine's own rule (engine/src/errors.ts `refusalCode`): the leading `snake_case` word, else `refused`. */
export function leadingCode(message: string): string {
  const m = /^([a-z][a-z0-9_]*)(?::|$)/.exec(message);
  return m ? m[1]! : "refused";
}

/** `{code, error, detail, paths}` of anything a request rejected with (an `EngineRefusal` or a plain Error). */
export function refusalOf(e: unknown): { code: string; error: string; detail: string; paths?: string[] } {
  const error = e instanceof Error ? e.message : String(e);
  const code = e instanceof EngineRefusal ? e.code : leadingCode(error);
  const detail = error.startsWith(`${code}:`) ? error.slice(code.length + 1) : "";
  const paths = e instanceof EngineRefusal ? e.paths : undefined;
  return paths ? { code, error, detail, paths } : { code, error, detail };
}

type Bridge = Pick<RGBridge, "request"> & Partial<Pick<RGBridge, "requestDetailed">>;

/** `window.rg.request` that keeps `code` / `paths` (falls back to plain `request` on a bridge without `requestDetailed`). */
export async function engineRequest<C extends EngineCommand>(cmd: C, bridge: Bridge = window.rg): Promise<ReplyFor<C>> {
  if (typeof bridge.requestDetailed !== "function") return bridge.request(cmd);
  const r = await bridge.requestDetailed(cmd);
  if (!r.ok) throw new EngineRefusal(r.error, r.code, r.paths, r.partial);
  return r.reply;
}
