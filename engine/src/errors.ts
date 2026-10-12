/**
 * A guard/validation refusal: replies `result{ok:false}` without an `error` event (Swift's silent `guard … else { return }`).
 * `code` is the stable, localizable id clients switch on (docs/PROTOCOL.md "Error and refusal codes"); it defaults to the
 * message's leading `snake_case` word (`file_changed_since_review:a.txt` → `file_changed_since_review`).
 */
export class CommandRefused extends Error {
  readonly code: string;
  /** Paths the refusal is about (e.g. every file a `reject_all` would have overwritten). */
  readonly paths?: string[];

  constructor(message: string, opts: { code?: string; paths?: string[] } = {}) {
    super(message);
    this.name = "CommandRefused";
    this.code = opts.code ?? refusalCode(message);
    if (opts.paths) this.paths = opts.paths;
  }
}

/** The leading `snake_case` word of a refusal / error message; `refused` when there is none. */
export function refusalCode(message: string): string {
  const m = /^([a-z][a-z0-9_]*)(?::|$)/.exec(message);
  return m ? m[1]! : "refused";
}

/** The `code` / `paths` a failed command's `result` carries: a refusal's own, else `command_failed`. */
export function refusalFields(e: unknown): { code: string; paths?: string[] } {
  if (e instanceof CommandRefused) return e.paths ? { code: e.code, paths: e.paths } : { code: e.code };
  return { code: "command_failed" };
}
