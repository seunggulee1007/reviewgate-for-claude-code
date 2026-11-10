import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TranscriptItem } from "../protocol.js";

/**
 * Transcript persistence (audit 3.1): one NDJSON row per transcript-relevant event in
 * `<gitdir>/reviewgate-transcript.ndjson`. The file is capped at 2 MB — when an append would cross
 * it, the oldest rows are dropped and the newest half is kept. `tail()` feeds `transcript_restore`.
 */
export const TRANSCRIPT_FILE = "reviewgate-transcript.ndjson";
export const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
export const TRANSCRIPT_RESTORE_ROWS = 200;

export class TranscriptStore {
  constructor(
    readonly path: string,
    readonly maxBytes = TRANSCRIPT_MAX_BYTES,
    private readonly log: (message: string) => void = () => {},
  ) {}

  // MARK: wave4b w4b-bigturn
  /** §39.1: the error of the last `append` (ENOSPC, …); null after a good one. */
  lastError: unknown = null;

  /** Appends one row; rotates first when the file would exceed `maxBytes`. Never throws. */
  append(item: TranscriptItem): void {
    const line = JSON.stringify(item) + "\n";
    try {
      const size = this.size();
      if (size + line.length > this.maxBytes) this.rotate(Math.floor(this.maxBytes / 2) - line.length);
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line, "utf8");
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      this.log(`transcript append failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The last `n` parsable rows (oldest first); empty when the file is missing. */
  tail(n = TRANSCRIPT_RESTORE_ROWS): TranscriptItem[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const items: TranscriptItem[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && items.length < n; i--) {
      const l = lines[i]!;
      if (!l) continue;
      try {
        const o = JSON.parse(l) as TranscriptItem;
        if (o && typeof o === "object" && typeof o.kind === "string") items.push(o);
      } catch {
        // torn or foreign line: skipped
      }
    }
    return items.reverse();
  }

  private size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** Keeps the newest `keepBytes` of the file, cut at a row boundary (temp + rename). */
  private rotate(keepBytes: number): void {
    const buf = readFileSync(this.path);
    let start = Math.max(0, buf.length - Math.max(0, keepBytes));
    const nl = buf.indexOf(0x0a, start);
    start = nl === -1 ? buf.length : nl + 1;
    const tmp = `${this.path}.rotate`;
    writeFileSync(tmp, buf.subarray(start));
    try {
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
