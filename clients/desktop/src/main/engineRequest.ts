/**
 * `rg:request` with the refusal details of docs/PROTOCOL.md §19.6: `ReviewEngine.request` rejects with
 * a bare `Error(result.error)`, so the `code` / `paths` of the failed `result` are picked up from the
 * engine's own event stream (the engine emits the `result` synchronously right after rejecting).
 */
import type { EngineCommand, EngineEvent, ReplyFor } from "@reviewgate/engine";

export type EngineLike = {
  request<C extends EngineCommand>(cmd: C): Promise<ReplyFor<C>>;
  on(listener: (ev: EngineEvent) => void): () => void;
};

/** What `rg:request` hands the preload: the reply, or `{__error, __code?, __paths?}`. */
export type RequestFailure = { __error: string; __code?: string; __paths?: string[] };

export async function requestWithDetails<C extends EngineCommand>(engine: EngineLike, cmd: C): Promise<ReplyFor<C> | RequestFailure> {
  const failed: { error: string; code?: string; paths?: string[] }[] = [];
  const off = engine.on((ev) => {
    if (ev.type === "result" && !ev.ok) failed.push(ev);
  });
  try {
    return await engine.request(cmd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Concurrent requests may fail too; the one with this exact text is ours (same text ⇒ same code).
    const hit = failed.find((f) => f.error === message);
    return {
      __error: message,
      ...(hit?.code ? { __code: hit.code } : {}),
      ...(hit?.paths ? { __paths: [...hit.paths] } : {}),
    };
  } finally {
    off();
  }
}
