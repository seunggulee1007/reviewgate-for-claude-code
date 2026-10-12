/**
 * MARK: wave4d w4d-peers
 * docs/PROTOCOL.md §42.2 on the desktop client (audit peer-05, peer-07): the SendMessage card names the session a message
 * goes to (`permission_request.toSession` — its registry name, where it runs, whether it is a terminal) instead of a
 * socket path, and the "Other Claude sessions" section says how the user's other sessions see this window
 * (`cli_sessions.self`) with a copy action. Older engines send neither: the card shows `input.to` as before. Pure.
 */
import type { CliSessionStatus, PeerSelf, PeerSessionInfo, PermissionRequest } from "@reviewgate/engine";
import { t } from "./i18n";
import { runningStatusLabel } from "./sessionTools";

const STATUSES: ReadonlySet<CliSessionStatus> = new Set(["idle", "busy", "waiting", "unknown"]);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/** `permission_request.toSession`, checked; null when absent or malformed. */
export function toSessionOf(request: Pick<PermissionRequest, "toSession">): PeerSessionInfo | null {
  const x = request.toSession as unknown as Record<string, unknown> | undefined;
  if (!x || typeof x !== "object" || typeof x.pid !== "number" || !Number.isFinite(x.pid)) return null;
  return {
    address: text(x.address) ?? "",
    pid: x.pid,
    name: text(x.name),
    cwd: text(x.cwd),
    status: STATUSES.has(x.status as CliSessionStatus) ? (x.status as CliSessionStatus) : "unknown",
    entrypoint: text(x.entrypoint),
  };
}

/** The card's receiving session: its registry name, else what the call named (`to`), else "?". */
export function recipientTitle(request: Pick<PermissionRequest, "toSession" | "input">): string {
  return toSessionOf(request)?.name ?? text(request.input["to"]) ?? text(request.input["recipient"]) ?? "?";
}

/** The home folder written as `~` (macOS / Linux / Windows user folders), like the Mac card. */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, "~");
}

/** The line under it: "터미널 · ~/acme · 입력 대기"; empty without a known session. */
export function recipientDetail(info: PeerSessionInfo | null): string {
  if (!info) return "";
  const kind = info.entrypoint === null || info.entrypoint === "cli" ? t("Terminal") : t("App");
  const status = info.status === "unknown" ? null : runningStatusLabel(info.status);
  return [kind, info.cwd ? tildePath(info.cwd) : null, status].filter((s): s is string => !!s).join(" · ");
}

/** The address under the name — only when the name is the registry's (else the title already is the address). */
export function recipientAddress(request: Pick<PermissionRequest, "toSession">): string | null {
  const info = toSessionOf(request);
  return info && info.name !== null && info.address ? info.address : null;
}

/** What "copy" puts on the clipboard for this window: `name (address)`, or whichever of them is known. */
export function selfCopyText(me: PeerSelf): string | null {
  if (me.name && me.address) return `${me.name} (${me.address})`;
  return me.name ?? me.address ?? null;
}
