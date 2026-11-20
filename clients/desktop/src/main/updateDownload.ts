/**
 * The in-app update's download (docs/PROTOCOL.md §48, Windows): a release asset fetched over https from GitHub only. Every
 * hop of a redirect is checked against `DOWNLOAD_HOSTS` before it is requested (github.com answers a release download with
 * a 302 to release-assets.githubusercontent.com — objects.githubusercontent.com before 2025), at most `MAX_REDIRECTS` of
 * them; the body is capped (`maxBytes`, also against the announced length) and written to a new file; the progress goes to
 * `onProgress`; the signal cancels it and removes what was written. The transport (`HttpGet`) follows no redirect itself:
 * main passes Electron's `net` (the system's proxy), the tests a local server through node:http.
 */
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import { t } from "../renderer/i18n";

/** The only hosts a download may reach, the first request and every redirect alike. */
export const DOWNLOAD_HOSTS: readonly string[] = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
/** The installer is ~115 MB (0.5.17); anything far larger is not ours. */
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
/** `ReviewGate-Setup-X.Y.Z.exe.sha256` is one line. */
export const MAX_CHECKSUM_BYTES = 4096;
export const MAX_REDIRECTS = 5;

/** https, a host of the list (exactly — no subdomain, no trailing dot), the default port, no user name or password. */
export function allowedDownloadUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && DOWNLOAD_HOSTS.includes(u.hostname);
}

/** One response, redirects not followed: `location` for a 3xx, `length` from Content-Length (null when absent). */
export type HttpResponse = { status: number; location?: string; length: number | null; body: AsyncIterable<Uint8Array>; discard: () => void };
export type HttpGet = (url: string, signal: AbortSignal) => Promise<HttpResponse>;

export class DownloadError extends Error {
  constructor(
    readonly code: "cancelled" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export type DownloadOptions = {
  get: HttpGet;
  signal: AbortSignal;
  maxBytes: number;
  /** The size the release says (the progress's total until the server says one). */
  expectedSize?: number | null;
  onProgress?: (received: number, total: number | null) => void;
  /** Tests serve from 127.0.0.1; the app always uses `allowedDownloadUrl`. */
  allowed?: (url: string) => boolean;
};

const hostOf = (raw: string): string => {
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw.slice(0, 80);
  }
};

const cancelled = () => new DownloadError("cancelled", t("The update was cancelled."));
const failed = (why: string) => new DownloadError("failed", t("The download failed: {0}", why));

/** Downloads `url` into `dest` (a new file); resolves to the bytes written. A failure or a cancel leaves no file. */
export async function downloadTo(url: string, dest: string, o: DownloadOptions): Promise<number> {
  const allowed = o.allowed ?? allowedDownloadUrl;
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!allowed(current)) throw failed(t("it was sent to {0}, which is not GitHub", hostOf(current)));
    if (o.signal.aborted) throw cancelled();
    let res: HttpResponse;
    try {
      res = await o.get(current, o.signal);
    } catch (e) {
      if (o.signal.aborted) throw cancelled();
      throw failed(e instanceof Error ? e.message : String(e));
    }
    if (res.status >= 300 && res.status < 400) {
      res.discard();
      if (!res.location) throw failed(`HTTP ${res.status}`);
      if (hop >= MAX_REDIRECTS) throw failed(t("too many redirects"));
      current = new URL(res.location, current).href;
      continue;
    }
    if (res.status !== 200) {
      res.discard();
      throw failed(`HTTP ${res.status}`);
    }
    const total = res.length ?? o.expectedSize ?? null;
    if (total !== null && total > o.maxBytes) {
      res.discard();
      throw failed(t("the file is larger than {0} MB", Math.round(o.maxBytes / 1_000_000)));
    }
    return write(res, total, dest, o);
  }
}

async function write(res: HttpResponse, total: number | null, dest: string, o: DownloadOptions): Promise<number> {
  const out = createWriteStream(dest, { flags: "wx" });
  let received = 0;
  try {
    await once(out, "open");
    for await (const chunk of res.body) {
      if (o.signal.aborted) throw cancelled();
      received += chunk.length;
      if (received > o.maxBytes) throw failed(t("the file is larger than {0} MB", Math.round(o.maxBytes / 1_000_000)));
      if (!out.write(chunk)) await once(out, "drain");
      o.onProgress?.(received, total);
    }
    if (o.signal.aborted) throw cancelled();
    if (res.length !== null && received !== res.length) throw failed(t("it ended after {0} of {1} bytes", received, res.length));
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    return received;
  } catch (e) {
    res.discard();
    // The handle is closed before the file is removed (Windows will not remove an open file); a write still queued fails quietly.
    out.on("error", () => undefined);
    if (!out.closed) {
      const closed = once(out, "close").catch(() => undefined);
      out.destroy();
      await closed;
    }
    await rm(dest, { force: true }).catch(() => undefined);
    if (e instanceof DownloadError) throw e;
    if (o.signal.aborted) throw cancelled();
    throw failed(e instanceof Error ? e.message : String(e));
  }
}
