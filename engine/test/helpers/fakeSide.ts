import { realpathSync } from "node:fs";
import type { EngineEvent } from "../../src/protocol.js";
import type { SideQueryEvent, SideQueryOptions, SideQueryResult } from "../../src/side/sideQuery.js";
import type { SideQueryLike } from "../../src/side/threads.js";
import type { Harness } from "./engine.js";
import { makeTempDir, sh, write } from "./repo.js";

/** What a scripted side CLI does for one question (wave 3: §36.10–§36.13 tests; the §21 tests keep their own copy). */
export type SideScript = (o: SideQueryOptions) => {
  text: string;
  hold?: boolean;
  error?: string;
  sessionId?: string;
  cost?: number;
  events?: SideQueryEvent[];
  /** With `error`: nothing came back before it (a fork at an unknown uuid) even when `events` are given. */
  silent?: boolean;
};

/** A scripted side CLI: records its options; `script` decides what it streams; `hold` keeps it running until released. */
export class FakeSide implements SideQueryLike {
  readonly opts: SideQueryOptions;
  private release: (() => void) | null = null;
  interrupted = false;
  constructor(opts: SideQueryOptions, private readonly script: SideScript) {
    this.opts = opts;
  }
  async run(): Promise<SideQueryResult> {
    // Like the CLI, nothing comes back before the caller got its handle.
    await new Promise<void>((r) => setImmediate(r));
    const s = this.script(this.opts);
    // An interrupt can come before this point (commands answered within one tick): it must not hold forever.
    if (s.hold && !this.interrupted) await new Promise<void>((r) => (this.release = r));
    if (this.interrupted) return { sessionId: s.sessionId ?? this.opts.sessionId ?? this.opts.resume ?? null, text: "", costUSD: 0, durationMs: 5, stopReason: "interrupted", error: null, sawOutput: true };
    const sid = s.sessionId ?? this.opts.sessionId ?? this.opts.resume ?? "side-x";
    if (s.error) {
      const spoke = s.silent !== true && (s.events ?? []).length > 0;
      if (spoke) for (const ev of s.events ?? []) this.opts.emit(ev);
      return { sessionId: spoke ? sid : null, text: "", costUSD: 0, durationMs: 1, stopReason: "error", error: s.error, sawOutput: spoke };
    }
    this.opts.emit({ type: "session", sessionId: sid });
    for (const ev of s.events ?? []) this.opts.emit(ev);
    if (s.text) this.opts.emit({ type: "text_delta", text: s.text });
    return { sessionId: sid, text: s.text, costUSD: s.cost ?? 0.002, durationMs: 42, stopReason: "success", error: null, sawOutput: true };
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.release?.();
  }
  async dispose(): Promise<void> {}
}

/** A repository on `main` with one commit (README.md: three lines). */
export function makeSideRepo(prefix = "rg-flow"): string {
  const dir = realpathSync(makeTempDir(prefix));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

export async function waitForEvent<T extends EngineEvent["type"]>(h: Harness, type: T, pred: (e: Extract<EngineEvent, { type: T }>) => boolean = () => true, timeoutMs = 5000): Promise<Extract<EngineEvent, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = h.ofType(type).find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
