/**
 * docs/PROTOCOL.md §57.3: the http server a terminal chat's `claude` posts its hooks to — 127.0.0.1 on a random port,
 * one token per spawn (`X-ReviewGate-Token`), each routed to its handler (the chat's TerminalSession). A token of an
 * earlier spawn or of a chat switched away from is retired: its hooks get a blocking answer, so a stale terminal can
 * neither start an unreviewed prompt nor write.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HOOK_TOKEN_HEADER } from "./terminalSpec.js";

/** What a hook answers (the CLI's hook output JSON). */
export type HookOutput = Record<string, unknown>;

export interface TerminalHookHandler {
  /** One hook's input (the CLI's JSON); resolves with the answer. `signal` aborts when the CLI gave up on the request. */
  handleHook(input: Record<string, unknown>, signal?: AbortSignal): Promise<HookOutput>;
}

/** The body cap (enforced while streaming). */
export const HOOK_BODY_MAX = 16 * 1024 * 1024;

export const RETIRED_REASON = "This terminal is no longer connected to ReviewGate's review. Restart it from its tab.";

/** How many retired tokens are remembered (older ones get 401). */
const RETIRED_KEEP = 64;

/** The blocking answer to a hook of a retired token, by event. */
export function retiredAnswer(event: unknown): HookOutput {
  if (event === "UserPromptSubmit") return { decision: "block", reason: RETIRED_REASON };
  if (event === "PreToolUse") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: RETIRED_REASON } };
  return {};
}

export class HookServer {
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private listenPort: number | null = null;
  private readonly live = new Map<string, TerminalHookHandler>();
  private readonly retired: string[] = [];

  constructor(private readonly log: (message: string) => void = () => {}) {}

  /** Listens (once) on 127.0.0.1, a port the system picks; resolves with it. */
  start(): Promise<number> {
    if (this.starting) return this.starting;
    const server = createServer((req, res) => this.onRequest(req, res));
    this.server = server;
    this.starting = new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        this.listenPort = (server.address() as AddressInfo).port;
        resolve(this.listenPort);
      });
    });
    this.starting.catch(() => {
      this.starting = null;
      this.server = null;
    });
    return this.starting;
  }

  get port(): number | null {
    return this.listenPort;
  }

  /** The hook url (`start` first). */
  get url(): string {
    return `http://127.0.0.1:${this.listenPort ?? 0}/hook`;
  }

  /** A fresh token routed to `handler` (32 random bytes, hex). */
  issue(handler: TerminalHookHandler): string {
    const token = randomBytes(32).toString("hex");
    this.live.set(token, handler);
    return token;
  }

  /** The token's hooks get the blocking answer from now on. */
  retire(token: string | null | undefined): void {
    if (!token || !this.live.delete(token)) return;
    this.retired.push(token);
    if (this.retired.length > RETIRED_KEEP) this.retired.shift();
  }

  /** Stops listening and drops every connection; resolves once closed. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.starting = null;
    this.listenPort = null;
    for (const t of [...this.live.keys()]) this.retire(t);
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private match(token: string): { handler: TerminalHookHandler } | "retired" | null {
    const given = Buffer.from(token);
    const same = (t: string): boolean => {
      const b = Buffer.from(t);
      return b.length === given.length && timingSafeEqual(b, given);
    };
    for (const [t, handler] of this.live) if (same(t)) return { handler };
    for (const t of this.retired) if (same(t)) return "retired";
    return null;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body: HookOutput = {}): void => {
      if (res.headersSent) return;
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/hook") {
      req.resume();
      return reply(404);
    }
    if (req.method !== "POST") {
      req.resume();
      return reply(405);
    }
    const header = req.headers[HOOK_TOKEN_HEADER.toLowerCase()];
    const token = Array.isArray(header) ? header[0] : header;
    const route = token ? this.match(token) : null;
    if (route === null) {
      req.resume();
      return reply(401);
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > HOOK_BODY_MAX) {
      req.resume();
      return reply(413);
    }
    // The CLI cancels a hook it stopped waiting for (its timeout, Esc): the connection closes before the answer went out.
    const cancelled = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) cancelled.abort();
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > HOOK_BODY_MAX) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => undefined);
    req.on("end", () => {
      if (tooBig) return reply(413);
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400);
      const body = input as Record<string, unknown>;
      if (route === "retired") {
        this.log(`terminal hook ${String(body.hook_event_name)} of a retired token: blocked`);
        return reply(200, retiredAnswer(body.hook_event_name));
      }
      route.handler.handleHook(body, cancelled.signal).then(
        (out) => reply(200, out),
        (e) => {
          this.log(`terminal hook ${String(body.hook_event_name)} failed: ${String(e)}`);
          reply(500);
        },
      );
    });
  }
}
